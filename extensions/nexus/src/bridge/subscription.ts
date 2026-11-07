// The one subscription engine behind both the real router (per webview) and the fake. Implements the delivery
// rules documented on BridgeRouter in types.ts: scoping, replay-then-held-then-live ordering, seq dedupe, cleanup.
// vscode-free and node-free.
import type { SubscriptionName } from "../contracts";
import { BridgeError, matchesSubscription } from "./types";
import type { Disposable } from "./types";

export function toBridgeError(e: unknown): BridgeError {
  return e instanceof BridgeError ? e : new BridgeError("internal", e instanceof Error ? e.message : String(e));
}

interface Sub {
  name: SubscriptionName; req: unknown; cb: (evt: unknown) => void; onFail?: (e: BridgeError) => void;
  active: boolean; ready: boolean; held: unknown[]; maxSeq: number; cleanup?: Disposable;
}

function firstSeq(name: SubscriptionName, req: unknown): number {
  return name === "agent.subscribe" ? (req as { fromSeq?: number }).fromSeq ?? 0 : 0;
}

export type OpenHandler = (req: unknown, emit: (evt: unknown) => void) => unknown;

export class SubscriptionSet {
  private readonly subs = new Set<Sub>();

  get size(): number { return this.subs.size; }

  /** Deliver an already-validated event to matching subscriptions (held while a subscription is still opening). */
  publish(name: SubscriptionName, evt: unknown): void {
    for (const s of [...this.subs]) {
      if (s.name !== name || !matchesSubscription(name, s.req, evt)) continue;
      if (!s.ready) { s.held.push(evt); continue; }
      try { this.deliver(s, evt); }
      catch (e) { this.remove(s); s.onFail?.(toBridgeError(e)); }   // a failing subscriber is removed
    }
  }

  /**
   * Open a subscription. `parse` validates replayed events. `cb` receives validated events; it may throw.
   * Resolves with the unsubscribe Disposable after the handler settled and held events drained.
   * Rejects with a BridgeError (subscription already removed) if the handler or a subscriber throws.
   * `onHandle` gets the Disposable synchronously, before the handler runs.
   */
  async open(name: SubscriptionName, req: unknown, handler: OpenHandler | undefined, parse: (evt: unknown) => unknown,
             cb: (evt: unknown) => void, opts: { onHandle?: (d: Disposable) => void; onFail?: (e: BridgeError) => void } = {}): Promise<Disposable> {
    const sub: Sub = { name, req, cb, onFail: opts.onFail, active: true, ready: false, held: [], maxSeq: firstSeq(name, req) - 1 };
    const handle: Disposable = { dispose: () => this.remove(sub) };
    this.subs.add(sub);
    opts.onHandle?.(handle);
    // emit = replay only: inert once the handler has settled, swallowed once unsubscribed.
    let settled = false;
    const emit = (evt: unknown) => { if (!settled) this.deliver(sub, parse(evt)); };
    let cleanup: Disposable | void = undefined;
    try {
      if (handler) cleanup = await handler(req, emit) as Disposable | void;
    } catch (e) {
      settled = true;
      this.remove(sub);
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

  disposeAll(): void { for (const s of [...this.subs]) this.remove(s); }

  private remove(s: Sub): void {
    s.active = false; this.subs.delete(s);
    const c = s.cleanup; s.cleanup = undefined;
    try { c?.dispose(); } catch { /* cleanup failure must not break teardown */ }
  }

  private deliver(s: Sub, evt: unknown): void {
    if (!s.active) return;
    const seq = (evt as { seq?: unknown }).seq;
    if (s.name === "agent.subscribe" && typeof seq === "number") {
      if (seq <= s.maxSeq) return;   // below fromSeq, or already delivered
      s.maxSeq = seq;
    }
    s.cb(evt);
  }
}
