// The session's single Slack progress message (CLAUDE.md sections 6 and 8): one bot message in the task's thread,
// edited in place. vscode-free. Bot token only; everything model-written is redacted, escaped and labeled.
import { CodeRef, encodeCodeRef, type AgentEvent, type AgentSession, type Task } from "../../contracts";
import { checkRelativePath } from "../coderef/create";
import { escapeAndTruncate } from "./interactivity";
import type { SlackService } from "./types";

/** Slack's section text limit; the whole message stays under it. */
export const MAX_PROGRESS_CHARS = 3000;
export const EDIT_DEBOUNCE_MS = 2000;
const MAX_FILES = 10;
const MAX_PATH_CHARS = 150;

export interface ProgressClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ProgressMessagesDeps {
  slack: Pick<SlackService, "postAsBot" | "updateBotMessage">;
  getTask(id: string): Promise<Task | undefined>;
  getSession(id: string): Promise<AgentSession | undefined>;
  putSession(session: AgentSession): Promise<void>;
  redact(text: string): string;
  /** The git workspace id (GitService.workspaceId): the id coderef open compares links against. */
  workspaceId(): Promise<string>;
  /** Injectable for deterministic tests; defaults to Date and the global timers. */
  clock?: ProgressClock;
  /** Never receives text from a Slack error. */
  log?(message: string): void;
}

export interface ProgressMessages {
  start(session: AgentSession): Promise<AgentSession | undefined>;
  /** Implements Lane 1's ProgressPort. False when the session has no progress message. */
  update(session: AgentSession, text: string): Promise<boolean>;
  onAgentEvent(event: AgentEvent): void;
  finish(session: AgentSession, summary?: string): Promise<void>;
}

interface Tracked {
  session: AgentSession;
  ref: NonNullable<AgentSession["slackProgress"]>;
  status: AgentSession["status"];
  text?: string;
  timer?: unknown;
  lastEditAt: number;
  files: Map<string, FileState>;
  commit?: string;
  finished: boolean;
  chain: Promise<void>;
}

const STATUS_LABEL: Record<AgentSession["status"], string> = {
  running: "working",
  awaiting_approval: "waiting for a human to approve",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};
const TERMINAL = new Set<AgentSession["status"]>(["done", "failed", "cancelled"]);

/** The agent's path as a plain repo-relative path ("./a" → "a"), or undefined for an absolute or otherwise unusable one. */
function repoRelative(path: string): string | undefined {
  const p = path.replace(/^(?:\.\/)+/, "");
  try { checkRelativePath(p); return p; } catch { return undefined; }
}

/** One file's state in the cumulative worktree diff. range null: no usable hunks or an unparseable path, so no link. */
type FileState = { range: { start: number; end: number } | null; deleted: boolean };

/**
 * Per-file new-side line ranges from a unified diff. file_edit.diff is the whole worktree diff against the base commit,
 * so each file's section is parsed on its own. Only unquoted paths are understood; anything else is skipped.
 */
function parseDiff(diff: string): Map<string, FileState> {
  const out = new Map<string, FileState>();
  let cur: { oldPath?: string; path?: string; deleted: boolean; bad: boolean; inHunk: boolean; start: number; end: number } | undefined;
  const flush = () => {
    if (cur && !cur.bad) {
      const path = cur.deleted ? cur.oldPath : cur.path;
      if (path) out.set(path, { deleted: cur.deleted, range: cur.deleted || !Number.isFinite(cur.start) ? null : { start: cur.start, end: Math.max(cur.end, cur.start) } });
    }
    cur = undefined;
  };
  const pathOf = (rest: string, prefix: string): string | undefined => {
    const r = rest.replace(/\t.*$/, "");
    return r.startsWith(prefix) && !r.startsWith('"') ? r.slice(prefix.length) : undefined;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { flush(); cur = { deleted: false, bad: false, inHunk: false, start: Infinity, end: 0 }; continue; }
    if (!cur) continue;
    if (!cur.inHunk && line.startsWith("--- ")) { cur.oldPath = pathOf(line.slice(4), "a/"); continue; }
    if (!cur.inHunk && line.startsWith("+++ ")) {
      const rest = line.slice(4);
      if (rest === "/dev/null") cur.deleted = true;
      else { cur.path = pathOf(rest, "b/"); if (cur.path === undefined) cur.bad = true; }
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur.inHunk = true;
      const s = Math.max(1, Number(m[1]));
      const len = m[2] === undefined ? 1 : Number(m[2]);
      cur.start = Math.min(cur.start, s);
      cur.end = Math.max(cur.end, len === 0 ? s : s + len - 1);
    }
  }
  flush();
  return out;
}

