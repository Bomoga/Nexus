import { PassThrough } from "node:stream";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChannel } from "../agent-process/channel";
import { run as runEcho } from "../agent-process/echo-runtime";
import { fx } from "../contracts/fixtures";
import { readLines } from "../shared/jsonl";
import { ProcessHost, childEnvironment, forkAgentProcess, type AgentHandlers, type HostLogger, type SessionErrorInfo, type Transport } from "./process-host";

const SECRET = "sk-ant-api03-SECRETSECRETSECRET1234567890";
// Tests run with cwd = extensions/nexus (npm test).
const FIXTURE = join(process.cwd(), "src", "agent-process", "__fixtures__", "echo-child.mjs");

const startParams = () => ({
  session: { id: fx.session.id, taskId: fx.task.id, branch: fx.session.branch, worktreePath: fx.session.worktreePath, baseCommit: fx.session.baseCommit, model: fx.session.model },
  task: fx.task,
  systemRules: "rules",
  untrustedBlocks: [{ label: "slack thread", text: "hello" }],
});

type Line = Record<string, unknown>;

/** A fake child: the test plays the agent by pushing raw lines and reading what the host wrote. */
function rawTransport() {
  const stdin = new PassThrough();       // host -> child
  const stdout = new PassThrough();      // child -> host
  const sent: Line[] = [];
  readLines(stdin, l => sent.push(JSON.parse(l) as Line));
  const exitCbs: Array<(c: number | null, s: string | null) => void> = [];
  let killed = false;
  const transport: Transport = { stdin, stdout, kill: () => { killed = true; }, onExit: cb => exitCbs.push(cb) };
  return {
    transport, sent,
    push: (v: unknown) => stdout.write((typeof v === "string" ? v : JSON.stringify(v)) + "\n"),
    exit: (code: number | null, signal: string | null = null) => exitCbs.forEach(cb => cb(code, signal)),
    get killed() { return killed; },
  };
}

/** A fake child running a real AgentRuntime in this process, connected by streams. */
function channelTransport(run: (c: AgentChannel) => Promise<void>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const channel = new AgentChannel(stdin, stdout);
  void run(channel);
  const transport: Transport = { stdin, stdout, kill: () => channel.close(), onExit: () => {} };
  return { transport, channel };
}

function harness(handlers: AgentHandlers = {}, extra: { requestTimeoutMs?: number; hostRequestTimeoutMs?: number; maxConcurrentRequests?: number; maxLineChars?: number } = {}) {
  const logs: string[] = [];
  const log: HostLogger = (level, message, meta) => logs.push(`${level} ${message} ${JSON.stringify(meta ?? {})}`);
  const raws: ReturnType<typeof rawTransport>[] = [];
  const errors: Array<{ sessionId: string; message: string; info: SessionErrorInfo }> = [];
  const host = new ProcessHost({
    spawn: () => { const r = rawTransport(); raws.push(r); return r.transport; },
    handlers, log, ...extra,
    onSessionError: (sessionId, message, info) => errors.push({ sessionId, message, info }),
  });
  return { host, raws, logs, errors, raw: () => raws[raws.length - 1] };
}

const hosts: ProcessHost[] = [];
afterEach(() => { hosts.splice(0).forEach(h => h.dispose()); });
const track = <T extends { host: ProcessHost }>(h: T): T => { hosts.push(h.host); return h; };

