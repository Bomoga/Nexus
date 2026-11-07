import { frame } from "../agent/prompt-framing";
import type { Provider, ToolCall, TurnMessage } from "../models/provider";
import { createProviders } from "../models/registry";
import { redact } from "../shared/redact";
import type { AgentChannel, HostReqOut } from "./channel";
import { SESSION_FINISHED } from "./session-events";
import { TOOL_DEFS, executeTool, type Gate } from "./tools";

// The provider-neutral tool loop that runs in the agent child process (PLAN L1-09).
// It never writes files, runs commands or talks to git: every tool is a gate request to the extension host.
// Keys arrive per call (credentials.get) and are dropped as soon as the provider call ends.

export const MAX_TURNS = 40;
const MAX_EVENT_STRING = 2000;

export type SessionStart = HostReqOut<"session.start">;

export interface SessionOutcome {
  sessionId: string;
  outcome: "done" | "failed" | "cancelled";
  turns: number;
  reason?: string;
}

export interface RuntimeDeps {
  providers: Record<string, Provider>;
  gate: Gate;
  maxTurns?: number;
  newCallId?: () => string;
  /** Called once per session when the loop ends, however it ends. The host controller maps it to a status. */
  onFinished?: (outcome: SessionOutcome) => void;
}

/** Strings in event payloads are redacted and clipped: they end up in the shared store and in Slack. */
export function sanitizeForEvent(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    const clean = redact(value);
    return clean.length > MAX_EVENT_STRING ? `${clean.slice(0, MAX_EVENT_STRING)}…[clipped ${clean.length - MAX_EVENT_STRING} chars]` : clean;
  }
  if (depth >= 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(v => sanitizeForEvent(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeForEvent(v, depth + 1)]));
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      v => { signal.removeEventListener("abort", onAbort); resolve(v); },
      e => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

interface Running {
  sessionId: string;
  abort: AbortController;
  done: Promise<SessionOutcome>;
}

export class AgentRuntime {
  private running?: Running;
  private callSeq = 0;

  constructor(private readonly deps: RuntimeDeps) {}

  get activeSessionId(): string | undefined {
    return this.running?.sessionId;
  }

  /** Begins the loop and returns immediately; the outcome arrives through onFinished (and `whenIdle`). */
  start(start: SessionStart): void {
    if (this.running) throw new Error("a session is already running in this agent process");
    const abort = new AbortController();
    const sessionId = start.session.id;
    const done = this.loop(start, abort.signal).then(o => {
      this.running = undefined;
      this.deps.onFinished?.(o);
      return o;
    });
    this.running = { sessionId, abort, done };
  }

  /** Stops the loop within one turn: aborts the provider call and abandons any tool still waiting on a human. */
  cancel(sessionId: string): boolean {
    if (!this.running || this.running.sessionId !== sessionId) return false;
    this.running.abort.abort();
    return true;
  }

  async whenIdle(): Promise<SessionOutcome | undefined> {
    return this.running?.done;
  }

  /** Wires this runtime to the host protocol on a channel. */
  attach(channel: AgentChannel): void {
    channel.onHostRequest((async (name: string, body: unknown) => {
      if (name === "session.start") {
        this.start(body as SessionStart);
        return { accepted: true };
      }
      if (name === "session.cancel") {
        const id = (body as { sessionId: string }).sessionId;
        if (!this.cancel(id)) throw new Error(`no running session ${id}`);
        return { cancelled: true };
      }
      return { ok: true, pid: process.pid };
    }) as never);
  }

  private async emit(type: "message" | "tool_call" | "tool_result" | "error", payload: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.gate.request("event.emit", { type, payload: sanitizeForEvent(payload) });
    } catch {
      // A lost event must not kill the session; the host's own log shows the failure.
    }
  }

  private async loop(start: SessionStart, signal: AbortSignal): Promise<SessionOutcome> {
    const sessionId = start.session.id;
    const maxTurns = this.deps.maxTurns ?? MAX_TURNS;
    let turns = 0;
    const finish = (outcome: SessionOutcome["outcome"], reason?: string): SessionOutcome => ({ sessionId, outcome, turns, reason });
    const fail = async (message: string) => {
      await this.emit("error", { message });
      return finish("failed", redact(message));
    };

    const provider = this.deps.providers[start.session.model.provider];
    if (!provider) return fail(`no provider "${start.session.model.provider}" in the agent process`);

    const system = [start.systemRules, frame(start.untrustedBlocks)].filter(s => s.length > 0).join("\n\n");
    const messages: TurnMessage[] = [{ role: "user", content: `Task: ${start.task.title}\n\n${start.task.brief}` }];

    while (turns < maxTurns) {
      if (signal.aborted) return finish("cancelled");
      turns++;

      const callId = this.deps.newCallId?.() ?? `call_${sessionId}_${++this.callSeq}`;
      let text = "";
      const toolCalls: ToolCall[] = [];
      let stop: string | undefined;
      try {
        const cred = await raceAbort(this.deps.gate.request("credentials.get", { provider: start.session.model.provider, callId }), signal);
        if (!cred) return finish("cancelled");
        let key: string | undefined = cred.apiKey;
        try {
          for await (const e of provider.turn({ modelId: start.session.model.modelId, role: "agent", system, messages: [...messages], tools: TOOL_DEFS, signal }, key)) {
            if (e.type === "text_delta") text += e.text;
            else if (e.type === "tool_call") toolCalls.push({ id: e.id, name: e.name, args: e.args });
            else if (e.type === "done") stop = e.stopReason;
            else return await fail(`model error: ${e.message}`);
          }
        } finally {
          key = undefined;                                    // the key never outlives the provider call
        }
      } catch (e) {
        return fail(`model call failed: ${e instanceof Error ? e.message : "unknown error"}`);
      }

      if (signal.aborted || stop === "cancelled") return finish("cancelled");
      if (text.trim().length > 0) await this.emit("message", { text });
      messages.push({ role: "assistant", content: text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined });

      if (toolCalls.length === 0) {
        if (stop === "max_tokens") return fail("the model hit its output limit before finishing");
        return finish("done");
      }

      for (const call of toolCalls) {
        await this.emit("tool_call", { tool: call.name, args: call.args });
        const result = await raceAbort(executeTool(this.deps.gate, call.name, call.args), signal);
        if (!result) return finish("cancelled");
        await this.emit("tool_result", { tool: call.name, ok: result.ok, summary: result.content.slice(0, 500) });
        // Tool output is data from the repo or a command, never instructions: it goes back to the model fenced.
        messages.push({ role: "tool", toolCallId: call.id, isError: !result.ok, content: frame([{ label: `tool result: ${call.name}`, text: result.content }]) });
      }
    }
    return fail(`turn limit (${maxTurns}) reached`);
  }
}

/** Entry used by main.ts: real (or fake, per NEXUS_FAKE_PROVIDER) providers, the channel as the gate, outcome reported to the host. */
export async function run(channel: AgentChannel, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const runtime = new AgentRuntime({
    providers: createProviders(env),
    gate: channel,
    onFinished: outcome => channel.notify(SESSION_FINISHED, outcome),
  });
  runtime.attach(channel);
}
