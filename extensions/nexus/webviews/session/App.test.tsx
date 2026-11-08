// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent, AgentSession, Envelope } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import { scriptedAgentEvents, scriptedReceipts } from "../../src/contracts/fixtures/stream";
import { createBridgeClient } from "../shared";
import type { Transport } from "../shared";
import { App } from "./App";
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
    await screen.findByText(/Fix cart discount for qty > 1/);
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
    expect(screen.getByText("Tests 12 passed (12)")).toBeTruthy(); // the default matcher collapses whitespace
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
    expect(within(row).getAllByText(/model-written/i).length).toBeGreaterThan(0);
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
    expect(await within(rows()[0]).findByText(/decided by slack U_BRANDON/)).toBeTruthy();
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
    await within(rows()[0]).findByText(/decided by slack U1/);
    emit("approvals.subscribe", fx.approval);
    expect(within(rows()[0]).queryByRole("button", { name: /approve/i })).toBeNull();
    expect(within(rows()[0]).getByText(/decided by slack U1/)).toBeTruthy();
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

  test("an empty list shows one hint line and makes no session requests", async () => {
    const { bridge, reqs, subbed } = setup({ "sessions.list": () => [] });
    render(<App bridge={bridge} sessionId={undefined} />);
    expect(await screen.findByText("no agent session yet · start one from a Slack thread")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(reqs("sessions.get").length + subbed("agent.subscribe").length).toBe(0);
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
