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
