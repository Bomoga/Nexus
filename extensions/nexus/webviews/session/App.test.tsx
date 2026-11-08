// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent, AgentSession, Envelope } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import { scriptedAgentEvents, scriptedReceipts } from "../../src/contracts/fixtures/stream";
import { createBridgeClient } from "../shared";
import type { Transport } from "../shared";
import { App, formatAge } from "./App";
import { resolveSessionId } from "./sessionId";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Req = Extract<Envelope, { t: "req" }>;
type Answers = Record<string, (body: Record<string, unknown>) => unknown>;

/** A local host the test drives: canned answers per request, manual events per subscription name. */
function setup(answers: Answers = {}) {
  const handlers = new Set<(e: Envelope) => void>();
  const posted: Envelope[] = [];
  const subs = new Map<string, string>(); // id -> name
  const sumCost = scriptedReceipts.reduce((a, r) => a + r.costUsd, 0);
  const sumBase = scriptedReceipts.reduce((a, r) => a + (r.baselineCostUsd ?? 0), 0);
  const defaults: Answers = {
    "sessions.get": () => fx.session,
    "sessions.list": () => [fx.session],
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
        let res: Envelope;
        try {
          res = fn ? { t: "res", id: env.id, ok: true, body: fn(env.body as Record<string, unknown>) } : { t: "res", id: env.id, ok: false, error: { code: "not_found", message: env.name } };
        } catch (e) {
          // An answer that throws { code, message } becomes a wire-level error, like the real host's BridgeError.
          const { code, message } = e as { code: string; message: string };
          res = { t: "res", id: env.id, ok: false, error: { code, message } };
        }
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
const statusBadge = () => screen.getByTestId("session-status").querySelector(".nx-badge") as HTMLElement;
const receiptRows = () => [...screen.getByRole("table", { name: "model call receipts" }).querySelectorAll("tbody tr")];
const receiptTotals = () => (screen.getByRole("table", { name: "model call receipts" }).querySelector("tfoot") as HTMLElement).textContent ?? "";
const seqs = () => rows().map((r) => Number(r.getAttribute("data-seq")));
const ev = (seq: number, rest: object) => ({ sessionId: "ses_01", seq, at: fx.session.startedAt, ...rest }) as AgentEvent;

describe("session view", () => {
  test("header shows task title, requested model, branch, status and CANCEL", async () => {
    const { bridge, reqs } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    expect(await screen.findByText(/Fix cart discount for qty > 1/)).toBeTruthy();
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
    expect(within(row).getAllByText(/model-written/i).length).toBeGreaterThan(0);
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
    await screen.findByText(/Fix cart discount for qty > 1/);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", ev(0, { type: "status", status: "awaiting_approval" }));
    expect(statusBadge().className).toContain("nx-badge--pending");
    emit("agent.subscribe", ev(1, { type: "status", status: "done" }));
    expect(statusBadge().className).toContain("nx-badge--ok");
    expect((screen.getByRole("button", { name: /cancel/i }) as HTMLButtonElement).disabled).toBe(true);
    emit("agent.subscribe", ev(2, { type: "status", status: "failed" }));
    expect(statusBadge().className).toContain("nx-badge--error");
  });

  test("CANCEL requests agent.cancel", async () => {
    const { bridge, reqs } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await screen.findByText(/Fix cart discount for qty > 1/);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(reqs("agent.cancel").length).toBe(1));
    expect(reqs("agent.cancel")[0].body).toEqual({ sessionId: "ses_01" });
    await waitFor(() => expect(screen.getByTestId("session-status").textContent).toMatch(/cancelled/i));
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
    expect(screen.getByText("Tests 12 passed (12)")).toBeTruthy(); // the default matcher collapses whitespace
  });

  test("RECEIPTS lists calls and totals match the fixture sums; routing is flagged", async () => {
    const routed = { ...scriptedReceipts[1], callId: "call_09", servedModel: "cheap-model", costUsd: 0.0005, pruneReceiptId: "rcpt_x" };
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    fireEvent.click(screen.getByRole("tab", { name: /receipts/i }));
    expect(await screen.findByText("rcpt_fixture_01")).toBeTruthy();
    expect(receiptRows().length).toBe(4);
    expect(receiptTotals()).toContain("0.0177");
    expect(receiptTotals()).toContain("0.0431");
    expect(receiptTotals()).toContain("0.0254");
    expect(screen.getAllByRole("button", { name: /open/i }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    await waitFor(() => expect(subbed("receipts.subscribe").length).toBe(1));
    expect(subbed("receipts.subscribe")[0].body).toEqual({ sessionId: "ses_01" });
    emit("receipts.subscribe", scriptedReceipts[0]); // duplicate callId
    expect(receiptRows().length).toBe(4);
    emit("receipts.subscribe", routed);
    expect(receiptRows().length).toBe(5);
    expect(receiptTotals()).toContain("0.0182");
    expect(screen.getByText(/cheap-model/).className).toContain("nx-tone-pending");
  });

  test("approval requests render inline; APPROVE resolves through approvals.resolve", async () => {
    const { bridge, emit, subbed, reqs } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", scriptedAgentEvents[8]);
    const row = rows()[0];
    expect(await within(row).findByText(/npm test/)).toBeTruthy();
    expect(within(row).getAllByText(/model-written/i).length).toBeGreaterThan(0);
    fireEvent.click(within(row).getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(reqs("approvals.resolve").length).toBe(1));
    expect(reqs("approvals.resolve")[0].body).toEqual({ approvalId: "apr_01", decision: "approved" });
    expect(await within(rows()[0]).findByText(/approved by app me/)).toBeTruthy();
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
    expect(await within(rows()[0]).findByText(/approved by slack U_BRANDON/)).toBeTruthy();
  });

  test("a lost race (host answers conflict) shows the winner from approvals.list, not an error", async () => {
    let decided = false;
    const winner = { ...fx.approval, decision: "approved", decidedBy: { via: "slack", userId: "U_BRANDON" }, decidedAt: fx.approval.requestedAt };
    const { bridge, emit, subbed, reqs } = setup({
      "approvals.resolve": () => {
        decided = true;
        throw { code: "conflict", message: "Already decided by U_BRANDON via slack." };
      },
      "approvals.list": () => [decided ? winner : fx.approval],
    });
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", scriptedAgentEvents[8]);
    fireEvent.click(await within(rows()[0]).findByRole("button", { name: /reject/i }));
    expect(await within(rows()[0]).findByText(/approved by slack U_BRANDON/)).toBeTruthy();
    expect(within(rows()[0]).queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByText(/Already decided/)).toBeNull();
    expect(reqs("approvals.list").length).toBe(2);
  });

  test("a late undecided copy never reopens a decided approval", async () => {
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("approvals.subscribe").length).toBe(1));
    emit("agent.subscribe", scriptedAgentEvents[8]);
    emit("approvals.subscribe", { ...fx.approval, decision: "approved", decidedBy: { via: "slack", userId: "U1" }, decidedAt: fx.approval.requestedAt });
    await within(rows()[0]).findByText(/approved by slack U1/);
    emit("approvals.subscribe", fx.approval);
    expect(within(rows()[0]).queryByRole("button", { name: /approve/i })).toBeNull();
    expect(within(rows()[0]).getByText(/approved by slack U1/)).toBeTruthy();
  });

  test("approvals.subscribe updates an approval live", async () => {
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("approvals.subscribe").length).toBe(1));
    emit("agent.subscribe", scriptedAgentEvents[8]);
    await within(rows()[0]).findByRole("button", { name: /approve/i });
    emit("approvals.subscribe", { ...fx.approval, decision: "rejected", decidedBy: { via: "auth0_push", userId: "auth0|1" }, decidedAt: fx.approval.requestedAt });
    expect(await within(rows()[0]).findByText(/rejected by auth0_push auth0\|1/)).toBeTruthy();
  });
});

