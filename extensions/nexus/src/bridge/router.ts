// The real BridgeRouter: speaks Envelopes over a webview transport. vscode-free; host.ts adapts a Webview to
// WebviewTransport. Delivery rules for subscriptions live in subscription.ts (shared with the fake).
import { Envelope, ErrorCode, Requests, Subscriptions } from "../contracts";
import type { Req, RequestName, Res, SubEvt, SubscriptionName } from "../contracts";
import { SubscriptionSet } from "./subscription";
import type { OpenHandler } from "./subscription";
import { BridgeError } from "./types";
import type { BridgeRouter, Disposable, RequestHandler, SubscribeHandler } from "./types";

/** What the router needs from a webview. */
export interface WebviewTransport {
  /** Post one envelope to the webview. May return a promise; `false` or a rejection counts as a failed post. */
  post(message: unknown): unknown;
  onMessage(cb: (message: unknown) => void): Disposable;
  /** The webview is gone for good. */
  onDidDispose(cb: () => void): Disposable;
  /**
   * Visibility changes, for webviews whose page dies when hidden (retainContextWhenHidden off): the router drops all of
   * that webview's subscriptions when it becomes hidden, and the reloaded page subscribes again. Omit it for a retained
   * webview, whose page and subscriptions outlive a hide.
   */
  onDidChangeVisibility?(cb: (visible: boolean) => void): Disposable;
}

export interface RouterOptions {
  /** Required, no default: true if the value looks like it contains a secret. A flagged body or error is never posted. A throwing check counts as flagged. */
  containsSecret: (value: unknown) => boolean;
  /**
   * Where drops and internal-error detail go (never to the webview). The sink receives only context strings, request and
   * subscription names, and a plain summary of an error: name, message, stack, code and up to 5 causes, all of which
   * passed `containsSecret`. If any of that is flagged it receives `{ redacted: true }`. It never receives a raw Error
   * (extra fields such as headers stay out) or a request, response or event body. A throwing sink is swallowed.
   */
  log: (message: string, detail?: unknown) => void;
  limits?: { maxIdLength?: number; maxSubscriptionsPerWebview?: number; maxHeldEvents?: number };
}

const GENERIC_INTERNAL = "internal error";
const DEFAULT_LIMITS = { maxIdLength: 128, maxSubscriptionsPerWebview: 256, maxHeldEvents: 10_000 };

function isRequestName(n: string): n is RequestName { return Object.hasOwn(Requests, n); }
function isSubscriptionName(n: string): n is SubscriptionName { return Object.hasOwn(Subscriptions, n); }

/** The plain summary the secret check sees and the log sink receives, so the two cannot differ. Strings pass; other values reduce to their type. */
function logView(e: unknown, depth = 0): unknown {
  if (typeof e === "string") return e;
  if (!(e instanceof Error)) return e === undefined ? undefined : { type: typeof e };
  const code = (e as { code?: unknown }).code;
  return {
    name: e.name, message: e.message, stack: e.stack,
    code: typeof code === "string" || typeof code === "number" ? code : undefined,
    cause: depth < 5 && e.cause !== undefined ? logView(e.cause, depth + 1) : undefined,
  };
}

/** postMessage serializes as JSON. Round-trip first so what we validate and secret-check is exactly what the webview gets. */
function jsonSafe(value: unknown): unknown {
  const text = JSON.stringify(value);   // throws on cycles and BigInt
  if (text === undefined) throw new Error("body is not JSON-serializable");
  return JSON.parse(text);
}

interface Handle extends Disposable { cancelled: boolean }
type Limits = Required<NonNullable<RouterOptions["limits"]>>;

class Guard {
  constructor(private readonly opts: RouterOptions) {}

  flagged(value: unknown): boolean {
    try { return this.opts.containsSecret(value); } catch { return true; }   // fail closed
  }

  log(message: string, detail?: unknown): void {
    let out: unknown;
    try { out = logView(detail); } catch { out = { redacted: true }; }   // a throwing getter on a hostile error
    if (out !== undefined && this.flagged(out)) out = { redacted: true };
    try { this.opts.log(message, out); } catch { /* a broken sink must never escape */ }
  }

