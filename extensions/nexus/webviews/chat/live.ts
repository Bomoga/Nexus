// Live updates and optimistic sending for the chat view. Pure list helpers plus the hooks the channel
// history and the thread pane share. All traffic goes through the kit's bridge client.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatMessage, SlackUser } from "../../src/contracts";
import type { BridgeClient } from "../shared";

export const PENDING_PREFIX = "pending:";

/** The Slack identity posts are made as (slack.status postsAs). */
export interface Self { userId: string; name: string }

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

export function makePending(o: Outgoing, self?: Self): ChatMessage {
  return {
    id: `${PENDING_PREFIX}${o.clientId}`,
    channelId: o.channelId,
    ts: (Date.now() / 1000).toFixed(6),
    ...(o.threadTs ? { threadTs: o.threadTs } : {}),
    author: { id: self?.userId ?? "nexus-self", name: self?.name ?? "you", isBot: false },
    text: o.text,
    codeRefs: [],
    sentVia: "user",
    pending: true,
  };
}

const sameTarget = (a: ChatMessage, b: ChatMessage) => a.channelId === b.channelId && (a.threadTs ?? "") === (b.threadTs ?? "");

/**
 * The echo (pending, or failed because the bridge timed out on a slow post) that a subscription message is
 * Slack's confirmed copy of. Only our own posting identity can match: another person's identical text must
 * never consume our echo, and with no known identity there is no fallback (the post reply confirms instead).
 */
export function matchEcho(list: ChatMessage[], incoming: ChatMessage, self: Self | undefined): ChatMessage | undefined {
  if (!self || incoming.author.id !== self.userId || incoming.sentVia !== "user" || incoming.author.isBot) return undefined;
  if (list.some((m) => keyOf(m) === keyOf(incoming))) return undefined;
  const same = (m: ChatMessage) => m.text === incoming.text && sameTarget(m, incoming);
  return list.find((m) => m.pending && !m.failed && same(m)) ?? list.find((m) => m.failed && same(m));
}

/** Applies a message from slack.subscribe; a matching echo (see matchEcho) is replaced by it. */
export function applyIncoming(list: ChatMessage[], incoming: ChatMessage, self?: Self): ChatMessage[] {
  const echo = matchEcho(list, incoming, self);
  return mergeMessages(echo ? list.filter((m) => m !== echo) : list, [incoming]);
}

/** The slack.post reply is the confirmed copy of the echo with that clientId; it is always kept (de-duped by ts). */
export function confirmPending(list: ChatMessage[], clientId: string, confirmed: ChatMessage): ChatMessage[] {
  return mergeMessages(list.filter((m) => m.id !== `${PENDING_PREFIX}${clientId}`), [confirmed]);
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
    return off;
  }, [client, channelId]);
}

/** The identity we post as, from slack.status; undefined while unknown (or when Slack would post as the app). */
export function usePostsAs(client: BridgeClient): Self | undefined {
  const [self, setSelf] = useState<Self | undefined>();
  useEffect(() => {
    let live = true;
    client
      .request("slack.status", {})
      .then((st) => live && setSelf(st.postsAs ? { userId: st.postsAs.userId, name: st.postsAs.name } : undefined))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client]);
  return self;
}

export interface Outbox {
  send(text: string): void;
  retry(message: ChatMessage): void;
  /** Failed echoes of a target (kept even when the user was elsewhere when the post failed). */
  failedFor(channelId: string, threadTs?: string): ChatMessage[];
  /** slack.subscribe message into a list: replaces a matching echo and forgets it. */
  incoming(list: ChatMessage[], message: ChatMessage): ChatMessage[];
}

const targetKey = (channelId: string, threadTs?: string) => `${channelId}/${threadTs ?? ""}`;

/**
 * Optimistic sending into a message list: the echo shows pending at once, then the post reply (or the
 * subscription's copy, see matchEcho) replaces it; a rejected post marks it failed for retry. The target is
 * captured when the user sends, never read later.
 */
export function useOutbox(
  client: BridgeClient,
  target: { channelId: string; threadTs?: string },
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  self: Self | undefined,
  onSent?: () => void,
): Outbox {
  const { channelId, threadTs } = target;
  const current = useRef(target);
  current.current = target;
  const selfRef = useRef(self);
  selfRef.current = self;
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;
  const failed = useRef(new Map<string, Map<string, ChatMessage>>());

  const forget = useCallback((m: ChatMessage) => {
    const id = clientIdOf(m);
    if (id) failed.current.get(targetKey(m.channelId, m.threadTs))?.delete(id);
  }, []);

  const post = useCallback(
    (echo: ChatMessage, clientId: string) => {
      const here = () => current.current.channelId === echo.channelId && current.current.threadTs === echo.threadTs;
      client
        .request("slack.post", { channelId: echo.channelId, text: echo.text, ...(echo.threadTs ? { threadTs: echo.threadTs } : {}), clientId })
        .then((confirmed) => {
          forget(echo);
          if (here()) setMessages((l) => confirmPending(l, clientId, confirmed));
        })
        .catch(() => {
          const k = targetKey(echo.channelId, echo.threadTs);
          const map = failed.current.get(k) ?? new Map<string, ChatMessage>();
          map.set(clientId, { ...echo, pending: false, failed: true });
          failed.current.set(k, map);
          if (here()) setMessages((l) => failPending(l, clientId));
        });
    },
    [client, setMessages, forget],
  );

  const send = useCallback(
    (text: string) => {
      const clientId = newClientId();
      const echo = makePending({ channelId, threadTs, text, clientId }, selfRef.current);
      setMessages((l) => mergeMessages(l, [echo]));
      onSentRef.current?.();
      post(echo, clientId);
    },
    [post, setMessages, channelId, threadTs],
  );

  const retry = useCallback(
    (m: ChatMessage) => {
      const clientId = clientIdOf(m);
      if (!clientId) return;
      forget(m);
      setMessages((l) => repending(l, clientId));
      post({ ...m, pending: true, failed: false }, clientId);
    },
    [post, setMessages, forget],
  );

  const failedFor = useCallback((c: string, t?: string) => [...(failed.current.get(targetKey(c, t))?.values() ?? [])], []);

  const incoming = useCallback(
    (list: ChatMessage[], m: ChatMessage) => {
      const echo = matchEcho(list, m, selfRef.current);
      if (echo) forget(echo);
      return applyIncoming(list, m, selfRef.current);
    },
    [forget],
  );

  return { send, retry, failedFor, incoming };
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
