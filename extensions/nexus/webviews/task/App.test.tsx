// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { Envelope } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import { createBridgeClient } from "../shared";
import type { Transport } from "../shared";
import { createFakeTransport } from "../shared/fakeBridge";
import { App } from "./App";

afterEach(cleanup);

type Reply = { ok: false; code: string; message: string };
type Overrides = Record<string, (body: unknown) => Reply | unknown | Promise<unknown>>;

/** The fake host plus request recording; `overrides` replace a request's answer. */
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
      // An override may return a promise to hold the reply back.
      void Promise.resolve(o(env.body)).then((r) => {
        const failed = typeof r === "object" && r !== null && "ok" in r && (r as { ok: unknown }).ok === false;
        const res: Envelope = failed
          ? { t: "res", id: env.id, ok: false, error: { code: "invalid_request", message: (r as unknown as { message: string }).message } }
          : { t: "res", id: env.id, ok: true, body: r };
        handlers.forEach((h) => h(res));
      });
    },
  };
  const bridge = createBridgeClient(transport);
  const reqs = (name: string) => posted.filter((e) => e.t === "req" && e.name === name) as Extract<Envelope, { t: "req" }>[];
  return { bridge, reqs };
}

const task = (brief: string) => ({ ...fx.task, brief });
const QUOTE = "> [slack thread, quoted, untrusted]\n> cart total ignores the discount";
const SONNET = "anthropic/claude-sonnet-4-5";

