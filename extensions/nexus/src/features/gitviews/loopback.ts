// An in-process bridge client: attaches to the shared NexusBridgeRouter the way a webview does, so extension-host
// code (commands) can call the handlers Lanes 1 and 2 serve (git.commit.show, sessions.list, ...) with the same
// validation and error mapping. vscode-free.
import { Envelope, Requests } from "../../contracts";
import type { Req, RequestName, Res } from "../../contracts";
import type { WebviewTransport } from "../../bridge/router";
import type { Disposable } from "../../bridge/types";

export class LoopbackError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LoopbackError"; }
}

export interface LoopbackClient extends Disposable {
  request<N extends RequestName>(name: N, body: Req<N>, options?: RequestOptions): Promise<Res<N>>;
}

export interface LoopbackOptions { timeoutMs?: number }
export interface RequestOptions { timeoutMs?: number }

interface Pending { resolve(v: unknown): void; reject(e: Error): void; name: RequestName; timer: ReturnType<typeof setTimeout> }

export function createLoopbackClient(router: { attach(t: WebviewTransport): Disposable }, opts: LoopbackOptions = {}): LoopbackClient {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pending = new Map<string, Pending>();
  let toRouter: (m: unknown) => void = () => {};
  let disposed = false;
  let next = 0;

  const settle = (id: string): Pending | undefined => {
    const p = pending.get(id);
    if (p) { pending.delete(id); clearTimeout(p.timer); }
    return p;
  };

  const transport: WebviewTransport = {
    post(message) {
      const parsed = Envelope.safeParse(message);
      if (!parsed.success || parsed.data.t !== "res") return true;   // events and anything else: not ours
      const m = parsed.data;
      const p = settle(m.id);
      if (!p) return true;
      if (!m.ok) { p.reject(new LoopbackError(m.error.code, m.error.message)); return true; }
      const body = Requests[p.name].res.safeParse(m.body);
      if (!body.success) p.reject(new LoopbackError("internal", `invalid response body for ${p.name}`));
      else p.resolve(body.data);
      return true;
    },
    onMessage(cb) { toRouter = cb; return { dispose() { toRouter = () => {}; } }; },
    onDidDispose() { return { dispose() {} }; },
  };
  const attached = router.attach(transport);

  return {
    request<N extends RequestName>(name: N, body: Req<N>, options?: RequestOptions): Promise<Res<N>> {
      const limit = options?.timeoutMs ?? timeoutMs;
      if (disposed) return Promise.reject(new LoopbackError("cancelled", "loopback client disposed"));
      next += 1;
      const id = `lb-${next}`;
      return new Promise<Res<N>>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (settle(id)) reject(new LoopbackError("timeout", `request ${name} timed out after ${limit} ms`));
        }, limit);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, name, timer });
        toRouter({ t: "req", id, name, body });
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...pending.keys()]) settle(id)?.reject(new LoopbackError("cancelled", "loopback client disposed"));
      attached.dispose();
    },
  };
}
