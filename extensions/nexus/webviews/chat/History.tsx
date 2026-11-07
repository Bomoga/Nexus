import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../../src/contracts";
import { Button, Chip, EmptyState, StatusLine, friendlyError, getBridge } from "../shared";
import type { BridgeClient } from "../shared";
import { Composer, EchoBar, echoClass } from "./Composer";
import { isReply, mergeMessages, usePostsAs, useSlackLive, useUsers } from "./live";
import { useOutboxRows, useOutboxStore } from "./outbox";
import { MessageRow } from "./MessageRow";

const PAGE = 50;
const BOTTOM_SLOP = 4;

type Anchor = { kind: "bottom" } | { kind: "keep"; height: number };

export interface HistoryProps {
  bridge?: BridgeClient;
  channelId: string;
  /** For the empty-state line; without it the line says "no messages yet". */
  channelName?: string;
  onOpenLink?: (url: string) => void;
  /** Called with a parent message when its row or reply count is clicked. */
  onOpenThread?: (message: ChatMessage) => void;
}

export function History({ bridge, channelId, channelName, onOpenLink, onOpenThread }: HistoryProps) {
  const client = bridge ?? getBridge();
  // Slack's copies only; open sends come from the outbox (see useOutboxRows).
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [cached, setCached] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [olderFailed, setOlderFailed] = useState(false);
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  // The one older-page request in flight; only that request may clear it (a stale one from a previous channel must not).
  const inflight = useRef<object | undefined>(undefined);
  const anchor = useRef<Anchor | undefined>(undefined);
  const atBottom = useRef(true);
  const counted = useRef(new Set<string>());
  const self = usePostsAs(client);
  const outbox = useOutboxStore(client);
  const target = useMemo(() => ({ channelId }), [channelId]);
  const { shown, rows } = useOutboxRows(outbox, target, messages, self);
  const users = useUsers(client, shown, channelId);

  useEffect(() => {
    const gen = ++generation.current;
    setMessages([]);
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
        outbox.observe(r.messages);
        anchor.current = { kind: "bottom" };
        // Live messages that arrived while the page was loading stay.
        setMessages((cur) => mergeMessages(r.messages, cur));
        setCursor(r.nextCursor);
        setCached(r.fromCache);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (gen !== generation.current) return;
        setFailure(friendlyError(e, "slack"));
        setState("failed");
      });
  }, [client, channelId, attempt, outbox]);

  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = undefined;
    el.scrollTop = a.kind === "bottom" ? el.scrollHeight : el.scrollHeight - a.height;
  }, [rows]);

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
        outbox.observe(r.messages);
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
  }, [client, channelId, cursor, outbox]);

  // Paging is driven by scroll events, which never come if the pane does not overflow or the page we just
  // loaded added no height; keep loading while the top is in view and older pages exist.
  useEffect(() => {
    const el = scroller.current;
    if (state !== "ready" || !cursor || olderFailed || !el || el.clientHeight <= 0) return;
    if (el.scrollHeight <= el.clientHeight || el.scrollTop <= 0) loadOlder();
  }, [state, cursor, olderFailed, rows, loadOlder]);

  useSlackLive(client, channelId, (m, kind) => {
    outbox.observe([m]);
    if (isReply(m)) {
      // Replies belong to the thread pane; the parent only shows a count.
      if (kind === "message" && !counted.current.has(m.id)) {
        counted.current.add(m.id);
        setMessages((l) => l.map((p) => (p.ts === m.threadTs ? { ...p, replyCount: (p.replyCount ?? 0) + 1 } : p)));
      }
      return;
    }
    if (atBottom.current) anchor.current = { kind: "bottom" };
    setMessages((l) => mergeMessages(l, [m]));
  });

  const send = (text: string) => {
    anchor.current = { kind: "bottom" };
    outbox.send(target, text);
  };

  const openThread = (m: ChatMessage, el: HTMLElement) => {
    if (!onOpenThread || m.pending || m.failed || el.closest("button")) return;
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
        <EmptyState message={failure} action={{ label: "RETRY", onClick: () => setAttempt((n) => n + 1) }} />
      ) : state === "ready" && rows.length === 0 ? (
        <EmptyState message={channelName ? `no messages in #${channelName} yet` : "no messages yet"} />
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
          {rows.map(({ message: m, entry }) => {
            const opens = onOpenThread && !entry;
            const cls = [echoClass(entry?.state), opens ? "chat-row-open" : ""].filter(Boolean).join(" ") || undefined;
            return (
              <div key={m.id} className={cls} onClick={(e) => openThread(m, e.target as HTMLElement)}>
                <MessageRow
                  message={m}
                  displayName={users[m.author.id]?.displayName}
                  avatarUrl={users[m.author.id]?.avatarUrl}
                  onOpenLink={onOpenLink}
                  onOpenThread={entry ? undefined : onOpenThread}
                />
                {entry && entry.state !== "pending" ? <EchoBar state={entry.state} onRetry={() => outbox.retry(entry.clientId)} /> : null}
              </div>
            );
          })}
        </div>
      )}
      {state === "failed" ? null : (
        <Composer
          key={channelId}
          onSend={send}
          initialText={outbox.draftFor(target)}
          onDraftChange={(text) => outbox.setDraft(target, text)}
        />
      )}
    </div>
  );
}
