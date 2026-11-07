import { describe, expect, it } from "vitest";
import { fromUri, normalizeNexusUri, UriRouter } from "./uri-handler";

describe("UriRouter", () => {
  it("routes the frozen spelling and the extension-id spelling to the same handler, with the same uri", async () => {
    const r = new UriRouter();
    const seen: string[] = [];
    r.registerRoute("auth", u => { seen.push(u); return true; });
    expect(await r.handle("nexus://auth/callback?code=1&state=2")).toBe(true);
    expect(await r.handle("nexus://nexus.nexus/auth/callback?code=1&state=2")).toBe(true);
    expect(seen).toEqual(["nexus://auth/callback?code=1&state=2", "nexus://auth/callback?code=1&state=2"]);
  });

  it("ignores unknown routes, other schemes, malformed and oversized uris", async () => {
    const r = new UriRouter();
    let calls = 0;
    r.registerRoute("auth", () => { calls++; });
    for (const u of ["nexus://other/x", "https://auth/callback", "nexus://", "nexus:///auth", "nexus://AUTH/x", "", `nexus://auth/${"a".repeat(5000)}`, "nexus://authx/y"]) {
      expect(await r.handle(u)).toBe(false);
    }
    expect(calls).toBe(0);
  });

  it("matches only the whole first segment and hands no prototype keys through", async () => {
    const r = new UriRouter();
    r.registerRoute("session", () => true);
    expect(await r.handle("nexus://session")).toBe(true);
    expect(await r.handle("nexus://session/s1")).toBe(true);
    expect(await r.handle("nexus://session?x=1")).toBe(true);
    expect(await r.handle("nexus://sessions/s1")).toBe(false);
    expect(await r.handle("nexus://constructor/x")).toBe(false);
  });

  it("reports a handler's false, rejection or throw as not handled, and awaits async handlers", async () => {
    const r = new UriRouter();
    r.registerRoute("auth", async () => false);
    r.registerRoute("session", () => { throw new Error("boom"); });
    r.registerRoute("approval", async () => { throw new Error("boom"); });
    r.registerRoute("coderef", async () => undefined);
    expect(await r.handle("nexus://auth/x")).toBe(false);
    expect(await r.handle("nexus://session/x")).toBe(false);
    expect(await r.handle("nexus://approval/x")).toBe(false);
    expect(await r.handle("nexus://coderef/x")).toBe(true);
  });

  it("refuses duplicate or invalid prefixes, and frees a route on dispose", async () => {
    const r = new UriRouter();
    const d = r.registerRoute("auth", () => true);
    expect(() => r.registerRoute("auth", () => true)).toThrow("already");
    expect(() => r.registerRoute("a/b", () => true)).toThrow("invalid");
    d.dispose();
    expect(await r.handle("nexus://auth/x")).toBe(false);
    r.registerRoute("auth", () => true);
  });

  it("routes a decoded vscode.Uri so the auth query survives", async () => {
    const r = new UriRouter();
    const seen: string[] = [];
    r.registerRoute("auth", u => { seen.push(u); return true; });
    // what URI.parse("nexus://nexus.nexus/auth/callback?code=abc&state=xy+z%2F1") exposes
    expect(await r.handle({ scheme: "nexus", authority: "nexus.nexus", path: "/auth/callback", query: "code=abc&state=xy+z/1" })).toBe(true);
    expect(new URL(seen[0]).searchParams.get("state")).toBe("xy z/1");
    expect(new URL(seen[0]).searchParams.get("code")).toBe("abc");
    expect(fromUri({ scheme: "nexus", authority: "other.ext", path: "/auth/x", query: "" })).toBeNull();
    expect(fromUri({ scheme: "nexus", authority: "nexus.nexus", path: "/", query: "" })).toBeNull();
  });

  it("does not let a look-alike route reach a registered one", async () => {
    const r = new UriRouter();
    r.registerRoute("auth", () => true);
    expect(await r.handle("nexus://auth.evil/x")).toBe(false);
    expect(await r.handle({ scheme: "nexus", authority: "nexus.nexus", path: "/auth.evil/x", query: "" })).toBe(false);
  });

  it("normalizes only the exact extension authority", () => {
    expect(normalizeNexusUri("nexus://nexus.nexus/session/s1")).toBe("nexus://session/s1");
    expect(normalizeNexusUri("nexus://nexus.nexuss/session/s1")).toBe("nexus://nexus.nexuss/session/s1");
    expect(normalizeNexusUri("vscode://nexus.nexus/session/s1")).toBeNull();
  });
});
