import type { RequestName, SubscriptionName } from "../contracts";
import { BridgeError, type BridgeRouter, type Disposable, type RequestHandler, type SubscribeHandler } from "../bridge/types";
import { ApprovalConflict } from "./approvals/approvals-controller";
import type { Lane1 } from "./compose";

/** Maps what Lane 1's controllers throw to the frozen error codes; anything else is left for the router to call "internal". */
export function toBridgeError(e: unknown): unknown {
  if (e instanceof ApprovalConflict) return new BridgeError("conflict", e.message);
  return e;
}

/**
 * Registers every handler and subscription Lane 1 serves on the router. Returns one Disposable that removes them all
 * and stops the live feeds.
 */
export function wireLane1ToRouter(lane: Lane1, router: BridgeRouter): Disposable {
  const parts: Disposable[] = [];

  for (const [name, fn] of Object.entries(lane.handlers)) {
    const handler = (async (req: never) => {
      try { return await (fn as (r: never) => unknown)(req); } catch (e) { throw toBridgeError(e); }
    }) as unknown as RequestHandler<RequestName>;
    parts.push(router.handle(name as RequestName, handler));
  }

  // Replay then live. The router holds live events published while a replay is running and drops duplicate seqs, so the
  // handler only emits what is stored and the feeds publish each new event exactly once.
  const replays = lane.replays as unknown as Partial<Record<SubscriptionName, (req: never, emit: (e: never) => void) => Promise<void>>>;
  for (const [name, feed] of Object.entries(lane.live)) {
    const replay = replays[name as SubscriptionName];
    const handler = (async (req: never, emit: (e: never) => void) => { await replay?.(req, emit); }) as unknown as SubscribeHandler<SubscriptionName>;
    parts.push(router.onSubscribe(name as SubscriptionName, handler));
    const stop = (feed as (publish: (e: never) => void) => () => void)(evt => router.publish(name as SubscriptionName, evt as never));
    parts.push({ dispose: stop });
  }

  return { dispose: () => { for (const p of parts.reverse()) p.dispose(); } };
}
