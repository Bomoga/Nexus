import { totalmem } from "node:os";
import type { AgentSession, Task, TaskPlan } from "../../contracts";
import type { StorePort } from "../ports";

// Runs the sessions of an accepted plan in dependency order (PLAN L1-19). At most 2 at once, 1 on machines under 10 GB
// (CLAUDE.md §6, §11), and never more than the sessions controller can host. Each subtask starts its own session with
// its own branch, worktree and approvals; nothing starts before a human accepted the plan.

export function defaultConcurrency(memoryBytes = totalmem()): number {
  return memoryBytes < 10 * 1024 ** 3 ? 1 : 2;
}

export interface SchedulerDeps {
  store: StorePort;
  sessions: { start(taskId: string, model: { provider: string; modelId: string }): Promise<AgentSession>; readonly capacity?: number };
  model(): { provider: string; modelId: string } | undefined;
  maxConcurrent?: number;
  /** How long to wait before asking again when the agent is busy with something outside the plan (default 2 s). */
  retryMs?: number;
  log?: (message: string) => void;
}

export interface PlanRunSummary {
  done: string[];
  failed: string[];
  /** Tasks never started because something they depended on did not finish. */
  skipped: string[];
}

const TERMINAL = new Set<Task["status"]>(["done", "failed", "cancelled"]);
const MAX_CONCURRENT = 2;
const BUSY_RETRY_MS = 2000;

export class Scheduler {
  private readonly runs = new Set<{ tick(): void }>();

  constructor(private readonly deps: SchedulerDeps) {}

  get maxConcurrent(): number {
    // Never more than 2 (CLAUDE.md §6), whatever is configured, never more than the machine default allows when unset,
    // and never more than the sessions controller can actually host.
    return Math.max(1, Math.min(MAX_CONCURRENT, this.deps.maxConcurrent ?? defaultConcurrency(), this.deps.sessions.capacity ?? Number.POSITIVE_INFINITY));
  }

  /** Feed every task change here (tasks.subscribe / SessionsController.onTaskChange); it moves the plan forward. */
  observe(_task: Task): void {
    for (const r of this.runs) r.tick();
  }

  /** Resolves when every subtask is done, failed, cancelled or skipped. Refuses a plan a human has not accepted. */
  async run(plan: TaskPlan): Promise<PlanRunSummary> {
    if (plan.status !== "accepted" || !plan.createdTaskIds) throw new Error("A plan runs only after a human accepts it.");
    const { store } = this.deps;
    const model = this.deps.model();
    if (!model) throw new Error("Pick a model for the agent before running the plan.");
    const ids = plan.createdTaskIds;
    const deps = plan.subtasks.map(s => s.dependsOn);
    const started = new Set<number>();
    const skipped = new Set<number>();

    return new Promise<PlanRunSummary>((resolve, reject) => {
      let ticking = false;
      let again = false;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleRetry = () => {
        if (retryTimer !== undefined) return;
        retryTimer = setTimeout(() => { retryTimer = undefined; void tick(); }, this.deps.retryMs ?? BUSY_RETRY_MS);
      };
      const stop = () => { if (retryTimer !== undefined) clearTimeout(retryTimer); retryTimer = undefined; this.runs.delete(run); };
      const state = async () => Promise.all(ids.map(id => store.getTask(id)));

      const tick = async (): Promise<void> => {
        if (ticking) { again = true; return; }
        ticking = true;
        try {
          do {
            again = false;
            const tasks = await state();
            const status = (i: number) => tasks[i]?.status;
            // A subtask whose dependency ended badly (or was skipped) can never run. Repeat until nothing new is skipped:
            // a dependency may point at a LATER subtask, so one pass in index order is not enough.
            for (let changed = true; changed;) {
              changed = false;
              for (let i = 0; i < ids.length; i++) {
                if (started.has(i) || skipped.has(i)) continue;
                if (deps[i].some(d => skipped.has(d) || (TERMINAL.has(status(d)!) && status(d) !== "done"))) {
                  skipped.add(i);
                  changed = true;
                  const t = tasks[i];
                  if (t && t.status === "draft") await store.putTask({ ...t, status: "cancelled" });
                  this.deps.log?.(`skipped "${t?.title ?? ids[i]}": a dependency did not finish`);
                }
              }
            }
            let running = tasks.filter((t, i) => started.has(i) && t && !TERMINAL.has(t.status)).length;
            for (let i = 0; i < ids.length && running < this.maxConcurrent; i++) {
              if (started.has(i) || skipped.has(i) || deps[i].some(d => status(d) !== "done")) continue;
              started.add(i);
              running++;
              try {
                await this.deps.sessions.start(ids[i], model);
              } catch (e) {
                if (e instanceof Error && /already running/.test(e.message)) {
                  // Something outside this plan holds the agent. That is not this subtask's failure: wait and ask again.
                  started.delete(i);
                  running--;
                  scheduleRetry();
                  break;
                }
                this.deps.log?.(`could not start "${tasks[i]?.title ?? ids[i]}": ${e instanceof Error ? e.message : "unknown error"}`);
                const t = await store.getTask(ids[i]);
                if (t && !TERMINAL.has(t.status)) await store.putTask({ ...t, status: "failed" });
                running--;
                again = true;
              }
            }
            const fresh = await state();
            if (fresh.every((t, i) => skipped.has(i) || (t && TERMINAL.has(t.status)))) {
              stop();
              resolve({
                done: ids.filter((_, i) => fresh[i]?.status === "done"),
                failed: ids.filter((_, i) => !skipped.has(i) && (fresh[i]?.status === "failed" || fresh[i]?.status === "cancelled")),
                skipped: ids.filter((_, i) => skipped.has(i)),
              });
              return;
            }
          } while (again);
        } catch (e) {
          stop();
          reject(e);
        } finally {
          ticking = false;
        }
      };
      const run = { tick: () => { void tick(); } };
      this.runs.add(run);
      void tick();
    });
  }
}
