import { useEffect, useRef, useState } from "react";
import { Button, StatusLine, friendlyError, getBridge } from "../shared";
import type { BridgeClient } from "../shared";

// The reply box under a session's log: talk to the agent after the brief. While the agent works, the message is taken
// between its model calls; once it has finished, the same box continues the session on its own branch and worktree.

export interface ReplyProps {
  bridge?: BridgeClient;
  sessionId: string;
  /** The session is running or waiting on an approval (a message is queued) rather than finished (a message resumes it). */
  live: boolean;
}

export function Reply({ bridge, sessionId, live }: ReplyProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const sid = useRef(sessionId);

  // A different session on screen starts with an empty box and no stale error.
  useEffect(() => {
    sid.current = sessionId;
    setText("");
    setError("");
  }, [sessionId]);

  const body = text.trim();
  const send = () => {
    if (!body || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    const asked = sessionId;
    (bridge ?? getBridge())
      .request("agent.message", { sessionId: asked, text: body })
      .then(() => {
        if (sid.current === asked) setText("");
      })
      .catch((e) => {
        if (sid.current === asked) setError(friendlyError(e, "message"));
      })
      .finally(() => {
        sending.current = false;
        setBusy(false);
      });
  };

  return (
    <div className="sv-reply" aria-label="message the agent">
      <div className="sv-compose-box">
        <textarea
          className="nx-textarea sv-reply-text"
          aria-label="message to the agent"
          placeholder={live ? "message the agent · taken at its next step · enter sends" : "continue this session · enter sends"}
          value={text}
          disabled={busy}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="sv-compose-row">
          <span className="nx-caption sv-reply-hint">{live ? "QUEUED FOR THE AGENT" : "RESUMES ON ITS BRANCH"}</span>
          <Button variant="primary" size="sm" disabled={!body || busy} onClick={send} kbd="⏎">{busy ? "SENDING" : live ? "SEND" : "CONTINUE"}</Button>
        </div>
      </div>
      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
    </div>
  );
}
