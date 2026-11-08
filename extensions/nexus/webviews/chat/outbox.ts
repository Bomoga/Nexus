// The chat page's outbox: every send Slack has not confirmed yet, keyed by its clientId, owned by the App so
// a send outlives the channel history or thread pane that made it. An entry is confirmed only by an exact
// match: a message carrying its clientId, or the ts the slack.post reply gave it. Never by text, author or
// time. The outbox lives as long as the page; a webview reload starts it empty.
import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { ChatMessage } from "../../src/contracts";
import { BridgeError } from "../shared";
import type { BridgeClient } from "../shared";
import type { Self } from "./live";
import { mergeMessages } from "./live";

/** pending: posted, no answer yet. failed: the host said no. unconfirmed: no answer in time (the bridge timed out or was offline). */
export type EntryState = "pending" | "failed" | "unconfirmed";

export interface OutboxEntry {
  clientId: string;
  channelId: string;
  threadTs?: string;
  text: string;
  state: EntryState;
  /** Local send time as a Slack-style ts, for display only (never used to match). */
  sentAt: string;
  /** The ts of Slack's copy, from the slack.post reply. */
  confirmedTs?: string;
}

/** A channel's top level (no threadTs) or one thread. */
export interface Target { channelId: string; threadTs?: string }

export interface OutboxStore {
  /** Creates an entry for the target and posts it. */
  send(target: Target, text: string): OutboxEntry;
  /** Re-posts a failed or unconfirmed entry with the same clientId. */
  retry(clientId: string): void;
  /** Drops a failed or unconfirmed entry from the view (DISMISS). A pending one cannot be dropped. */
  dismiss(clientId: string): void;
  /** Open entries of a target, in the order they were sent. */
  entriesFor(target: Target): OutboxEntry[];
  /** Slack's copies of this page's confirmed sends to a target (the most recent few). */
  confirmedFor(target: Target): ChatMessage[];
  /** Any message from Slack (post reply, subscription, history or thread load); confirms the entries it matches exactly. */
  observe(messages: readonly ChatMessage[]): void;
  draftFor(target: Target): string;
  setDraft(target: Target, text: string): void;
  subscribe(listener: () => void): () => void;
  /** Changes whenever entries or confirmed copies change. */
  version(): number;
}

export interface OutboxOptions {
  /** Bridge timeout for slack.post; the bridge default when omitted. */
  postTimeoutMs?: number;
}

const CONFIRMED_KEEP = 50;

export const targetKey = (t: Target) => `${t.channelId}/${t.threadTs ?? ""}`;

/** The exact rule: the message carries the entry's clientId, or is the copy the post reply named. */
export function confirms(entry: OutboxEntry, m: ChatMessage): boolean {
  if (m.clientId !== undefined && m.clientId === entry.clientId) return true;
  return entry.confirmedTs !== undefined && m.channelId === entry.channelId && m.ts === entry.confirmedTs;
}

let clientSeq = 0;
export function newClientId(): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `nx-${++clientSeq}-${rand}`;
}

/**
 * Only a definite answer from the host is a failure. A timeout or an offline host may still have posted, and so may a
 * host whose reply failed validation (invalid_response): those stay "unconfirmed".
 */
const definite = (err: unknown) => err instanceof BridgeError && err.code !== "offline" && err.code !== "invalid_response";

