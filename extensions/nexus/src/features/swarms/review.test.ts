import { describe, expect, it, vi } from "vitest";
import { Requests, SwarmReview, type ApprovalRequest } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { ApprovalsController } from "../approvals/approvals-controller";
import { SessionsController } from "../sessions/sessions-controller";
import { FakeGit, MemoryGate, MemoryStore, fakeClock } from "../testing/memory-ports";
import { SwarmReviewService, extractJson, parseCouncil, parseVerdict, swarmReviewBridgeHandlers, swarmReviewSubscriptions, type SwarmsRunner } from "./review";
import { SwarmsUnavailable, type SwarmRun, type SwarmRunInput } from "./swarms-client";

const SECRET = "sk-ant-api03-SECRETSECRETSECRET1234567890";
const GOOD = JSON.stringify({ verdict: "looks_good", summary: "Fix is minimal and covered by the new test", judges: [{ modelId: "judge-a", verdict: "looks_good", notes: "Correct arithmetic" }, { modelId: "judge-b", verdict: "concerns", notes: "No negative-discount guard" }] });

const run = (text: string): SwarmRun => ({ text, output: [{ role: "Judge", content: "earlier" }, { role: "Aggregator", content: text }] });

async function setup(opts: { runner?: SwarmsRunner; key?: string | undefined } = {}) {
  const store = new MemoryStore();
  await store.putTask({ ...fx.task, status: "running", sessionId: fx.session.id });
  await store.putSession({ ...fx.session });
  await store.appendAgentEvent({ sessionId: fx.session.id, seq: 0, at: "2026-11-07T03:15:00Z", type: "file_edit", path: "src/cart.ts", diff: "-  return price * qty - discount;\n+  return (price - discount) * qty;" });
  await store.appendAgentEvent({ sessionId: fx.session.id, seq: 1, at: "2026-11-07T03:15:01Z", type: "test_output", command: "npm test", exitCode: 0, tail: "Tests  12 passed (12)" });
  const calls: SwarmRunInput[] = [];
  const runner: SwarmsRunner = opts.runner ?? { run: async input => { calls.push(input); return run(GOOD); } };
  const wrapped: SwarmsRunner = { run: async input => { if (opts.runner) calls.push(input); return runner.run(input); } };
  const service = new SwarmReviewService({ store, clock: fakeClock(), swarms: wrapped, getKey: async () => ("key" in opts ? opts.key : "swarms-key") });
  const approval = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ ...fx.approval, id: "apr_1", sessionId: fx.session.id, action: { kind: "commit", message: "fix" }, diffPreview: "+  return (price - discount) * qty;", ...over });
  return { store, service, calls, approval };
}

