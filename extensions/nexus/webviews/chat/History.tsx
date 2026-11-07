import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../src/contracts";
import { Button, Chip, EmptyState, StatusLine, getBridge } from "../shared";
import type { BridgeClient } from "../shared";
import { Composer, FailedBar } from "./Composer";
import { isReply, mergeMessages, useOutbox, usePostsAs, useSlackLive, useUsers } from "./live";
import { MessageRow } from "./MessageRow";

const PAGE = 50;
const BOTTOM_SLOP = 4;

type Anchor = { kind: "bottom" } | { kind: "keep"; height: number };

export interface HistoryProps {
  bridge?: BridgeClient;
  channelId: string;
  onOpenLink?: (url: string) => void;
  /** Called with a parent message when its row or reply count is clicked. */
  onOpenThread?: (message: ChatMessage) => void;
}

export function History({ bridge, channelId, onOpenLink, onOpenThread }: HistoryProps) {
  const client = bridge ?? getBridge();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [cached, setCached] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [olderFailed, setOlderFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  // The one older-page request in flight; only that request may clear it (a stale one from a previous channel must not).
  const inflight = useRef<object | undefined>(undefined);
  const anchor = useRef<Anchor | undefined>(undefined);
  const atBottom = useRef(true);
  const counted = useRef(new Set<string>());
  const users = useUsers(client, messages, channelId);
  const self = usePostsAs(client);
  const outbox = useOutbox(client, { channelId }, setMessages, self, () => {
    anchor.current = { kind: "bottom" };
  });
  const { failedFor } = outbox;

  useEffect(() => {
    const gen = ++generation.current;
    // Echoes whose post failed while we were here earlier come back with RETRY.
    setMessages(failedFor(channelId));
    setCursor(undefined);
    setCached(false);
    setState("loading");
    setOlderFailed(false);
    inflight.current = undefined;
    atBottom.current = true;
    counted.current = new Set();
    client
      .request("slack.history", { channelId, limit: PAGE })
      .then((r) => {
        if (gen !== generation.current) return;
        anchor.current = { kind: "bottom" };
        // Live and pending messages that arrived while the page was loading stay.
        setMessages((cur) => mergeMessages(r.messages, cur));
        setCursor(r.nextCursor);
        setCached(r.fromCache);
        setState("ready");
      })
      .catch(() => {
        if (gen === generation.current) setState("failed");
      });
  }, [client, channelId, attempt, failedFor]);

  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = undefined;
    el.scrollTop = a.kind === "bottom" ? el.scrollHeight : el.scrollHeight - a.height;
  }, [messages]);

  const loadOlder = useCallback(() => {
    if (!cursor || inflight.current) return;
    const token = {};
    inflight.current = token;
    setOlderFailed(false);
    const gen = generation.current;
    const height = scroller.current?.scrollHeight ?? 0;
    client
      .request("slack.history", { channelId, cursor, limit: PAGE })
      .then((r) => {
        if (gen !== generation.current) return;
        anchor.current = { kind: "keep", height };
        setMessages((m) => mergeMessages(m, r.messages));
        // A cursor that does not advance would loop forever; treat it as the end.
        setCursor(r.nextCursor === cursor ? undefined : r.nextCursor);
      })
      .catch(() => {
        if (gen === generation.current) setOlderFailed(true);
      })
      .finally(() => {
        if (inflight.current === token) inflight.current = undefined;
      });
  }, [client, channelId, cursor]);

  // Paging is driven by scroll events, which never come if the pane does not overflow or the page we just
  // loaded added no height; keep loading while the top is in view and older pages exist.
  useEffect(() => {
    const el = scroller.current;
    if (state !== "ready" || !cursor || olderFailed || !el || el.clientHeight <= 0) return;
    if (el.scrollHeight <= el.clientHeight || el.scrollTop <= 0) loadOlder();
  }, [state, cursor, olderFailed, messages, loadOlder]);

  useSlackLive(client, channelId, (m, kind) => {
    if (isReply(m)) {
      // Replies belong to the thread pane; the parent only shows a count.
      if (kind === "message" && !counted.current.has(m.id)) {
        counted.current.add(m.id);
        setMessages((l) => l.map((p) => (p.ts === m.threadTs ? { ...p, replyCount: (p.replyCount ?? 0) + 1 } : p)));
      }
      return;
    }
    if (atBottom.current) anchor.current = { kind: "bottom" };
    setMessages((l) => (kind === "message_changed" ? mergeMessages(l, [m]) : outbox.incoming(l, m)));
  });

  const openThread = (m: ChatMessage, target: HTMLElement) => {
    if (!onOpenThread || m.pending || m.failed || target.closest("button")) return;
    onOpenThread(m);
  };

  return (
    <div className="chat-history-pane">
      {cached ? (
        <div className="chat-history-head">
          <Chip>cached</Chip>
        </div>
      ) : null}
      {state === "failed" ? (
        <EmptyState message="could not load history" action={{ label: "RETRY", onClick: () => setAttempt((n) => n + 1) }} />
      ) : state === "ready" && messages.length === 0 ? (
        <EmptyState message="no messages yet" />
      ) : (
        <div
          ref={scroller}
          className="chat-history"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLOP;
            if (el.scrollTop <= 0) loadOlder();
          }}
        >
          {olderFailed ? (
            <StatusLine tone="error">
              could not load older messages{" "}
              <Button onClick={loadOlder}>RETRY</Button>
            </StatusLine>
          ) : null}
          {messages.map((m) => (
            <div
              key={m.id}
              className={[m.failed ? "chat-failed" : "", onOpenThread && !m.pending && !m.failed ? "chat-row-open" : ""].filter(Boolean).join(" ") || undefined}
              onClick={(e) => openThread(m, e.target as HTMLElement)}
            >
              <MessageRow
                message={m}
                displayName={users[m.author.id]?.displayName}
                avatarUrl={users[m.author.id]?.avatarUrl}
                onOpenLink={onOpenLink}
                onOpenThread={onOpenThread}
              />
              {m.failed ? <FailedBar onRetry={() => outbox.retry(m)} /> : null}
            </div>
          ))}
        </div>
      )}
      {state === "failed" ? null : <Composer key={channelId} onSend={outbox.send} />}
    </div>
  );
}