export function createOutbox(client: BridgeClient, opts: OutboxOptions = {}): OutboxStore {
  const entries = new Map<string, OutboxEntry>();
  const attempts = new Map<string, number>();
  const confirmed = new Map<string, ChatMessage[]>();
  const drafts = new Map<string, string>();
  const listeners = new Set<() => void>();
  let ver = 0;
  let sub: { key: string; off: () => void } | undefined;

  // While sends are open, the outbox listens to their channels itself, so a copy Slack delivers while the
  // user looks elsewhere still confirms them.
  const syncSubscription = () => {
    const channelIds = [...new Set([...entries.values()].map((e) => e.channelId))].sort();
    const key = channelIds.join("\n");
    if ((sub?.key ?? "") === key) return;
    const next = channelIds.length
      ? {
          key,
          off: client.subscribe("slack.subscribe", { channelIds }, (evt) => {
            if (evt.type !== "status") observe([evt.message]);
          }),
        }
      : undefined;
    sub?.off();
    sub = next;
  };

  const changed = () => {
    ver++;
    syncSubscription();
    listeners.forEach((l) => l());
  };

  const keep = (target: Target, m: ChatMessage) => {
    const k = targetKey(target);
    confirmed.set(k, mergeMessages(confirmed.get(k) ?? [], [m]).slice(-CONFIRMED_KEEP));
  };

  const settle = (e: OutboxEntry, m: ChatMessage) => {
    entries.delete(e.clientId);
    attempts.delete(e.clientId);
    keep(e, m);
  };

  function observe(messages: readonly ChatMessage[]) {
    let any = false;
    for (const m of messages) {
      for (const e of [...entries.values()]) {
        if (confirms(e, m)) {
          settle(e, m);
          any = true;
        }
      }
    }
    if (any) changed();
  }

  const post = (e: OutboxEntry) => {
    const attempt = (attempts.get(e.clientId) ?? 0) + 1;
    attempts.set(e.clientId, attempt);
    const target: Target = { channelId: e.channelId, threadTs: e.threadTs };
    client
      .request(
        "slack.post",
        { channelId: e.channelId, text: e.text, ...(e.threadTs ? { threadTs: e.threadTs } : {}), clientId: e.clientId },
        opts.postTimeoutMs ? { timeoutMs: opts.postTimeoutMs } : undefined,
      )
      .then(
        (copy) => {
          const open = entries.get(e.clientId);
          // Already confirmed by its subscription copy: the reply only refreshes the kept copy.
          if (open) settle({ ...open, confirmedTs: copy.ts }, copy);
          else keep(target, copy);
          changed();
        },
        (err: unknown) => {
          const open = entries.get(e.clientId);
          if (!open || attempts.get(e.clientId) !== attempt) return;
          entries.set(e.clientId, { ...open, state: definite(err) ? "failed" : "unconfirmed" });
          changed();
        },
      );
  };

  return {
    send(target, text) {
      const e: OutboxEntry = {
        clientId: newClientId(),
        channelId: target.channelId,
        ...(target.threadTs ? { threadTs: target.threadTs } : {}),
        text,
        state: "pending",
        sentAt: (Date.now() / 1000).toFixed(6),
      };
      entries.set(e.clientId, e);
      changed();
      post(e);
      return e;
    },
    retry(clientId) {
      const e = entries.get(clientId);
      if (!e || e.state === "pending") return;
      const next: OutboxEntry = { ...e, state: "pending" };
      entries.set(clientId, next);
      changed();
      post(next);
    },
    dismiss(clientId) {
      const e = entries.get(clientId);
      if (!e || e.state === "pending") return;
      entries.delete(clientId);
      attempts.delete(clientId);
      changed();
    },
    entriesFor: (t) => [...entries.values()].filter((e) => e.channelId === t.channelId && (e.threadTs ?? "") === (t.threadTs ?? "")),
    confirmedFor: (t) => confirmed.get(targetKey(t)) ?? [],
    observe,
    draftFor: (t) => drafts.get(targetKey(t)) ?? "",
    setDraft(t, text) {
      if (text) drafts.set(targetKey(t), text);
      else drafts.delete(targetKey(t));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => ver,
  };
}

/** The App's outbox; views rendered without an App fall back to a private one. */
export const OutboxContext = createContext<OutboxStore | undefined>(undefined);

export function useOutboxStore(client: BridgeClient): OutboxStore {
  const shared = useContext(OutboxContext);
  const own = useMemo(() => (shared ? undefined : createOutbox(client)), [shared, client]);
  return shared ?? own!;
}

/** One row of a message list: Slack's copy, or an open send (entry set). */
export interface Row { message: ChatMessage; entry?: OutboxEntry }

export function echoMessage(e: OutboxEntry, self: Self | undefined): ChatMessage {
  return {
    id: `pending:${e.clientId}`,
    channelId: e.channelId,
    ts: e.sentAt,
    ...(e.threadTs ? { threadTs: e.threadTs } : {}),
    author: { id: self?.userId ?? "nexus-self", name: self?.name ?? "you", isBot: false },
    text: e.text,
    codeRefs: [],
    sentVia: "user",
    clientId: e.clientId,
    ...(e.state === "failed" ? { failed: true } : { pending: true }),
  };
}

/**
 * What a view shows for a target: Slack's copies (the view's own list wins over the outbox's kept copies, so
 * edits stick), each once by ts, then the open sends that none of them confirms, oldest first.
 */
export function useOutboxRows(store: OutboxStore, target: Target, messages: ChatMessage[], self: Self | undefined): { shown: ChatMessage[]; rows: Row[] } {
  const version = useSyncExternalStore(store.subscribe, store.version);
  const { channelId, threadTs } = target;
  return useMemo(() => {
    const t = { channelId, threadTs };
    const shown = mergeMessages(store.confirmedFor(t), messages);
    const open = store.entriesFor(t).filter((e) => !shown.some((m) => confirms(e, m)));
    return { shown, rows: [...shown.map((message) => ({ message })), ...open.map((entry) => ({ message: echoMessage(entry, self), entry }))] };
    // version is the store's change counter: it is what makes the store's data fresh here.
  }, [store, version, channelId, threadTs, messages, self]);
}
