// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ApprovalRequest, Envelope, SwarmReview } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import { createBridgeClient } from "../shared";
import type { Transport } from "../shared";
import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Req = Extract<Envelope, { t: "req" }>;
type Answers = Record<string, (body: Record<string, unknown>) => unknown>;

/** A local host the test drives: canned (possibly async) answers per request, manual events per subscription name. */
function setup(answers: Answers = {}) {
  const handlers = new Set<(e: Envelope) => void>();
  const posted: Envelope[] = [];
  const subs = new Map<string, string>();
  const transport: Transport = {
    listen(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    post(env) {
      posted.push(env);
      if (env.t === "sub") subs.set(env.id, env.name);
      if (env.t !== "req") return;
      const fn = answers[env.name];
      void Promise.resolve()
        .then(() => (fn ? fn(env.body as Record<string, unknown>) : Promise.reject(new Error("no answer"))))
        .then(
          (body) => handlers.forEach((h) => h({ t: "res", id: env.id, ok: true, body })),
          (err) => {
            const code = (err as { code?: string }).code ?? "not_found";
            handlers.forEach((h) => h({ t: "res", id: env.id, ok: false, error: { code: code as "not_found", message: err instanceof Error ? err.message : env.name } }));
          },
        );
    },
  };
  const emit = (name: string, body: unknown) =>
    act(() => {
      for (const [id, n] of subs) if (n === name) handlers.forEach((h) => h({ t: "evt", id, body }));
    });
  const reqs = (name: string) => posted.filter((e): e is Req => e.t === "req" && e.name === name);
  const subbed = (name: string) => posted.filter((e) => e.t === "sub" && e.name === name);
  return { bridge: createBridgeClient(transport), emit, reqs, subbed };
}

const base = fx.approval;
const mk = (id: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ ...base, id, ...over });
const commit = (id: string, over: Partial<ApprovalRequest> = {}) =>
  mk(id, { action: { kind: "commit", message: "fix cart discount" }, diffPreview: "--- a/x\n+++ b/x\n-old\n+new", ...over });
const decidedApp = { decision: "approved" as const, decidedBy: { via: "app" as const, userId: "me" }, decidedAt: "2026-11-07T04:00:00Z" };
const rev = (approvalId: string, over: Partial<SwarmReview> = {}): SwarmReview => ({ ...fx.review, id: `rev_${approvalId}`, approvalId, ...over });
const noBody = { verdict: undefined, summary: undefined, judges: undefined };

const rows = () => screen.queryAllByTestId("approval-row");
const ids = () => rows().map((r) => r.getAttribute("data-id"));
const row = (id: string) => rows().find((r) => r.getAttribute("data-id") === id) as HTMLElement;
const btn = (scope: HTMLElement, name: RegExp) => within(scope).getByRole("button", { name }) as HTMLButtonElement;
const mount = async (list: ApprovalRequest[], extra: Answers = {}) => {
  const s = setup({ "approvals.list": () => list, "swarms.review.get": () => null, ...extra });
  render(<App bridge={s.bridge} />);
  if (list.length) await waitFor(() => expect(rows().length).toBe(list.length));
  return s;
};