describe("agent view layout", () => {
  test("approval buttons show only while undecided; a decided one states who and when", async () => {
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", ev(0, { type: "approval_request", approvalId: "apr_02" }));
    emit("agent.subscribe", ev(1, { type: "approval_request", approvalId: "apr_01" }));
    expect(await within(rows()[0]).findByText(/^approved by slack U_BRANDON at T\+/)).toBeTruthy();
    expect(within(rows()[0]).queryByRole("button", { name: /approve|reject/i })).toBeNull();
    expect(within(rows()[1]).getByRole("button", { name: /approve/i })).toBeTruthy();
    expect(within(rows()[1]).getByRole("button", { name: /reject/i })).toBeTruthy();
  });

  test("the swarm verdict badge and judges table sit on the approval card, labeled model-written", async () => {
    const { bridge, emit, subbed, reqs } = setup({ "swarms.review.get": () => fx.review });
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", ev(0, { type: "approval_request", approvalId: "apr_02" }));
    const row = rows()[0];
    expect(await within(row).findByText("LOOKS GOOD")).toBeTruthy();
    expect(reqs("swarms.review.get")[0].body).toEqual({ approvalId: "apr_02" });
    expect(within(row).getByText("judge-a")).toBeTruthy();
    expect(within(row).getByText("No negative-discount guard")).toBeTruthy();
    expect(within(row).getAllByText(/model-written/i).length).toBeGreaterThan(0);
    emit("swarms.review.subscribe", { ...fx.review, status: "unavailable", verdict: undefined });
    expect(await within(row).findByText("REVIEW UNAVAILABLE")).toBeTruthy();
  });

  test("tabs carry counts and a diff collapses", async () => {
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", ev(0, { type: "file_edit", path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new" }));
    emit("agent.subscribe", ev(1, { type: "message", text: "hi" }));
    expect(screen.getByRole("tab", { name: /^LOG\s*2$/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^DIFF\s*1$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /diff/i }));
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "COLLAPSE" }));
    expect(screen.queryByText("+new")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "EXPAND" }));
    expect(screen.getByText("+new")).toBeTruthy();
  });

  test("tool results get a check or cross glyph and the strip carries the spend", async () => {
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", ev(0, { type: "tool_result", tool: "fs.read", ok: true, summary: "read 40 lines" }));
    emit("agent.subscribe", ev(1, { type: "tool_result", tool: "cmd.run", ok: false, summary: "exit 1" }));
    expect(within(rows()[0]).getByRole("img", { name: "ok" }).textContent).toBe("✓");
    expect(within(rows()[1]).getByRole("img", { name: "failed" }).textContent).toBe("✗");
    await waitFor(() => expect(screen.getByTitle(/^nexus\/agent-ses_01 · claude-sonnet-4-5 · T\+\d\d:\d\d · .+ · \$0\.0177 \(saved 0\.0254\)$/)).toBeTruthy());
  });
});