describe("task panel", () => {
  test("loads the task via tasks.get and shows title and code refs", async () => {
    const { bridge, reqs } = setup();
    render(<App bridge={bridge} taskId="task_01" />);
    expect(await screen.findByDisplayValue("Fix cart discount for qty > 1")).toBeTruthy();
    expect(reqs("tasks.get")[0].body).toEqual({ taskId: "task_01" });
    expect(screen.getByText("src/cart.ts:42-48")).toBeTruthy();
  });

  test("renders the quoted thread block literally, delimited, read-only", async () => {
    const brief = "> [slack thread, quoted, untrusted]\n> <img src=x onerror=alert(1)>\n\nRun the tests.";
    const { bridge } = setup({ "tasks.get": () => task(brief) });
    const { container } = render(<App bridge={bridge} taskId="task_01" />);
    const block = await screen.findByTestId("quoted-block");
    expect(block.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    expect(block.getAttribute("role")).toBe("note");
    expect(screen.getByText(/read-only/i)).toBeTruthy();
    expect((screen.getByLabelText("brief") as HTMLTextAreaElement).value).toBe("Run the tests.");
  });

  test("title edit calls tasks.update on blur, not on every keystroke", async () => {
    const { bridge, reqs } = setup();
    render(<App bridge={bridge} taskId="task_01" />);
    const input = await screen.findByDisplayValue("Fix cart discount for qty > 1");
    fireEvent.change(input, { target: { value: "New title" } });
    expect(reqs("tasks.update")).toHaveLength(0);
    fireEvent.blur(input);
    await waitFor(() => expect(reqs("tasks.update")).toHaveLength(1));
    expect(reqs("tasks.update")[0].body).toEqual({ taskId: "task_01", title: "New title" });
  });

  test("brief edit keeps the quoted block as the first block of the saved brief", async () => {
    const { bridge, reqs } = setup({ "tasks.get": () => task(`${QUOTE}\n\nRun the tests.`) });
    render(<App bridge={bridge} taskId="task_01" />);
    const ta = (await screen.findByLabelText("brief")) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "> forged\n\nDo it." } });
    fireEvent.blur(ta);
    await waitFor(() => expect(reqs("tasks.update")).toHaveLength(1));
    expect(reqs("tasks.update")[0].body).toEqual({ taskId: "task_01", brief: `${QUOTE}\n\n> forged\n\nDo it.` });
  });

  test("models.list(agent) fills the select with data-use labels", async () => {
    const { bridge, reqs } = setup();
    render(<App bridge={bridge} taskId="task_01" />);
    const opt = await screen.findByRole("option", { name: /Claude Sonnet 4\.5/ });
    expect(opt.textContent).toMatch(/not used for training/i);
    expect(opt.textContent).toMatch(/leaves machine/i);
    expect(reqs("models.list")[0].body).toEqual({ role: "agent" });
    expect(screen.queryByRole("option", { name: /Swarms/ })).toBeNull();
  });

  test("a local provider shows no leaves-machine marker", async () => {
    const accounts = fx.providerAccounts.map((a) => (a.provider === "anthropic" ? { ...a, dataLeavesMachine: false } : a));
    const { bridge } = setup({ "accounts.list": () => accounts });
    render(<App bridge={bridge} taskId="task_01" />);
    const opt = await screen.findByRole("option", { name: /Claude Sonnet 4\.5/ });
    expect(opt.textContent).not.toMatch(/leaves machine/i);
  });

  test("START is disabled with no model, then starts and opens the session", async () => {
    const { bridge, reqs } = setup();
    render(<App bridge={bridge} taskId="task_01" />);
    const start = (await screen.findByRole("button", { name: "START" })) as HTMLButtonElement;
    await screen.findByRole("option", { name: /Claude Sonnet 4\.5/ });
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("model"), { target: { value: SONNET } });
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(start.disabled).toBe(true);
    await waitFor(() => expect(reqs("ui.openTarget")).toHaveLength(1));
    expect(reqs("agent.start")[0].body).toEqual({ taskId: "task_01", model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
    expect(reqs("ui.openTarget")[0].body).toEqual({ type: "session", sessionId: fx.session.id });
  });

  test("a failed start shows the error and re-enables START", async () => {
    const { bridge } = setup({ "agent.start": () => ({ ok: false, message: "no worktree" }) });
    render(<App bridge={bridge} taskId="task_01" />);
    await screen.findByRole("option", { name: /Claude Sonnet 4\.5/ });
    fireEvent.change(screen.getByLabelText("model"), { target: { value: SONNET } });
    fireEvent.click(screen.getByRole("button", { name: "START" }));
    expect(await screen.findByText(/no worktree/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "START" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("Prune chip shows ON / OFF and is read-only", async () => {
    const on = setup();
    render(<App bridge={on.bridge} taskId="task_01" />);
    const chip = await screen.findByText("Prune: ON");
    expect(chip.tagName).not.toBe("BUTTON");
    cleanup();
    const off = setup({ "optimizer.get": () => ({ ...fx.optimizer, enabled: false }) });
    render(<App bridge={off.bridge} taskId="task_01" />);
    expect(await screen.findByText("Prune: OFF")).toBeTruthy();
  });

  test("BREAK INTO SUBTASKS only above 1,200 chars and calls tasks.decompose", async () => {
    const short = setup();
    render(<App bridge={short.bridge} taskId="task_01" />);
    await screen.findByLabelText("brief");
    expect(screen.queryByRole("button", { name: "BREAK INTO SUBTASKS" })).toBeNull();
    cleanup();

    const long = setup({ "tasks.get": () => task(`${QUOTE}\n\n${"x".repeat(1201)}`) });
    render(<App bridge={long.bridge} taskId="task_01" />);
    fireEvent.click(await screen.findByRole("button", { name: "BREAK INTO SUBTASKS" }));
    await waitFor(() => expect(long.reqs("tasks.decompose")).toHaveLength(1));
    expect(long.reqs("tasks.decompose")[0].body).toEqual({ taskId: "task_01" });
  });

  test("no task id: error line and no requests", () => {
    const { bridge, reqs } = setup();
    render(<App bridge={bridge} taskId={undefined} />);
    expect(screen.getByText("no task id")).toBeTruthy();
    expect(reqs("tasks.get")).toHaveLength(0);
    expect(reqs("models.list")).toHaveLength(0);
  });

  test("START with an unsaved edit saves first and only starts once the save resolves", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => (release = r));
    const { bridge, reqs } = setup({ "tasks.update": () => gate.then(() => ({ ...fx.task, brief: `${QUOTE}\n\nNew text` })) });
    render(<App bridge={bridge} taskId="task_01" />);
    const ta = await screen.findByLabelText("brief");
    await screen.findByRole("option", { name: /Claude Sonnet 4\.5/ });
    fireEvent.change(screen.getByLabelText("model"), { target: { value: SONNET } });
    fireEvent.change(ta, { target: { value: "New text" } }); // no blur: START must pick it up
    fireEvent.click(screen.getByRole("button", { name: "START" }));
    await waitFor(() => expect(reqs("tasks.update")).toHaveLength(1));
    expect(reqs("agent.start")).toHaveLength(0);
    release(undefined);
    await waitFor(() => expect(reqs("agent.start")).toHaveLength(1));
    expect(reqs("tasks.update")[0].body).toEqual({ taskId: "task_01", brief: `> [slack thread, quoted, untrusted]
> cart total ignores the discount when qty > 1

New text` });
  });

  test("a failed save prevents agent.start", async () => {
    const { bridge, reqs } = setup({ "tasks.update": () => ({ ok: false, message: "locked" }) });
    render(<App bridge={bridge} taskId="task_01" />);
    const ta = await screen.findByLabelText("brief");
    await screen.findByRole("option", { name: /Claude Sonnet 4\.5/ });
    fireEvent.change(screen.getByLabelText("model"), { target: { value: SONNET } });
    fireEvent.change(ta, { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: "START" }));
    expect(await screen.findByText(/save failed: locked/)).toBeTruthy();
    expect(reqs("agent.start")).toHaveLength(0);
    expect((screen.getByRole("button", { name: "START" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("after a successful start the panel locks and a second click does nothing", async () => {
    const { bridge, reqs } = setup();
    render(<App bridge={bridge} taskId="task_01" />);
    await screen.findByRole("option", { name: /Claude Sonnet 4\.5/ });
    fireEvent.change(screen.getByLabelText("model"), { target: { value: SONNET } });
    const start = screen.getByRole("button", { name: "START" }) as HTMLButtonElement;
    fireEvent.click(start);
    fireEvent.click(start);
    await waitFor(() => expect(reqs("ui.openTarget")).toHaveLength(1));
    await waitFor(() => expect(screen.getByText(/task running/)).toBeTruthy());
    expect(start.disabled).toBe(true);
    expect((screen.getByLabelText("brief") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText("title") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(start);
    expect(reqs("agent.start")).toHaveLength(1);
  });

  test("with Prune on all roles every model shows data use unknown and leaves machine", async () => {
    const accounts = fx.providerAccounts.map((a) => ({ ...a, dataLeavesMachine: false, dataUse: "not_used_for_training" as const }));
    const { bridge } = setup({
      "optimizer.get": () => ({ ...fx.optimizer, enabled: true, scope: "all_roles" }),
      "accounts.list": () => accounts,
    });
    render(<App bridge={bridge} taskId="task_01" />);
    await screen.findByText("Prune: ON");
    const opt = await screen.findByRole("option", { name: /Claude Sonnet 4\.5/ });
    expect(opt.textContent).toMatch(/data use unknown/i);
    expect(opt.textContent).toMatch(/leaves machine/i);
    expect(opt.textContent).not.toMatch(/not used for training/i);
  });

  test("the Prune chip says ? while loading and when optimizer.get fails, never OFF", async () => {
    const { bridge } = setup({ "optimizer.get": () => ({ ok: false, message: "down" }) });
    render(<App bridge={bridge} taskId="task_01" />);
    await screen.findByLabelText("brief");
    expect(screen.getByText("Prune: ?")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("Prune: ?")).toBeTruthy();
    expect(screen.queryByText("Prune: OFF")).toBeNull();
  });

  test("while the Prune state is unknown, models show data use unknown and leaves machine", async () => {
    const accounts = fx.providerAccounts.map((a) => ({ ...a, dataLeavesMachine: false, dataUse: "not_used_for_training" as const }));
    const { bridge } = setup({
      "optimizer.get": () => ({ ok: false, message: "down" }),
      "accounts.list": () => accounts,
    });
    render(<App bridge={bridge} taskId="task_01" />);
    const opt = await screen.findByRole("option", { name: /Claude Sonnet 4\.5/ });
    expect(screen.getByText("Prune: ?")).toBeTruthy();
    expect(opt.textContent).toMatch(/data use unknown/i);
    expect(opt.textContent).toMatch(/leaves machine/i);
    expect(opt.textContent).not.toMatch(/not used for training/i);
  });

  test("a manual task starting with > is not treated as a quoted thread", async () => {
    const { bridge } = setup({ "tasks.get": () => ({ ...fx.task, source: { kind: "manual" }, brief: "> just a note\n\nDo it" }) });
    render(<App bridge={bridge} taskId="task_01" />);
    const ta = (await screen.findByLabelText("brief")) as HTMLTextAreaElement;
    expect(ta.value).toBe("> just a note\n\nDo it");
    expect(screen.queryByTestId("quoted-block")).toBeNull();
    expect(screen.getByText(/lines starting with "> " are treated as quoted data/)).toBeTruthy();
  });

  test("a title with markup is shown literally and an empty title is refused with a message", async () => {
    const { bridge, reqs } = setup({ "tasks.get": () => ({ ...fx.task, title: "<img src=x onerror=alert(1)>" }) });
    const { container } = render(<App bridge={bridge} taskId="task_01" />);
    const input = (await screen.findByLabelText("title")) as HTMLInputElement;
    expect(input.value).toBe("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.blur(input);
    expect(await screen.findByText("title can't be empty")).toBeTruthy();
    expect(reqs("tasks.update")).toHaveLength(0);
  });

  test("a code ref path with markup renders as a literal chip", async () => {
    const ref = { ...fx.codeRef, path: "src/<b>x</b>.ts" };
    const { bridge } = setup({ "tasks.get": () => ({ ...fx.task, codeRefs: [ref] }) });
    const { container } = render(<App bridge={bridge} taskId="task_01" />);
    expect(await screen.findByText("src/<b>x</b>.ts:42-48")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
  });
});