describe("approvals states", () => {
  test("a not_found approvals.list shows the friendly line and RETRY re-requests", async () => {
    let missing = true;
    const s = setup({
      "approvals.list": () => {
        if (missing) throw Object.assign(new Error("no handler for approvals.list"), { code: "not_found" });
        return [];
      },
    });
    render(<App bridge={s.bridge} />);
    expect(await screen.findByText("approvals isn't connected yet")).toBeTruthy();
    expect(screen.queryByText(/no handler/)).toBeNull();
    missing = false;
    fireEvent.click(screen.getByRole("button", { name: "RETRY" }));
    expect(await screen.findByText("No approvals")).toBeTruthy();
    expect(s.reqs("approvals.list")).toHaveLength(2);
    expect(screen.queryByText("approvals isn't connected yet")).toBeNull();
  });

  test("a failed review.get has RETRY that asks again", async () => {
    let down = true;
    const s = await mount([commit("c1")], {
      "swarms.review.get": () => {
        if (down) throw new Error("down");
        return null;
      },
    });
    expect(await screen.findByText("review: not found")).toBeTruthy();
    down = false;
    fireEvent.click(screen.getByRole("button", { name: "RETRY" }));
    await waitFor(() => expect(s.reqs("swarms.review.get")).toHaveLength(2));
    expect(screen.queryByText("review: not found")).toBeNull();
  });

  test("a pending approval shows amber waiting time and the no-timeout line; time never decides it", async () => {
    const asked = Date.parse(base.requestedAt);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(asked + 10_000);
    const s = await mount([mk("a1"), mk("a2", { requestedAt: new Date(asked + 5 * 60_000).toISOString() })]);
    expect(within(row("a1")).getByText("waiting <1m").className).toContain("nx-tone-pending");
    expect(within(row("a1")).getAllByText("no timeout: the agent waits until someone decides")).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(30_000 * 20);
    });
    expect(within(row("a1")).getByText("waiting 10m")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(3 * 3_600_000);
    });
    for (const id of ["a1", "a2"]) {
      expect(btn(row(id), /approve/i).disabled).toBe(false);
      expect(within(row(id)).getByText("pending")).toBeTruthy();
    }
    expect(s.reqs("approvals.resolve")).toHaveLength(0);
  });

  test("a decided approval has no waiting line", async () => {
    await mount([mk("d1", decidedApp)]);
    expect(within(row("d1")).queryByText(/waiting/)).toBeNull();
    expect(within(row("d1")).queryByText(/no timeout/)).toBeNull();
  });
});