export function createProgressMessages(deps: ProgressMessagesDeps): ProgressMessages {
  const clock: ProgressClock = deps.clock ?? {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const log = (m: string) => { try { deps.log?.(m); } catch { /* logging never throws */ } };
  const tracked = new Map<string, Tracked>();
  const finishedIds = new Set<string>();
  const starting = new Map<string, Promise<AgentSession | undefined>>();

  const safe = (text: string, max: number) => escapeAndTruncate(deps.redact(text), max);
  const fence = (text: string, max: number) => `\`\`\`\n${safe(text, max)}\n\`\`\``;

  const header = (t: Tracked) =>
    `⬡ Nexus agent ${STATUS_LABEL[t.status]} on ${safe(t.session.branch, 100)} · ${safe(`${t.session.model.provider}/${t.session.model.modelId}`, 100)}`;

  async function render(t: Tracked, summary?: string): Promise<string> {
    const head = header(t);
    if (!t.finished) {
      if (!t.text) return head;
      const label = "\nLatest (model-written):\n";
      return head + label + fence(t.text, MAX_PROGRESS_CHARS - head.length - label.length - 10);
    }
    let out = head;
    if (summary) {
      const label = "\nSummary (model-written):\n";
      out += label + fence(summary, Math.min(1200, MAX_PROGRESS_CHARS - head.length - label.length - 10));
    }
    const files = [...t.files.entries()];
    if (files.length) {
      let workspaceId: string | undefined;
      try { workspaceId = await deps.workspaceId(); } catch { log("could not read the workspace id for progress links"); }
      const title = "\nEdited files:";
      const reserve = 30;   // room for the "and N more" line
      let block = "";
      let shown = 0;
      for (const [path, state] of files.slice(0, MAX_FILES)) {
        const label = safe(path, MAX_PATH_CHARS).replace(/\|/g, "¦");
        const parsed = workspaceId && t.commit && state.range && !state.deleted
          ? CodeRef.safeParse({ workspaceId, commit: t.commit, path, startLine: state.range.start, endLine: state.range.end })
          : undefined;
        // A plain label is an inline code span, so Slack neither auto-links nor formats a repo path (escaping already removed backticks).
        const line = `\n• ${parsed?.success ? `<${encodeCodeRef(parsed.data)}|${label}>` : `\`${label}\`${state.deleted ? " (deleted)" : ""}`}`;
        if (out.length + title.length + block.length + line.length + reserve > MAX_PROGRESS_CHARS) break;
        block += line;
        shown++;
      }
      out += title + block;
      if (files.length > shown) out += `\nand ${files.length - shown} more`;
    }
    return out.length <= MAX_PROGRESS_CHARS ? out : head;
  }

  /** Serialized per session; a Slack failure is logged and reported as false, never thrown. */
  function edit(t: Tracked, summary?: string): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      try {
        await deps.slack.updateBotMessage(t.ref.channelId, t.ref.messageTs, await render(t, summary));
        t.lastEditAt = clock.now();
        return true;
      } catch {
        log(`progress message edit failed for session ${t.session.id}`);
        return false;
      }
    };
    const result = t.chain.then(run);
    t.chain = result.then(() => undefined);
    return result;
  }

  function cancelTimer(t: Tracked) {
    if (t.timer !== undefined) { clock.clearTimeout(t.timer); t.timer = undefined; }
  }

  function adopt(session: AgentSession, ref: NonNullable<AgentSession["slackProgress"]>): Tracked {
    const existing = tracked.get(session.id);
    if (existing) return existing;
    const t: Tracked = { session, ref, status: session.status, lastEditAt: -Infinity, files: new Map(), finished: false, chain: Promise.resolve() };
    tracked.set(session.id, t);
    return t;
  }

  /** The tracker for a session with a progress message. A session already terminal in the store is finished (unless the caller is finishing it). */
  async function lookup(session: AgentSession, finishing = false): Promise<Tracked | undefined> {
    if (finishedIds.has(session.id)) return undefined;
    const known = tracked.get(session.id);
    if (known) return known;
    const latest = (await deps.getSession(session.id)) ?? session;
    const ref = latest.slackProgress ?? session.slackProgress;
    if (!ref) return undefined;
    if (!finishing && TERMINAL.has(latest.status)) { finishedIds.add(session.id); return undefined; }
    return adopt(latest, ref);
  }

  async function doStart(session: AgentSession): Promise<AgentSession | undefined> {
    try {
      if (finishedIds.has(session.id)) return undefined;
      const known = tracked.get(session.id);
      if (known) return known.session;
      const task = await deps.getTask(session.taskId);
      if (!task || task.source.kind !== "thread") return undefined;
      const latest = (await deps.getSession(session.id)) ?? session;
      if (latest.slackProgress) { adopt(latest, latest.slackProgress); return latest; }
      const text = `⬡ Nexus agent started on ${safe(latest.branch, 100)} · ${safe(`${latest.model.provider}/${latest.model.modelId}`, 100)}`;
      const posted = await deps.slack.postAsBot({ channelId: task.source.channelId, threadTs: task.source.threadTs, text });
      const updated: AgentSession = { ...latest, slackProgress: { channelId: task.source.channelId, threadTs: task.source.threadTs, messageTs: posted.ts } };
      adopt(updated, updated.slackProgress!);   // kept even if the store write fails, so a repeat start never posts again
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await deps.putSession(updated); return updated; } catch { /* retried once */ }
      }
      log(`could not store the progress message for session ${session.id}`);
      return updated;
    } catch {
      log(`could not post the progress message for session ${session.id}`);
      return undefined;
    }
  }

  return {
    start(session) {
      const running = starting.get(session.id);
      if (running) return running;
      const p = doStart(session).finally(() => { starting.delete(session.id); });
      starting.set(session.id, p);
      return p;
    },

    async update(session, text) {
      try {
        const t = await lookup(session);
        if (!t || t.finished) return false;
        t.text = text;
        if (t.timer === undefined) {
          const wait = Math.max(0, t.lastEditAt + EDIT_DEBOUNCE_MS - clock.now());
          t.timer = clock.setTimeout(() => {
            t.timer = undefined;
            if (!t.finished) void edit(t);
          }, wait);
        }
        return true;
      } catch {
        log(`progress update failed for session ${session.id}`);
        return false;
      }
    },

    onAgentEvent(event) {
      const t = tracked.get(event.sessionId);
      if (!t || t.finished) return;
      if (event.type === "status") {
        t.status = event.status;
        cancelTimer(t);
        void edit(t);
      } else if (event.type === "file_edit") {
        // The diff is cumulative (the whole worktree against the base), so the latest one replaces earlier ranges.
        const parsed = parseDiff(event.diff);
        const next = new Map<string, FileState>();
        for (const [path, state] of t.files) if (!parsed.has(path)) next.set(path, { range: null, deleted: state.deleted });
        for (const [path, state] of parsed) next.set(path, state);
        const own = repoRelative(event.path);
        if (own !== undefined && !next.has(own)) next.set(own, { range: null, deleted: false });
        t.files = next;
      } else if (event.type === "commit") {
        t.commit = event.sha;
      }
    },

    async finish(session, summary) {
      try {
        const t = await lookup(session, true);
        if (!t || t.finished) return;
        cancelTimer(t);
        if (TERMINAL.has(session.status)) t.status = session.status;
        t.finished = true;
        tracked.delete(session.id);
        finishedIds.add(session.id);
        await edit(t, summary);
      } catch {
        log(`progress finish failed for session ${session.id}`);
      }
    },
  };
}