describe("async answers after a session switch", () => {
  const mk = (id: string, m: number): AgentSession => ({ ...fx.session, id, startedAt: new Date(Date.parse(fx.session.startedAt) + m * 60_000).toISOString(), branch: `nexus/agent-${id}` });

  test("a cancel answer that lands after switching never marks the new session cancelled or shows its error", async () => {
    const list = [mk("ses_b", 5), mk("ses_a", 0)];
    const h = setup({ "sessions.list": () => list, "sessions.get": (b) => list.find((x) => x.id === b.sessionId) });
    let answer!: (ok: boolean) => void;
    const real = h.bridge.request.bind(h.bridge);
    const bridge = {
      ...h.bridge,
      request: (name: string, body: unknown, o?: unknown) =>
        name === "agent.cancel"
          ? new Promise((res, rej) => {
              answer = (ok) => (ok ? res({ ...fx.session, status: "cancelled" }) : rej({ code: "offline", message: "down" }));
            })
          : (real as (n: string, b: unknown, o?: unknown) => Promise<unknown>)(name, body, o),
    } as unknown as typeof h.bridge;
    render(<App bridge={bridge} sessionId="ses_a" />);
    await waitFor(() => expect(h.subbed("agent.subscribe").length).toBe(1));
    for (let i = 0; i < 4; i++) h.emit("agent.subscribe", ev(i, { type: "status", status: "running" }));
    await waitFor(() => expect((screen.getByRole("combobox", { name: "session" }) as HTMLSelectElement).options.length).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(answer).toBeTypeOf("function"));
    fireEvent.change(screen.getByRole("combobox", { name: "session" }), { target: { value: "ses_b" } });
    await waitFor(() => expect(h.subbed("agent.subscribe").length).toBe(2));
    h.emit("agent.subscribe", ev(1, { type: "status", status: "running" }));
    await act(async () => {
      answer(true);
    });
    expect(statusBadge().textContent).toMatch(/running/i);
    expect((screen.getByRole("button", { name: /cancel/i }) as HTMLButtonElement).disabled).toBe(false);
    // the failure path leaks nothing either
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "session" }), { target: { value: "ses_a" } });
    await waitFor(() => expect(h.subbed("agent.subscribe").length).toBe(3));
    await act(async () => {
      answer(false);
    });
    expect(screen.queryByText(/offline/)).toBeNull();
    expect((screen.getByRole("button", { name: /cancel/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("an approval_request whose id is not in approvals.list renders no buttons", async () => {
    const { bridge, emit, subbed } = setup({ "approvals.list": () => [] });
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", ev(0, { type: "approval_request", approvalId: "apr_ghost" }));
    expect(await within(rows()[0]).findByText(/apr_ghost · … loading/)).toBeTruthy();
    expect(within(rows()[0]).queryByRole("button")).toBeNull();
  });

  test("once approval_resolved was seen, an undecided stored copy shows no buttons", async () => {
    const { bridge, emit, subbed } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", ev(0, { type: "approval_request", approvalId: "apr_01" }));
    await within(rows()[0]).findByRole("button", { name: /approve/i });
    emit("agent.subscribe", ev(1, { type: "approval_resolved", approvalId: "apr_01", decision: "approved" }));
    expect(within(rows()[0]).queryByRole("button", { name: /approve|reject/i })).toBeNull();
    expect(within(rows()[0]).getByText(/approved \(resolved event\)/)).toBeTruthy();
  });

  test("the switcher refetches sessions.list on focus and shows a one-line error when that fails", async () => {
    let down = false;
    const { bridge, reqs } = setup({
      "sessions.list": () => {
        if (down) throw { code: "offline", message: "down" };
        return [fx.session];
      },
    });
    render(<App bridge={bridge} sessionId="ses_01" />);
    const select = await screen.findByRole("combobox", { name: "session" });
    await waitFor(() => expect(reqs("sessions.list").length).toBe(1));
    down = true;
    await new Promise((r) => setTimeout(r, 1100));
    fireEvent.focus(select);
    expect(await screen.findByText("sessions: offline")).toBeTruthy();
    expect(reqs("sessions.list").length).toBe(2);
  });
});

describe("session resolution", () => {
  const T = (m: number) => new Date(Date.parse(fx.session.startedAt) + m * 60_000).toISOString();
  const mk = (id: string, status: AgentSession["status"], m: number): AgentSession => ({ ...fx.session, id, status, startedAt: T(m), branch: `nexus/agent-${id}` });

  test("no id: sessions.list picks the newest running session over a newer finished one", async () => {
    const { bridge, reqs, subbed } = setup({
      "sessions.list": () => [mk("ses_old", "running", 0), mk("ses_done", "done", 30), mk("ses_run", "awaiting_approval", 10)],
      "sessions.get": (b) => mk(String(b.sessionId), "running", 10),
    });
    render(<App bridge={bridge} sessionId={undefined} />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    expect(reqs("sessions.get")[0].body).toEqual({ sessionId: "ses_run" });
    expect(subbed("agent.subscribe")[0].body).toEqual({ sessionId: "ses_run", fromSeq: 0 });
    expect((screen.getByRole("combobox", { name: "session" }) as HTMLSelectElement).value).toBe("ses_run");
  });

  test("the switcher lists sessions newest first and re-subscribes from seq 0 for the chosen one", async () => {
    const list = [mk("ses_a", "done", 0), mk("ses_b", "running", 5)];
    const { bridge, reqs, subbed } = setup({ "sessions.list": () => list, "sessions.get": (b) => list.find((x) => x.id === b.sessionId) });
    render(<App bridge={bridge} sessionId={undefined} />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    const select = screen.getByRole("combobox", { name: "session" }) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    expect([...select.options].map((o) => o.value)).toEqual(["ses_b", "ses_a"]);
    expect(select.options[0].textContent).toMatch(/^RUNNING · Fix cart discount for qty > 1 · claude-sonnet-4-5$/);
    fireEvent.change(select, { target: { value: "ses_a" } });
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(2));
    expect(subbed("agent.subscribe")[1].body).toEqual({ sessionId: "ses_a", fromSeq: 0 });
    expect(reqs("sessions.get").map((r) => r.body)).toEqual([{ sessionId: "ses_b" }, { sessionId: "ses_a" }]);
    // A later sessions.list never resets the choice.
    fireEvent.mouseDown(select);
    await waitFor(() => expect(reqs("sessions.list").length).toBe(2));
    expect(select.value).toBe("ses_a");
    expect(subbed("agent.subscribe").length).toBe(2);
  });

  test("an id from the host wins over the list", async () => {
    const { bridge, subbed } = setup({ "sessions.list": () => [mk("ses_x", "running", 50), fx.session] });
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    await waitFor(() => expect((screen.getByRole("combobox", { name: "session" }) as HTMLSelectElement).options.length).toBe(2));
    expect(subbed("agent.subscribe")[0].body).toEqual({ sessionId: "ses_01", fromSeq: 0 });
    expect(subbed("agent.subscribe").length).toBe(1);
  });

  const composerAnswers: Answers = {
    "models.list": () => fx.models.filter((m) => m.supportsTools),
    "models.selected": () => null,
    "accounts.list": () => fx.providerAccounts,
    "optimizer.get": () => fx.optimizer,
    "git.branches": () => [],
  };

  test("the composer starts on the status bar's remembered model, and a pick here is remembered the same way", async () => {
    const selects: Record<string, unknown>[] = [];
    const { bridge } = setup({
      ...composerAnswers,
      "sessions.list": () => [],
      "models.selected": () => ({ provider: "google", modelId: "gemini-3-flash-preview" }),
      "models.select": (b) => {
        selects.push(b);
        return { provider: b.provider, modelId: b.modelId };
      },
    });
    render(<App bridge={bridge} sessionId={undefined} />);
    const model = (await screen.findByRole("combobox", { name: "model" })) as HTMLSelectElement;
    await waitFor(() => expect(model.value).toBe("google/gemini-3-flash-preview")); // not the first listed (anthropic)
    fireEvent.change(model, { target: { value: "anthropic/claude-sonnet-4-5" } });
    await waitFor(() => expect(selects).toEqual([{ role: "agent", provider: "anthropic", modelId: "claude-sonnet-4-5" }]));
    expect(model.value).toBe("anthropic/claude-sonnet-4-5");
  });

  test("without a git repository the composer says so and START stays off even with a brief", async () => {
    const { bridge, reqs } = setup({
      ...composerAnswers,
      "sessions.list": () => [],
      "git.branches": () => {
        throw { code: "not_found", message: "no handler for git.branches" };
      },
    });
    render(<App bridge={bridge} sessionId={undefined} />);
    const brief = (await screen.findByRole("textbox", { name: "what should the agent do?" })) as HTMLTextAreaElement;
    expect(await screen.findByText(/no git repository open/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("combobox", { name: "model" }) as HTMLSelectElement).value).not.toBe(""));
    fireEvent.change(brief, { target: { value: "do a thing" } });
    const start = screen.getByRole("button", { name: /START/ }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.keyDown(brief, { key: "Enter" });
    expect(reqs("tasks.create").length).toBe(0);
  });

  test("an empty list shows the grey mark and a composer (no Slack thread needed), and makes no session requests", async () => {
    const { bridge, reqs, subbed } = setup({ ...composerAnswers, "sessions.list": () => [] });
    render(<App bridge={bridge} sessionId={undefined} />);
    expect(await screen.findByTestId("nexus-logo")).toBeTruthy();
    const brief = screen.getByRole("textbox", { name: "what should the agent do?" }) as HTMLTextAreaElement;
    expect(brief.value).toBe("");
    const start = screen.getByRole("button", { name: /START/ }) as HTMLButtonElement;
    expect(start.disabled).toBe(true); // nothing typed yet
    // The first agent model is preselected, with its data-use line.
    await waitFor(() => expect((screen.getByRole("combobox", { name: "model" }) as HTMLSelectElement).value).toBe("anthropic/claude-sonnet-4-5"));
    expect(screen.queryByText("no agent session yet · make a task from a Slack thread")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "session" })).toBeNull(); // no sessions to switch to
    expect(reqs("sessions.get").length + subbed("agent.subscribe").length).toBe(0);
  });

  test("START creates a manual task titled from the brief's first line, starts an agent on the chosen model and shows that session", async () => {
    const created: Record<string, unknown>[] = [];
    const started: Record<string, unknown>[] = [];
    const { bridge, reqs, subbed } = setup({
      ...composerAnswers,
      "sessions.list": () => [],
      "tasks.create": (b) => {
        created.push(b);
        return { ...fx.task, id: "task_new", title: b.title, brief: b.brief, source: { kind: "manual" }, status: "draft", codeRefs: [] };
      },
      "agent.start": (b) => {
        started.push(b);
        return { ...fx.session, id: "ses_new", taskId: "task_new", model: b.model };
      },
      "sessions.get": () => ({ ...fx.session, id: "ses_new", taskId: "task_new" }),
    });
    render(<App bridge={bridge} sessionId={undefined} />);
    const brief = (await screen.findByRole("textbox", { name: "what should the agent do?" })) as HTMLTextAreaElement;
    await waitFor(() => expect((screen.getByRole("combobox", { name: "model" }) as HTMLSelectElement).value).toBe("anthropic/claude-sonnet-4-5"));
    fireEvent.change(screen.getByRole("combobox", { name: "model" }), { target: { value: "google/gemini-3-flash-preview" } });
    fireEvent.change(brief, { target: { value: "Fix the cart total\n\nThe discount comes off once per line instead of once per unit." } });
    fireEvent.keyDown(brief, { key: "Enter", shiftKey: true }); // a new line, not a start
    expect(created.length).toBe(0);
    fireEvent.keyDown(brief, { key: "Enter" });
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    expect(created).toEqual([{ title: "Fix the cart total", brief: "Fix the cart total\n\nThe discount comes off once per line instead of once per unit." }]);
    expect(started).toEqual([{ taskId: "task_new", model: { provider: "google", modelId: "gemini-3-flash-preview" } }]);
    expect(subbed("agent.subscribe")[0].body).toEqual({ sessionId: "ses_new", fromSeq: 0 });
    expect(reqs("sessions.list").length).toBe(2); // refreshed so the switcher lists the new session
  });

  test("a failed start stays on the composer with the brief kept and the error shown", async () => {
    const { bridge, subbed } = setup({
      ...composerAnswers,
      "sessions.list": () => [],
      "tasks.create": () => {
        throw { code: "offline", message: "down" };
      },
    });
    render(<App bridge={bridge} sessionId={undefined} />);
    const brief = (await screen.findByRole("textbox", { name: "what should the agent do?" })) as HTMLTextAreaElement;
    await waitFor(() => expect((screen.getByRole("combobox", { name: "model" }) as HTMLSelectElement).value).not.toBe(""));
    fireEvent.change(brief, { target: { value: "do a thing" } });
    fireEvent.click(screen.getByRole("button", { name: /START/ }));
    expect(await screen.findByText("task: offline")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "what should the agent do?" }) as HTMLTextAreaElement).value).toBe("do a thing");
    expect(subbed("agent.subscribe").length).toBe(0);
  });

  test("NEW on a session opens the composer with the past sessions listed; clicking one shows it again", async () => {
    const { bridge, subbed } = setup({ ...composerAnswers, "sessions.list": () => [mk("ses_x", "running", 50), fx.session] });
    render(<App bridge={bridge} sessionId={undefined} />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "NEW" }));
    expect(await screen.findByTestId("nexus-logo")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "session" })).toBeNull(); // the NEW TASK dropdown is gone
    expect(subbed("agent.subscribe").length).toBe(1); // no new subscription while composing
    const rows = within(screen.getByRole("region", { name: "past sessions" })).getAllByRole("button");
    expect(rows.length).toBe(2);
    fireEvent.click(rows[1]);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(2));
    expect(subbed("agent.subscribe")[1].body).toEqual({ sessionId: "ses_01", fromSeq: 0 });
    expect(screen.queryByTestId("nexus-logo")).toBeNull();
  });

  test("the composer state reads top to bottom: composer, the mark, past sessions (newest first, with an age)", async () => {
    const { bridge } = setup({ ...composerAnswers, "sessions.list": () => [mk("ses_old", "done", 0), mk("ses_new", "done", 30)] });
    render(<App bridge={bridge} sessionId={undefined} composeSeq={1} />);
    const logo = await screen.findByTestId("nexus-logo");
    const composer = screen.getByLabelText("new agent task");
    const past = await screen.findByRole("region", { name: "past sessions" });
    expect(composer.compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(logo.compareDocumentPosition(past) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The model Select and START sit inside the composer box with the textarea.
    expect(within(composer).getByRole("combobox", { name: "model" })).toBeTruthy();
    expect(within(composer).getByRole("button", { name: /START/ })).toBeTruthy();
    expect(within(composer).getByText(/the agent works on its own branch/)).toBeTruthy();
    const rows = within(past).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("data-session"))).toEqual(["ses_new", "ses_old"]);
    expect(within(rows[0]).getByText("DONE")).toBeTruthy();
    expect(within(rows[0]).getByText(/^\d+[mhd]$|^now$/)).toBeTruthy();
  });

  test("a compose seq from the host boots on the composer even when sessions exist", async () => {
    const { bridge, reqs, subbed } = setup({ ...composerAnswers, "sessions.list": () => [mk("ses_x", "running", 50), fx.session] });
    render(<App bridge={bridge} sessionId={undefined} composeSeq={1} />);
    expect(await screen.findByTestId("nexus-logo")).toBeTruthy();
    await waitFor(() => expect(reqs("sessions.list").length).toBe(1));
    expect(subbed("agent.subscribe").length).toBe(0);
    expect(within(await screen.findByRole("region", { name: "past sessions" })).getAllByRole("button").length).toBe(2);
  });

  test("formatAge: now under a minute, then m, h and d", () => {
    const t = Date.parse("2026-01-01T12:00:00Z");
    const ago = (ms: number) => formatAge(new Date(t - ms).toISOString(), t);
    expect(ago(20_000)).toBe("now");
    expect(ago(51 * 60_000)).toBe("51m");
    expect(ago(125 * 60_000)).toBe("2h");
    expect(ago(3 * 86_400_000 + 5000)).toBe("3d");
    expect(ago(-5000)).toBe("now"); // clock skew never shows a negative age
    expect(formatAge("garbage", t)).toBe("");
  });

  test("a failing sessions.list shows an error with RETRY", async () => {
    let down = true;
    const { bridge, reqs } = setup({
      "sessions.list": () => {
        if (down) throw { code: "offline", message: "down" };
        return [fx.session];
      },
    });
    render(<App bridge={bridge} sessionId={undefined} />);
    expect(await screen.findByText("sessions: offline")).toBeTruthy();
    down = false;
    fireEvent.click(screen.getByRole("button", { name: "RETRY" }));
    expect(await screen.findByText(/Fix cart discount/)).toBeTruthy();
    expect(reqs("sessions.list").length).toBe(2);
  });
});

