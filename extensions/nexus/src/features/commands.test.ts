import { describe, expect, it } from "vitest";
import type { Lane1 } from "./compose";
import { lane1Commands, type CommandUi } from "./commands";

const LINK = "[APPROVE](command:workbench.action.quit)";

function ui() {
  const infos: string[] = [];
  const errors: string[] = [];
  const picks: Array<Array<{ id: string; label: string; detail: string }>> = [];
  const u: CommandUi = { info: m => infos.push(m), error: m => errors.push(m), pickApproval: async items => { picks.push(items); return undefined; } };
  return { u, infos, errors, picks };
}
const noBrackets = (s: string) => expect(s).not.toMatch(/[[\]]/);

describe("make task opens the task editor", () => {
  it("opens the editor for the new task instead of a popup", async () => {
    const lane = { tasks: { createFromThread: async () => ({ id: "task_9", title: "T" }) } } as unknown as Lane1;
    const c = ui();
    const opened: string[] = [];
    await lane1Commands(lane, c.u, () => "a", id => opened.push(id))["nexus.makeTaskFromThread"]("C1", "1.1");
    expect(opened).toEqual(["task_9"]);
    expect(c.infos).toEqual([]);
  });
});

describe("make task starts an agent", () => {
  const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
  const lane = (over: object = {}) => ({
    tasks: { createFromThread: async () => ({ id: "task_9", title: "T" }) },
    agentModel: () => model,
    sessions: { start: async (id: string, m: unknown) => { started.push([id, m]); return { id: "ses_9" }; } },
    ...over,
  }) as unknown as Lane1;
  const started: unknown[] = [];

  it("starts a session with the status bar's model and shows it, instead of opening the editor", async () => {
    started.length = 0;
    const c = ui();
    const shown: string[] = [];
    const opened: string[] = [];
    await lane1Commands(lane(), { ...c.u, openSession: id => shown.push(id) }, () => "a", id => opened.push(id))["nexus.makeTaskFromThread"]("C1", "1.1");
    expect(started).toEqual([["task_9", model]]);
    expect(shown).toEqual(["ses_9"]);
    expect(opened).toEqual([]);
    expect(c.infos[0]).toContain("Agent started");
  });

  it("opens the task editor when no model is chosen, and keeps the draft when the start fails", async () => {
    const c = ui();
    const opened: string[] = [];
    await lane1Commands(lane({ agentModel: () => undefined }), c.u, () => "a", id => opened.push(id))["nexus.makeTaskFromThread"]("C1", "1.1");
    expect(opened).toEqual(["task_9"]);
    const d = ui();
    const opened2: string[] = [];
    const failing = lane({ sessions: { start: async () => { throw new Error("An agent session is already running"); } } });
    await lane1Commands(failing, d.u, () => "a", id => opened2.push(id))["nexus.makeTaskFromThread"]("C1", "1.1");
    expect(d.errors[0]).toContain("already running");
    expect(d.errors[0]).toContain("saved as a draft");
    expect(opened2).toEqual(["task_9"]);
  });
});

describe("lane1Commands keep untrusted text from becoming command links", () => {
  it("task titles", async () => {
    const lane = { tasks: { createFromThread: async () => ({ title: `Fix ${LINK}` }) } } as unknown as Lane1;
    const c = ui();
    await lane1Commands(lane, c.u, () => "a")["nexus.makeTaskFromThread"]("C1", "1.1");
    expect(c.infos[0]).toContain("Fix ［APPROVE］");
    c.infos.forEach(noBrackets);
  });

  it("error messages", async () => {
    const lane = { tasks: { createFromThread: async () => { throw new Error(`boom ${LINK}\u202E`); } } } as unknown as Lane1;
    const c = ui();
    await lane1Commands(lane, c.u, () => "a")["nexus.makeTaskFromThread"]("C1", "1.1");
    expect(c.errors).toHaveLength(1);
    c.errors.forEach(noBrackets);
    expect(c.errors[0]).not.toContain("\u202E");
  });

  it("approval picker labels and details", async () => {
    const approvals = [
      { id: "a1", action: { kind: "run_command", command: `rm ${LINK}` }, reason: `why ${LINK}` },
      { id: "a2", action: { kind: "other", description: "x" }, reason: "y" },
    ];
    const lane = { approvals: { list: async () => approvals } } as unknown as Lane1;
    const c = ui();
    await lane1Commands(lane, c.u, () => "a")["nexus.approve"]();
    for (const i of c.picks[0]) { noBrackets(i.label); noBrackets(i.detail); }
    expect(c.picks[0][0].detail).toContain("(model-written)");
  });
});
