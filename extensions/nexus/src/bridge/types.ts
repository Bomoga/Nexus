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

/** Extension-side surface. Lanes 1 and 2 register handlers and publish events through this. */
export interface BridgeRouter {
  /** Register the single handler for a request name. Registering twice throws. */
  handle<N extends RequestName>(name: N, fn: RequestHandler<N>): Disposable;
  /** Register the handler invoked on each new subscription of this name (e.g. replay from fromSeq, then live). */
  onSubscribe<N extends SubscriptionName>(name: N, fn: SubscribeHandler<N>): Disposable;
  /** Broadcast an event to every live subscription of this name. The router validates it against Subscriptions[name].evt. */
  publish<N extends SubscriptionName>(sub: N, evt: SubEvt<N>): void;
}