describe("approvals view", () => {
  test("empty list shows one line", async () => {
    const s = setup({ "approvals.list": () => [] });
    render(<App bridge={s.bridge} />);
    expect(await screen.findByText("No approvals")).toBeTruthy();
    expect(s.reqs("approvals.list")[0].body).toEqual({ pendingOnly: false });
  });

  test("pending first (oldest request on top), then decided newest decision first", async () => {
    await mount([
      mk("d_old", { ...decidedApp, decidedAt: "2026-11-07T04:00:00Z" }),
      mk("p_new", { requestedAt: "2026-11-07T05:00:00Z" }),
      mk("d_new", { ...decidedApp, decidedAt: "2026-11-07T06:00:00Z" }),
      mk("p_old", { requestedAt: "2026-11-07T03:30:00Z" }),
    ]);
    expect(ids()).toEqual(["p_old", "p_new", "d_new", "d_old"]);
  });

  test("run_command shows the command in monospace with the model-written reason and T+ time", async () => {
    await mount([mk("a1", { action: { kind: "run_command", command: "npm test" }, requestedAt: "2026-11-07T05:07:00Z" })]);
    const cmd = within(row("a1")).getByText("npm test");
    expect(cmd.className).toContain("nx-data");
    expect(within(row("a1")).getAllByText(/model-written/i).length).toBeGreaterThan(0);
    expect(within(row("a1")).getByText("T+02:07")).toBeTruthy();
  });

  test("commit shows the message and a collapsed diff that expands and collapses", async () => {
    await mount([commit("c1")]);
    const r = row("c1");
    expect(within(r).getByText("fix cart discount")).toBeTruthy();
    expect(r.textContent).not.toContain("+new");
    fireEvent.click(btn(r, /diff/i));
    const pre = within(r).getByText(/\+new/);
    expect(pre.tagName).toBe("PRE");
    expect(pre.className).toContain("nx-data");
    fireEvent.click(btn(r, /diff/i));
    expect(r.textContent).not.toContain("+new");
  });

  test("APPROVE resolves via approvals.resolve and shows the returned decider", async () => {
    const s = await mount([mk("a1")], {
      "approvals.resolve": (b) => mk("a1", { decision: b.decision as "approved", decidedBy: { via: "app", userId: "me" }, decidedAt: "2026-11-07T04:00:00Z" }),
    });
    fireEvent.click(btn(row("a1"), /approve/i));
    await waitFor(() => expect(row("a1").textContent).toMatch(/decided by me via app/));
    expect(s.reqs("approvals.resolve")[0].body).toEqual({ approvalId: "a1", decision: "approved" });
    expect(within(row("a1")).queryByRole("button", { name: /approve/i })).toBeNull();
  });

  test("a conflict from the host shows no error and re-lists to show the winner", async () => {
    let decided = false;
    const winner = mk("a1", { decision: "rejected", decidedBy: { via: "slack", userId: "U_BRANDON" }, decidedAt: "2026-11-07T04:00:00Z" });
    const s = await mount([mk("a1")], {
      "approvals.list": () => (decided ? [winner] : [mk("a1")]),
      "approvals.resolve": () => {
        decided = true;
        throw Object.assign(new Error("Already decided by U_BRANDON via slack."), { code: "conflict" });
      },
      "slack.users": () => fx.slackUsers,
    });
    fireEvent.click(btn(row("a1"), /approve/i));
    await waitFor(() => expect(row("a1").textContent).toMatch(/decided by Brandon via slack/));
    expect(row("a1").textContent).toMatch(/rejected/i);
    expect(s.reqs("approvals.list").length).toBe(2);
    expect(screen.queryByText(/failed|Already decided/i)).toBeNull();
    expect(within(row("a1")).queryByRole("button", { name: /approve/i })).toBeNull();
  });

  test("a successful resolve renders the returned approval", async () => {
    await mount([mk("a1")], { "approvals.resolve": () => mk("a1", { decision: "rejected", decidedBy: { via: "app", userId: "me" }, decidedAt: "2026-11-07T04:00:00Z" }) });
    fireEvent.click(btn(row("a1"), /reject/i));
    await waitFor(() => expect(row("a1").textContent).toMatch(/rejected/i));
    expect(row("a1").textContent).toMatch(/decided by me via app/);
  });

  test("a decided approval without decidedBy shows 'decided' and no buttons", async () => {
    await mount([mk("a1", { decision: "approved", decidedAt: "2026-11-07T04:00:00Z" })]);
    expect(row("a1").textContent).toMatch(/decided T\+/);
    expect(row("a1").textContent).not.toMatch(/decided by/);
    expect(within(row("a1")).queryByRole("button", { name: /approve|reject/i })).toBeNull();
  });

  test("decider name falls back to the id when slack.users fails", async () => {
    await mount([mk("a1", { decision: "approved", decidedBy: { via: "slack", userId: "U_GONE" }, decidedAt: "2026-11-07T04:00:00Z" })]);
    await waitFor(() => expect(row("a1").textContent).toMatch(/decided by U_GONE via slack/));
  });

  test("auth0_push is shown as 'auth0 push' and needs no lookup", async () => {
    const s = await mount([mk("a1", { decision: "approved", decidedBy: { via: "auth0_push", userId: "auth0|abc" }, decidedAt: "2026-11-07T04:00:00Z" })]);
    expect(row("a1").textContent).toMatch(/decided by auth0\|abc via auth0 push/);
    expect(s.reqs("slack.users").length).toBe(0);
  });

  test("a late undecided subscribe event never reopens a decided approval", async () => {
    const s = await mount([mk("a1", decidedApp)]);
    await waitFor(() => expect(s.subbed("approvals.subscribe").length).toBe(1));
    s.emit("approvals.subscribe", mk("a1"));
    expect(row("a1").textContent).toMatch(/decided by me via app/);
    expect(within(row("a1")).queryByRole("button", { name: /approve/i })).toBeNull();
  });

  test("a live subscribe event adds a new pending approval", async () => {
    const s = await mount([mk("a1")]);
    await waitFor(() => expect(s.subbed("approvals.subscribe").length).toBe(1));
    s.emit("approvals.subscribe", mk("a2", { requestedAt: "2026-11-07T09:00:00Z" }));
    expect(ids()).toEqual(["a1", "a2"]);
  });

  test("busy state is per approval id", async () => {
    let release: (v: ApprovalRequest) => void = () => {};
    const s = await mount([mk("a1"), mk("a2", { requestedAt: "2026-11-07T09:00:00Z" })], {
      "approvals.resolve": () => new Promise<ApprovalRequest>((r) => (release = r)),
    });
    fireEvent.click(btn(row("a1"), /approve/i));
    await waitFor(() => expect(btn(row("a1"), /approve/i).disabled).toBe(true));
    expect(btn(row("a1"), /reject/i).disabled).toBe(true);
    expect(btn(row("a2"), /approve/i).disabled).toBe(false);
    expect(btn(row("a2"), /reject/i).disabled).toBe(false);
    expect(s.reqs("approvals.resolve").length).toBe(1);
    release(mk("a1", decidedApp));
    await waitFor(() => expect(row("a1").textContent).toMatch(/decided by me/));
  });

  test("a failed resolve shows an error that clears on the next success", async () => {
    let fail = true;
    await mount([mk("a1"), mk("a2", { requestedAt: "2026-11-07T09:00:00Z" })], {
      "approvals.resolve": (b) => {
        if (fail && b.approvalId === "a1") throw new Error("boom");
        return mk(b.approvalId as string, decidedApp);
      },
    });
    fireEvent.click(btn(row("a1"), /approve/i));
    expect(await screen.findByText("approvals: not found")).toBeTruthy();
    expect(btn(row("a1"), /approve/i).disabled).toBe(false);
    fail = false;
    fireEvent.click(btn(row("a2"), /approve/i));
    await waitFor(() => expect(row("a2").textContent).toMatch(/decided by me/));
    expect(screen.queryByText("approvals: not found")).toBeNull();
  });

  test("reason is model-written and rendered literally", async () => {
    await mount([mk("a1", { reason: "<img src=x onerror=alert(1)>" })]);
    expect(document.body.querySelector("img")).toBeNull();
    expect(row("a1").textContent).toContain("<img src=x onerror=alert(1)>");
    expect(within(row("a1")).getAllByText(/model-written/i).length).toBeGreaterThan(0);
  });
});

