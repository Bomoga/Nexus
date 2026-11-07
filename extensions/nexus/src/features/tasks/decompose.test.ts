import { describe, expect, it } from "vitest";
import { Requests, TaskPlan } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { SwarmsUnavailable, type SwarmRun, type SwarmRunInput } from "../swarms/swarms-client";
import { MemoryStore, fakeClock } from "../testing/memory-ports";
import { DecomposeService, isAcyclic, parsePlan, planBridgeHandlers } from "./decompose";

const SECRET = "sk-ant-api03-SECRETSECRETSECRET1234567890";
const GOOD = JSON.stringify({ subtasks: [
  { title: "Add a failing test", brief: "Write a test for the qty > 1 case.", dependsOn: [] },
  { title: "Fix discount math", brief: "Apply the discount per unit.", dependsOn: [0] },
  { title: "Update the changelog", brief: "Note the fix.", dependsOn: [1] },
] });
const run = (text: string): SwarmRun => ({ text, output: [{ role: "Director", content: "planning…" }, { role: "Worker", content: text }] });

async function setup(opts: { reply?: string | (() => Promise<SwarmRun>); key?: string | undefined } = {}) {
  const store = new MemoryStore();
  await store.putTask({ ...fx.task });
  const calls: SwarmRunInput[] = [];
  const created: string[] = [];
  const swarms = { run: async (input: SwarmRunInput) => { calls.push(input); return typeof opts.reply === "function" ? opts.reply() : run(opts.reply ?? GOOD); } };
  const service = new DecomposeService({ store, clock: fakeClock(), swarms, getKey: async () => ("key" in opts ? opts.key : "swarms-key"), onTaskCreated: t => created.push(t.id) });
  return { store, service, calls, created };
}

describe("decompose", () => {
  it("asks a HierarchicalSwarm with the fenced, redacted brief and returns a proposed plan without creating anything", async () => {
    const s = await setup();
    await s.store.putTask({ ...fx.task, brief: `${fx.task.brief}\nkey ${SECRET}` });
    const plan = await s.service.decompose("task_01");
    expect(plan).toMatchObject({ sourceTaskId: "task_01", swarmType: "HierarchicalSwarm", status: "proposed" });
    expect(plan.subtasks.map(t => t.title)).toEqual(["Add a failing test", "Fix discount math", "Update the changelog"]);
    expect(plan.subtasks.map(t => t.dependsOn)).toEqual([[], [0], [1]]);
    expect(plan.createdTaskIds).toBeUndefined();
    expect(() => TaskPlan.parse(plan)).not.toThrow();
    expect(await s.store.getPlan(plan.id)).toEqual(plan);
    expect(s.store.tasks.size).toBe(1);                                         // nothing created before a human accepts
    expect(s.calls[0]).toMatchObject({ apiKey: "swarms-key", swarmType: "HierarchicalSwarm", sessionId: "plan:task_01" });
    expect(s.calls[0].task).toMatch(/<<<UNTRUSTED [a-z0-9]{12} label="task">>>/);
    expect(s.calls[0].task).not.toContain("SECRETSECRET");
  });

  it("explains itself when Swarms is unavailable or there is no key, and creates no plan", async () => {
    const down = await setup({ reply: async () => { throw new SwarmsUnavailable("timeout", "Swarms did not answer within 45 s."); } });
    await expect(down.service.decompose("task_01")).rejects.toThrow("No plan: Swarms did not answer within 45 s.");
    expect(down.store.plans.size).toBe(0);
    const noKey = await setup({ key: undefined });
    await expect(noKey.service.decompose("task_01")).rejects.toThrow("Connect a Swarms key");
    expect(noKey.calls).toEqual([]);
    await expect((await setup()).service.decompose("nope")).rejects.toThrow("No task");
  });

  it.each([
    ["one subtask", JSON.stringify({ subtasks: [{ title: "a", brief: "b", dependsOn: [] }] }), /proposed 1 subtasks/],
    ["five subtasks", JSON.stringify({ subtasks: Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, brief: "b", dependsOn: [] })) }), /proposed 5 subtasks/],
    ["a self dependency", JSON.stringify({ subtasks: [{ title: "a", brief: "b", dependsOn: [0] }, { title: "c", brief: "d", dependsOn: [] }] }), /does not exist/],
    ["an out-of-range dependency", JSON.stringify({ subtasks: [{ title: "a", brief: "b", dependsOn: [] }, { title: "c", brief: "d", dependsOn: [7] }] }), /does not exist/],
    ["a dependency loop", JSON.stringify({ subtasks: [{ title: "a", brief: "b", dependsOn: [1] }, { title: "c", brief: "d", dependsOn: [0] }] }), /loop/],
    ["a missing title", JSON.stringify({ subtasks: [{ brief: "b", dependsOn: [] }, { title: "c", brief: "d", dependsOn: [] }] }), /no title or brief/],
    ["no JSON", "I would split it in three.", /usable plan/],
  ])("rejects %s", async (_n, reply, message) => {
    const s = await setup({ reply });
    await expect(s.service.decompose("task_01")).rejects.toThrow(message);
    expect(s.store.plans.size).toBe(0);
  });

  it("tolerates prose and a code fence around the JSON, clips long text and redacts secrets", async () => {
    const reply = `Plan:\n\`\`\`json\n${JSON.stringify({ subtasks: [{ title: `${"T".repeat(200)} ${SECRET}`, brief: "b".repeat(5000), dependsOn: [] }, { title: "second", brief: "ok", dependsOn: [0, 0] }] })}\n\`\`\``;
    const plan = await (await setup({ reply })).service.decompose("task_01");
    expect(plan.subtasks[0].title.length).toBeLessThanOrEqual(80);
    expect(plan.subtasks[0].brief.length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(plan)).not.toContain("SECRETSECRET");
    expect(plan.subtasks[1].dependsOn).toEqual([0]);
  });
});

