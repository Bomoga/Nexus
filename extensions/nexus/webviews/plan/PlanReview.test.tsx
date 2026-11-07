// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { TaskPlan } from "../../src/contracts";
import type { Envelope } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import { createBridgeClient } from "../shared";
import type { Transport } from "../shared";
import { createFakeTransport } from "../shared/fakeBridge";
import { PlanReview } from "./PlanReview";

afterEach(cleanup);

type Overrides = Record<string, (body: unknown) => unknown | Promise<unknown>>;

/** The fake host plus request recording; `overrides` replace a request's answer (a returned { ok: false } becomes an error reply). */
function setup(overrides: Overrides = {}) {
  const inner = createFakeTransport({ liveIntervalMs: 0 });
  const posted: Envelope[] = [];
  const handlers = new Set<(e: Envelope) => void>();
  const transport: Transport = {
    listen(h) {
      handlers.add(h);
      const off = inner.listen(h);
      return () => {
        handlers.delete(h);
        off();
      };
    },
    post(env) {
      posted.push(env);
      const o = env.t === "req" ? overrides[env.name] : undefined;
      if (env.t !== "req" || !o) return inner.post(env);
      void Promise.resolve(o(env.body)).then((r) => {
        const failed = typeof r === "object" && r !== null && "ok" in r && (r as { ok: unknown }).ok === false;
        const res: Envelope = failed
          ? { t: "res", id: env.id, ok: false, error: { code: ((r as { code?: string }).code ?? "invalid_request") as "invalid_request", message: (r as { message: string }).message } }
          : { t: "res", id: env.id, ok: true, body: r };
        handlers.forEach((h) => h(res));
      });
    },
  };
  const bridge = createBridgeClient(transport);
  const reqs = (name: string) => posted.filter((e) => e.t === "req" && e.name === name) as Extract<Envelope, { t: "req" }>[];
  return { bridge, reqs };
}

const plan = (over: Record<string, unknown> = {}) =>
  TaskPlan.parse({
    ...fx.plan,
    subtasks: [
      { title: "Add failing test", brief: "line one of the brief\nline two", dependsOn: [] },
      { title: "Fix discount math", brief: "<script>alert(1)</script>", dependsOn: [0] },
      { title: "Update CHANGELOG", brief: "note it", dependsOn: [0, 1] },
    ],
    ...over,
  });

