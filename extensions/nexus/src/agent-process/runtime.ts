import { frame } from "../agent/prompt-framing";
import type { ModelCallReceipt } from "../contracts";
import { wrapProvider } from "../models/prune-adapter";
import type { Provider, ToolCall, TurnMessage } from "../models/provider";
import { createProviders } from "../models/registry";
import { redact } from "../shared/redact";
import { sanitizeForEvent } from "../shared/sanitize";
import type { AgentChannel, HostReqOut } from "./channel";
import { SESSION_FINISHED } from "./session-events";
import { TOOL_DEFS, executeTool, type Gate } from "./tools";

// The provider-neutral tool loop that runs in the agent child process (PLAN L1-09).
// It never writes files, runs commands or talks to git: every tool is a gate request to the extension host.
// Keys arrive per call (credentials.get) and are dropped as soon as the provider call ends.

export const MAX_TURNS = 40;
export { sanitizeForEvent };

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
  /** Test hook: the fetch used for calls routed through Prune. */
  fetch?: typeof fetch;
  /** Called once per session when the loop ends, however it ends. The host controller maps it to a status. */
  onFinished?: (outcome: SessionOutcome) => void;
}

/**
 * Iterates a provider stream but stops waiting the moment the signal aborts, even if the provider ignores the signal:
 * a cancelled session must free the runtime within one turn.
 */
async function* abortable<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await raceAbort(it.next(), signal);
      if (next === undefined || next.done) return;
      yield next.value;
    }
  } finally {
    void Promise.resolve(it.return?.()).catch(() => undefined);      // best effort; never waited on
  }
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
  /** A person's follow-ups, taken by the loop between model calls (and before it would finish). */
  inbox: string[];
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
    const inbox: string[] = [];
    const done = this.loop(start, abort.signal, inbox).then(o => {
      this.running = undefined;
      this.deps.onFinished?.(o);
      return o;
    });
    this.running = { sessionId, abort, done, inbox };
  }

  /** Queues a person's follow-up for the running loop; false when that session is not running (it just ended). */
  message(sessionId: string, text: string): boolean {
    if (!this.running || this.running.sessionId !== sessionId) return false;
    this.running.inbox.push(text);
    return true;
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
      if (name === "session.message") {
        const b = body as { sessionId: string; text: string };
        if (!this.message(b.sessionId, b.text)) throw new Error(`no running session ${b.sessionId}`);
        return { accepted: true };
      }
      return { ok: true, pid: process.pid };
    }) as never);
  }

  /** Receipts become `receipt` events; a Prune fallback note becomes a plainly labeled message. */
  private async flushReceipts(receipts: ModelCallReceipt[], notes: string[]): Promise<void> {
    for (const r of receipts.splice(0)) await this.emit("receipt", r as unknown as Record<string, unknown>);
    for (const n of notes.splice(0)) await this.emit("message", { text: `[nexus] ${n}` });
  }

  private async emit(type: "message" | "tool_call" | "tool_result" | "error" | "receipt", payload: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.gate.request("event.emit", { type, payload: sanitizeForEvent(payload) });
    } catch {
      // A lost event must not kill the session; the host's own log shows the failure.
    }
  }

  private async loop(start: SessionStart, signal: AbortSignal, inbox: string[]): Promise<SessionOutcome> {
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
    // The title may come from a Slack message, so it is fenced as data like every other untrusted text; the brief is
    // quoted by the brief builder (its Slack lines start with "> "), and the system rules say how to read both.
    const messages: TurnMessage[] = [];
    // Consecutive turns of one role are joined: providers expect alternating roles, and a follow-up can land right after tool results.
    const add = (role: "user" | "assistant", text: string) => {
      const last = messages[messages.length - 1];
      if (last && last.role === role && !(last.role === "assistant" && last.toolCalls)) last.content = `${last.content}\n\n${text}`;
      else messages.push(role === "user" ? { role, content: text } : { role, content: text });
    };
    add("user", `Task title (data, supplied by a person):\n${frame([{ label: "task title", text: start.task.title }])}\n\nTask brief:\n${start.task.brief}`);
    // A resumed session starts from what was said so far (the worktree already holds the work), then the person's new message.
    // The history is the transcript the host stored: the person's own messages and the agent's replies, not tool output.
    for (const h of start.resume?.history ?? []) add(h.role, h.text);
    if (start.resume) add("user", start.resume.message);

    while (turns < maxTurns) {
      if (signal.aborted) return finish("cancelled");
      turns++;
      for (const text of inbox.splice(0)) add("user", text);          // a follow-up typed while the agent was working

      const callId = this.deps.newCallId?.() ?? `call_${sessionId}_${++this.callSeq}`;
      let text = "";
      const toolCalls: ToolCall[] = [];
      let stop: string | undefined;
      try {
        const cred = await raceAbort(this.deps.gate.request("credentials.get", { provider: start.session.model.provider, callId }), signal);
        if (!cred) return finish("cancelled");
        let key: string | undefined = cred.apiKey;
        // The host decides per call whether this call goes through Prune (toggle on, agent in scope, key present).
        const receipts: ModelCallReceipt[] = [];
        const notes: string[] = [];
        const callProvider = cred.prune?.enabled && cred.prune.apiKey
          ? wrapProvider(provider, {
              apiKey: cred.prune.apiKey, scope: "all_roles", allowModelRouting: false, sessionId, newCallId: () => callId, fetch: this.deps.fetch,
              now: () => new Date().toISOString(), onReceipt: r => receipts.push(r), onNote: n => notes.push(n),
            })
          : provider;
        try {
          for await (const e of abortable(callProvider.turn({ modelId: start.session.model.modelId, role: "agent", system, messages: [...messages], tools: TOOL_DEFS, signal }, key), signal)) {
            if (e.type === "text_delta") text += e.text;
            else if (e.type === "tool_call") toolCalls.push({ id: e.id, name: e.name, args: e.args, ...(e.providerMeta !== undefined ? { providerMeta: e.providerMeta } : {}) });
            else if (e.type === "done") stop = e.stopReason;
            else { await this.flushReceipts(receipts, notes); return await fail(`model error: ${e.message}`); }
          }
        } finally {
          key = undefined;                                    // the key never outlives the provider call
        }
        await this.flushReceipts(receipts, notes);
      } catch (e) {
        return fail(`model call failed: ${e instanceof Error ? e.message : "unknown error"}`);
      }

      if (signal.aborted || stop === "cancelled") return finish("cancelled");
      if (text.trim().length > 0) await this.emit("message", { text });
      messages.push({ role: "assistant", content: text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined });

      if (toolCalls.length === 0) {
        if (stop === "max_tokens") return fail("the model hit its output limit before finishing");
        if (inbox.length > 0) continue;                               // a follow-up arrived during this turn: answer it instead of finishing
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