describe("accept and reject", () => {
  it("accept creates one draft task per subtask in order, linked to the plan, and records their ids", async () => {
    const s = await setup();
    const plan = await s.service.decompose("task_01");
    const accepted = await s.service.accept(plan.id);
    expect(accepted.status).toBe("accepted");
    expect(accepted.createdTaskIds).toHaveLength(3);
    expect(s.created).toEqual(accepted.createdTaskIds);
    const tasks = await Promise.all(accepted.createdTaskIds!.map(id => s.store.getTask(id)));
    tasks.forEach((t, i) => {
      expect(t).toMatchObject({ status: "draft", source: { kind: "plan", planId: plan.id, subtaskIndex: i }, workspaceId: "ws_demo", title: plan.subtasks[i].title });
      expect(t!.brief).toContain(`(Part ${i + 1} of 3 of: ${fx.task.title})`);
      expect(t!.codeRefs).toEqual(fx.task.codeRefs);
    });
    expect(await s.store.getPlan(plan.id)).toEqual(accepted);
  });

  it("a plan can be decided once: accept twice, reject after accept, accept after reject all fail", async () => {
    const s = await setup();
    const a = await s.service.decompose("task_01");
    await s.service.accept(a.id);
    await expect(s.service.accept(a.id)).rejects.toThrow("already accepted");
    await expect(s.service.reject(a.id)).rejects.toThrow("already accepted");
    const b = await s.service.decompose("task_01");
    expect((await s.service.reject(b.id)).status).toBe("rejected");
    await expect(s.service.accept(b.id)).rejects.toThrow("already rejected");
    expect(s.store.tasks.size).toBe(1 + 3);                                    // the original plus only the first plan's subtasks
    await expect(s.service.get("nope")).rejects.toThrow("No plan");
  });

  it("accept fails if the parent task is gone", async () => {
    const s = await setup();
    const plan = await s.service.decompose("task_01");
    s.store.tasks.clear();
    await expect(s.service.accept(plan.id)).rejects.toThrow("no longer exists");
  });
});

describe("helpers and bridge", () => {
  it("isAcyclic", () => {
    expect(isAcyclic([[], [0], [0, 1]])).toBe(true);
    expect(isAcyclic([[1], [2], [0]])).toBe(false);
    expect(isAcyclic([[0]])).toBe(false);
    expect(isAcyclic([])).toBe(true);
  });

  it("parsePlan returns validated subtasks", () => {
    expect(parsePlan(GOOD)).toHaveLength(3);
  });

  it("bridge handlers serve tasks.decompose and tasks.plan.* with contract-shaped responses", async () => {
    const s = await setup();
    const h = planBridgeHandlers(s.service);
    const plan = await h["tasks.decompose"]({ taskId: "task_01" });
    Requests["tasks.decompose"].res.parse(plan);
    Requests["tasks.plan.get"].res.parse(await h["tasks.plan.get"]({ planId: plan.id }));
    Requests["tasks.plan.accept"].res.parse(await h["tasks.plan.accept"]({ planId: plan.id }));
    const other = await h["tasks.decompose"]({ taskId: "task_01" });
    Requests["tasks.plan.reject"].res.parse(await h["tasks.plan.reject"]({ planId: other.id }));
  });
});
