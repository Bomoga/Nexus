import { useEffect, useState } from "react";
import type { SlackStatus } from "../../src/contracts";
import { Button, StatusLine, friendlyError, getBridge } from "../shared";
import type { BridgeClient } from "../shared";

const SOURCE_LABEL = { token_vault: "token vault", manual: "manual", none: "no token" } as const;

export function StatusBar({ bridge }: { bridge?: BridgeClient }) {
  const [status, setStatus] = useState<SlackStatus | undefined>();
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setFailure("");
    (bridge ?? getBridge())
      .request("slack.status", {})
      .then((s) => live && setStatus(s))
      .catch((e: unknown) => live && setFailure(friendlyError(e, "slack")));
    return () => {
      live = false;
    };
  }, [bridge, attempt]);

  if (failure) {
    return (
      <StatusLine tone="error">
        {failure} <Button onClick={() => setAttempt((n) => n + 1)}>RETRY</Button>
      </StatusLine>
    );
  }
  if (!status) return <StatusLine>connecting</StatusLine>;
  if (!status.connected) return <StatusLine tone="error">slack disconnected</StatusLine>;
  if (!status.postsAs) {
    return <StatusLine tone="pending">{`no user token: messages would post as ${status.botName}, not you`}</StatusLine>;
  }
  return <StatusLine>{`posting as ${status.postsAs.name} via ${SOURCE_LABEL[status.userTokenSource]}`}</StatusLine>;
}