describe("states", () => {
  test("a not_found sessions.get shows the friendly line and RETRY re-requests", async () => {
    let missing = true;
    const { bridge, reqs } = setup({
      "sessions.get": () => {
        if (missing) throw { code: "not_found", message: "no handler for sessions.get" };
        return fx.session;
      },
    });
    render(<App bridge={bridge} sessionId="ses_01" />);
    expect(await screen.findByText(/session isn.t connected yet/)).toBeTruthy();
    expect(screen.queryByText(/no handler/)).toBeNull();
    missing = false;
    fireEvent.click(screen.getByRole("button", { name: "RETRY" }));
    expect(await screen.findByText(/Fix cart discount for qty > 1/)).toBeTruthy();
    expect(reqs("sessions.get")).toHaveLength(2);
  });

  test("a failing approvals.list does not replace the view or hide a sessions.get error", async () => {
    const down = { code: "offline", message: "down" };
    const a = setup({ "approvals.list": () => { throw down; } });
    render(<App bridge={a.bridge} sessionId="ses_01" />);
    expect(await screen.findByText(/Fix cart discount for qty > 1/)).toBeTruthy();
    expect(await screen.findByText("approvals: offline")).toBeTruthy();
    cleanup();
    const b = setup({ "sessions.get": () => { throw down; }, "approvals.list": () => { throw down; } });
    render(<App bridge={b.bridge} sessionId="ses_01" />);
    expect(await screen.findByText("session: offline")).toBeTruthy();
  });

  test("empty tabs say one line each", async () => {
    const { bridge } = setup({ "receipts.list": () => ({ receipts: [], summary: { sessionId: "ses_01", calls: 0, costUsd: 0, savedUsd: 0 } }) });
    render(<App bridge={bridge} sessionId="ses_01" />);
    await screen.findByText(/Fix cart discount for qty > 1/);
    fireEvent.click(screen.getByRole("tab", { name: /diff/i }));
    expect(screen.getByText("no diffs yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /tests/i }));
    expect(screen.getByText("no test output yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /receipts/i }));
    expect(screen.getByText("no receipts yet")).toBeTruthy();
  });

  test("a pending approval shows waiting time and the no-timeout line; time never decides it", async () => {
    const asked = Date.parse(fx.approval.requestedAt);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(asked + 10_000);
    const { bridge, emit, subbed, reqs } = setup();
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    emit("agent.subscribe", scriptedAgentEvents[8]);
    const row = rows()[0];
    expect(await within(row).findByText("waiting <1m")).toBeTruthy();
    expect(within(row).getByText("no timeout: the agent waits until someone decides")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(30_000 * 7);
    });
    expect(within(row).getByText("waiting 3m").className).toContain("nx-tone-pending");
    act(() => {
      vi.advanceTimersByTime(30 * 60_000);
    });
    expect(within(row).getByText("waiting 33m")).toBeTruthy();
    expect(within(row).getByRole("button", { name: /approve/i })).toBeTruthy();
    expect(within(row).getByRole("button", { name: /reject/i })).toBeTruthy();
    expect(reqs("approvals.resolve")).toHaveLength(0);
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

describe("reply box", () => {
  test("a live session queues the message, shows it in the log as YOU, and clears the box", async () => {
    const { bridge, emit, reqs, subbed } = setup({ "agent.message": () => fx.session });
    render(<App bridge={bridge} sessionId="ses_01" />);
    await waitFor(() => expect(subbed("agent.subscribe").length).toBe(1));
    const box = (await screen.findByLabelText("message to the agent")) as HTMLTextAreaElement;
    expect(box.placeholder).toMatch(/message the agent/);
    expect((screen.getByRole("button", { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);        // empty: nothing to send
    fireEvent.change(box, { target: { value: "  also cover the empty cart  " } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(reqs("agent.message")).toHaveLength(1));
    expect(reqs("agent.message")[0].body).toEqual({ sessionId: "ses_01", text: "also cover the empty cart" });
    await waitFor(() => expect(box.value).toBe(""));
    emit("agent.subscribe", ev(40, { type: "user_message", text: "also cover the empty cart" }));
    expect(await screen.findByText("YOU")).toBeTruthy();
    expect(screen.getByText(/also cover the empty cart/)).toBeTruthy();
  });

  test("Shift+Enter does not send, and a finished session offers CONTINUE", async () => {
    const { bridge, reqs } = setup({ "sessions.get": () => ({ ...fx.session, status: "done" }) });
    render(<App bridge={bridge} sessionId="ses_01" />);
    const box = (await screen.findByLabelText("message to the agent")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.placeholder).toMatch(/continue the session/));
    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(reqs("agent.message")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /resume/i })).toBeTruthy();
  });

  test("a failed send keeps the text and shows the error", async () => {
    const { bridge } = setup({ "agent.message": () => { throw { code: "internal", message: "Another agent session is running" }; } });
    render(<App bridge={bridge} sessionId="ses_01" />);
    const box = (await screen.findByLabelText("message to the agent")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "go on" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/Another agent session is running|message/i)).toBeTruthy());
    expect(box.value).toBe("go on");
  });
});
