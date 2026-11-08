// A fake extension host: answers every request and subscription from the contract fixtures and the
// demo scenario (PLAN §2.12) so any view runs in a plain browser with ?fake=1. Streams replay the
// scripted data and then keep emitting on a timer so live UI is visible.
import { Requests, Subscriptions } from "../../src/contracts";
import type { ActivityBucket, AgentEvent, ChatMessage, Envelope, NexusEvent, Req, RequestName, Res } from "../../src/contracts";
import { fx, MACHINE_ID } from "../../src/contracts/fixtures";
import { demoScenario } from "../../src/contracts/fixtures/scenario";
import type { Transport } from "./bridgeClient";

export interface FakeOptions {
  /** Milliseconds between live events; 0 disables the timers. Default 1500. */
  liveIntervalMs?: number;
}

type Handlers = { [N in RequestName]: (body: Req<N>) => Res<N> };

const SHA = "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21";

function slackTs(): string {
  return (Date.now() / 1000).toFixed(6);
}

const BUCKET_MS = 15 * 60_000;

/** The scripted demo events counted into 15-minute buckets per orbit (what the continuous aggregate serves). */
function activityBuckets(from: string, to: string): ActivityBucket[] {
  const counts = new Map<string, number>();
  for (const e of demoScenario.events) {
    if (e.at < from || e.at > to) continue;
    const start = new Date(Math.floor(Date.parse(e.at) / BUCKET_MS) * BUCKET_MS).toISOString();
    const key = `${start}\n${e.orbit}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => {
    const [bucketStart, orbit] = key.split("\n");
    return { bucketStart, orbit, count };
  });
}

function buildHandlers(): Handlers {
  const approvals = [...demoScenario.approvals];
  const tasks = [fx.task];
  const sessions = [fx.session];
  let optimizer = fx.optimizer;
  let selectedModel: { provider: string; modelId: string } | null = { ...fx.session.model };
  let plan = fx.plan;
  const thread = demoScenario.thread;
  const summary = (calls: typeof demoScenario.receipts) => ({
    calls: calls.length,
    costUsd: calls.reduce((s, r) => s + r.costUsd, 0),
    savedUsd: calls.reduce((s, r) => s + Math.max(0, (r.baselineCostUsd ?? r.costUsd) - r.costUsd), 0),
  });
  return {
    "app.ping": () => ({ pong: true, machineId: MACHINE_ID, tPlus: "T+00:00:00" }),
    "auth.status": () => ({ signedIn: true, auth0UserId: "auth0|fake", name: "Adrian", slackViaTokenVault: true }),
    "store.status": () => ({ online: true, outboxDepth: 0, lastSyncAt: fx.event.at }),
    "accounts.list": () => demoScenario.accounts,
    "accounts.test": ({ accountId }) => demoScenario.accounts.find((a) => a.id === accountId) ?? demoScenario.accounts[0],
    "models.list": ({ role }) => (role === "agent" ? demoScenario.models.filter((m) => m.supportsTools) : demoScenario.models),
    "models.selected": () => selectedModel,
    "models.select": ({ provider, modelId }) => (selectedModel = { provider, modelId }),
    "optimizer.get": () => optimizer,
    "optimizer.set": (body) => (optimizer = body),
    "receipts.list": ({ sessionId, limit }) => {
      const receipts = demoScenario.receipts.filter((r) => !sessionId || r.sessionId === sessionId).slice(0, limit);
      return { receipts, summary: summary(receipts) };
    },
    "slack.status": () => demoScenario.slackStatus,
    "slack.channels": () => demoScenario.channels,
    "slack.history": ({ channelId }) => ({
      messages: channelId === thread.channelId ? thread.messages.filter((m) => !m.threadTs) : [],
      fromCache: false,
    }),
    "slack.thread": () => thread,
    "slack.users": ({ ids }) => demoScenario.users.filter((u) => !ids || ids.includes(u.id)),
    // Echoes the clientId on the reply (and on the slack.subscribe copy, see post below), as the real host does.
    "slack.post": ({ channelId, text, threadTs, clientId }) => {
      const ts = slackTs();
      return { id: `${channelId}:${ts}`, channelId, ts, threadTs, author: { id: "U_ADRIAN", name: "adrian", isBot: false }, text, codeRefs: [], sentVia: "user", clientId };
    },
    "tasks.createFromThread": () => ({ ...fx.task, status: "draft" }),
    "tasks.create": ({ title, brief }) => {
      const t = { ...fx.task, id: `task_${String(tasks.length + 1).padStart(2, "0")}`, title, brief, source: { kind: "manual" as const }, status: "draft" as const, codeRefs: [] };
      tasks.push(t);
      return t;
    },
    "tasks.get": ({ taskId }) => tasks.find((t) => t.id === taskId) ?? fx.task,
    "tasks.list": ({ status }) => tasks.filter((t) => !status || t.status === status),
    "tasks.update": ({ taskId, title, brief }) => {
      const t = tasks.find((x) => x.id === taskId) ?? fx.task;
      return { ...t, title: title ?? t.title, brief: brief ?? t.brief };
    },
    "agent.start": () => fx.session,
    "agent.cancel": () => ({ ...fx.session, status: "cancelled" }),
    "sessions.get": ({ sessionId }) => sessions.find((s) => s.id === sessionId) ?? fx.session,
    "sessions.list": ({ status }) => sessions.filter((s) => !status || s.status === status),
    "approvals.list": ({ sessionId, pendingOnly }) =>
      approvals.filter((a) => (!sessionId || a.sessionId === sessionId) && (!pendingOnly || !a.decision)),
    "approvals.resolve": ({ approvalId, decision }) => {
      const i = approvals.findIndex((a) => a.id === approvalId);
      const base = approvals[i] ?? fx.approval;
      const next = base.decision ? base : { ...base, decision, decidedBy: { via: "app" as const, userId: "adrian" }, decidedAt: new Date().toISOString() };
      if (i >= 0) approvals[i] = next;
      return next;
    },
    "swarms.review.get": () => demoScenario.review,
    "swarms.review.rerun": () => demoScenario.review,
    "tasks.decompose": () => plan,
    "tasks.plan.get": () => plan,
    "tasks.plan.accept": () => (plan = { ...plan, status: "accepted", createdTaskIds: ["task_02", "task_03", "task_04"] }),
    "tasks.plan.reject": () => (plan = { ...plan, status: "rejected" }),
    "events.query": ({ from, to, orbits, kinds, limit }) =>
      demoScenario.events
        .filter((e) => e.at >= from && e.at <= to && (!orbits || orbits.includes(e.orbit)) && (!kinds || kinds.includes(e.kind)))
        .slice(0, limit),
    "events.search": ({ q, limit }) =>
      demoScenario.events
        .filter((e) => e.title.toLowerCase().includes(q.toLowerCase()))
        .slice(0, limit)
        .map((event) => ({ event, score: 1 })),
    "events.activity": ({ from, to }) => activityBuckets(from, to),
    "git.commit.show": ({ sha }) => ({
      sha,
      subject: "add cart module",
      body: "",
      author: "Adrian",
      at: fx.event.at,
      parents: [],
      files: [{ path: "src/cart.ts", status: "M", additions: 3, deletions: 1 }],
    }),
    "git.branches": () => [
      { name: "main", head: SHA, isCurrent: true, isAgent: false },
      { name: fx.session.branch, head: SHA, isCurrent: false, isAgent: true },
    ],
    "git.mergeAgentBranch": () => ({ ok: true, mergeSha: SHA, message: "merged" }),
    "coderef.create": ({ path, startLine, endLine }) => ({ ref: { ...fx.codeRef, path, startLine, endLine }, link: "nexus://coderef/fake", snippet: "return price * qty - discount;" }),
    "coderef.open": () => ({ opened: "at_commit", stale: false }),
    "ui.openTarget": () => ({}),
    "ui.setTimeWindow": () => ({}),
    "ui.openExternal": () => ({}),
  };
}

export function createFakeTransport(opts: FakeOptions = {}): Transport {
  const interval = opts.liveIntervalMs ?? 1500;
  const handlers = buildHandlers() as unknown as Record<string, (body: unknown) => unknown>;
  const listeners = new Set<(env: Envelope) => void>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  // Open slack.subscribe subscriptions and their channels, so a post is delivered back like Slack would.
  const slackSubs = new Map<string, string[]>();
  const emit = (env: Envelope) => queueMicrotask(() => listeners.forEach((l) => l(env)));
  const evt = (id: string, body: unknown) => emit({ t: "evt", id, body });

  function startSubscription(id: string, name: string, body: unknown) {
    const every = (fn: () => void) => {
      if (interval > 0) timers.set(id, setInterval(fn, interval));
    };
    let n = 0;
    switch (name) {
      case "events.subscribe": {
        // Live commits on the scripted orbits, stamped now.
        const base = demoScenario.events.filter((e) => e.kind === "commit");
        every(() => {
          const src = base[n % base.length];
          const live: NexusEvent = { ...src, id: `${src.id}:live${n++}`, at: new Date().toISOString() };
          evt(id, live);
        });
        break;
      }
      case "agent.subscribe": {
        const from = (body as { fromSeq: number }).fromSeq;
        const rest: AgentEvent[] = demoScenario.agentEvents.filter((e) => e.seq >= from);
        const replay = rest.slice(0, 3);
        replay.forEach((e) => evt(id, e));
        n = replay.length;
        every(() => {
          if (n < rest.length) evt(id, rest[n++]);
        });
        break;
      }
      case "slack.subscribe": {
        slackSubs.set(id, (body as { channelIds: string[] }).channelIds);
        evt(id, { type: "status", status: demoScenario.slackStatus });
        every(() => {
          const ts = slackTs();
          const message: ChatMessage = { id: `C_DEMO:${ts}`, channelId: "C_DEMO", ts, author: { id: "U_BRANDON", name: "brandon", isBot: false }, text: `live message ${++n}`, codeRefs: [], sentVia: "user" };
          evt(id, { type: "message", message });
        });
        break;
      }
      case "approvals.subscribe":
        demoScenario.approvals.forEach((a) => evt(id, a));
        break;
      case "swarms.review.subscribe":
        evt(id, demoScenario.review);
        break;
      case "receipts.subscribe":
        demoScenario.receipts.forEach((r) => evt(id, r));
        break;
      case "store.subscribe":
        evt(id, { online: true, outboxDepth: 0 });
        break;
      case "tasks.subscribe":
        evt(id, demoScenario.task);
        break;
    }
  }

  return {
    post(env) {
      if (env.t === "req") {
        const def = (Requests as Record<string, { req: { safeParse(v: unknown): { success: boolean; data?: unknown } } }>)[env.name];
        const handler = handlers[env.name];
        const parsed = def?.req.safeParse(env.body);
        if (!def || !handler) emit({ t: "res", id: env.id, ok: false, error: { code: "not_found", message: `unknown request ${env.name}` } });
        else if (!parsed?.success) emit({ t: "res", id: env.id, ok: false, error: { code: "invalid_request", message: "bad body" } });
        else {
          const body = handler(parsed.data);
          emit({ t: "res", id: env.id, ok: true, body });
          if (env.name === "slack.post") {
            const message = body as ChatMessage;
            slackSubs.forEach((channelIds, subId) => {
              if (channelIds.includes(message.channelId)) evt(subId, { type: "message", message });
            });
          }
        }
      } else if (env.t === "sub") {
        if (env.name in Subscriptions) startSubscription(env.id, env.name, env.body);
      } else if (env.t === "unsub") {
        slackSubs.delete(env.id);
        const timer = timers.get(env.id);
        if (timer) clearInterval(timer);
        timers.delete(env.id);
      }
    },
    listen(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}