  /** What a webview sees for a failure: handler-authored valid codes pass through unless flagged; everything else is generic `internal`. */
  wireError(e: unknown, context: string): { code: ErrorCode; message: string } {
    const generic = { code: "internal" as ErrorCode, message: GENERIC_INTERNAL };
    if (e instanceof BridgeError && e.code !== "internal") {
      if (!ErrorCode.safeParse(e.code).success) { this.log(`invalid error code in ${context}`, e); return generic; }
      const wire = { code: e.code, message: e.message };
      if (!this.flagged(wire)) return wire;
      this.log(`flagged error message suppressed in ${context}`, e);
      return generic;
    }
    this.log(`internal error in ${context}`, e);
    return generic;
  }
}

export class NexusBridgeRouter implements BridgeRouter {
  private readonly handlers = new Map<string, RequestHandler<RequestName>>();
  private readonly subHandlers = new Map<string, SubscribeHandler<SubscriptionName>>();
  private readonly sessions = new Set<WebviewSession>();
  private readonly guard: Guard;
  private readonly limits: Limits;

  constructor(opts: RouterOptions) {
    this.guard = new Guard(opts);
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
  }

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
    catch (e) { this.guard.log(`dropped invalid event for ${sub}`, e); return; }
    for (const s of [...this.sessions]) s.subs.publish(sub, parsed);
  }

  /** Webviews currently attached. */
  sessionCount(): number { return this.sessions.size; }

  /** Serve one webview. Disposing the result (or the webview) disposes all its subscriptions. */
  attach(transport: WebviewTransport): Disposable {
    const session = new WebviewSession(this.handlers, this.subHandlers, transport, this.guard, this.limits, s => { this.sessions.delete(s); });
    this.sessions.add(session);
    return { dispose: () => session.dispose() };
  }
}

class WebviewSession {
  readonly subs: SubscriptionSet;
  private readonly ids = new Map<string, Handle>();
  private readonly listeners: Disposable[] = [];
  private epoch = 0;
  private disposed = false;

  constructor(
    private readonly handlers: Map<string, RequestHandler<RequestName>>,
    private readonly subHandlers: Map<string, SubscribeHandler<SubscriptionName>>,
    private readonly t: WebviewTransport, private readonly guard: Guard, private readonly limits: Limits,
    private readonly onGone: (s: WebviewSession) => void,
  ) {
    this.subs = new SubscriptionSet(limits.maxHeldEvents);
    this.listeners.push(t.onMessage(m => { void this.onMessage(m); }));
    this.listeners.push(t.onDidDispose(() => { this.dispose(); }));
    if (t.onDidChangeVisibility) this.listeners.push(t.onDidChangeVisibility(visible => { if (!visible) this.reset(); }));
  }

  /** Forget everything the (now gone) page had: subscriptions with their cleanups, ids, and in-flight work. */
  private reset(): void {
    this.epoch++;
    for (const h of [...this.ids.values()]) h.dispose();
    this.subs.disposeAll();
    this.ids.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    this.onGone(this);
    for (const l of this.listeners) l.dispose();
  }

  /** Throws if the body is not serializable or is flagged; the caller turns that into an `internal` error. */
  private checked(body: unknown): unknown {
    const safe = jsonSafe(body);
    if (this.guard.flagged(safe)) throw new Error("secret check flagged an outbound body");
    return safe;
  }

