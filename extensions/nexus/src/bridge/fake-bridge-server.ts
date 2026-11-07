// In-memory BridgeRouter for tests: no vscode, no postMessage. Does the client side too (call / subscribe).
// Validates like the real router will (req in, res out, evt out) so fixtures that drift from the contracts fail fast.
import { Requests, Subscriptions } from "../contracts";
import type { Req, RequestName, Res, SubEvt, SubscriptionName } from "../contracts";
import type { z } from "zod";
import { BridgeError } from "./types";
import type { BridgeRouter, Disposable, RequestHandler, SubscribeHandler } from "./types";

interface Sub { name: string; cb: (evt: unknown) => void; cleanup?: Disposable }

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
    for (const s of [...this.subs]) if (s.name === sub) s.cb(parsed);
  }

  /** Client side: send a request as a webview would. Rejects with BridgeError carrying the frozen code. */
  async call<N extends RequestName>(name: N, req: z.input<(typeof Requests)[N]["req"]>): Promise<Res<N>> {
    const fn = this.handlers.get(name);
    if (!fn) throw new BridgeError("not_found", `no handler: ${name}`);
    const parsedReq = Requests[name].req.safeParse(req);
    if (!parsedReq.success) throw new BridgeError("invalid_request", parsedReq.error.message);
    let res: unknown;
    try { res = await fn(parsedReq.data as Req<RequestName>); }
    catch (e) { throw e instanceof BridgeError ? e : new BridgeError("internal", e instanceof Error ? e.message : String(e)); }
    const parsedRes = Requests[name].res.safeParse(res);
    if (!parsedRes.success) throw new BridgeError("internal", `invalid response for ${name}: ${parsedRes.error.message}`);
    return parsedRes.data as Res<N>;
  }

  /** Client side: subscribe as a webview would. Returns an unsubscribe Disposable. */
  async subscribe<N extends SubscriptionName>(name: N, req: z.input<(typeof Subscriptions)[N]["req"]>, cb: (evt: SubEvt<N>) => void): Promise<Disposable> {
    const fn = this.subHandlers.get(name);
    const parsedReq = Subscriptions[name].req.safeParse(req);
    if (!parsedReq.success) throw new BridgeError("invalid_request", parsedReq.error.message);
    const sub: Sub = { name, cb: cb as (evt: unknown) => void };
    this.subs.add(sub);
    const emit = (evt: unknown) => sub.cb(Subscriptions[name].evt.parse(evt));
    if (fn) sub.cleanup = (await (fn as unknown as (r: unknown, e: (x: unknown) => void) => unknown)(parsedReq.data, emit)) as Disposable | undefined;
    return { dispose: () => { this.subs.delete(sub); sub.cleanup?.dispose(); } };
  }
}
