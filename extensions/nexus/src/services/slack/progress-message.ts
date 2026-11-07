// The session's single Slack progress message (CLAUDE.md sections 6 and 8): one bot message in the task's thread,
// edited in place. vscode-free. Bot token only; everything model-written is redacted, escaped and labeled.
import { encodeCodeRef, type AgentEvent, type AgentSession, type CodeRef, type Task } from "../../contracts";
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
  workspaceId: string;
  status: AgentSession["status"];
  text?: string;
  timer?: unknown;
  lastEditAt: number;
  files: Map<string, { start: number; end: number }>;
  commit?: string;
  finished: boolean;
  chain: Promise<void>;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Cuts on code points so the escaped result is at most `max` characters; never splits an entity or a surrogate pair. */
function clip(raw: string, max: number): string {
  let out = "";
  for (const ch of raw) {
    const piece = ESC[ch] ?? ch;
    if (out.length + piece.length > max - 1) return `${out}…`;
    out += piece;
  }
  return out;
}

const STATUS_LABEL: Record<AgentSession["status"], string> = {
  running: "working",
  awaiting_approval: "waiting for a human to approve",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** New-side line range covered by a unified diff's hunks; null when there are none. */
function diffRange(diff: string): { start: number; end: number } | null {
  let start = Infinity;
  let end = 0;
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const s = Math.max(1, Number(m[1]));
    const len = m[2] === undefined ? 1 : Number(m[2]);
    start = Math.min(start, s);
    end = Math.max(end, len === 0 ? s : s + len - 1);
  }
  return Number.isFinite(start) ? { start, end: Math.max(end, start) } : null;
}

export function createProgressMessages(deps: ProgressMessagesDeps): ProgressMessages {
  const clock: ProgressClock = deps.clock ?? {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const log = (m: string) => { try { deps.log?.(m); } catch { /* logging never throws */ } };
  const tracked = new Map<string, Tracked>();

  const header = (t: Tracked) =>
    `⬡ Nexus agent ${STATUS_LABEL[t.status]} on ${clip(deps.redact(t.session.branch), 100)} · ${clip(deps.redact(`${t.session.model.provider}/${t.session.model.modelId}`), 100)}`;

  function render(t: Tracked, summary?: string): string {
    const head = header(t);
    const parts: string[] = [head];
    if (t.finished) {
      const files = [...t.files.entries()];
      const lines: string[] = [];
      for (const [path, range] of files.slice(0, MAX_FILES)) {
        const safePath = deps.redact(path);
        const label = clip(safePath, MAX_PATH_CHARS).replace(/\|/g, "¦");
        const ref = t.commit ? buildRef(t, safePath, range) : null;
        lines.push(ref ? `• <${encodeCodeRef(ref)}|${label}>` : `• ${label}`);
      }
      if (files.length > MAX_FILES) lines.push(`and ${files.length - MAX_FILES} more`);
      const filesBlock = lines.length ? `\nEdited files:\n${lines.join("\n")}` : "";
      const used = head.length + filesBlock.length + 60;
      if (summary) parts.push(`\nSummary (model-written):\n${clip(deps.redact(summary), Math.max(40, MAX_PROGRESS_CHARS - used))}`);
      return (parts.join("\n") + filesBlock).slice(0, MAX_PROGRESS_CHARS);
    }
    if (t.text) {
      const used = head.length + 40;
      parts.push(`\nLatest (model-written):\n${clip(deps.redact(t.text), Math.max(40, MAX_PROGRESS_CHARS - used))}`);
    }
    return parts.join("\n").slice(0, MAX_PROGRESS_CHARS);
  }

  function buildRef(t: Tracked, path: string, range: { start: number; end: number }): CodeRef | null {
    if (!/^[0-9a-f]{40}$/.test(t.commit ?? "") || path.startsWith("/") || path.includes("..")) return null;
    return { workspaceId: t.workspaceId, commit: t.commit!, path, startLine: range.start, endLine: range.end };
  }

  /** Serialized per session; a Slack failure is logged and reported as false, never thrown. */
  function edit(t: Tracked, summary?: string): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      try {
        await deps.slack.updateBotMessage(t.ref.channelId, t.ref.messageTs, render(t, summary));
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

  async function lookup(session: AgentSession): Promise<Tracked | undefined> {
    const known = tracked.get(session.id);
    if (known) return known;
    const latest = (await deps.getSession(session.id)) ?? session;
    const ref = latest.slackProgress ?? session.slackProgress;
    if (!ref) return undefined;
    const task = await deps.getTask(latest.taskId);
    return adopt(latest, ref, task?.workspaceId ?? "");
  }

  function adopt(session: AgentSession, ref: NonNullable<AgentSession["slackProgress"]>, workspaceId: string): Tracked {
    const existing = tracked.get(session.id);
    if (existing) return existing;
    const t: Tracked = { session, ref, workspaceId, status: session.status, lastEditAt: -Infinity, files: new Map(), finished: false, chain: Promise.resolve() };
    tracked.set(session.id, t);
    return t;
  }

  return {
    async start(session) {
      try {
        const task = await deps.getTask(session.taskId);
        if (!task || task.source.kind !== "thread") return undefined;
        const latest = (await deps.getSession(session.id)) ?? session;
        if (latest.slackProgress) { adopt(latest, latest.slackProgress, task.workspaceId); return latest; }
        const text = `⬡ Nexus agent started on ${clip(deps.redact(latest.branch), 100)} · ${clip(deps.redact(`${latest.model.provider}/${latest.model.modelId}`), 100)}`;
        const posted = await deps.slack.postAsBot({ channelId: task.source.channelId, threadTs: task.source.threadTs, text });
        const updated: AgentSession = { ...latest, slackProgress: { channelId: task.source.channelId, threadTs: task.source.threadTs, messageTs: posted.ts } };
        adopt(updated, updated.slackProgress!, task.workspaceId);
        await deps.putSession(updated);
        return updated;
      } catch {
        log(`could not post the progress message for session ${session.id}`);
        return undefined;
      }
    },

    async update(session, text) {
      try {
        const t = await lookup(session);
        if (!t) return false;
        if (t.finished) return false;
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
        const range = diffRange(event.diff) ?? { start: 1, end: 1 };
        const prev = t.files.get(event.path);
        t.files.set(event.path, prev ? { start: Math.min(prev.start, range.start), end: Math.max(prev.end, range.end) } : range);
      } else if (event.type === "commit") {
        t.commit = event.sha;
      }
    },

    async finish(session, summary) {
      try {
        const t = await lookup(session);
        if (!t || t.finished) return;
        cancelTimer(t);
        t.status = session.status === "running" || session.status === "awaiting_approval" ? t.status : session.status;
        t.finished = true;
        await edit(t, summary);
      } catch {
        log(`progress finish failed for session ${session.id}`);
      }
    },
  };
}