describe("ProcessHost with an in-process agent runtime (echo-runtime)", () => {
  it("round-trips session.start through credentials.get and event.emit, and never logs the key", async () => {
    const logs: string[] = [];
    const seen: Line[] = [];
    let seq = 0;
    const { transport } = channelTransport(runEcho);
    const host = new ProcessHost({
      spawn: () => transport,
      log: (level, message, meta) => logs.push(`${level} ${message} ${JSON.stringify(meta ?? {})}`),
      handlers: {
        "credentials.get": async b => { seen.push({ credentials: b }); return { apiKey: SECRET, prune: { enabled: false, allowModelRouting: false } }; },
        "event.emit": async b => { seen.push({ emit: b }); return { seq: seq++ }; },
      },
    });
    hosts.push(host);
    await expect(host.startSession(startParams())).resolves.toEqual({ accepted: true });
    expect(seen[0]).toEqual({ credentials: { provider: "anthropic", callId: "call_ses_01" } });
    expect(seen[1]).toMatchObject({ emit: { type: "message", payload: { text: `echo: ${fx.task.title}`, hasKey: true } } });
    expect(logs.join("\n")).not.toContain("SECRETSECRET");
    expect(JSON.stringify(seen[1])).not.toContain("SECRETSECRET");
  });

  it("delivers approval.resolved to the runtime", async () => {
    const emitted: unknown[] = [];
    const { transport } = channelTransport(runEcho);
    const host = new ProcessHost({
      spawn: () => transport,
      handlers: { "event.emit": async b => { emitted.push(b); return { seq: emitted.length }; } },
    });
    hosts.push(host);
    host.start();
    expect(host.sendEvent("approval.resolved", { approvalId: "apr_01", decision: "approved" })).toBe(true);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]).toMatchObject({ payload: { text: "echo: approval apr_01 approved" } });
  });

  it("answers health and session.cancel", async () => {
    const { transport } = channelTransport(runEcho);
    const host = new ProcessHost({ spawn: () => transport, handlers: {} });
    hosts.push(host);
    expect(await host.health()).toMatchObject({ ok: true });
    expect(await host.cancelSession("ses_01")).toEqual({ cancelled: true });
  });
});

