import { createServer } from "node:http";

// A one-shot loopback listener for the Auth0 sign-in redirect. Chrome (and other browsers) can silently refuse to hand a
// custom-scheme redirect (nexus://) to the OS, which leaves sign-in stuck on Auth0's consent page. An http://127.0.0.1
// redirect needs no protocol handler. The listener binds to the loopback interface only, answers only GET /callback for
// the exact host it was started on, hands the query string to the sign-in logic (which checks the PKCE state), and is
// closed as soon as the sign-in finishes, fails or times out. It never echoes anything it received.

export const LOOPBACK_HOST = "127.0.0.1";
export const LOOPBACK_PORT = 51789;                 // fixed: Auth0's Allowed Callback URLs must list the exact URL
export const LOOPBACK_PATH = "/callback";

export interface LoopbackHandle {
  redirectUri: string;
  close(): void;
}

export interface LoopbackListener {
  /** Starts listening. `onCallback` gets the query string (with its leading "?") of a plausible callback request. Rejects if the port is unavailable. */
  start(onCallback: (search: string) => void): Promise<LoopbackHandle>;
}

const PAGE = "<!doctype html><meta charset=\"utf-8\"><title>Nexus</title><body style=\"font:14px system-ui;padding:2em\">Return to Nexus. You can close this tab.</body>";

export function createLoopbackListener(opts: { port?: number } = {}): LoopbackListener {
  return {
    start: onCallback => new Promise<LoopbackHandle>((resolve, reject) => {
      let hostHeader = "";
      const server = createServer((req, res) => {
        const send = (status: number, body: string) => {
          res.writeHead(status, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
            "x-content-type-options": "nosniff",
            connection: "close",
          });
          res.end(body);
        };
        // A page on the web can make the browser send a request to 127.0.0.1 (and DNS rebinding can fake the name), so
        // only the exact Host this listener was started on is accepted.
        if (req.headers.host !== hostHeader || req.method !== "GET") { send(400, ""); return; }
        let u: URL;
        try { u = new URL(req.url ?? "/", `http://${hostHeader}`); } catch { send(400, ""); return; }
        if (u.pathname !== LOOPBACK_PATH) { send(404, ""); return; }
        // Only a request that looks like Auth0's answer counts; anything else (a favicon fetch, a stray probe) is ignored.
        if (!u.searchParams.has("code") && !u.searchParams.has("error")) { send(400, ""); return; }
        send(200, PAGE);
        onCallback(u.search);
      });
      server.once("error", reject);
      server.listen(opts.port ?? LOOPBACK_PORT, LOOPBACK_HOST, () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") { server.close(); reject(new Error("The loopback listener has no address.")); return; }
        hostHeader = `${LOOPBACK_HOST}:${addr.port}`;
        server.removeListener("error", reject);
        server.on("error", () => undefined);
        resolve({
          redirectUri: `http://${hostHeader}${LOOPBACK_PATH}`,
          close: () => { server.close(); server.closeAllConnections?.(); },
        });
      });
    }),
  };
}