describe("swarm card", () => {
  const review = (r: SwarmReview | null) => ({ "swarms.review.get": () => r });

  test("running: text only, buttons stay enabled", async () => {
    await mount([commit("c1")], review(rev("c1", { status: "running", ...noBody })));
    await waitFor(() => expect(within(row("c1")).getByText(/council reviewing/i)).toBeTruthy());
    expect(btn(row("c1"), /approve/i).disabled).toBe(false);
    expect(btn(row("c1"), /reject/i).disabled).toBe(false);
  });

  test("done: verdict chip, summary, left machine label, expandable judges", async () => {
    const s = await mount([commit("c1")], review(rev("c1")));
    const r = row("c1");
    expect(await within(r).findByText("looks_good")).toBeTruthy();
    expect(within(r).getByText(/Fix is minimal/)).toBeTruthy();
    expect(within(r).getByText(/left machine · model-written/i)).toBeTruthy();
    expect(r.textContent).not.toContain("Correct arithmetic");
    fireEvent.click(btn(r, /judges/i));
    expect(within(r).getByText(/Correct arithmetic/)).toBeTruthy();
    expect(within(r).getByText(/No negative-discount guard/)).toBeTruthy();
    expect(s.reqs("swarms.review.get")[0].body).toEqual({ approvalId: "c1" });
  });

  test("verdict chip tone follows the verdict", async () => {
    await mount([commit("g"), commit("c"), commit("d")], {
      "swarms.review.get": (b) => rev(b.approvalId as string, { verdict: ({ g: "looks_good", c: "concerns", d: "do_not_merge" } as const)[b.approvalId as "g"] }),
    });
    await waitFor(() => expect(within(row("d")).getByText("do_not_merge")).toBeTruthy());
    expect(within(row("g")).getByText("looks_good").className).toContain("nx-tone-ok");
    expect(within(row("c")).getByText("concerns").className).toContain("nx-tone-pending");
    expect(within(row("d")).getByText("do_not_merge").className).toContain("nx-tone-error");
  });

  test("do_not_merge never disables APPROVE or REJECT", async () => {
    await mount([commit("c1")], review(rev("c1", { verdict: "do_not_merge" })));
    await waitFor(() => expect(within(row("c1")).getByText("do_not_merge")).toBeTruthy());
    expect(btn(row("c1"), /approve/i).disabled).toBe(false);
    expect(btn(row("c1"), /reject/i).disabled).toBe(false);
  });

  test("unavailable: one line and RE-RUN calls swarms.review.rerun", async () => {
    const s = await mount([commit("c1")], {
      ...review(rev("c1", { status: "unavailable", ...noBody })),
      "swarms.review.rerun": () => rev("c1", { id: "rev_c1_2", status: "running", ...noBody, at: "2026-11-07T05:00:00Z" }),
    });
    await waitFor(() => expect(within(row("c1")).getByText(/review unavailable/i)).toBeTruthy());
    expect(btn(row("c1"), /approve/i).disabled).toBe(false);
    fireEvent.click(btn(row("c1"), /re-run/i));
    await waitFor(() => expect(s.reqs("swarms.review.rerun")[0]?.body).toEqual({ approvalId: "c1" }));
    await waitFor(() => expect(within(row("c1")).getByText(/council reviewing/i)).toBeTruthy());
  });

  test("a live review event updates the card; the newest at wins per approval", async () => {
    const s = await mount([commit("c1")], review(null));
    await waitFor(() => expect(s.subbed("swarms.review.subscribe").length).toBe(1));
    s.emit("swarms.review.subscribe", rev("c1", { status: "done", summary: "newer", at: "2026-11-07T05:00:00Z" }));
    expect(within(row("c1")).getByText(/newer/)).toBeTruthy();
    s.emit("swarms.review.subscribe", rev("c1", { status: "running", ...noBody, at: "2026-11-07T04:00:00Z" }));
    expect(within(row("c1")).getByText(/newer/)).toBeTruthy();
  });

  test("swarm summary and judge notes are model-written text, rendered literally", async () => {
    await mount([commit("c1")], review(rev("c1", { summary: "<b>hi</b>", judges: [{ modelId: "j", verdict: "concerns", notes: "<img src=x onerror=alert(1)>" }] })));
    const r = row("c1");
    expect(await within(r).findByText("<b>hi</b>")).toBeTruthy();
    fireEvent.click(btn(r, /judges/i));
    expect(r.querySelector("img")).toBeNull();
    expect(r.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("a late running snapshot with the same id and time never replaces a finished review", async () => {
    const s = await mount([commit("c1")], review(null));
    await waitFor(() => expect(s.subbed("swarms.review.subscribe").length).toBe(1));
    s.emit("swarms.review.subscribe", rev("c1", { status: "done", summary: "finished" }));
    s.emit("swarms.review.subscribe", rev("c1", { status: "running", ...noBody }));
    expect(within(row("c1")).getByText(/finished/)).toBeTruthy();
    expect(within(row("c1")).queryByText(/council reviewing/i)).toBeNull();
  });

  test("commit message and other description are labeled model-written", async () => {
    await mount([commit("c1"), mk("o1", { action: { kind: "other", description: "do a thing" } })]);
    expect(row("c1").querySelectorAll(".ap-label").length).toBe(2);
    expect(row("o1").querySelectorAll(".ap-label").length).toBe(2);
  });

  test("a failed swarms.review.get shows an error", async () => {
    await mount([commit("c1")], { "swarms.review.get": () => { throw new Error("down"); } });
    expect(await screen.findByText("review: not found")).toBeTruthy();
  });

  test("a failed RE-RUN shows an error and RE-RUN is disabled while it runs", async () => {
    let fail: (e: Error) => void = () => {};
    await mount([commit("c1")], {
      "swarms.review.get": () => rev("c1", { status: "unavailable", ...noBody }),
      "swarms.review.rerun": () => new Promise((_, rej) => (fail = rej)),
    });
    await waitFor(() => expect(within(row("c1")).getByText(/review unavailable/i)).toBeTruthy());
    fireEvent.click(btn(row("c1"), /re-run/i));
    await waitFor(() => expect(btn(row("c1"), /re-run/i).disabled).toBe(true));
    expect(btn(row("c1"), /approve/i).disabled).toBe(false);
    fail(new Error("nope"));
    expect(await screen.findByText("review: not found")).toBeTruthy();
    expect(btn(row("c1"), /re-run/i).disabled).toBe(false);
  });

  test("non-commit approvals never fetch a review", async () => {
    const s = await mount([mk("a1")]);
    expect(s.reqs("swarms.review.get").length).toBe(0);
  });
});
