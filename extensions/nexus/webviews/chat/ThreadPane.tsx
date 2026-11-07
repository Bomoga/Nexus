import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../../src/contracts";
import { Button, EmptyState, StatusLine, friendlyError, getBridge } from "../shared";
import type { BridgeClient } from "../shared";
import { Composer, EchoBar, echoClass } from "./Composer";
import { mergeMessages, usePostsAs, useSlackLive, useUsers } from "./live";
import { useOutboxRows, useOutboxStore } from "./outbox";
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
  // Slack's copies only; open sends come from the outbox (see useOutboxRows).
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [load, setLoad] = useState<Load>("loading");
  const [loadFailure, setLoadFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  // MAKE TASK state per thread: a result lands on the thread that asked, never on the one open later.
  const [makes, setMakes] = useState<Record<string, Make>>({});
  const threadKey = `${channelId}/${threadTs}`;
  const make = makes[threadKey] ?? "idle";
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const stick = useRef(true);
  const self = usePostsAs(client);
  const outbox = useOutboxStore(client);
  const target = useMemo(() => ({ channelId, threadTs }), [channelId, threadTs]);
  const { shown, rows } = useOutboxRows(outbox, target, messages, self);
  const users = useUsers(client, shown, threadKey);
  const inThread = (m: ChatMessage) => m.threadTs === threadTs || m.ts === threadTs;

  useEffect(() => {
    let live = true;
    setMessages([]);
    setLoad("loading");
    stick.current = true;
    client
      .request("slack.thread", { channelId, threadTs })
      .then((t) => {
        if (!live) return;
        outbox.observe(t.messages);
        // Anything that arrived live while the thread was loading stays.
        setMessages((cur) => mergeMessages(t.messages, cur));
        setLoad("ready");
      })
      .catch((e: unknown) => {
        if (!live) return;
        setLoadFailure(friendlyError(e, "slack"));
        setLoad("failed");
      });
    return () => {
      live = false;
    };
  }, [client, channelId, threadTs, attempt, outbox]);

  useSlackLive(client, channelId, (m) => {
    outbox.observe([m]);
    if (!inThread(m)) return;
    if (atBottom.current) stick.current = true;
    setMessages((l) => mergeMessages(l, [m]));
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    stick.current = false;
    el.scrollTop = el.scrollHeight;
  }, [rows]);

  const makeTask = useCallback(() => {
    const set = (v: Make) => setMakes((m) => ({ ...m, [threadKey]: v }));
    set("working");
    const args = { channelId, threadTs };
    const run = runCommand
      ? Promise.resolve(runCommand("nexus.makeTaskFromThread", args))
      : client.request("tasks.createFromThread", args);
    run.then(
      () => set("done"),
      () => set("failed"),
    );
  }, [client, channelId, threadTs, threadKey, runCommand]);

  const send = (text: string) => {
    stick.current = true;
    outbox.send(target, text);
  };

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
        <EmptyState message={loadFailure} action={{ label: "RETRY", onClick: () => setAttempt((n) => n + 1) }} />
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
          {rows.map(({ message: m, entry }) => (
            <div key={m.id} className={echoClass(entry?.state)}>
              <MessageRow
                message={m}
                displayName={users[m.author.id]?.displayName}
                avatarUrl={users[m.author.id]?.avatarUrl}
                onOpenLink={onOpenLink}
              />
              {entry && entry.state !== "pending" ? <EchoBar state={entry.state} onRetry={() => outbox.retry(entry.clientId)} /> : null}
            </div>
          ))}
        </div>
      )}
      {load === "failed" ? null : (
        <Composer
          key={threadKey}
          onSend={send}
          placeholder="reply"
          initialText={outbox.draftFor(target)}
          onDraftChange={(text) => outbox.setDraft(target, text)}
        />
      )}
    </div>
  );
}
