import type { Readable, Writable } from "node:stream";
import type { z } from "zod";
import {
  AgentEnvelope, AgentRequests, HostEvents, HostRequests,
  type AgentRequestName, type HostRequestName,
} from "../contracts";
import { readLines, writeLine } from "../shared/jsonl";

// Child-side end of the agent protocol (PLAN L1-08). The agent process has no fs, child_process or network access
// to the user's workspace: everything it does is a request over this channel, answered by the gate in the host.

export type AgentReqIn<K extends AgentRequestName> = z.input<(typeof AgentRequests)[K]["req"]>;
export type AgentResOut<K extends AgentRequestName> = z.output<(typeof AgentRequests)[K]["res"]>;
export type HostReqOut<K extends HostRequestName> = z.output<(typeof HostRequests)[K]["req"]>;
export type HostResIn<K extends HostRequestName> = z.input<(typeof HostRequests)[K]["res"]>;
export type HostEventName = keyof typeof HostEvents;

export type HostRequestHandler = <K extends HostRequestName>(name: K, body: HostReqOut<K>) => Promise<HostResIn<K>>;

interface Pending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  name: AgentRequestName;
}

export class AgentChannel {
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private hostHandler?: HostRequestHandler;
  private readonly eventHandlers = new Map<string, Array<(body: unknown) => void>>();
  private readonly stopReading: () => void;
  private closed = false;

  constructor(input: Readable, private readonly output: Writable) {
    this.stopReading = readLines(input, line => this.onLine(line));
    input.once("close", () => this.failAll(new Error("host closed the channel")));
    input.once("end", () => this.failAll(new Error("host closed the channel")));
  }

  /** Sends a request to the host (through the gate) and resolves with the schema-validated response. */
  request<K extends AgentRequestName>(name: K, body: AgentReqIn<K>): Promise<AgentResOut<K>> {
    const schema = AgentRequests[name];
    const parsed = schema.req.safeParse(body);
    if (!parsed.success) return Promise.reject(new Error(`invalid ${name} request: ${parsed.error.message}`));
    if (this.closed) return Promise.reject(new Error("channel closed"));
    const id = `a${++this.seq}`;
    return new Promise<AgentResOut<K>>((resolve, reject) => {
      this.pending.set(id, { name, resolve: resolve as (v: unknown) => void, reject });
      if (!writeLine(this.output, { t: "req", id, name, body: parsed.data })) {
        this.pending.delete(id);
        reject(new Error("host stream closed"));
      }
    });
  }

  /** Registers the single handler for host requests (session.start, session.cancel, health). */
  onHostRequest(handler: HostRequestHandler): void {
    this.hostHandler = handler;
  }

  /** Subscribes to host events such as "approval.resolved". */
  onHostEvent<N extends HostEventName>(name: N, cb: (body: z.output<(typeof HostEvents)[N]>) => void): void {
    const list = this.eventHandlers.get(name) ?? [];
    list.push(cb as (body: unknown) => void);
    this.eventHandlers.set(name, list);
  }

  close(): void {
    this.closed = true;
    this.stopReading();
    this.failAll(new Error("channel closed"));
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private onLine(line: string): void {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    const env = AgentEnvelope.safeParse(raw);
    if (!env.success) return;
    const msg = env.data;
    if (msg.t === "res") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (!msg.ok) { p.reject(new Error(msg.error ?? "request failed")); return; }
      const res = AgentRequests[p.name].res.safeParse(msg.body);
      if (res.success) p.resolve(res.data);
      else p.reject(new Error(`invalid ${p.name} response from host`));
    } else if (msg.t === "req") {
      void this.serveHostRequest(msg.id, msg.name, msg.body);
    } else {
      const schema = (HostEvents as Record<string, z.ZodType | undefined>)[msg.name];
      const body = schema?.safeParse(msg.body);
      if (!body?.success) return;
      for (const cb of this.eventHandlers.get(msg.name) ?? []) cb(body.data);
    }
  }

  private async serveHostRequest(id: string, name: string, body: unknown): Promise<void> {
    const reply = (value: unknown) => writeLine(this.output, value);
    const schema = (HostRequests as Record<string, (typeof HostRequests)[HostRequestName] | undefined>)[name];
    if (!schema || !this.hostHandler) { reply({ t: "res", id, ok: false, error: `unknown host request ${name}` }); return; }
    const req = schema.req.safeParse(body);
    if (!req.success) { reply({ t: "res", id, ok: false, error: `invalid ${name} request` }); return; }
    try {
      const result = await this.hostHandler(name as HostRequestName, req.data as never);
      const res = schema.res.safeParse(result);
      if (!res.success) { reply({ t: "res", id, ok: false, error: `invalid ${name} response` }); return; }
      reply({ t: "res", id, ok: true, body: res.data });
    } catch (e) {
      reply({ t: "res", id, ok: false, error: e instanceof Error ? e.message : "internal error" });
    }
  }
}
