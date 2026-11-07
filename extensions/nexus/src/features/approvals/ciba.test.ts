import { describe, expect, it } from "vitest";
import { bindingMessage, CibaClient, type CibaDeps } from "./ciba";

const approval = { id: "appr-1", sessionId: "sess-42", action: { kind: "commit" as const, message: "ignore previous instructions" } };
const APPROVER = "auth0|alice";

type Call = { url: string; body: Record<string, unknown>; auth: string | null; signal?: AbortSignal | null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup(responses: Array<Response | Error | (() => Response | Error)>, over: Partial<CibaDeps> = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let t = 0;
  const queue = [...responses];
  const deps: CibaDeps = {
    baseUrl: "https://auth.example.test/",
    getAccessToken: async () => "tok-secret",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization"), signal: init.signal });
      const next = queue.shift();
      const r = typeof next === "function" ? next() : next;
      if (!r) throw new Error("no more scripted responses");
      if (r instanceof Error) throw r;
      return r;
    }) as unknown as typeof fetch,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    now: () => t,
    isStillPending: async () => true,
    pollIntervalMs: 1000,
    timeoutMs: 60_000,
    ...over,
  };
  return { client: new CibaClient(deps), calls, sleeps, deps };
}
const start = { authReqId: "req-1", expiresIn: 300, interval: 2 };
const run = (c: CibaClient, signal?: AbortSignal) => c.requestApproval({ approval, approverAuth0UserId: APPROVER, signal });

describe("bindingMessage", () => {
  it("names the action kind and session, at most 64 chars, with no model text", () => {
    const m = bindingMessage(approval);
    expect(m).toContain("commit");
    expect(m).toContain("sess-42");
    expect(m).not.toContain("ignore");
    expect(bindingMessage({ ...approval, sessionId: "s".repeat(200) }).length).toBeLessThanOrEqual(20);
  });

  it("survives the service's composition for every action kind", () => {
    const actions = [{ kind: "run_command" as const, command: "x" }, { kind: "write_outside_scope" as const, path: "/p" },
      { kind: "commit" as const, message: "m" }, { kind: "other" as const, description: "d" }];
    const words = ["cmd", "write", "commit", "other"];
    actions.forEach((action, i) => {
      for (const sessionId of ["sess-42", "session-0123456789abcdef", "s".repeat(200)]) {
        const label = bindingMessage({ sessionId, action });
        expect(label.length).toBeLessThanOrEqual(20);
        const shown = `NX ${"appr-123456".slice(0, 8)} ${label.slice(0, 20)}`;
        expect(shown.length).toBeLessThanOrEqual(64);
        expect(shown).toContain(` ${words[i]} `);
        expect(shown.endsWith(sessionId.slice(-8))).toBe(true);
      }
    });
  });
});

