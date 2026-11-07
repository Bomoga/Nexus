// The real BridgeRouter: speaks Envelopes over a webview transport. vscode-free; host.ts adapts a Webview to
// WebviewTransport. Delivery rules for subscriptions live in subscription.ts (shared with the fake).
import { Envelope, Requests, Subscriptions } from "../contracts";
import type { ErrorCode, Req, RequestName, Res, SubEvt, SubscriptionName } from "../contracts";
import { SubscriptionSet } from "./subscription";
import type { OpenHandler } from "./subscription";
import { BridgeError } from "./types";
import type { BridgeRouter, Disposable, RequestHandler, SubscribeHandler } from "./types";

/** What the router needs from a webview. */
export interface WebviewTransport {
  /** Post one envelope to the webview. May return a promise that rejects on failure. */
  post(message: unknown): unknown;
  onMessage(cb: (message: unknown) => void): Disposable;
  onDidDispose(cb: () => void): Disposable;
}

export interface RouterOptions {
  /** Required, no default: true if the value looks like it contains a secret. A flagged body is never posted. */
  containsSecret: (value: unknown) => boolean;
  /** Where drops and internal-error detail go (never to the webview). */
  log: (message: string, detail?: unknown) => void;
}

const GENERIC_INTERNAL = "internal error";

function isRequestName(n: string): n is RequestName { return Object.hasOwn(Requests, n); }
function isSubscriptionName(n: string): n is SubscriptionName { return Object.hasOwn(Subscriptions, n); }

/** What a webview sees for a failure: handler-authored codes pass through, everything else is generic `internal`. */
function wireError(e: unknown, log: RouterOptions["log"], context: string): { code: ErrorCode; message: string } {
  if (e instanceof BridgeError && e.code !== "internal") return { code: e.code, message: e.message };
  log(`internal error in ${context}`, e);
  return { code: "internal", message: GENERIC_INTERNAL };
}

/** postMessage serializes as JSON. Round-trip first so what we validate and secret-check is exactly what the webview gets. */
function jsonSafe(value: unknown): unknown {
  const text = JSON.stringify(value);   // throws on cycles and BigInt
  if (text === undefined) throw new Error("body is not JSON-serializable");
  return JSON.parse(text);
}

export class NexusBridgeRouter implements BridgeRouter {
  private readonly handlers = new Map<string, RequestHandler<RequestName>>();
  private readonly subHandlers = new Map<string, SubscribeHandler<SubscriptionName>>();
  private readonly sessions = new Set<WebviewSession>();

  constructor(private readonly opts: RouterOptions) {}

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
    let parsed: unknown;
    try { parsed = Subscriptions[sub].evt.parse(jsonSafe(evt)); }
    catch (e) { this.opts.log(`dropped invalid event for ${sub}`, e); return; }
    for (const s of [...this.sessions]) s.subs.publish(sub, parsed);
  }

  /** Serve one webview. Disposing the result (or the webview) disposes all its subscriptions. */
  attach(transport: WebviewTransport): Disposable {
    const session = new WebviewSession(this, transport, this.opts);
    this.sessions.add(session);
    return { dispose: () => { this.sessions.delete(session); session.dispose(); } };
  }

  /** @internal used by sessions */
  lookup(): { handlers: Map<string, RequestHandler<RequestName>>; subHandlers: Map<string, SubscribeHandler<SubscriptionName>>; drop: (s: WebviewSession) => void } {
    return { handlers: this.handlers, subHandlers: this.subHandlers, drop: s => { this.sessions.delete(s); } };
  }
}

class WebviewSession {
  readonly subs = new SubscriptionSet();
  private readonly ids = new Map<string, Disposable>();
  private readonly listeners: Disposable[] = [];
  private disposed = false;

  constructor(private readonly router: NexusBridgeRouter, private readonly t: WebviewTransport, private readonly opts: RouterOptions) {
    this.listeners.push(t.onMessage(m => { void this.onMessage(m); }));
    this.listeners.push(t.onDidDispose(() => { this.router.lookup().drop(this); this.dispose(); }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subs.disposeAll();
    this.ids.clear();
    for (const l of this.listeners) l.dispose();
  }

  /** Throws if the body is not serializable or is flagged; the caller turns that into an `internal` error. */
  private checked(body: unknown): unknown {
    const safe = jsonSafe(body);
    if (this.opts.containsSecret(safe)) throw new Error("secret check flagged an outbound body");
    return safe;
  }

  private send(envelope: unknown): void {
    if (this.disposed) return;
    let result: unknown;
    try { result = this.t.post(envelope); } catch (e) { this.opts.log("post failed", e); return; }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      (result as PromiseLike<unknown>).then(undefined, (e: unknown) => this.opts.log("post failed", e));
    }
  }

  private fail(id: string, e: unknown, context: string): void {
    this.send({ t: "res", id, ok: false, error: wireError(e, this.opts.log, context) });
  }

  private async onMessage(raw: unknown): Promise<void> {
    const parsed = Envelope.safeParse(raw);
    if (!parsed.success) { this.opts.log("dropped malformed envelope"); return; }
    const m = parsed.data;
    switch (m.t) {
      case "req": return this.onRequest(m.id, m.name, m.body);
      case "sub": return this.onSub(m.id, m.name, m.body);
      case "unsub": this.ids.get(m.id)?.dispose(); this.ids.delete(m.id); return;
      default: this.opts.log(`dropped webview-sent ${m.t} envelope`);
    }
  }

  private async onRequest(id: string, name: string, body: unknown): Promise<void> {
    if (!isRequestName(name)) { this.opts.log(`dropped request with unknown name`, name); return; }
    const fn = this.router.lookup().handlers.get(name);
    if (!fn) { this.fail(id, new BridgeError("not_found", `no handler for ${name}`), name); return; }
    const req = Requests[name].req.safeParse(body);
    if (!req.success) { this.fail(id, new BridgeError("invalid_request", `invalid request body for ${name}`), name); return; }
    try {
      const res = await fn(req.data as Req<RequestName>);
      const out = Requests[name].res.parse(jsonSafe(res)) as Res<RequestName>;
      const safe = this.checked(out);
      this.send({ t: "res", id, ok: true, body: safe });
    } catch (e) { this.fail(id, e, name); }
  }

  private async onSub(id: string, name: string, body: unknown): Promise<void> {
    if (!isSubscriptionName(name)) { this.opts.log(`dropped subscribe with unknown name`, name); return; }
    if (this.ids.has(id)) { this.fail(id, new BridgeError("conflict", "duplicate subscription id"), name); return; }
    const req = Subscriptions[name].req.safeParse(body);
    if (!req.success) { this.fail(id, new BridgeError("invalid_request", `invalid subscribe body for ${name}`), name); return; }
    const handler = this.router.lookup().subHandlers.get(name) as OpenHandler | undefined;
    const post = (evt: unknown) => {
      const safe = this.checked(evt);   // throws -> subscriber failure -> subscription removed
      const result = this.t.post({ t: "evt", id, body: safe });
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        (result as PromiseLike<unknown>).then(undefined, (e: unknown) => { this.ids.get(id)?.dispose(); this.ids.delete(id); this.fail(id, e, name); });
      }
    };
    try {
      await this.subs.open(name, req.data, handler, evt => Subscriptions[name].evt.parse(jsonSafe(evt)), post, {
        onHandle: d => { this.ids.set(id, d); },
        onFail: e => { this.ids.delete(id); this.fail(id, e, name); },
      });
    } catch (e) {
      this.ids.delete(id);
      this.fail(id, e, name);
    }
  }
}