describe("ProcessHost request handling (raw child)", () => {
  const request = (name: string, body: unknown, id = "x1") => ({ t: "req", id, name, body });
  const reply = (h: ReturnType<typeof harness>, id = "x1") => vi.waitFor(() => {
    const r = h.raw().sent.find(s => s.id === id && s.t === "res");
    if (!r) throw new Error("no reply yet");
    return r;
  });

  it("routes a valid request to its handler and returns the validated body", async () => {
    const h = track(harness({ "fs.read": async b => ({ content: `read ${b.path}`, truncated: false }) }));
    h.host.start();
    h.raw().push(request("fs.read", { path: "src/cart.ts" }));
    expect(await reply(h)).toMatchObject({ ok: true, body: { content: "read src/cart.ts", truncated: false } });
  });

  it("applies schema defaults before calling the handler", async () => {
    let seen: unknown;
    const h = track(harness({ "fs.list": async b => { seen = b; return { entries: [] }; } }));
    h.host.start();
    h.raw().push(request("fs.list", {}));
    await reply(h);
    expect(seen).toEqual({ path: ".", depth: 2 });
  });

  it("rejects an unknown request name without crashing", async () => {
    const h = track(harness());
    h.host.start();
    h.raw().push(request("fs.delete", { path: "/" }));
    expect(await reply(h)).toMatchObject({ ok: false, error: "unknown request fs.delete" });
    expect(h.logs.some(l => l.includes("unknown agent request"))).toBe(true);
  });

  it("rejects an invalid body and does not call the handler", async () => {
    const handler = vi.fn(async () => ({ content: "", truncated: false }));
    const h = track(harness({ "fs.read": handler }));
    h.host.start();
    h.raw().push(request("fs.read", { path: 42 }));
    expect(await reply(h)).toMatchObject({ ok: false, error: "invalid fs.read request" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("drops non-JSON and non-envelope lines, logs only their size, and keeps serving", async () => {
    const h = track(harness({ "fs.read": async () => ({ content: "ok", truncated: false }) }));
    h.host.start();
    h.raw().push(`not json {"apiKey":"${SECRET}"`);
    h.raw().push({ t: "zzz", id: "1" });
    h.raw().push(request("fs.read", { path: "a" }, "ok1"));
    expect(await reply(h, "ok1")).toMatchObject({ ok: true });
    const joined = h.logs.join("\n");
    expect(joined).toContain("not JSON");
    expect(joined).toContain("not an AgentEnvelope");
    expect(joined).not.toContain("SECRETSECRET");
  });

  it("errors when no handler is registered", async () => {
    const h = track(harness());
    h.host.start();
    h.raw().push(request("fs.read", { path: "a" }));
    expect(await reply(h)).toMatchObject({ ok: false, error: "no handler for fs.read" });
  });

  it("times out an ordinary request that never resolves", async () => {
    const h = track(harness({ "fs.read": () => new Promise(() => {}) }, { requestTimeoutMs: 30 }));
    h.host.start();
    h.raw().push(request("fs.read", { path: "a" }));
    expect(await reply(h)).toMatchObject({ ok: false, error: "fs.read timed out" });
  });

  it.each(["cmd.run", "git.commit", "approval.request"] as const)("never times out %s (it waits for a human)", async name => {
    const results = {
      "cmd.run": { exitCode: 0, stdoutTail: "", stderrTail: "" },
      "git.commit": { sha: fx.session.baseCommit, approvalId: "apr_02" },
      "approval.request": { approvalId: "apr_01", decision: "approved" as const },
    };
    const bodies = { "cmd.run": { command: "npm test" }, "git.commit": { message: "m" }, "approval.request": { kind: "other", description: "d", reason: "r" } };
    const slow = async () => { await new Promise(r => setTimeout(r, 120)); return results[name]; };
    const h = track(harness({ [name]: slow } as AgentHandlers, { requestTimeoutMs: 30 }));
    h.host.start();
    h.raw().push(request(name, bodies[name]));
    expect(await reply(h)).toMatchObject({ ok: true });
  });

  it("refuses a handler result that breaks the response schema", async () => {
    const h = track(harness({ "fs.read": (async () => ({ content: 1 })) as unknown as AgentHandlers["fs.read"] }));
    h.host.start();
    h.raw().push(request("fs.read", { path: "a" }));
    expect(await reply(h)).toMatchObject({ ok: false, error: "invalid fs.read response" });
    expect(h.logs.some(l => l.startsWith("error "))).toBe(true);
  });

  it("redacts secrets in a handler's error message", async () => {
    const h = track(harness({ "fs.read": async () => { throw new Error(`upstream said ${SECRET}`); } }));
    h.host.start();
    h.raw().push(request("fs.read", { path: "a" }));
    const r = await reply(h);
    expect(JSON.stringify(r)).not.toContain("SECRETSECRET");
    expect(JSON.stringify(r)).toContain("REDACTED");
  });
});

describe("ProcessHost host-to-agent calls", () => {
  it("sends validated session.start and resolves on the child's response", async () => {
    const h = track(harness());
    const p = h.host.startSession(startParams());
    await vi.waitFor(() => expect(h.raw().sent).toHaveLength(1));
    const req = h.raw().sent[0];
    expect(req).toMatchObject({ t: "req", name: "session.start" });
    h.raw().push({ t: "res", id: req.id, ok: true, body: { accepted: true } });
    await expect(p).resolves.toEqual({ accepted: true });
  });

  it("rejects when the child stays silent", async () => {
    const h = track(harness({}, { hostRequestTimeoutMs: 30 }));
    await expect(h.host.startSession(startParams())).rejects.toThrow("session.start timed out");
  });

  it("stops the child when session.start is not confirmed, and blames no session for that exit", async () => {
    const h = track(harness({}, { hostRequestTimeoutMs: 30 }));
    const p = h.host.startSession(startParams());
    const raw = h.raw();
    expect(raw.killed).toBe(false);
    await expect(p).rejects.toThrow("session.start timed out");
    expect(raw.killed).toBe(true);
    raw.exit(null, "SIGTERM");
    expect(h.errors).toEqual([]);
  });

  it("rejects an invalid response from the child", async () => {
    const h = track(harness());
    const p = h.host.health();
    await vi.waitFor(() => expect(h.raw().sent).toHaveLength(1));
    h.raw().push({ t: "res", id: h.raw().sent[0].id, ok: true, body: { ok: false } });
    await expect(p).rejects.toThrow("invalid health response");
  });

  it("rejects pending calls when the child exits", async () => {
    const h = track(harness());
    const p = h.host.health();
    await vi.waitFor(() => expect(h.raw().sent).toHaveLength(1));
    h.raw().exit(1);
    await expect(p).rejects.toThrow("agent process exited");
  });

  it("rejects an invalid session.start before sending anything", async () => {
    const h = track(harness());
    const bad = { ...startParams(), session: { ...startParams().session, baseCommit: "main" } };
    await expect(h.host.startSession(bad)).rejects.toThrow();
    expect(h.raw().sent).toHaveLength(0);
  });

  it("refuses an invalid host event", () => {
    const h = track(harness());
    h.host.start();
    expect(() => h.host.sendEvent("approval.resolved", { approvalId: "a", decision: "maybe" as never })).toThrow();
  });

  it("dispose kills the child and rejects pending calls", async () => {
    const h = harness();
    const p = h.host.health();
    await vi.waitFor(() => expect(h.raw().sent).toHaveLength(1));
    h.host.dispose();
    await expect(p).rejects.toThrow("disposed");
    expect(h.raw().killed).toBe(true);
    expect(h.host.running).toBe(false);
  });
});

describe("ProcessHost crash handling", () => {
  async function startAndAccept(h: ReturnType<typeof harness>, sessionId = fx.session.id) {
    const params = startParams();
    params.session.id = sessionId;
    const p = h.host.startSession(params);
    await vi.waitFor(() => expect(h.raw().sent.some(s => s.name === "session.start")).toBe(true));
    const req = h.raw().sent.filter(s => s.name === "session.start").at(-1)!;
    h.raw().push({ t: "res", id: req.id, ok: true, body: { accepted: true } });
    await p;
  }

  it("restarts once per session, reports each crash, and then gives up", async () => {
    const h = track(harness());
    await startAndAccept(h);
    expect(h.raws).toHaveLength(1);

    h.raws[0].exit(3);
    expect(h.raws).toHaveLength(2);                                   // respawned
    expect(h.errors).toEqual([{ sessionId: "ses_01", message: expect.stringContaining("restarted"), info: { restarted: true, exitCode: 3, signal: null } }]);

    await startAndAccept(h);                                          // controller re-sends session.start
    h.raws[1].exit(null, "SIGKILL");
    expect(h.raws).toHaveLength(2);                                   // no second restart
    expect(h.errors[1]).toMatchObject({ sessionId: "ses_01", info: { restarted: false, signal: "SIGKILL" } });
    expect(h.host.running).toBe(false);
  });

  it("gives a different session its own restart budget (and a lazy respawn)", async () => {
    const h = track(harness());
    await startAndAccept(h, "ses_a");
    h.raws[0].exit(1);
    await startAndAccept(h, "ses_a");
    h.raws[1].exit(1);                                                // ses_a is out of restarts
    expect(h.host.running).toBe(false);
    await startAndAccept(h, "ses_b");                                 // start() spawns a third process
    expect(h.raws).toHaveLength(3);
    h.raws[2].exit(1);
    expect(h.errors.at(-1)).toMatchObject({ sessionId: "ses_b", info: { restarted: true } });
  });

  it("does not respawn or report anything when an idle process exits", async () => {
    const h = track(harness());
    h.host.start();
    h.raws[0].exit(0);
    expect(h.errors).toEqual([]);
    expect(h.raws).toHaveLength(1);
    expect(h.host.running).toBe(false);
    h.host.start();
    expect(h.raws).toHaveLength(2);
  });

  it("does not blame an ended session for a later exit", async () => {
    const h = track(harness());
    await startAndAccept(h);
    h.host.endSession(fx.session.id);
    h.raws[0].exit(0);
    expect(h.errors).toEqual([]);
  });
});

describe("ProcessHost isolation and limits", () => {
  const request = (id: string, name: string, body: unknown) => ({ t: "req", id, name, body });
  async function accept(h: ReturnType<typeof harness>, sessionId = fx.session.id) {
    const params = startParams();
    params.session.id = sessionId;
    const p = h.host.startSession(params);
    await vi.waitFor(() => expect(h.raw().sent.some(s => s.name === "session.start")).toBe(true));
    h.raw().push({ t: "res", id: h.raw().sent.filter(s => s.name === "session.start").at(-1)!.id, ok: true, body: { accepted: true } });
    await p;
  }

  it("never delivers a late reply to the process that replaced the one that asked", async () => {
    let release: (v: { apiKey: string }) => void = () => {};
    const h = track(harness({ "credentials.get": () => new Promise(r => { release = r; }) }));
    await accept(h);
    h.raws[0].push(request("a1", "credentials.get", { provider: "anthropic", callId: "c1" }));
    await vi.waitFor(() => expect(h.logs.length).toBeGreaterThan(0));
    h.raws[0].exit(3);                                   // active session: the host respawns
    expect(h.raws).toHaveLength(2);
    release({ apiKey: SECRET });
    await new Promise(r => setTimeout(r, 40));
    expect(h.raws[1].sent.find(s => s.t === "res" && s.id === "a1")).toBeUndefined();
    expect(JSON.stringify(h.raws[1].sent)).not.toContain("SECRETSECRET");
    expect(h.logs.some(l => l.includes("dropped a reply for a replaced process"))).toBe(true);
  });

  it("ignores requests from a process that has already been replaced", async () => {
    const handler = vi.fn(async () => ({ content: "", truncated: false }));
    const h = track(harness({ "fs.read": handler }));
    await accept(h);
    h.raws[0].exit(3);
    h.raws[0].push(request("late", "fs.read", { path: "a" }));
    await new Promise(r => setTimeout(r, 20));
    expect(handler).not.toHaveBeenCalled();
  });

  it("caps concurrent requests and refuses a duplicate in-flight id", async () => {
    const h = track(harness({ "fs.read": () => new Promise(() => {}) }, { maxConcurrentRequests: 2, requestTimeoutMs: 60_000 }));
    h.host.start();
    for (const id of ["r1", "r2", "r3"]) h.raw().push(request(id, "fs.read", { path: "a" }));
    h.raw().push(request("r1", "fs.read", { path: "a" }));
    await vi.waitFor(() => expect(h.raw().sent.filter(s => s.t === "res")).toHaveLength(2));
    const errs = Object.fromEntries(h.raw().sent.filter(s => s.t === "res").map(s => [s.id as string, s.error]));
    expect(errs.r3).toBe("too many concurrent requests");
    expect(errs.r1).toBe("duplicate request id");
  });

  it("kills a child that sends a line over the size limit", async () => {
    const h = track(harness({}, { maxLineChars: 50 }));
    h.host.start();
    h.raw().push("x".repeat(200));
    await vi.waitFor(() => expect(h.raw().killed).toBe(true));
    expect(h.logs.some(l => l.includes("size limit"))).toBe(true);
  });

  it("childEnvironment passes an allowlist plus explicit extras, and nothing secret from the parent", () => {
    const env = childEnvironment(
      { PATH: "/bin", Path: "C:/x", HOME: "/h", ANTHROPIC_API_KEY: "k", SLACK_USER_TOKEN: "t", NEXUS_AGENT_RUNTIME: "./evil", NODE_OPTIONS: "--require /evil.js" },
      { NEXUS_AGENT_RUNTIME: "./echo-runtime" },
    );
    expect(env).toEqual({ PATH: "/bin", Path: "C:/x", HOME: "/h", ELECTRON_RUN_AS_NODE: "1", NEXUS_AGENT_RUNTIME: "./echo-runtime" });
  });
});

describe("ProcessHost with a real child process", () => {
  it("starts the real process, answers health, and runs ELECTRON_RUN_AS_NODE", async () => {
    const host = new ProcessHost({ spawn: forkAgentProcess(FIXTURE), handlers: {} });
    hosts.push(host);
    const res = await host.health();
    expect(res.ok).toBe(true);
    expect(res.pid).not.toBe(process.pid);
  });

  it("round-trips session.start with per-call credentials from the host", async () => {
    const emitted: unknown[] = [];
    const host = new ProcessHost({
      spawn: forkAgentProcess(FIXTURE),
      handlers: {
        "credentials.get": async () => ({ apiKey: SECRET, prune: { enabled: false, allowModelRouting: false } }),
        "event.emit": async b => { emitted.push(b); return { seq: 0 }; },
      },
    });
    hosts.push(host);
    await expect(host.startSession(startParams())).resolves.toEqual({ accepted: true });
    expect(emitted[0]).toMatchObject({ payload: { gotKey: true, electronAsNode: "1" } });
  });

  it("does not hand the parent's API keys to the child", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-PARENTENVSECRET1234567890";
    const emitted: Array<{ payload: { leakedKey: boolean; hasPath: boolean } }> = [];
    const host = new ProcessHost({
      spawn: forkAgentProcess(FIXTURE),
      handlers: { "credentials.get": async () => ({ apiKey: "k" }), "event.emit": async b => { emitted.push(b as never); return { seq: 0 }; } },
    });
    hosts.push(host);
    try {
      await host.startSession(startParams());
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    expect(emitted[0].payload).toMatchObject({ leakedKey: false, hasPath: true });
  });

  it("detects a real crash and restarts the process once", async () => {
    const errors: Array<{ message: string; restarted: boolean }> = [];
    const host = new ProcessHost({
      spawn: forkAgentProcess(FIXTURE, { env: { CRASH_ON_START: "1" } }),
      handlers: {
        "credentials.get": async () => ({ apiKey: "k" }),
        "event.emit": async () => ({ seq: 0 }),
      },
      onSessionError: (_id, message, info) => errors.push({ message, restarted: info.restarted }),
    });
    hosts.push(host);
    await host.startSession(startParams());
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 5000 });
    expect(errors[0].restarted).toBe(true);
    await expect(host.health()).resolves.toMatchObject({ ok: true });   // the replacement process answers

    await host.startSession(startParams());
    await vi.waitFor(() => expect(errors).toHaveLength(2), { timeout: 5000 });
    expect(errors[1].restarted).toBe(false);
  }, 20_000);
});

describe("ProcessHost session.finished events", () => {
  it("reports a valid session.finished, clears the active session, and ignores malformed ones", async () => {
    const finished: unknown[] = [];
    const raws: ReturnType<typeof rawTransport>[] = [];
    const host = new ProcessHost({ spawn: () => { const r = rawTransport(); raws.push(r); return r.transport; }, handlers: {}, onSessionFinished: o => finished.push(o), onSessionError: () => { throw new Error("must not be blamed"); } });
    hosts.push(host);
    const p = host.startSession(startParams());
    await vi.waitFor(() => expect(raws[0].sent).toHaveLength(1));
    raws[0].push({ t: "res", id: raws[0].sent[0].id, ok: true, body: { accepted: true } });
    await p;
    raws[0].push({ t: "evt", name: "session.finished", body: { sessionId: "ses_01", outcome: "bogus", turns: 1 } });
    raws[0].push({ t: "evt", name: "something.else", body: {} });
    raws[0].push({ t: "evt", name: "session.finished", body: { sessionId: "ses_01", outcome: "done", turns: 5 } });
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toEqual({ sessionId: "ses_01", outcome: "done", turns: 5 });
    raws[0].exit(0);                                    // the session already ended, so this exit is not an error
    expect(raws).toHaveLength(1);
  });
});
