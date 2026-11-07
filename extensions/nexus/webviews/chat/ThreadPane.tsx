import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../src/contracts";
import { Button, EmptyState, StatusLine, getBridge } from "../shared";
import type { BridgeClient } from "../shared";
import { Composer, FailedBar } from "./Composer";
import { mergeMessages, useOutbox, usePostsAs, useSlackLive, useUsers } from "./live";
import { MessageRow } from "./MessageRow";

export type ThreadCommand = "nexus.makeTaskFromThread";
export interface ThreadCommandArgs { channelId: string; threadTs: string }

export interface ThreadPaneProps {
  bridge?: BridgeClient;
  channelId: string;
  threadTs: string;
  onClose: () => void;
  onOpenLink?: (url: string) => void;
  /**
   * Runs an editor command by id. The bridge protocol has no command request yet, so without this the
   * MAKE TASK button falls back to the equivalent tasks.createFromThread request.
   */
  runCommand?: (command: ThreadCommand, args: ThreadCommandArgs) => Promise<unknown> | void;
}

type Load = "loading" | "ready" | "failed";
type Make = "idle" | "working" | "done" | "failed";

export function ThreadPane({ bridge, channelId, threadTs, onClose, onOpenLink, runCommand }: ThreadPaneProps) {
  const client = bridge ?? getBridge();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [load, setLoad] = useState<Load>("loading");
  const [attempt, setAttempt] = useState(0);
  const [make, setMake] = useState<Make>("idle");
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const stick = useRef(true);
  const users = useUsers(client, messages, `${channelId}/${threadTs}`);
  const self = usePostsAs(client);
  const outbox = useOutbox(client, { channelId, threadTs }, setMessages, self, () => {
    stick.current = true;
  });
  const { failedFor } = outbox;
  const inThread = (m: ChatMessage) => m.threadTs === threadTs || m.ts === threadTs;

  useEffect(() => {
    let live = true;
    setMessages(failedFor(channelId, threadTs));
    setLoad("loading");
    setMake("idle");
    stick.current = true;
    client
      .request("slack.thread", { channelId, threadTs })
      .then((t) => {
        if (!live) return;
        // Anything that arrived live while the thread was loading stays.
        setMessages((cur) => mergeMessages(t.messages, cur));
        setLoad("ready");
      })
      .catch(() => live && setLoad("failed"));
    return () => {
      live = false;
    };
  }, [client, channelId, threadTs, attempt, failedFor]);

  useSlackLive(client, channelId, (m, kind) => {
    if (!inThread(m)) return;
    if (atBottom.current) stick.current = true;
    setMessages((l) => (kind === "message_changed" ? mergeMessages(l, [m]) : outbox.incoming(l, m)));
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    stick.current = false;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const makeTask = useCallback(() => {
    setMake("working");
    const args = { channelId, threadTs };
    const run = runCommand
      ? Promise.resolve(runCommand("nexus.makeTaskFromThread", args))
      : client.request("tasks.createFromThread", args);
    run.then(
      () => setMake("done"),
      () => setMake("failed"),
    );
  }, [client, channelId, threadTs, runCommand]);

  return (
    <div className="chat-thread-pane">
      <div className="chat-thread-head">
        <span className="chat-thread-title">THREAD</span>
        <Button variant="primary" onClick={makeTask} disabled={make === "working" || make === "done"}>
          MAKE TASK
        </Button>
        <Button onClick={onClose}>CLOSE</Button>
      </div>
      {make === "done" ? <StatusLine tone="ok">task drafted</StatusLine> : null}
      {make === "failed" ? <StatusLine tone="error">could not make a task</StatusLine> : null}
      {load === "failed" ? (
        <EmptyState message="could not load thread" action={{ label: "RETRY", onClick: () => setAttempt((n) => n + 1) }} />
      ) : (
        <div
          ref={scroller}
          className="chat-history chat-thread-list"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
          }}
        >
          {load === "loading" ? <StatusLine>loading</StatusLine> : null}
          {messages.map((m) => (
            <div key={m.id} className={m.failed ? "chat-failed" : undefined}>
              <MessageRow
                message={m}
                displayName={users[m.author.id]?.displayName}
                avatarUrl={users[m.author.id]?.avatarUrl}
                onOpenLink={onOpenLink}
              />
              {m.failed ? <FailedBar onRetry={() => outbox.retry(m)} /> : null}
            </div>
          ))}
        </div>
      )}
      {load === "failed" ? null : <Composer key={`${channelId}/${threadTs}`} onSend={outbox.send} placeholder="reply" />}
    </div>
  );
}
