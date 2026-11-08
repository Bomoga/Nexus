// Live updates for the chat view: pure list helpers plus the hooks the channel history and the thread pane
// share. Sending lives in outbox.ts. All traffic goes through the kit's bridge client.
import { useEffect, useRef, useState } from "react";
import type { ChatMessage, SlackUser } from "../../src/contracts";
import type { BridgeClient } from "../shared";

/** The Slack identity posts are made as (slack.status postsAs). */
export interface Self { userId: string; name: string }

const byTs = (a: ChatMessage, b: ChatMessage) => parseFloat(a.ts) - parseFloat(b.ts) || a.ts.localeCompare(b.ts);

/** Messages are the same message when their channel and Slack ts match. */
const keyOf = (m: ChatMessage) => `${m.channelId}/${m.ts}`;

/** Merges by ts (later copies win) and sorts oldest to newest. */
export function mergeMessages(existing: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  const map = new Map(existing.map((m) => [keyOf(m), m]));
  for (const m of incoming) map.set(keyOf(m), m);
  return [...map.values()].sort(byTs);
}

export const isReply = (m: ChatMessage) => m.threadTs !== undefined && m.threadTs !== m.ts;

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

/** The Slack identity we post as. `known` turns true once slack.status answered; `self` is unset when Slack would post as the app. */
export interface PostsAsState { known: boolean; self: Self | undefined }

export function usePostsAsState(client: BridgeClient): PostsAsState {
  const [state, setState] = useState<PostsAsState>({ known: false, self: undefined });
  useEffect(() => {
    let live = true;
    client
      .request("slack.status", {})
      .then((st) => live && setState({ known: true, self: st.postsAs ? { userId: st.postsAs.userId, name: st.postsAs.name } : undefined }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client]);
  return state;
}

/** The identity we post as, from slack.status; undefined while unknown (or when Slack would post as the app). */
export function usePostsAs(client: BridgeClient): Self | undefined {
  return usePostsAsState(client).self;
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
