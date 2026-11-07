// In-memory BridgeRouter for tests: no vscode, no postMessage. Does the client side too (call / subscribe).
// Validates like the real router will (req in, res out, evt out) so fixtures that drift from the contracts fail fast.
import { Requests, Subscriptions } from "../contracts";
import type { Req, RequestName, Res, SubEvt, SubscriptionName } from "../contracts";
import type { z } from "zod";
import { BridgeError } from "./types";
import { matchesSubscription } from "./types";
import type { BridgeRouter, Disposable, RequestHandler, SubscribeHandler } from "./types";

interface Sub { name: SubscriptionName; req: unknown; cb: (evt: unknown) => void; active: boolean; ready: boolean; held: unknown[]; maxSeq: number; cleanup?: Disposable }

function toBridgeError(e: unknown): BridgeError {
  return e instanceof BridgeError ? e : new BridgeError("internal", e instanceof Error ? e.message : String(e));
}

function firstSeq(name: SubscriptionName, req: unknown): number {
  return name === "agent.subscribe" ? (req as { fromSeq?: number }).fromSeq ?? 0 : 0;
}

export class FakeBridgeServer implements BridgeRouter {
  private readonly handlers = new Map<string, RequestHandler<RequestName>>();
  private readonly subHandlers = new Map<string, SubscribeHandler<SubscriptionName>>();
  private readonly subs = new Set<Sub>();

  handle<N extends RequestName>(name: N, fn: RequestHandler<N>): Disposable {
    if (this.handlers.has(name)) throw new Error(`handler already registered: ${name}`);
    this.handlers.set(name, fn as unknown as RequestHandler<RequestName>);
    return { dispose: () => { this.handlers.delete(name); } };
  }

  onSubscribe<N extends SubscriptionName>(name: N, fn: SubscribeHandler<N>): Disposable {
    if (this.subHandlers.has(name)) throw new Error(`subscribe handler already registered: ${name}`);
    this.subHandlers.set(name, fn as unknown as SubscribeHandler<SubscriptionName>);
    return { dispose: () => { this.subHandlers.delete(name); } };
  }

  publish<N extends SubscriptionName>(sub: N, evt: SubEvt<N>): void {
    const parsed = Subscriptions[sub].evt.parse(evt);
    for (const s of [...this.subs]) {
      if (s.name !== sub || !matchesSubscription(sub, s.req, parsed)) continue;
      if (s.ready) this.deliver(s, parsed); else s.held.push(parsed);
    }
  }

  /** Client side: send a request as a webview would. Rejects with BridgeError carrying the frozen code. */
  async call<N extends RequestName>(name: N, req: z.input<(typeof Requests)[N]["req"]>): Promise<Res<N>> {
    const fn = this.handlers.get(name);
    if (!fn) throw new BridgeError("not_found", `no handler: ${name}`);
    const parsedReq = Requests[name].req.safeParse(req);
    if (!parsedReq.success) throw new BridgeError("invalid_request", parsedReq.error.message);
    let res: unknown;
    try { res = await fn(parsedReq.data as Req<RequestName>); }
    catch (e) { throw toBridgeError(e); }
    const parsedRes = Requests[name].res.safeParse(res);
    if (!parsedRes.success) throw new BridgeError("internal", `invalid response for ${name}: ${parsedRes.error.message}`);
    return parsedRes.data as Res<N>;
  }

  /** Test helper: live subscriptions, so a leak is observable. */
  subscriptionCount(): number { return this.subs.size; }

  private deliver(s: Sub, evt: unknown): void {
    if (!s.active) return;
    const seq = (evt as { seq?: unknown }).seq;
    if (s.name === "agent.subscribe" && typeof seq === "number") {
      if (seq <= s.maxSeq) return;   // below fromSeq, or already delivered
      s.maxSeq = seq;
    }
    s.cb(evt);
  }

  /**
   * Client side: subscribe as a webview would. Returns an unsubscribe Disposable once the subscribe handler has resolved.
   * `onHandle` receives that Disposable synchronously, before the handler runs, so tests can unsubscribe during replay.
   */
  async subscribe<N extends SubscriptionName>(name: N, req: z.input<(typeof Subscriptions)[N]["req"]>, cb: (evt: SubEvt<N>) => void, onHandle?: (d: Disposable) => void): Promise<Disposable> {
    const fn = this.subHandlers.get(name);
    const parsedReq = Subscriptions[name].req.safeParse(req);
    if (!parsedReq.success) throw new BridgeError("invalid_request", parsedReq.error.message);
    const sub: Sub = { name, req: parsedReq.data, cb: cb as (evt: unknown) => void, active: true, ready: false, held: [], maxSeq: firstSeq(name, parsedReq.data) - 1 };
    const handle: Disposable = { dispose: () => { sub.active = false; this.subs.delete(sub); sub.cleanup?.dispose(); sub.cleanup = undefined; } };
    this.subs.add(sub);
    onHandle?.(handle);
    // emit = replay only: inert once the handler has settled, swallowed once unsubscribed.
    let settled = false;
    const emit = (evt: unknown) => { if (!settled) this.deliver(sub, Subscriptions[name].evt.parse(evt)); };
    let cleanup: Disposable | void = undefined;
    try {
      if (fn) cleanup = await (fn as unknown as (r: unknown, e: (x: unknown) => void) => unknown)(parsedReq.data, emit) as Disposable | void;
    } catch (e) {
      settled = true;
      this.subs.delete(sub); sub.active = false;
      throw toBridgeError(e);
    }
    settled = true;
    if (!sub.active) { cleanup?.dispose(); return handle; }   // unsubscribed while the handler ran
    sub.cleanup = cleanup ?? undefined;
    try {
      // ready only once drained, so a publish from inside a subscriber queues behind the held events.
      while (sub.active && sub.held.length) this.deliver(sub, sub.held.shift());
    } catch (e) {
      handle.dispose();
      throw toBridgeError(e);
    }
    if (sub.active) sub.ready = true;
    return handle;
  }
}
