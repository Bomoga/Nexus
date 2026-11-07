// Live updates and optimistic sending for the chat view. Pure list helpers plus the hooks the channel
// history and the thread pane share. All traffic goes through the kit's bridge client.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatMessage, SlackUser } from "../../src/contracts";
import type { BridgeClient } from "../shared";

export const PENDING_PREFIX = "pending:";

const SELF = { id: "nexus-self", name: "you", isBot: false } as const;

const byTs = (a: ChatMessage, b: ChatMessage) => parseFloat(a.ts) - parseFloat(b.ts) || a.ts.localeCompare(b.ts);

/** Messages are the same message when their Slack ts match (pending echoes have no real ts, so they key on id). */
const keyOf = (m: ChatMessage) => (m.id.startsWith(PENDING_PREFIX) ? m.id : `${m.channelId}/${m.ts}`);

/** Merges by ts (later copies win) and sorts oldest to newest. */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const map = new Map(existing.map((m) => [keyOf(m), m]));
  for (const m of incoming) map.set(keyOf(m), m);
  return [...map.values()].sort(byTs);
}

export const isReply = (m: ChatMessage) => m.threadTs !== undefined && m.threadTs !== m.ts;
export const clientIdOf = (m: ChatMessage) => (m.id.startsWith(PENDING_PREFIX) ? m.id.slice(PENDING_PREFIX.length) : undefined);

let clientSeq = 0;
export function newClientId(): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `nx-${++clientSeq}-${rand}`;
}

export interface Outgoing { channelId: string; threadTs?: string; text: string; clientId: string }

export function makePending(o: Outgoing): ChatMessage {
  return {
    id: `${PENDING_PREFIX}${o.clientId}`,
    channelId: o.channelId,
    ts: (Date.now() / 1000).toFixed(6),
    ...(o.threadTs ? { threadTs: o.threadTs } : {}),
    author: SELF,
    text: o.text,
    codeRefs: [],
    sentVia: "user",
    pending: true,
  };
}

const sameTarget = (a: ChatMessage, b: ChatMessage) => a.channelId === b.channelId && (a.threadTs ?? "") === (b.threadTs ?? "");

/**
 * Applies a message from slack.subscribe. A user message that matches an in-flight pending echo (same
 * channel, thread and text) is Slack's confirmed copy of it and takes its place.
 */
export function applyIncoming(list: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const known = list.some((m) => keyOf(m) === keyOf(incoming));
  let rest = list;
  if (!known && incoming.sentVia === "user" && !incoming.author.isBot) {
    const i = list.findIndex((m) => m.pending && !m.failed && m.text === incoming.text && sameTarget(m, incoming));
    if (i >= 0) rest = list.filter((_, j) => j !== i);
  }
  return mergeMessages(rest, [incoming]);
}

/**
 * The slack.post reply is the confirmed copy of the pending echo with that clientId. If the echo is already
 * gone, the subscription's copy replaced it first and there is nothing to add.
 */
export function confirmPending(list: ChatMessage[], clientId: string, confirmed: ChatMessage): ChatMessage[] {
  const id = `${PENDING_PREFIX}${clientId}`;
  if (!list.some((m) => m.id === id)) return list;
  return mergeMessages(list.filter((m) => m.id !== id), [confirmed]);
}

export function failPending(list: ChatMessage[], clientId: string): ChatMessage[] {
  return list.map((m) => (m.id === `${PENDING_PREFIX}${clientId}` ? { ...m, pending: false, failed: true } : m));
}

export function repending(list: ChatMessage[], clientId: string): ChatMessage[] {
  return list.map((m) => (m.id === `${PENDING_PREFIX}${clientId}` ? { ...m, pending: true, failed: false } : m));
}

/** Subscribes to slack.subscribe for one channel; the callback sees only that channel's messages. */
export function useSlackLive(
  client: BridgeClient,
  channelId: string,
  onMessage: (message: ChatMessage, kind: "message" | "message_changed") => void,
): void {
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(() => {
    const off = client.subscribe("slack.subscribe", { channelIds: [channelId] }, (evt) => {
      if (evt.type === "status") return;
      if (evt.message.channelId !== channelId) return;
      handler.current(evt.message, evt.type);
    });
    return () => off?.();
  }, [client, channelId]);
}

export interface Outbox {
  send(text: string): void;
  retry(message: ChatMessage): void;
}

/**
 * Optimistic sending into a message list: the echo shows pending at once, then the post reply (or the
 * subscription's copy, see applyIncoming) replaces it; a rejected post marks it failed for retry.
 */
export function useOutbox(
  client: BridgeClient,
  target: { channelId: string; threadTs?: string },
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  onSent?: () => void,
): Outbox {
  const current = useRef(target);
  current.current = target;
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;

  const post = useCallback(
    (o: Outgoing) => {
      const stillHere = () => current.current.channelId === o.channelId && current.current.threadTs === o.threadTs;
      client
        .request("slack.post", { channelId: o.channelId, text: o.text, ...(o.threadTs ? { threadTs: o.threadTs } : {}), clientId: o.clientId })
        .then((confirmed) => {
          if (stillHere()) setMessages((l) => confirmPending(l, o.clientId, confirmed));
        })
        .catch(() => {
          if (stillHere()) setMessages((l) => failPending(l, o.clientId));
        });
    },
    [client, setMessages],
  );

  const send = useCallback(
    (text: string) => {
      const o: Outgoing = { channelId: current.current.channelId, threadTs: current.current.threadTs, text, clientId: newClientId() };
      setMessages((l) => mergeMessages(l, [makePending(o)]));
      onSentRef.current?.();
      post(o);
    },
    [post, setMessages],
  );

  const retry = useCallback(
    (m: ChatMessage) => {
      const clientId = clientIdOf(m);
      if (!clientId) return;
      setMessages((l) => repending(l, clientId));
      post({ channelId: m.channelId, threadTs: m.threadTs, text: m.text, clientId });
    },
    [post, setMessages],
  );

  return { send, retry };
}

/** Resolves display names and (safe) avatars for authors not asked about yet; `resetKey` clears the cache. */
export function useUsers(client: BridgeClient, messages: ChatMessage[], resetKey: string): Record<string, SlackUser> {
  const [users, setUsers] = useState<Record<string, SlackUser>>({});
  const asked = useRef(new Set<string>());
  const epoch = useRef(0);
  const lastKey = useRef(resetKey);
  if (lastKey.current !== resetKey) {
    lastKey.current = resetKey;
    epoch.current++;
    asked.current = new Set();
  }
  useEffect(() => {
    const ids = [...new Set(messages.filter((m) => !m.pending && !m.failed).map((m) => m.author.id))].filter((id) => !asked.current.has(id));
    if (ids.length === 0) return;
    ids.forEach((id) => asked.current.add(id));
    const mine = epoch.current;
    client
      .request("slack.users", { ids })
      .then((list) => {
        if (mine !== epoch.current) return;
        setUsers((u) => ({ ...u, ...Object.fromEntries(list.map((x) => [x.id, x])) }));
      })
      .catch(() => undefined);
  }, [client, messages]);
  return users;
}
