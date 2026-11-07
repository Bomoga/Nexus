import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { z } from "zod";
import {
  AgentEnvelope, AgentRequests, HostEvents, HostRequests,
  type AgentRequestName, type HostRequestName,
} from "../contracts";
import { readLines, writeLine } from "../shared/jsonl";
import { redact } from "../shared/redact";

// Host side of the agent child process (PLAN L1-08). Frames AgentEnvelope as JSON lines, validates every message with
// Zod, routes agent requests to injected handlers (gate, store, slack, credentials) and never blocks on the child.

export type AgentReqOut<K extends AgentRequestName> = z.output<(typeof AgentRequests)[K]["req"]>;
export type AgentResIn<K extends AgentRequestName> = z.input<(typeof AgentRequests)[K]["res"]>;
export type AgentHandlers = { [K in AgentRequestName]?: (body: AgentReqOut<K>) => Promise<AgentResIn<K>> };

export type HostReqIn<K extends HostRequestName> = z.input<(typeof HostRequests)[K]["req"]>;
export type HostResOut<K extends HostRequestName> = z.output<(typeof HostRequests)[K]["res"]>;
export type HostEventIn<N extends keyof typeof HostEvents> = z.input<(typeof HostEvents)[N]>;

export interface Transport {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  kill(): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
}
export type Spawner = () => Transport;

export type LogLevel = "debug" | "info" | "warn" | "error";
/** Log lines carry names, ids and sizes only; never request or response bodies (they can hold credentials). */
export type HostLogger = (level: LogLevel, message: string, meta?: Record<string, string | number | boolean | undefined>) => void;

export interface SessionErrorInfo {
  /** True when the process was respawned (the controller should re-send session.start or fail the session). */
  restarted: boolean;
  exitCode: number | null;
  signal: string | null;
}

export interface ProcessHostOptions {
  spawn: Spawner;
  handlers: AgentHandlers;
  log?: HostLogger;
  /** Called with an "error" AgentEvent payload's message when the process dies under an active session. */
  onSessionError?: (sessionId: string, message: string, info: SessionErrorInfo) => void;
  /** Timeout for ordinary agent requests (default 30 s). cmd.run, git.commit and approval.request wait for humans and have none. */
  requestTimeoutMs?: number;
  /** Timeout for host-to-agent requests such as session.start (default 10 s). */
  hostRequestTimeoutMs?: number;
}

/** These wait on a human decision or a long command, so the host never times them out. */
const NO_TIMEOUT: ReadonlySet<string> = new Set<AgentRequestName>(["cmd.run", "git.commit", "approval.request"]);
const MAX_RESTARTS_PER_SESSION = 1;

interface HostPending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  name: HostRequestName;
  timer: ReturnType<typeof setTimeout>;
}

export class ProcessHost {
  private transport?: Transport;
  private seq = 0;
  private readonly pending = new Map<string, HostPending>();
  private readonly restarts = new Map<string, number>();
  private activeSession?: string;
  private disposed = false;
  private stopReading?: () => void;
  private generation = 0;
  private readonly log: HostLogger;
  private readonly requestTimeoutMs: number;
  private readonly hostRequestTimeoutMs: number;

  constructor(private readonly opts: ProcessHostOptions) {
    this.log = opts.log ?? (() => {});
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.hostRequestTimeoutMs = opts.hostRequestTimeoutMs ?? 10_000;
  }

  /** Spawns the child if it is not running. Safe to call repeatedly. */
  start(): void {
    if (this.disposed) throw new Error("process host disposed");
    if (this.transport) return;
    const gen = ++this.generation;
    const t = this.opts.spawn();
    this.transport = t;
    this.stopReading = readLines(t.stdout, line => this.onLine(line));
    if (t.stderr) readLines(t.stderr, line => this.log("debug", `agent stderr: ${redact(line).slice(0, 500)}`));
    t.stdin.on("error", err => this.log("warn", `agent stdin error: ${err.message}`));
    t.onExit((code, signal) => this.onExit(gen, code, signal));
    this.log("info", "agent process started", { generation: gen });
  }

  /** Starts a session in the child (spawning it first if needed). Resolves once the runtime accepts. */
  async startSession(params: HostReqIn<"session.start">): Promise<HostResOut<"session.start">> {
    this.start();
    this.activeSession = params.session.id;
    return this.requestChild("session.start", params);
  }

  async cancelSession(sessionId: string): Promise<HostResOut<"session.cancel">> {
    const res = await this.requestChild("session.cancel", { sessionId });
    if (this.activeSession === sessionId) this.activeSession = undefined;
    return res;
  }

  /** The controller calls this when a session finishes normally, so a later process exit is not blamed on it. */
  endSession(sessionId: string): void {
    if (this.activeSession === sessionId) this.activeSession = undefined;
  }

  health(): Promise<HostResOut<"health">> {
    this.start();
    return this.requestChild("health", {});
  }

  /** Delivers a host event to the agent, e.g. "approval.resolved" to wake a waiting cmd.run. */
  sendEvent<N extends keyof typeof HostEvents>(name: N, body: HostEventIn<N>): boolean {
    if (!this.transport) return false;
    return writeLine(this.transport.stdin, { t: "evt", name, body: HostEvents[name].parse(body) });
  }

  get running(): boolean {
    return this.transport !== undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.failPending(new Error("process host disposed"));
    this.stopReading?.();
    const t = this.transport;
    this.transport = undefined;
    t?.kill();
  }

