import { useEffect, useState } from "react";
import type { SlackStatus } from "../../src/contracts";
import { Button, StatusLine, friendlyError, getBridge } from "../shared";
import type { BridgeClient } from "../shared";

const SOURCE_LABEL = { token_vault: "token vault", manual: "manual", none: "no token" } as const;

/** Socket Mode may still be connecting when the view opens: ask again soon until it is up, then only now and then. */
export const POLL_WHILE_DOWN_MS = 3_000;
export const POLL_WHILE_UP_MS = 30_000;

/** The one-line connection state under the panes; who a send posts as is on the composer's own line. */
export function StatusBar({ bridge, pollWhileDownMs = POLL_WHILE_DOWN_MS, pollWhileUpMs = POLL_WHILE_UP_MS }: { bridge?: BridgeClient; pollWhileDownMs?: number; pollWhileUpMs?: number }) {
  const [status, setStatus] = useState<SlackStatus | undefined>();
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setFailure("");
    const client = bridge ?? getBridge();
    const poll = () => {
      client
        .request("slack.status", {})
        .then((s) => {
          if (!live) return;
          setStatus(s);
          timer = setTimeout(poll, s.connected ? pollWhileUpMs : pollWhileDownMs);
        })
        .catch((e: unknown) => live && setFailure(friendlyError(e, "slack")));
    };
    poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [bridge, attempt, pollWhileDownMs, pollWhileUpMs]);

  if (failure) {
    return (
      <StatusLine tone="error">
        <span>{failure}</span>
        <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
          RETRY
        </Button>
      </StatusLine>
    );
  }
  if (!status) return <StatusLine>… connecting</StatusLine>;
  if (!status.connected) return <StatusLine tone="error">slack disconnected</StatusLine>;
  if (!status.postsAs) {
    return <StatusLine tone="pending">{`slack connected · no user token: posts go as ${status.botName}`}</StatusLine>;
  }
  return <StatusLine>{`slack connected · token: ${SOURCE_LABEL[status.userTokenSource]}`}</StatusLine>;
}