  /** Post and watch the outcome: a throw, a rejection, or `false` is a failed post. Returns the failure handler hook. */
  private post(envelope: unknown, onFail?: (e: unknown) => void): void {
    if (this.disposed) return;
    const failed = (e: unknown) => { this.guard.log("post failed", e); onFail?.(e); };
    let result: unknown;
    try { result = this.t.post(envelope); } catch (e) { failed(e); return; }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      (result as PromiseLike<unknown>).then(ok => { if (ok === false) failed(new Error("postMessage returned false")); }, failed);
    } else if (result === false) failed(new Error("postMessage returned false"));
  }

  private fail(id: string, e: unknown, context: string): void {
    this.post({ t: "res", id, ok: false, error: this.guard.wireError(e, context) });
  }

  private async onMessage(raw: unknown): Promise<void> {
    const parsed = Envelope.safeParse(raw);
    if (!parsed.success) { this.guard.log("dropped malformed envelope"); return; }
    const m = parsed.data;
    switch (m.t) {
      case "req": return this.onRequest(m.id, m.name, m.body);
      case "sub": return this.onSub(m.id, m.name, m.body);
      case "unsub": { const h = this.ids.get(m.id); this.ids.delete(m.id); h?.dispose(); return; }
      default: this.guard.log(`dropped webview-sent ${m.t} envelope`);
    }
  }

  private async onRequest(id: string, name: string, body: unknown): Promise<void> {
    if (!isRequestName(name)) { this.guard.log("dropped request with unknown name", name.slice(0, 100)); return; }
    if (id.length > this.limits.maxIdLength) { this.fail(id.slice(0, this.limits.maxIdLength), new BridgeError("invalid_request", "id too long"), name); return; }
    const fn = this.handlers.get(name);
    if (!fn) { this.fail(id, new BridgeError("not_found", `no handler for ${name}`), name); return; }
    const req = Requests[name].req.safeParse(body);
    if (!req.success) { this.fail(id, new BridgeError("invalid_request", `invalid request body for ${name}`), name); return; }
    const epoch = this.epoch;
    try {
      const res = await fn(req.data as Req<RequestName>);
      const out = Requests[name].res.parse(jsonSafe(res)) as Res<RequestName>;
      const safe = this.checked(out);
      if (epoch !== this.epoch) return;   // the page that asked is gone
      this.post({ t: "res", id, ok: true, body: safe });
    } catch (e) { if (epoch === this.epoch) this.fail(id, e, name); }
  }

  private async onSub(id: string, name: string, body: unknown): Promise<void> {
    if (!isSubscriptionName(name)) { this.guard.log("dropped subscribe with unknown name", name.slice(0, 100)); return; }
    if (id.length > this.limits.maxIdLength) { this.fail(id.slice(0, this.limits.maxIdLength), new BridgeError("invalid_request", "id too long"), name); return; }
    const req = Subscriptions[name].req.safeParse(body);
    if (!req.success) { this.fail(id, new BridgeError("invalid_request", `invalid subscribe body for ${name}`), name); return; }
    // A reused id means the page reloaded without reporting hidden (a moved panel): the new open replaces the old one.
    const previous = this.ids.get(id);
    if (previous) { this.ids.delete(id); previous.dispose(); }
    if (this.ids.size >= this.limits.maxSubscriptionsPerWebview) { this.fail(id, new BridgeError("invalid_request", "too many subscriptions"), name); return; }
    const handler = this.subHandlers.get(name) as OpenHandler | undefined;
    const epoch = this.epoch;
    let mine: Handle | undefined;
    // A failure deletes the id only if it is still this open's, and is reported at most once, never for an abandoned open.
    const settleFail = (e: unknown) => {
      if (mine && this.ids.get(id) === mine) this.ids.delete(id);
      if (mine?.cancelled || epoch !== this.epoch) return;
      if (mine) mine.cancelled = true;
      this.fail(id, e, name);
    };
    const send = (evt: unknown) => {
      const safe = this.checked(evt);   // throws -> subscriber failure -> subscription removed
      this.post({ t: "evt", id, body: safe }, e => { settleFail(e); mine?.dispose(); });
    };
    try {
      await this.subs.open(name, req.data, handler, evt => Subscriptions[name].evt.parse(jsonSafe(evt)), send, {
        onHandle: d => {
          const h: Handle = { cancelled: false, dispose() { h.cancelled = true; d.dispose(); } };
          mine = h; this.ids.set(id, h);
        },
        onFail: settleFail,
      });
    } catch (e) { settleFail(e); }
  }
}
