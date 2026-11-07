import { describe, expect, it, vi } from "vitest";
import { TaskPlan, type AgentSession, type Task } from "../../contracts";
import { fx } from "../../contracts/fixtures";
import { MemoryStore } from "../testing/memory-ports";
import { Scheduler, defaultConcurrency } from "./scheduler";

const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

/** deps[i] = the indices subtask i waits for. */
async function setup(deps: number[][], opts: { max?: number; capacity?: number; failStart?: number; model?: typeof model | undefined; status?: TaskPlan["status"] } = {}) {
  const store = new MemoryStore();
  const ids = deps.map((_, i) => `sub_${i}`);
  for (const [i, id] of ids.entries()) await store.putTask({ ...fx.task, id, title: `Subtask ${i}`, status: "draft", source: { kind: "plan", planId: "plan_1", subtaskIndex: i } });
  const plan: TaskPlan = TaskPlan.parse({
    id: "plan_1", sourceTaskId: "task_01", swarmType: "HierarchicalSwarm", status: opts.status ?? "accepted", at: "2026-11-07T03:15:00Z",
    subtasks: deps.map((d, i) => ({ title: `Subtask ${i}`, brief: "b", dependsOn: d })),
    ...(opts.status === "proposed" ? {} : { createdTaskIds: ids }),
  });
  const started: string[] = [];
  let concurrentNow = 0, concurrentMax = 0;
  const scheduler: Scheduler = new Scheduler({
    store, maxConcurrent: opts.max, model: () => ("model" in opts ? opts.model : model),
    sessions: {
      capacity: opts.capacity,
      async start(taskId) {
        if (opts.failStart !== undefined && taskId === ids[opts.failStart]) throw new Error("no worktree");
        started.push(taskId);
        concurrentNow++; concurrentMax = Math.max(concurrentMax, concurrentNow);
        const t = (await store.getTask(taskId))!;
        await store.putTask({ ...t, status: "running" });
        return { id: `ses_${taskId}` } as AgentSession;
      },
    },
  });
  const finish = async (index: number, status: Task["status"] = "done") => {
    const t = (await store.getTask(ids[index]))!;
    await store.putTask({ ...t, status });
    if (["done", "failed", "cancelled"].includes(status)) concurrentNow--;
    scheduler.observe({ ...t, status });
  };
  return { scheduler, plan, store, ids, started, finish, concurrency: () => concurrentMax };
}
const settle = () => new Promise(r => setTimeout(r, 10));

describe("Scheduler.run", () => {
  it("runs a chain strictly in dependency order, one at a time", async () => {
    const s = await setup([[], [0], [1]], { max: 2 });
    const done = s.scheduler.run(s.plan);
    await vi.waitFor(() => expect(s.started).toEqual(["sub_0"]));
    await settle();
    expect(s.started).toEqual(["sub_0"]);                                         // sub_1 waits for sub_0
    await s.finish(0);
    await vi.waitFor(() => expect(s.started).toEqual(["sub_0", "sub_1"]));
    await s.finish(1);
    await vi.waitFor(() => expect(s.started).toEqual(["sub_0", "sub_1", "sub_2"]));
    await s.finish(2);
    expect(await done).toEqual({ done: s.ids, failed: [], skipped: [] });
  });

  it("starts independent subtasks together up to the limit, and joins on the last", async () => {
    const s = await setup([[], [], [0, 1]], { max: 2 });
    const done = s.scheduler.run(s.plan);
    await vi.waitFor(() => expect(s.started).toEqual(["sub_0", "sub_1"]));
    await s.finish(0);
    await settle();
    expect(s.started).toEqual(["sub_0", "sub_1"]);                                // sub_2 still waits for sub_1
    await s.finish(1);
    await vi.waitFor(() => expect(s.started).toContain("sub_2"));
    await s.finish(2);
    expect((await done).done).toHaveLength(3);
    expect(s.concurrency()).toBe(2);
  });

  it("with a limit of one, even independent subtasks run one after another", async () => {
    const s = await setup([[], [], []], { max: 1 });
    const done = s.scheduler.run(s.plan);
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(s.started).toHaveLength(i + 1));
      await settle();
      expect(s.started).toHaveLength(i + 1);
      await s.finish(i);
    }
    await done;
    expect(s.concurrency()).toBe(1);
  });

  it("never exceeds what the sessions controller can host, even if asked for more", async () => {
    const s = await setup([[], [], []], { max: 5, capacity: 1 });
    expect(s.scheduler.maxConcurrent).toBe(1);
    const done = s.scheduler.run(s.plan);
    for (let i = 0; i < 3; i++) { await vi.waitFor(() => expect(s.started).toHaveLength(i + 1)); await s.finish(i); }
    await done;
    expect(s.concurrency()).toBe(1);
  });

  it("skips everything downstream of a failed subtask and cancels those drafts", async () => {
    const s = await setup([[], [0], [1], []], { max: 1 });
    const done = s.scheduler.run(s.plan);
    await vi.waitFor(() => expect(s.started).toEqual(["sub_0"]));
    await s.finish(0, "failed");
    await vi.waitFor(() => expect(s.started).toEqual(["sub_0", "sub_3"]));        // the independent one still runs
    await s.finish(3);
    expect(await done).toEqual({ done: ["sub_3"], failed: ["sub_0"], skipped: ["sub_1", "sub_2"] });
    expect((await s.store.getTask("sub_1"))!.status).toBe("cancelled");
    expect((await s.store.getTask("sub_2"))!.status).toBe("cancelled");
    expect(s.started).not.toContain("sub_1");
  });

  it("treats a cancelled subtask like a failed one", async () => {
    const s = await setup([[], [0]], { max: 1 });
    const done = s.scheduler.run(s.plan);
    await vi.waitFor(() => expect(s.started).toEqual(["sub_0"]));
    await s.finish(0, "cancelled");
    expect(await done).toEqual({ done: [], failed: ["sub_0"], skipped: ["sub_1"] });
  });

  it("marks a subtask failed when its session cannot start, and carries on", async () => {
    const s = await setup([[], [0], []], { max: 1, failStart: 0 });
    const done = s.scheduler.run(s.plan);
    await vi.waitFor(() => expect(s.started).toEqual(["sub_2"]));
    await s.finish(2);
    expect(await done).toEqual({ done: ["sub_2"], failed: ["sub_0"], skipped: ["sub_1"] });
    expect((await s.store.getTask("sub_0"))!.status).toBe("failed");
  });

  it("does not start anything for a plan that was not accepted, or without a model", async () => {
    const proposed = await setup([[], [0]], { status: "proposed" });
    await expect(proposed.scheduler.run(proposed.plan)).rejects.toThrow("only after a human accepts");
    expect(proposed.started).toEqual([]);
    const noModel = await setup([[], [0]], { model: undefined });
    await expect(noModel.scheduler.run(noModel.plan)).rejects.toThrow("Pick a model");
    expect(noModel.started).toEqual([]);
  });

  it("observe() with nothing running is harmless", async () => {
    const s = await setup([[], []]);
    s.scheduler.observe(fx.task);
    expect(s.started).toEqual([]);
  });
});

describe("defaultConcurrency", () => {
  it("is one under 10 GB and two otherwise", () => {
    expect(defaultConcurrency(8 * 1024 ** 3)).toBe(1);
    expect(defaultConcurrency(10 * 1024 ** 3)).toBe(2);
    expect(defaultConcurrency(16 * 1024 ** 3)).toBe(2);
  });
});
