// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentEvent, Envelope } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import { scriptedAgentEvents, scriptedReceipts } from "../../src/contracts/fixtures/stream";
import { createBridgeClient } from "../shared";
import type { Transport } from "../shared";
import { App } from "./App";
import { resolveSessionId } from "./sessionId";

afterEach(cleanup);

type Req = Extract<Envelope, { t: "req" }>;
type Answers = Record<string, (body: any) => unknown>;

/** A local host the test drives: canned answers per request, manual events per subscription name. */
function setup(answers: Answers = {}) {
  const handlers = new Set<(e: Envelope) => void>();
  const posted: Envelope[] = [];
  const subs = new Map<string, string>(); // id -> name
  const sumCost = scriptedReceipts.reduce((a, r) => a + r.costUsd, 0);
  const sumBase = scriptedReceipts.reduce((a, r) => a + (r.baselineCostUsd ?? 0), 0);
  const defaults: Answers = {
    "sessions.get": () => fx.session,
    "tasks.get": () => fx.task,
    "receipts.list": () => ({ receipts: scriptedReceipts, summary: { sessionId: "ses_01", calls: 4, costUsd: sumCost, savedUsd: sumBase - sumCost } }),
    "approvals.list": () => [fx.approval, fx.approvalDecided],
    "agent.cancel": () => ({ ...fx.session, status: "cancelled" }),
    "approvals.resolve": (b) => ({ ...fx.approval, decision: b.decision, decidedBy: { via: "app", userId: "me" }, decidedAt: fx.approval.requestedAt }),
  };
  const transport: Transport = {
    listen(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    post(env) {
      posted.push(env);
      if (env.t === "sub") subs.set(env.id, env.name);
      if (env.t !== "req") return;
      const fn = answers[env.name] ?? defaults[env.name];
      queueMicrotask(() => {
        const res: Envelope = fn ? { t: "res", id: env.id, ok: true, body: fn(env.body) } : { t: "res", id: env.id, ok: false, error: { code: "not_found", message: env.name } };
        handlers.forEach((h) => h(res));
      });
    },
  };
  const emit = (name: string, body: unknown) =>
    act(() => {
      for (const [id, n] of subs) if (n === name) handlers.forEach((h) => h({ t: "evt", id, body }));
    });
  const reqs = (name: string) => posted.filter((e): e is Req => e.t === "req" && e.name === name);
  const subbed = (name: string) => posted.filter((e): e is Extract<Envelope, { t: "sub" }> => e.t === "sub" && e.name === name);
  return { bridge: createBridgeClient(transport), emit, reqs, subbed };
}

const rows = () => screen.queryAllByTestId("log-row");
const seqs = () => rows().map((r) => Number(r.getAttribute("data-seq")));
const ev = (seq: number, rest: object) => ({ sessionId: "ses_01", seq, at: fx.session.startedAt, ...rest }) as AgentEvent;

describe("session view", () => {
  test("header shows task title, requested model, branch, status and CANCEL", async () => {
    const { bridge, reqs } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    expect(await screen.findByText("Fix cart discount for qty > 1")).toBeTruthy();
    expect(reqs("sessions.get")[0].body).toEqual({ sessionId: "ses_01" });
    expect(reqs("tasks.get")[0].body).toEqual({ taskId: "task_01" });
    expect(screen.getByText("claude-sonnet-4-5")).toBeTruthy();
    expect(screen.getByText("nexus/agent-ses_01")).toBeTruthy();
    expect((screen.getByRole("button", { name: /cancel/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("subscribes from seq 0 and replays scriptedAgentEvents as 16 rows in seq order", async () => {
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    expect(subbed("agent.subscribe")[0].body).toEqual({ sessionId: "ses_01", fromSeq: 0 });
    // Deliver out of order on purpose: the view orders by seq.
    for (const e of [...scriptedAgentEvents].reverse()) emit("agent.subscribe", e);
    expect(rows().length).toBe(16);
    expect(seqs()).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(screen.queryByText(/missing events/)).toBeNull();
  });

  test("model-written text is labeled and rendered as text", async () => {
    const { bridge, emit, subbed } = setup();
    const { container } = render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", ev(0, { type: "message", text: "<img src=x onerror=alert(1)>" }));
    expect(container.querySelector("img")).toBeNull();
    const row = rows()[0];
    expect(row.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(within(row).getByText(/model-written/i)).toBeTruthy();
  });

  test("a duplicate seq is ignored", async () => {
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", scriptedAgentEvents[0]);
    emit("agent.subscribe", scriptedAgentEvents[1]);
    emit("agent.subscribe", scriptedAgentEvents[1]);
    emit("agent.subscribe", scriptedAgentEvents[0]);
    expect(seqs()).toEqual([0, 1]);
  });

  test("a gap in seq shows one warning naming the missing events", async () => {
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    for (const i of [0, 1, 2, 3, 5]) emit("agent.subscribe", scriptedAgentEvents[i]);
    expect(screen.getAllByText(/missing events 4$/).length).toBe(1);
    emit("agent.subscribe", scriptedAgentEvents[4]);
    expect(screen.queryByText(/missing events/)).toBeNull();
    emit("agent.subscribe", scriptedAgentEvents[9]);
    expect(screen.getAllByText(/missing events 6-8$/).length).toBe(1);
  });

  test("status events drive the header status and CANCEL enablement", async () => {
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await screen.findByText("Fix cart discount for qty > 1");
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", ev(0, { type: "status", status: "awaiting_approval" }));
    expect(screen.getByTestId("session-status").className).toContain("nx-tone-pending");
    emit("agent.subscribe", ev(1, { type: "status", status: "done" }));
    expect(screen.getByTestId("session-status").className).toContain("nx-tone-ok");
    expect((screen.getByRole("button", { name: /cancel/i }) as HTMLButtonElement).disabled).toBe(true);
    emit("agent.subscribe", ev(2, { type: "status", status: "failed" }));
    expect(screen.getByTestId("session-status").className).toContain("nx-tone-error");
  });

  test("CANCEL requests agent.cancel", async () => {
    const { bridge, reqs } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await screen.findByText("Fix cart discount for qty > 1");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(reqs("agent.cancel").length).toBe(1));
    expect(reqs("agent.cancel")[0].body).toEqual({ sessionId: "ses_01" });
    await waitFor(() => expect(screen.getByTestId("session-status").textContent).toContain("cancelled"));
  });

  test("DIFF keeps the latest diff per path, colored as text", async () => {
    const { bridge, emit, subbed } = setup();
    const { container } = render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", ev(0, { type: "file_edit", path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+first" }));
    emit("agent.subscribe", ev(1, { type: "file_edit", path: "b.ts", diff: "@@ -1 +1 @@\n-x\n+y" }));
    emit("agent.subscribe", ev(2, { type: "file_edit", path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+second <b>" }));
    fireEvent.click(screen.getByRole("tab", { name: /diff/i }));
    expect(screen.getAllByTestId("diff-path").map((n) => n.textContent)).toEqual(["a.ts", "b.ts"]);
    expect(screen.queryByText("+first")).toBeNull();
    expect(screen.getByText("+second <b>").className).toContain("diff-add");
    expect(screen.getByText("-old", { selector: ".diff-del" })).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
  });

  test("TESTS shows test_output tails with command and exit code", async () => {
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", scriptedAgentEvents[10]);
    fireEvent.click(screen.getByRole("tab", { name: /tests/i }));
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText(/exit 0/)).toBeTruthy();
    expect(screen.getByText("Tests  12 passed (12)")).toBeTruthy();
  });

  test("RECEIPTS lists calls and totals match the fixture sums; routing is flagged", async () => {
    const routed = { ...scriptedReceipts[1], callId: "call_09", servedModel: "cheap-model", costUsd: 0.0005, pruneReceiptId: "rcpt_x" };
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    fireEvent.click(screen.getByRole("tab", { name: /receipts/i }));
    expect(await screen.findByText("rcpt_fixture_01")).toBeTruthy();
    expect(screen.getAllByTestId("receipt-row").length).toBe(4);
    const totals = screen.getByTestId("receipts-totals");
    expect(totals.textContent).toContain("0.0177");
    expect(totals.textContent).toContain("0.0431");
    expect(totals.textContent).toContain("0.0254");
    expect(screen.getAllByRole("button", { name: /open/i }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    await waitFor(() => expect(subbed("receipts.subscribe").length).toBe(1));
    expect(subbed("receipts.subscribe")[0].body).toEqual({ sessionId: "ses_01" });
    emit("receipts.subscribe", scriptedReceipts[0]); // duplicate callId
    expect(screen.getAllByTestId("receipt-row").length).toBe(4);
    emit("receipts.subscribe", routed);
    expect(screen.getAllByTestId("receipt-row").length).toBe(5);
    expect(screen.getByTestId("receipts-totals").textContent).toContain("0.0182");
    expect(screen.getByText(/cheap-model/).className).toContain("nx-tone-pending");
  });

  test("approval requests render inline; APPROVE resolves through approvals.resolve", async () => {
    const { bridge, emit, subbed, reqs } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", scriptedAgentEvents[8]);
    const row = rows()[0];
    expect(await within(row).findByText(/npm test/)).toBeTruthy();
    expect(within(row).getByText(/model-written/i)).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(reqs("approvals.resolve").length).toBe(1));
    expect(reqs("approvals.resolve")[0].body).toEqual({ approvalId: "apr_01", decision: "approved" });
    expect(await within(rows()[0]).findByText(/decided by app me/)).toBeTruthy();
    expect(within(rows()[0]).queryByRole("button", { name: /approve/i })).toBeNull();
  });

  test("REJECT sends rejected, and a winner from elsewhere is shown", async () => {
    const { bridge, emit, subbed, reqs } = setup({
      "approvals.resolve": () => ({ ...fx.approval, decision: "approved", decidedBy: { via: "slack", userId: "U_BRANDON" }, decidedAt: fx.approval.requestedAt }),
    });
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", scriptedAgentEvents[8]);
    const row = rows()[0];
    fireEvent.click(await within(row).findByRole("button", { name: /reject/i }));
    await waitFor(() => expect(reqs("approvals.resolve")[0].body).toEqual({ approvalId: "apr_01", decision: "rejected" }));
    expect(await within(rows()[0]).findByText(/decided by slack U_BRANDON/)).toBeTruthy();
  });

  test("approvals.subscribe updates an approval live", async () => {
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("approvals.subscribe").length).toBe(1));
    emit("agent.subscribe", scriptedAgentEvents[8]);
    await within(rows()[0]).findByRole("button", { name: /approve/i });
    emit("approvals.subscribe", { ...fx.approval, decision: "rejected", decidedBy: { via: "auth0_push", userId: "auth0|1" }, decidedAt: fx.approval.requestedAt });
    expect(await within(rows()[0]).findByText(/decided by auth0_push auth0\|1/)).toBeTruthy();
  });

  test("no session id: one line, no requests", () => {
    const { bridge, reqs, subbed } = setup();
    render(<App bridge={bridge} sessionId={undefined} />);
    expect(screen.getByText(/no session/i)).toBeTruthy();
    expect(reqs("sessions.get").length + subbed("agent.subscribe").length).toBe(0);
  });
});

describe("resolveSessionId", () => {
  test("outside fake mode there is no fallback", async () => {
    document.body.removeAttribute("data-session-id");
    expect(await resolveSessionId()).toBeUndefined();
  });
  test("body attribute wins", async () => {
    document.body.dataset.sessionId = "ses_77";
    expect(await resolveSessionId()).toBe("ses_77");
    document.body.removeAttribute("data-session-id");
  });
});
