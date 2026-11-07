// Bridge interface shared by the real router (router.ts) and the in-memory fake (fake-bridge-server.ts).
// vscode-free and node-free on purpose. Types are inferred from the frozen Requests / Subscriptions maps.
import type { ErrorCode, Req, RequestName, Res, SubEvt, SubscriptionName, Subscriptions } from "../contracts";
import type { z } from "zod";

/** Disposable-shaped, so vscode.Disposable satisfies it structurally. */
export interface Disposable { dispose(): void }

/** Thrown by a handler to return a frozen error code to the webview. Anything else maps to "internal". */
export class BridgeError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); this.name = "BridgeError"; }
}

export type RequestHandler<N extends RequestName> = (req: Req<N>) => Res<N> | Promise<Res<N>>;

/** Called when a webview subscribes. Returns an optional cleanup that runs on unsub or webview disposal. */
export type SubscribeHandler<N extends SubscriptionName> =
  (req: z.infer<(typeof Subscriptions)[N]["req"]>, emit: (evt: SubEvt<N>) => void) => Disposable | void | Promise<Disposable | void>;

/**
 * Extension-side surface. Lanes 1 and 2 register handlers and publish events through this.
 *
 * Subscription delivery rules (the real router and the fake both follow them):
 * - `emit` (passed to onSubscribe) is for REPLAY only, inside the handler. Once the handler settles it delivers nothing.
 *   Live events go only through publish.
 * - The router owns ordering: live events published while onSubscribe is unresolved are held for that subscription, in
 *   order, and drained after the handler resolves. Events published during the drain queue behind the held ones.
 * - agent.subscribe delivers each seq at most once and in rising order: a seq below fromSeq, or at or below the highest
 *   already delivered, is dropped on every path (replay, held, live).
 * - After unsubscribe, emit delivers nothing, and a cleanup returned late is disposed immediately.
 * - If a subscriber throws while held events drain, the subscription is removed and its cleanup disposed.
 * - A throwing handler removes the subscription; the error maps like a request error (BridgeError code kept, else "internal").
 * - publish reaches only subscriptions whose req matches the event (see matchesSubscription).
 */
export interface BridgeRouter {
  /** Register the single handler for a request name. Registering twice throws. */
  handle<N extends RequestName>(name: N, fn: RequestHandler<N>): Disposable;
  /** Register the handler invoked on each new subscription of this name (e.g. replay from fromSeq, then live). */
  onSubscribe<N extends SubscriptionName>(name: N, fn: SubscribeHandler<N>): Disposable;
  /** Deliver an event to matching live subscriptions of this name. The router validates it against Subscriptions[name].evt. */
  publish<N extends SubscriptionName>(sub: N, evt: SubEvt<N>): void;
}

/**
 * Does a subscription made with `req` receive `evt`? The one shared scoping rule.
 * - An optional scope field left unset means all.
 * - slack.subscribe: `status` events always pass; messages pass only if channelId is in channelIds (empty array = no messages).
 * - agent.subscribe by sessionId; receipts.subscribe by sessionId (a receipt with no sessionId matches only unscoped subs);
 *   swarms.review.subscribe by approvalId. Every other subscription is unscoped.
 */
export function matchesSubscription<N extends SubscriptionName>(name: N, req: unknown, evt: unknown): boolean {
  const r = (req ?? {}) as Record<string, unknown>;
  const e = (evt ?? {}) as Record<string, unknown>;
  switch (name) {
    case "slack.subscribe": {
      if (e.type === "status") return true;
      const message = e.message as { channelId?: string } | undefined;
      return (r.channelIds as string[]).includes(message?.channelId ?? "");
    }
    case "agent.subscribe": return r.sessionId === e.sessionId;
    case "receipts.subscribe": return r.sessionId === undefined || r.sessionId === e.sessionId;
    case "swarms.review.subscribe": return r.approvalId === undefined || r.approvalId === e.approvalId;
    default: return true;
  }
}