describe("PlanReview", () => {
  test("renders status, model-written label and subtasks with 1-based dependencies", () => {
    const { bridge } = setup();
    render(<PlanReview plan={plan()} bridge={bridge} />);
    expect(screen.getByText(/proposed/)).toBeTruthy();
    expect(screen.getByText("HierarchicalSwarm", { exact: false })).toBeTruthy();
    expect(screen.getByText(/model-written/i)).toBeTruthy();
    expect(screen.getByText(/left machine/i)).toBeTruthy();
    expect(screen.getByText("Add failing test")).toBeTruthy();
    expect(screen.getByText("Fix discount math")).toBeTruthy();
    expect(screen.getByText("after: 1")).toBeTruthy();
    expect(screen.getByText("after: 1, 2")).toBeTruthy();
  });

  test("briefs are collapsed to one line and expand as plain text", () => {
    const { bridge } = setup();
    const { container } = render(<PlanReview plan={plan()} bridge={bridge} />);
    expect(container.querySelector("pre")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /expand brief/i })[0]);
    expect(container.querySelector("pre")?.textContent).toBe("line one of the brief\nline two");
    fireEvent.click(screen.getByRole("button", { name: /collapse brief/i }));
    expect(container.querySelector("pre")).toBeNull();
  });

  test("a brief containing <script> renders literally", () => {
    const { bridge } = setup();
    const { container } = render(<PlanReview plan={plan()} bridge={bridge} />);
    fireEvent.click(screen.getAllByRole("button", { name: /expand brief/i })[1]);
    expect(container.querySelector("pre")?.textContent).toBe("<script>alert(1)</script>");
    expect(container.querySelector("script")).toBeNull();
  });

  test("ACCEPT calls tasks.plan.accept, shows accepted and the created count, and removes the buttons", async () => {
    const { bridge, reqs } = setup();
    render(<PlanReview plan={plan()} bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "ACCEPT" }));
    expect(await screen.findByText(/created 3 draft tasks/)).toBeTruthy();
    expect(reqs("tasks.plan.accept")[0].body).toEqual({ planId: "plan_01" });
    expect(screen.getByText(/accepted/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ACCEPT" })).toBeNull();
    expect(screen.queryByRole("button", { name: "REJECT" })).toBeNull();
  });

  test("REJECT calls tasks.plan.reject and shows rejected", async () => {
    const { bridge, reqs } = setup();
    render(<PlanReview plan={plan()} bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "REJECT" }));
    await waitFor(() => expect(screen.getByText(/rejected/)).toBeTruthy());
    expect(reqs("tasks.plan.reject")[0].body).toEqual({ planId: "plan_01" });
    expect(screen.queryByRole("button", { name: "ACCEPT" })).toBeNull();
  });

  test("both buttons are disabled while a request is in flight, and a second click sends nothing", async () => {
    let release: (v: unknown) => void = () => undefined;
    const held = new Promise((r) => (release = r));
    const { bridge, reqs } = setup({ "tasks.plan.accept": () => held });
    render(<PlanReview plan={plan()} bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "ACCEPT" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "REJECT" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "ACCEPT" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "ACCEPT" }));
    expect(reqs("tasks.plan.accept")).toHaveLength(1);
    release(plan({ status: "accepted", createdTaskIds: ["task_02", "task_03", "task_04"] }));
    expect(await screen.findByText(/created 3 draft tasks/)).toBeTruthy();
  });

  test("an accept failure shows the error and keeps the buttons", async () => {
    const { bridge } = setup({ "tasks.plan.accept": () => ({ ok: false, message: "boom" }) });
    render(<PlanReview plan={plan()} bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "ACCEPT" }));
    expect(await screen.findByText(/plan failed: boom/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "ACCEPT" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("accepted and rejected plans show no buttons", () => {
    const { bridge } = setup();
    render(<PlanReview plan={plan({ status: "accepted", createdTaskIds: ["task_02", "task_03"] })} bridge={bridge} />);
    expect(screen.queryByRole("button", { name: "ACCEPT" })).toBeNull();
    expect(screen.getByText(/created 2 draft tasks/)).toBeTruthy();
    cleanup();
    render(<PlanReview plan={plan({ status: "rejected" })} bridge={bridge} />);
    expect(screen.queryByRole("button", { name: "REJECT" })).toBeNull();
  });

  test("loads by id with tasks.plan.get", async () => {
    const { bridge, reqs } = setup();
    render(<PlanReview planId="plan_01" bridge={bridge} />);
    expect(await screen.findByText("Fix discount math")).toBeTruthy();
    expect(reqs("tasks.plan.get")[0].body).toEqual({ planId: "plan_01" });
  });

  test("a not_found load shows the friendly line and RETRY re-requests", async () => {
    let missing = true;
    const { bridge, reqs } = setup({
      "tasks.plan.get": () => (missing ? { ok: false, code: "not_found", message: "plan gone" } : fx.plan),
    });
    render(<PlanReview planId="plan_01" bridge={bridge} />);
    expect(await screen.findByText(/plan: not found/)).toBeTruthy();
    missing = false;
    fireEvent.click(screen.getByRole("button", { name: "RETRY" }));
    expect(await screen.findByText("Fix discount math")).toBeTruthy();
    expect(reqs("tasks.plan.get")).toHaveLength(2);
  });

  test("with neither id nor plan it says so and makes no request", () => {
    const { bridge, reqs } = setup();
    render(<PlanReview bridge={bridge} />);
    expect(screen.getByText("no plan id")).toBeTruthy();
    expect(reqs("tasks.plan.get")).toHaveLength(0);
  });
});