  // ---- host -> child ----

  private requestChild<K extends HostRequestName>(name: K, body: HostReqIn<K>): Promise<HostResOut<K>> {
    const t = this.transport;
    if (!t) return Promise.reject(new Error("agent process not running"));
    const parsed = HostRequests[name].req.parse(body);
    const id = `h${++this.seq}`;
    return new Promise<HostResOut<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${name} timed out`));
      }, this.hostRequestTimeoutMs);
      this.pending.set(id, { name, resolve: resolve as (v: unknown) => void, reject, timer });
      if (!writeLine(t.stdin, { t: "req", id, name, body: parsed })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("agent process stdin closed"));
      }
    });
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  // ---- child -> host ----

  private onLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.log("warn", "dropped agent line: not JSON", { bytes: line.length });
      return;
    }
    const env = AgentEnvelope.safeParse(raw);
    if (!env.success) {
      this.log("warn", "dropped agent line: not an AgentEnvelope", { bytes: line.length });
      return;
    }
    const msg = env.data;
    if (msg.t === "req") void this.serve(msg.id, msg.name, msg.body);
    else if (msg.t === "res") this.onChildResponse(msg.id, msg.ok, msg.body, msg.error);
    else this.log("debug", "ignored agent event", { name: msg.name });
  }

  private onChildResponse(id: string, ok: boolean, body: unknown, error?: string): void {
    const p = this.pending.get(id);
    if (!p) {
      this.log("warn", "dropped agent response: unknown id", { id });
      return;
    }
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (!ok) { p.reject(new Error(redact(error ?? `${p.name} failed`))); return; }
    const res = HostRequests[p.name].res.safeParse(body);
    if (res.success) p.resolve(res.data);
    else p.reject(new Error(`invalid ${p.name} response from agent`));
  }

  private reply(id: string, ok: true, body: unknown): void;
  private reply(id: string, ok: false, error: string): void;
  private reply(id: string, ok: boolean, payload: unknown): void {
    const t = this.transport;
    if (!t) return;
    writeLine(t.stdin, ok ? { t: "res", id, ok: true, body: payload } : { t: "res", id, ok: false, error: payload });
  }

  private async serve(id: string, name: string, body: unknown): Promise<void> {
    const schema = (AgentRequests as Record<string, (typeof AgentRequests)[AgentRequestName] | undefined>)[name];
    if (!schema) {
      this.log("warn", "unknown agent request", { name });
      this.reply(id, false, `unknown request ${name}`);
      return;
    }
    const req = schema.req.safeParse(body);
    if (!req.success) {
      this.log("warn", "invalid agent request", { name });
      this.reply(id, false, `invalid ${name} request`);
      return;
    }
    const handler = this.opts.handlers[name as AgentRequestName] as ((b: unknown) => Promise<unknown>) | undefined;
    if (!handler) {
      this.log("warn", "no handler for agent request", { name });
      this.reply(id, false, `no handler for ${name}`);
      return;
    }
    try {
      const result = NO_TIMEOUT.has(name) ? await handler(req.data) : await withTimeout(handler(req.data), this.requestTimeoutMs, `${name} timed out`);
      const res = schema.res.safeParse(result);
      if (!res.success) {
        this.log("error", "handler returned an invalid response", { name });
        this.reply(id, false, `invalid ${name} response`);
        return;
      }
      this.reply(id, true, res.data);
    } catch (e) {
      this.log("warn", "agent request failed", { name });
      this.reply(id, false, redact(e instanceof Error ? e.message : "internal error"));
    }
  }

  // ---- lifecycle ----

  private onExit(gen: number, code: number | null, signal: string | null): void {
    if (gen !== this.generation || this.disposed) return;
    this.transport = undefined;
    this.stopReading?.();
    this.failPending(new Error("agent process exited"));
    const sessionId = this.activeSession;
    this.log("warn", "agent process exited", { code: code ?? undefined, signal: signal ?? undefined, session: sessionId });
    if (!sessionId) return;                                  // idle: respawn lazily on the next start()
    const used = this.restarts.get(sessionId) ?? 0;
    if (used < MAX_RESTARTS_PER_SESSION) {
      this.restarts.set(sessionId, used + 1);
      this.activeSession = undefined;                        // the controller decides whether to re-send session.start
      try { this.start(); } catch (e) { this.log("error", "restart failed", { reason: e instanceof Error ? e.message : "unknown" }); }
      this.opts.onSessionError?.(sessionId, "agent process crashed and was restarted once", { restarted: this.transport !== undefined, exitCode: code, signal });
    } else {
      this.activeSession = undefined;
      this.opts.onSessionError?.(sessionId, "agent process crashed again; not restarting", { restarted: false, exitCode: code, signal });
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface ForkOptions {
  execArgv?: string[];
  env?: Record<string, string>;
}

/**
 * Spawner for the real child: runs `entry` with the current Node/Electron binary.
 * ELECTRON_RUN_AS_NODE makes the extension host's Electron binary behave as plain Node.
 */
export function forkAgentProcess(entry: string, opts: ForkOptions = {}): Spawner {
  return () => {
    const child = spawn(process.execPath, [...(opts.execArgv ?? []), entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...opts.env },
      windowsHide: true,
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      kill: () => { child.kill(); },
      onExit: cb => { child.once("exit", cb); child.once("error", () => cb(null, null)); },
    };
  };
}
