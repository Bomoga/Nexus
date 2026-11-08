import { buildBrief } from "../../agent/brief-builder";
import { Task, type NexusEvent, type Req, type Res } from "../../contracts";
import type { Clock, SlackPort, StorePort, Unsubscribe } from "../ports";

// Tasks controller (PLAN L1-11): "Make task" on a Slack thread builds a draft Task whose brief quotes the thread and
// lists its code references; the human edits the draft; only then does a session start (sessions controller).

export interface TasksDeps {
  store: StorePort;
  slack: SlackPort;
  clock: Clock;
  machineId: string;
  /** Stable id of the repo the task is for (the git service's workspace id). */
  workspaceId(): string | Promise<string>;
  /** Who is making the task (for the task and the event). */
  identity(): { userId: string; name: string; auth0UserId?: string };
  /** Branch family a new slack_task event should sit on (default "main"). */
  currentOrbit?(): string;
}

export class TasksController {
  private readonly listeners = new Set<(t: Task) => void>();

  constructor(private readonly deps: TasksDeps) {}

  async createFromThread(channelId: string, threadTs: string): Promise<Task> {
    const { store, slack, clock } = this.deps;
    let thread;
    try {
      thread = await slack.getThread(channelId, threadTs);
    } catch (e) {
      throw new Error(`Could not read the Slack thread: ${e instanceof Error ? e.message : "unknown error"}`, { cause: e });
    }
    if (thread.messages.length === 0) throw new Error("That Slack thread has no messages.");
    const { title, brief, codeRefs } = buildBrief(thread);
    const who = this.deps.identity();
    const task = Task.parse({
      id: clock.newId("task"), title, brief,
      source: { kind: "thread", channelId, threadTs },
      workspaceId: await this.deps.workspaceId(), status: "draft", createdAt: clock.now(), codeRefs,
      createdBy: { userId: who.userId, ...(who.auth0UserId ? { auth0UserId: who.auth0UserId } : {}) },
    });
    await store.putTask(task);
    await store.putNexusEvent(this.event(task, who.name, { type: "thread", channelId, threadTs }));
    this.publish(task);
    return task;
  }

  async createManual(title: string, brief: string): Promise<Task> {
    const { store, clock } = this.deps;
    const who = this.deps.identity();
    const task = Task.parse({
      id: clock.newId("task"), title: title.trim(), brief, source: { kind: "manual" },
      workspaceId: await this.deps.workspaceId(), status: "draft", createdAt: clock.now(), codeRefs: [],
      createdBy: { userId: who.userId, ...(who.auth0UserId ? { auth0UserId: who.auth0UserId } : {}) },
    });
    await store.putTask(task);
    this.publish(task);
    return task;
  }

  /** Edits title and/or brief, only while the task is still a draft. */
  async update(taskId: string, patch: { title?: string; brief?: string }): Promise<Task> {
    const task = await this.deps.store.getTask(taskId);
    if (!task) throw new Error(`No task ${taskId}.`);
    if (task.status !== "draft") throw new Error(`Task "${task.title}" is ${task.status}; only a draft can be edited.`);
    const title = patch.title === undefined ? task.title : patch.title.trim();
    if (title.length === 0) throw new Error("A task needs a title.");
    const next: Task = { ...task, title, brief: patch.brief ?? task.brief };
    await this.deps.store.putTask(next);
    this.publish(next);
    return next;
  }

  async get(taskId: string): Promise<Task> {
    const task = await this.deps.store.getTask(taskId);
    if (!task) throw new Error(`No task ${taskId}.`);
    return task;
  }

  async list(status?: Task["status"]): Promise<Task[]> {
    return (await this.deps.store.listTasks()).filter(t => !status || t.status === status).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** tasks.subscribe: every create, edit and status change. */
  subscribe(cb: (t: Task) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** The sessions controller calls this after it changes a task's status. */
  publish(task: Task): void {
    for (const cb of this.listeners) cb(task);
  }

  private event(task: Task, actorName: string, target: NexusEvent["target"]): NexusEvent {
    return {
      id: this.deps.clock.newId("evt"), kind: "slack_task", at: task.createdAt,
      orbit: this.deps.currentOrbit?.() ?? "main", title: `task: ${task.title}`,
      actor: { name: actorName, kind: "human" }, target, workspaceId: task.workspaceId, machineId: this.deps.machineId,
    };
  }
}

/** The webview-protocol handlers this controller serves; Lane 2's bridge router registers them by name. */
export function tasksBridgeHandlers(c: TasksController) {
  return {
    "tasks.createFromThread": async (r: Req<"tasks.createFromThread">): Promise<Res<"tasks.createFromThread">> => c.createFromThread(r.channelId, r.threadTs),
    "tasks.create": async (r: Req<"tasks.create">): Promise<Res<"tasks.create">> => c.createManual(r.title, r.brief),
    "tasks.get": async (r: Req<"tasks.get">): Promise<Res<"tasks.get">> => c.get(r.taskId),
    "tasks.list": async (r: Req<"tasks.list">): Promise<Res<"tasks.list">> => c.list(r.status),
    "tasks.update": async (r: Req<"tasks.update">): Promise<Res<"tasks.update">> => c.update(r.taskId, { title: r.title, brief: r.brief }),
  };
}

/**
 * The Slack view's MAKE TASK sends tasks.createFromThread (the bridge has no command request), so the task editor opens after
 * that request as it does after the nexus.makeTaskFromThread command. A failure to open never fails the request: the task exists.
 */
export function openEditorAfterCreate<H extends { "tasks.createFromThread": (r: Req<"tasks.createFromThread">) => Promise<Res<"tasks.createFromThread">> }>(handlers: H, open?: (taskId: string) => void): H {
  if (!open) {
    return handlers;
  }
  const create = handlers["tasks.createFromThread"];
  return {
    ...handlers,
    "tasks.createFromThread": async (r: Req<"tasks.createFromThread">) => {
      const task = await create(r);
      try { open(task.id); } catch { /* the editor is a convenience; the draft task is already stored */ }
      return task;
    },
  };
}

/**
 * The Slack view's MAKE TASK sends tasks.createFromThread (the bridge has no command request), so what follows a new task (an
 * agent starts, or the task editor opens) runs after that request. It never fails or delays the request: the task exists.
 */
export function startAgentAfterCreate<H extends { "tasks.createFromThread": (r: Req<"tasks.createFromThread">) => Promise<Res<"tasks.createFromThread">> }>(handlers: H, after: (task: Res<"tasks.createFromThread">) => Promise<void>): H {
  const create = handlers["tasks.createFromThread"];
  return {
    ...handlers,
    "tasks.createFromThread": async (r: Req<"tasks.createFromThread">) => {
      const task = await create(r);
      void after(task).catch(() => { /* reported by the handler itself; the draft task is already stored */ });
      return task;
    },
  };
}
