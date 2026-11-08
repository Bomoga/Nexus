import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackListener, LOOPBACK_PATH, type LoopbackHandle } from "./loopback";

const open: LoopbackHandle[] = [];
afterEach(() => { for (const h of open.splice(0)) h.close(); });

async function start(onCallback: (s: string) => void = () => undefined, port = 0) {
  const h = await createLoopbackListener({ port }).start(onCallback);
  open.push(h);
  return h;
}

function get(h: LoopbackHandle, path: string, opts: { method?: string; host?: string } = {}): Promise<{ status: number; body: string }> {
  const u = new URL(h.redirectUri);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method: opts.method ?? "GET", headers: { host: opts.host ?? u.host } }, res => {
      let body = "";
      res.on("data", d => { body += String(d); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the loopback listener", () => {
  it("listens on 127.0.0.1 only and hands a callback's query string to the sign-in logic", async () => {
    const seen = vi.fn();
    const h = await start(seen);
    const u = new URL(h.redirectUri);
    expect(u.hostname).toBe("127.0.0.1");
    expect(u.pathname).toBe(LOOPBACK_PATH);
    const r = await get(h, `${LOOPBACK_PATH}?code=abc&state=xyz`);
    expect(r.status).toBe(200);
    expect(seen).toHaveBeenCalledWith("?code=abc&state=xyz");
  });

  it("never echoes what it received into the page", async () => {
    const h = await start();
    const r = await get(h, `${LOOPBACK_PATH}?code=SECRET-CODE&state=SECRET-STATE`);
    expect(r.body).not.toContain("SECRET");
  });

  it("passes on an error answer too, so a refusal reaches the sign-in", async () => {
    const seen = vi.fn();
    const h = await start(seen);
    expect((await get(h, `${LOOPBACK_PATH}?error=access_denied&state=s`)).status).toBe(200);
    expect(seen).toHaveBeenCalledWith("?error=access_denied&state=s");
  });

  it("ignores requests that are not an Auth0 answer: no code or error, another path, another method", async () => {
    const seen = vi.fn();
    const h = await start(seen);
    expect((await get(h, LOOPBACK_PATH)).status).toBe(400);
    expect((await get(h, `${LOOPBACK_PATH}?state=only`)).status).toBe(400);
    expect((await get(h, "/favicon.ico")).status).toBe(404);
    expect((await get(h, `/other?code=c&state=s`)).status).toBe(404);
    expect((await get(h, `${LOOPBACK_PATH}?code=c&state=s`, { method: "POST" })).status).toBe(400);
    expect(seen).not.toHaveBeenCalled();
  });

  it("refuses a request whose Host is not the listener's own address (DNS rebinding)", async () => {
    const seen = vi.fn();
    const h = await start(seen);
    expect((await get(h, `${LOOPBACK_PATH}?code=c&state=s`, { host: "evil.example" })).status).toBe(400);
    expect(seen).not.toHaveBeenCalled();
  });

  it("stops listening when closed", async () => {
    const h = await start();
    h.close();
    await expect(get(h, `${LOOPBACK_PATH}?code=c&state=s`)).rejects.toThrow();
  });

  it("rejects when the port is already taken, so sign-in can fall back", async () => {
    const first = await start();
    const port = Number(new URL(first.redirectUri).port);
    await expect(createLoopbackListener({ port }).start(() => undefined)).rejects.toThrow();
  });
});
