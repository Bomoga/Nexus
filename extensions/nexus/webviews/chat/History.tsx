import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage, SlackUser } from "../../src/contracts";
import { Chip, EmptyState, getBridge } from "../shared";
import type { BridgeClient } from "../shared";
import { MessageRow } from "./MessageRow";

const PAGE = 50;

const byTs = (a: ChatMessage, b: ChatMessage) => parseFloat(a.ts) - parseFloat(b.ts) || a.ts.localeCompare(b.ts);

function merge(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const map = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort(byTs);
}

type Anchor = { kind: "bottom" } | { kind: "keep"; height: number };

export interface HistoryProps {
  bridge?: BridgeClient;
  channelId: string;
  onOpenLink?: (url: string) => void;
  /** Wired by the thread pane (L3-09). */
  onOpenThread?: (message: ChatMessage) => void;
}

export function History({ bridge, channelId, onOpenLink, onOpenThread }: HistoryProps) {
  const client = bridge ?? getBridge();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [cached, setCached] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [users, setUsers] = useState<Record<string, SlackUser>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const loadingOlder = useRef(false);
  const generation = useRef(0);
  const anchor = useRef<Anchor | undefined>(undefined);
  const asked = useRef(new Set<string>());

  useEffect(() => {
    const gen = ++generation.current;
    setMessages([]);
    setCursor(undefined);
    setCached(false);
    setState("loading");
    loadingOlder.current = false;
    asked.current = new Set();
    client
      .request("slack.history", { channelId, limit: PAGE })
      .then((r) => {
        if (gen !== generation.current) return;
        anchor.current = { kind: "bottom" };
        setMessages(merge([], r.messages));
        setCursor(r.nextCursor);
        setCached(r.fromCache);
        setState("ready");
      })
      .catch(() => {
        if (gen === generation.current) setState("failed");
      });
  }, [client, channelId]);

  // Resolve display names and (safe) avatars for authors we have not asked about yet.
  useEffect(() => {
    const ids = [...new Set(messages.map((m) => m.author.id))].filter((id) => !asked.current.has(id));
    if (ids.length === 0) return;
    ids.forEach((id) => asked.current.add(id));
    const gen = generation.current;
    client
      .request("slack.users", { ids })
      .then((list) => {
        if (gen !== generation.current) return;
        setUsers((u) => ({ ...u, ...Object.fromEntries(list.map((x) => [x.id, x])) }));
      })
      .catch(() => undefined);
  }, [client, messages]);

  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = undefined;
    el.scrollTop = a.kind === "bottom" ? el.scrollHeight : el.scrollHeight - a.height;
  }, [messages]);

  const loadOlder = useCallback(() => {
    if (!cursor || loadingOlder.current) return;
    loadingOlder.current = true;
    const gen = generation.current;
    const height = scroller.current?.scrollHeight ?? 0;
    client
      .request("slack.history", { channelId, cursor, limit: PAGE })
      .then((r) => {
        if (gen !== generation.current) return;
        anchor.current = { kind: "keep", height };
        setMessages((m) => merge(m, r.messages));
        setCursor(r.nextCursor);
      })
      .catch(() => undefined)
      .finally(() => {
        loadingOlder.current = false;
      });
  }, [client, channelId, cursor]);

  return (
    <div className="chat-history-pane">
      {cached ? (
        <div className="chat-history-head">
          <Chip>cached</Chip>
        </div>
      ) : null}
      {state === "failed" ? (
        <EmptyState message="could not load history" />
      ) : state === "ready" && messages.length === 0 ? (
        <EmptyState message="no messages yet" />
      ) : (
        <div
          ref={scroller}
          className="chat-history"
          onScroll={(e) => {
            if (e.currentTarget.scrollTop <= 0) loadOlder();
          }}
        >
          {messages.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              displayName={users[m.author.id]?.displayName}
              avatarUrl={users[m.author.id]?.avatarUrl}
              onOpenLink={onOpenLink}
              onOpenThread={onOpenThread}
            />
          ))}
        </div>
      )}
    </div>
  );
}