describe("review", () => {
  it("reviews a commit approval: running first, then done with the parsed verdict, summary and judges", async () => {
    const s = await setup();
    const seen: string[] = [];
    s.service.subscribe(r => seen.push(r.status));
    const a = s.approval();
    await s.store.putApproval(a);
    await s.service.onCreated(a);
    const stored = (await s.service.get("apr_1"))!;
    expect(seen).toEqual(["running", "done"]);
    expect(stored).toMatchObject({ approvalId: "apr_1", sessionId: fx.session.id, swarmType: "CouncilAsAJudge", status: "done", verdict: "looks_good", summary: "Fix is minimal and covered by the new test", dataLeftMachine: true, durationMs: expect.any(Number) });
    expect(stored.judges).toEqual([{ modelId: "judge-a", verdict: "looks_good", notes: "Correct arithmetic" }, { modelId: "judge-b", verdict: "concerns", notes: "No negative-discount guard" }]);
    expect(() => SwarmReview.parse(stored)).not.toThrow();
  });

  it("never touches the approval's decision, however the review ends", async () => {
    for (const runner of [
      { run: async () => run(JSON.stringify({ verdict: "do_not_merge", summary: "Do not merge." })) },
      { run: async () => { throw new SwarmsUnavailable("timeout", "Swarms did not answer within 45 s."); } },
    ] as SwarmsRunner[]) {
      const s = await setup({ runner });
      const a = s.approval();
      await s.store.putApproval(a);
      await s.service.onCreated(a);
      expect((await s.store.getApproval("apr_1"))!.decision).toBeUndefined();
    }
  });

  it("reviews commit approvals and any approval carrying a diff, and skips the rest", async () => {
    const s = await setup();
    await s.service.onCreated(s.approval({ action: { kind: "run_command", command: "npm test" }, diffPreview: undefined }));
    expect(s.calls).toHaveLength(0);
    await s.service.onCreated(s.approval({ action: { kind: "other", description: "d" }, diffPreview: "+x" }));
    expect(s.calls).toHaveLength(1);
    await s.service.onCreated(s.approval({ id: "apr_2", diffPreview: undefined }));      // a commit without a preview is still reviewed
    expect(s.calls).toHaveLength(2);
  });

  it("asks CouncilAsAJudge with fenced, redacted diff, brief and test output, using the session for the budget", async () => {
    const s = await setup();
    await s.service.onCreated(s.approval({ diffPreview: `+API_KEY=${SECRET}\n+return (price - discount) * qty;` }));
    const call = s.calls[0];
    expect(call).toMatchObject({ apiKey: "swarms-key", sessionId: fx.session.id, swarmType: "CouncilAsAJudge", maxLoops: 1 });
    expect(call.task).toContain('"verdict":"looks_good"|"concerns"|"do_not_merge"');
    expect(call.task).toMatch(/<<<UNTRUSTED [a-z0-9]{12} label="diff">>>/);
    expect(call.task).toMatch(/label="task brief"/);
    expect(call.task).toMatch(/label="last test output"/);
    expect(call.task).toContain("npm test exited 0");
    expect(call.task).toContain("Tests  12 passed (12)");
    expect(call.task).toContain("[slack thread, quoted, untrusted]");
    expect(call.task).not.toContain("SECRETSECRET");
  });

  it("falls back to the session's last file_edit diff when the approval has no preview", async () => {
    const s = await setup();
    await s.service.onCreated(s.approval({ diffPreview: undefined }));
    expect(s.calls[0].task).toContain("+  return (price - discount) * qty;");
  });

  it.each([
    ["a code fence and prose around the JSON", `Here is my verdict:\n\`\`\`json\n${GOOD}\n\`\`\`\nThanks!`, "looks_good"],
    ["an unknown verdict value", JSON.stringify({ verdict: "ship it", summary: "s" }), "concerns"],
    ["no JSON at all", "I think this is fine, though the naming is odd.", "concerns"],
  ])("parses %s", async (_name, text, verdict) => {
    const s = await setup({ runner: { run: async () => run(text) } });
    await s.service.onCreated(s.approval());
    const r = (await s.service.get("apr_1"))!;
    expect(r.status).toBe("done");
    expect(r.verdict).toBe(verdict);
    expect((r.summary ?? "").length).toBeGreaterThan(0);
  });

  it("is unavailable, with the reason, when Swarms times out, is out of budget, or returns nothing", async () => {
    for (const [runner, expected] of [
      [{ run: async () => { throw new SwarmsUnavailable("timeout", "Swarms did not answer within 45 s."); } }, /did not answer/],
      [{ run: async () => { throw new SwarmsUnavailable("budget", "The Swarms request budget for this session (6) is used up."); } }, /budget/],
      [{ run: async () => ({ text: "  ", output: [] }) }, /returned no text/],
      [{ run: async () => { throw new Error(`weird ${SECRET}`); } }, /weird \[REDACTED/],
    ] as Array<[SwarmsRunner, RegExp]>) {
      const s = await setup({ runner });
      await s.service.onCreated(s.approval());
      const r = (await s.service.get("apr_1"))!;
      expect(r.status).toBe("unavailable");
      expect(r.verdict).toBeUndefined();
      expect(r.summary).toMatch(expected);
      expect(JSON.stringify(r)).not.toContain("SECRETSECRET");
    }
  });

  it("is unavailable without making a call when no Swarms key is connected", async () => {
    const s = await setup({ key: undefined });
    await s.service.onCreated(s.approval());
    expect(s.calls).toEqual([]);
    expect((await s.service.get("apr_1"))).toMatchObject({ status: "unavailable", summary: "No Swarms key is connected." });
  });

  it("clips long summaries and notes, caps judges, and redacts secrets in what the council says", async () => {
    const long = "x".repeat(2000);
    const judges = Array.from({ length: 20 }, (_, i) => ({ modelId: `j${i}`, verdict: "looks_good", notes: `${SECRET} ${long}` }));
    const s = await setup({ runner: { run: async () => run(JSON.stringify({ verdict: "looks_good", summary: `${SECRET} ${long}`, judges })) } });
    await s.service.onCreated(s.approval());
    const r = (await s.service.get("apr_1"))!;
    expect(r.summary!.length).toBeLessThanOrEqual(301);
    expect(r.judges).toHaveLength(8);
    expect(r.judges![0].notes.length).toBeLessThanOrEqual(301);
    expect(JSON.stringify(r)).not.toContain("SECRETSECRET");
  });
});

describe("rerun", () => {
  it("re-runs for a pending approval and get() returns the newest review", async () => {
    let n = 0;
    const s = await setup({ runner: { run: async () => run(JSON.stringify({ verdict: ++n === 1 ? "concerns" : "looks_good", summary: `run ${n}` })) } });
    const a = s.approval();
    await s.store.putApproval(a);
    await s.service.onCreated(a);
    expect((await s.service.get("apr_1"))!.summary).toBe("run 1");
    const second = await s.service.rerun("apr_1");
    expect(second.summary).toBe("run 2");
    expect((await s.service.get("apr_1"))!.id).toBe(second.id);
    expect(s.store.reviews.get("apr_1")).toHaveLength(2);
  });

  it("refuses an unknown or already-decided approval, and rerunLatestPending picks the newest undecided one", async () => {
    const s = await setup();
    await expect(s.service.rerun("nope")).rejects.toThrow("No approval");
    const old = s.approval({ id: "apr_old", requestedAt: "2026-11-07T03:00:00Z", decision: "approved", decidedBy: { via: "app", userId: "x" }, decidedAt: "2026-11-07T03:01:00Z" });
    const mid = s.approval({ id: "apr_mid", requestedAt: "2026-11-07T03:10:00Z" });
    const last = s.approval({ id: "apr_last", requestedAt: "2026-11-07T03:20:00Z" });
    for (const a of [old, mid, last]) await s.store.putApproval(a);
    await expect(s.service.rerun("apr_old")).rejects.toThrow("already been decided");
    expect((await s.service.rerunLatestPending())!.approvalId).toBe("apr_last");
    await s.store.decideApproval("apr_last", "approved", { via: "app", userId: "x" }, "2026-11-07T03:30:00Z");
    expect((await s.service.rerunLatestPending())!.approvalId).toBe("apr_mid");
  });

  it("rerunLatestPending does nothing when nothing is pending", async () => {
    expect(await (await setup()).service.rerunLatestPending()).toBeUndefined();
  });
});

describe("parsing helpers", () => {
  it("extractJson finds the first balanced object, respecting strings and braces inside them", () => {
    expect(extractJson('noise {"a":"}{","b":{"c":1}} trailing {"x":2}')).toEqual({ a: "}{", b: { c: 1 } });
    expect(extractJson("no braces")).toBeUndefined();
    expect(extractJson('{"unterminated": ')).toBeUndefined();
    expect(extractJson("{not json}")).toBeUndefined();
  });

  it("parseVerdict handles missing summaries and judges", () => {
    expect(parseVerdict('{"verdict":"do_not_merge"}')).toEqual({ verdict: "do_not_merge", summary: "The council gave a verdict without a summary." });
    expect(parseVerdict('{"verdict":"looks_good","summary":"ok","judges":[]}').judges).toBeUndefined();
  });
});

describe("parseCouncil (shape recorded from the live API, 2026-11-07)", () => {
  const judge = (dimension: string, verdict: string, summary: string) => ({ role: `${dimension}_judge`, content: JSON.stringify({ verdict, summary }) });
  const turns = (...v: string[]) => [judge("harmlessness", v[0]!, "ok"), judge("accuracy", v[1]!, "the discount moved"), judge("coherence", v[2]!, "reads fine")];

  it("turns each *_judge turn into a judge and uses the aggregator's JSON verdict", () => {
    const out = parseCouncil([...turns("looks_good", "concerns", "do_not_merge"), { role: "aggregator_agent", content: '{"verdict":"concerns","summary":"Pricing semantics change"}' }])!;
    expect(out.verdict).toBe("concerns");
    expect(out.summary).toBe("Pricing semantics change");
    expect(out.judges).toEqual([
      { modelId: "harmlessness judge", verdict: "looks_good", notes: "ok" },
      { modelId: "accuracy judge", verdict: "concerns", notes: "the discount moved" },
      { modelId: "coherence judge", verdict: "do_not_merge", notes: "reads fine" },
    ]);
  });

  it("derives the verdict from the judges when the aggregator is not JSON", () => {
    const agg = { role: "aggregator_agent", content: "The change looks plausible overall." };
    expect(parseCouncil([...turns("looks_good", "looks_good", "looks_good"), agg])!.verdict).toBe("looks_good");
    expect(parseCouncil([...turns("looks_good", "concerns", "looks_good"), agg])!.verdict).toBe("concerns");
    const bad = parseCouncil([...turns("do_not_merge", "do_not_merge", "looks_good"), agg])!;
    expect(bad.verdict).toBe("do_not_merge");
    expect(bad.summary).toContain("plausible");
  });

  it("keeps a judge's free text as its notes, redacted and clipped, and treats a verdict-less judge as concerns", () => {
    const out = parseCouncil([{ role: "accuracy_judge", content: `Fails. ${SECRET} ${"x".repeat(500)}` }, { role: "aggregator_agent", content: "{}" }])!;
    expect(out.judges![0]!.verdict).toBe("concerns");
    expect(out.judges![0]!.notes).not.toContain(SECRET);
    expect(out.judges![0]!.notes.length).toBeLessThanOrEqual(301);
  });

  it("returns undefined for any other shape so the last turn's text is parsed instead", () => {
    expect(parseCouncil("text")).toBeUndefined();
    expect(parseCouncil([{ role: "Judge", content: "x" }, { role: "Aggregator", content: GOOD }])).toBeUndefined();
  });
});

describe("through the approvals controller", () => {
  it("runs as an approval hook: the human can decide while the review is still running, and the review lands afterwards", async () => {
    const store = new MemoryStore();
    await store.putTask({ ...fx.task });
    const clock = fakeClock();
    let release: (r: SwarmRun) => void = () => {};
    const swarms: SwarmsRunner = { run: () => new Promise<SwarmRun>(r => { release = r; }) };
    const service = new SwarmReviewService({ store, clock, swarms, getKey: async () => "k" });
    // eslint-disable-next-line prefer-const
    let approvalsRef!: ApprovalsController;
    const sessions = new SessionsController({
      store, git: new FakeGit(), gate: new MemoryGate(), clock, machineId: "m", getKey: async () => "k",
      host: { startSession: async () => ({}), cancelSession: async () => ({}), endSession: () => {} },
      approvals: { request: i => approvalsRef.request(i) },
    });
    approvalsRef = new ApprovalsController({ store, clock, sessions, hooks: [service], identity: () => "adrian", host: { sendEvent: () => true }, notify: { show: () => {}, update: () => {} } });
    const session = await sessions.start("task_01", { provider: "anthropic", modelId: "m" });

    const pending = approvalsRef.request({ sessionId: session.id, action: { kind: "commit", message: "fix" }, reason: "ready", diffPreview: "+x" });
    await vi.waitFor(async () => expect((await store.listApprovals()).length).toBe(1));
    const [approval] = await store.listApprovals();
    await approvalsRef.resolve(approval.id, "approved", { via: "slack", userId: "brandon" });      // decided before the review returns
    expect((await pending).decision).toBe("approved");
    expect((await service.get(approval.id))!.status).toBe("running");
    release(run(GOOD));
    await vi.waitFor(async () => expect((await service.get(approval.id))!.status).toBe("done"));
    expect((await store.getApproval(approval.id))).toMatchObject({ decision: "approved", decidedBy: { userId: "brandon" } });
  });
});

describe("bridge handlers", () => {
  it("serve swarms.review.get (null when none) and swarms.review.rerun, and subscribe filters by approval", async () => {
    const s = await setup();
    const h = swarmReviewBridgeHandlers(s.service);
    expect(await h["swarms.review.get"]({ approvalId: "apr_1" })).toBeNull();
    const a = s.approval();
    await s.store.putApproval(a);
    const got: string[] = [];
    const stop = swarmReviewSubscriptions(s.service)["swarms.review.subscribe"]({ approvalId: "apr_1" }, r => got.push(r.status));
    const other: string[] = [];
    swarmReviewSubscriptions(s.service)["swarms.review.subscribe"]({ approvalId: "apr_other" }, r => other.push(r.status));
    const review = await h["swarms.review.rerun"]({ approvalId: "apr_1" });
    Requests["swarms.review.rerun"].res.parse(review);
    Requests["swarms.review.get"].res.parse(await h["swarms.review.get"]({ approvalId: "apr_1" }));
    expect(got).toEqual(["running", "done"]);
    expect(other).toEqual([]);
    stop();
  });
});