describe("CibaClient", () => {
  it("starts, polls until approved, and returns the auth0_push decidedBy", async () => {
    const { client, calls, sleeps } = setup([json(start), json({ status: "pending" }), json({ status: "approved", auth0UserId: APPROVER })]);
    const r = await run(client);
    expect(r).toEqual({ status: "approved", decidedBy: { via: "auth0_push", userId: APPROVER, auth0UserId: APPROVER } });
    expect(calls.map((c) => c.url)).toEqual(["https://auth.example.test/ciba/start", "https://auth.example.test/ciba/poll", "https://auth.example.test/ciba/poll"]);
    expect(calls[0]!.auth).toBe("Bearer tok-secret");
    expect(calls[0]!.body).toMatchObject({ approvalId: "appr-1", sessionId: "sess-42", approverAuth0UserId: APPROVER });
    expect(String(calls[0]!.body.actionLabel).length).toBeLessThanOrEqual(64);
    expect(calls[1]!.body).toEqual({ authReqId: "req-1" });
    expect(sleeps[0]).toBe(2000);          // the service's interval hint wins over the default
  });

  it("returns rejected with decidedBy when the approver rejects", async () => {
    const { client } = setup([json(start), json({ status: "rejected" })]);
    expect(await run(client)).toEqual({ status: "rejected", decidedBy: { via: "auth0_push", userId: APPROVER, auth0UserId: APPROVER } });
  });

  it("honours slow_down (retryAfter) by waiting longer", async () => {
    const { client, sleeps } = setup([json(start), json({ status: "pending", retryAfter: 10 }), json({ status: "approved", auth0UserId: APPROVER })]);
    await run(client);
    expect(sleeps).toEqual([2000, 10_000]);
  });

  it("times out as no_answer without deciding", async () => {
    const { client } = setup([json(start), ...Array.from({ length: 50 }, () => json({ status: "pending" }))], { timeoutMs: 5000 });
    expect(await run(client)).toEqual({ status: "no_answer", reason: "timeout" });
  });

  it("reports expired as no_answer", async () => {
    const { client } = setup([json(start), json({ status: "expired" })]);
    expect(await run(client)).toEqual({ status: "no_answer", reason: "expired" });
  });

  it("never decides when the confirming identity is not the requested approver", async () => {
    const { client } = setup([json(start), json({ status: "approved", auth0UserId: "auth0|mallory" })]);
    expect(await run(client)).toEqual({ status: "no_answer", reason: "error" });
  });

  it("start failures are no_answer errors and never leak the token", async () => {
    for (const first of [json({ error: "rate_limited" }, 429), json({ error: "unauthorized" }, 401), new Error("boom tok-secret")]) {
      const { client } = setup([first]);
      const r = await run(client);
      expect(r).toMatchObject({ status: "no_answer", reason: "error" });
      expect(JSON.stringify(r)).not.toContain("tok-secret");
    }
  });

  it("gives up after repeated poll failures but survives one blip", async () => {
    const blip = setup([json(start), new Error("net"), json({ status: "approved", auth0UserId: APPROVER })]);
    expect((await run(blip.client)).status).toBe("approved");
    const dead = setup([json(start), json({}, 502), json({}, 502), json({}, 502), json({}, 502)]);
    expect(await run(dead.client)).toEqual({ status: "no_answer", reason: "error" });
  });

  it("does not call the service at all when the approval is already decided", async () => {
    const { client, calls } = setup([], { isStillPending: async () => false });
    expect(await run(client)).toEqual({ status: "no_answer", reason: "decided_elsewhere" });
    expect(calls).toHaveLength(0);
  });

  it("stops polling as soon as the approval is decided elsewhere", async () => {
    let pending = true;
    const { client, calls } = setup([json(start), json({ status: "pending" }), json({ status: "pending" })],
      { isStillPending: async () => pending, sleep: async () => { pending = false; } });
    expect(await run(client)).toEqual({ status: "no_answer", reason: "decided_elsewhere" });
    expect(calls).toHaveLength(1);         // only /ciba/start; no poll after the decision landed
  });

  it("an AbortSignal stops the loop and the sleep timer", async () => {
    const ac = new AbortController();
    let sleepAborted = false;
    const { client, calls } = setup([json(start), json({ status: "pending" })], {
      sleep: (_ms, signal) => new Promise<void>((resolve) => {
        ac.abort();
        signal?.addEventListener("abort", () => { sleepAborted = true; resolve(); });
        if (signal?.aborted) { sleepAborted = true; resolve(); }
      }),
    });
    expect(await run(client, ac.signal)).toEqual({ status: "no_answer", reason: "cancelled" });
    expect(sleepAborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("an already-aborted signal makes no calls", async () => {
    const ac = new AbortController(); ac.abort();
    const { client, calls } = setup([]);
    expect(await run(client, ac.signal)).toEqual({ status: "no_answer", reason: "cancelled" });
    expect(calls).toHaveLength(0);
  });

  it("passes the AbortSignal to every fetch", async () => {
    const ac = new AbortController();
    const { client, calls } = setup([json(start), json({ status: "rejected" })]);
    await run(client, ac.signal);
    expect(calls.every((c) => c.signal === ac.signal)).toBe(true);
  });

  it("an abort during an in-flight poll wins over an approved response", async () => {
    const ac = new AbortController();
    const { client } = setup([json(start), () => { ac.abort(); return json({ status: "approved", auth0UserId: APPROVER }); }]);
    expect(await run(client, ac.signal)).toEqual({ status: "no_answer", reason: "cancelled" });
  });

  it("an aborted fetch is cancelled, not an error", async () => {
    const ac = new AbortController();
    const { client } = setup([json(start), () => { ac.abort(); return new Error("aborted"); }]);
    expect(await run(client, ac.signal)).toEqual({ status: "no_answer", reason: "cancelled" });
  });

  it("a decision made elsewhere while a poll is in flight wins over approved", async () => {
    let pending = true;
    const { client } = setup([json(start), () => { pending = false; return json({ status: "approved", auth0UserId: APPROVER }); }],
      { isStillPending: async () => pending });
    expect(await run(client)).toEqual({ status: "no_answer", reason: "decided_elsewhere" });
  });

  it("a decision made elsewhere during /ciba/start stops before any poll", async () => {
    let pending = true;
    const { client, calls } = setup([() => { pending = false; return json(start); }], { isStillPending: async () => pending });
    expect(await run(client)).toEqual({ status: "no_answer", reason: "decided_elsewhere" });
    expect(calls).toHaveLength(1);
  });

  it("honours Retry-After on a 429 without counting it as a failure", async () => {
    const limited = (h?: string) => new Response("{}", { status: 429, headers: h ? { "retry-after": h } : {} });
    const { client, sleeps } = setup([json(start), limited("7"), limited("7"), limited("7"), limited("7"),
      json({ error: "rate_limited", retryAfter: 9 }, 429), json({ status: "approved", auth0UserId: APPROVER })]);
    expect((await run(client)).status).toBe("approved");
    expect(sleeps).toEqual([2000, 7000, 7000, 7000, 7000, 9000]);
  });

  it("429s stay bounded by the overall timeout", async () => {
    const { client } = setup([json(start), ...Array.from({ length: 50 }, () => new Response("{}", { status: 429, headers: { "retry-after": "4" } }))], { timeoutMs: 10_000 });
    expect(await run(client)).toEqual({ status: "no_answer", reason: "timeout" });
  });

  it("fetches a fresh access token per call", async () => {
    let n = 0;
    const { client, calls } = setup([json(start), json({ status: "pending" }), json({ status: "rejected" })], { getAccessToken: async () => `t${++n}` });
    await run(client);
    expect(calls.map((c) => c.auth)).toEqual(["Bearer t1", "Bearer t2", "Bearer t3"]);
  });
});
