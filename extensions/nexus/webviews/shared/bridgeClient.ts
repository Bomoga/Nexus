// The only door between a webview and the extension host (PLAN §2.9). Every response and event is
// validated with the contract's Zod schema; nothing else in webviews/** may call postMessage.
import type { z } from "zod";
import { Envelope, Requests, Subscriptions } from "../../src/contracts";
import type { RequestName, Res, SubEvt, SubscriptionName } from "../../src/contracts";

export interface Transport {
  post(env: Envelope): void;
  /** Registers a listener for extension -> webview envelopes; returns a remover. */
  listen(handler: (env: Envelope) => void): () => void;
}

export type ReqIn<N extends RequestName> = z.input<(typeof Requests)[N]["req"]>;
export type SubIn<N extends SubscriptionName> = z.input<(typeof Subscriptions)[N]["req"]>;

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export interface BridgeClient {
  request<N extends RequestName>(name: N, body: ReqIn<N>, opts?: RequestOptions): Promise<Res<N>>;
  subscribe<N extends SubscriptionName>(name: N, body: SubIn<N>, cb: (evt: SubEvt<N>) => void): () => void;
  /** Removes the transport listener, rejects nothing, and clears pending timers. */
  dispose(): void;
}

export interface RequestOptions {
  /** Milliseconds to wait for a reply. Default 30000. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export function createBridgeClient(transport: Transport): BridgeClient {
  let seq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; schema: z.ZodType; timer: ReturnType<typeof setTimeout> }>();
  const subs = new Map<string, { schema: z.ZodType; cb: (evt: never) => void }>();

  const stopListening = transport.listen((raw) => {
    const parsed = Envelope.safeParse(raw);
    if (!parsed.success) return;
    const env = parsed.data;
    if (env.t === "res") {
      const p = pending.get(env.id);
      if (!p) return;
      pending.delete(env.id);
      clearTimeout(p.timer);
      if (!env.ok) {
        p.reject(new BridgeError(env.error.code, env.error.message));
        return;
      }
      const body = p.schema.safeParse(env.body);
      if (body.success) p.resolve(body.data);
      else p.reject(new BridgeError("invalid_response", body.error.message));
    } else if (env.t === "evt") {
      const s = subs.get(env.id);
      if (!s) return;
      const body = s.schema.safeParse(env.body);
      if (!body.success) return;
      try {
        s.cb(body.data as never);
      } catch (err) {
        console.error("bridgeClient: subscriber callback threw", err);
      }
    }
  });

  return {
    request<N extends RequestName>(name: N, body: ReqIn<N>, opts: RequestOptions = {}): Promise<Res<N>> {
      const def = Requests[name];
      const parsedBody = def.req.safeParse(body);
      if (!parsedBody.success) {
        return Promise.reject(new BridgeError("invalid_request", parsedBody.error.message));
      }
      const id = `r${++seq}`;
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return new Promise<unknown>((resolve, reject) => {
        // The contract's ErrorCode has no "timeout"; "offline" (host unreachable) is the closest code.
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new BridgeError("offline", `${name} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, schema: def.res, timer });
        transport.post({ t: "req", id, name, body: parsedBody.data });
      }) as Promise<Res<N>>;
    },
    subscribe<N extends SubscriptionName>(name: N, body: SubIn<N>, cb: (evt: SubEvt<N>) => void): () => void {
      const def = Subscriptions[name];
      const parsedBody = def.req.safeParse(body);
      if (!parsedBody.success) {
        throw new BridgeError("invalid_request", parsedBody.error.message);
      }
      const id = `s${++seq}`;
      subs.set(id, { schema: def.evt, cb: cb as (evt: never) => void });
      transport.post({ t: "sub", id, name, body: parsedBody.data });
      return () => {
        if (!subs.delete(id)) return;
        transport.post({ t: "unsub", id });
      };
    },
    dispose() {
      stopListening();
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      subs.clear();
    },
  };
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

function createVsCodeTransport(): Transport {
  const api = acquireVsCodeApi();
  return {
    post: (env) => api.postMessage(env),
    listen(handler) {
      const fn = (e: MessageEvent) => handler(e.data as Envelope);
      window.addEventListener("message", fn);
      return () => window.removeEventListener("message", fn);
    },
  };
}

/** True when the page was opened with ?fake=1 (vite dev server in a browser). */
export function isFakeMode(): boolean {
  return typeof location !== "undefined" && new URLSearchParams(location.search).get("fake") === "1";
}

/** Loads the fake host on demand so normal builds do not ship demo fixtures (the import is split into its own chunk). */
function createLazyFakeTransport(): Transport {
  const listeners = new Set<(env: Envelope) => void>();
  const queue: Envelope[] = [];
  let inner: Transport | undefined;
  void import("./fakeBridge").then((m) => {
    inner = m.createFakeTransport();
    inner.listen((env) => listeners.forEach((l) => l(env)));
    queue.splice(0).forEach((env) => inner!.post(env));
  });
  return {
    post: (env) => (inner ? inner.post(env) : void queue.push(env)),
    listen(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}

let shared: BridgeClient | undefined;

/** The page's bridge: fake in ?fake=1, the VS Code webview API otherwise. */
export function getBridge(): BridgeClient {
  shared ??= createBridgeClient(isFakeMode() ? createLazyFakeTransport() : createVsCodeTransport());
  return shared;
}

export function request<N extends RequestName>(name: N, body: ReqIn<N>, opts?: RequestOptions): Promise<Res<N>> {
  return getBridge().request(name, body, opts);
}

export function subscribe<N extends SubscriptionName>(name: N, body: SubIn<N>, cb: (evt: SubEvt<N>) => void): () => void {
  return getBridge().subscribe(name, body, cb);
}
