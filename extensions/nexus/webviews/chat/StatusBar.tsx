import { useEffect, useState } from "react";
import type { SlackStatus } from "../../src/contracts";
import { StatusLine, getBridge } from "../shared";
import type { BridgeClient } from "../shared";

const SOURCE_LABEL = { token_vault: "token vault", manual: "manual", none: "no token" } as const;

export function StatusBar({ bridge }: { bridge?: BridgeClient }) {
  const [status, setStatus] = useState<SlackStatus | undefined>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    (bridge ?? getBridge())
      .request("slack.status", {})
      .then((s) => live && setStatus(s))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [bridge]);

  if (failed) return <StatusLine tone="error">slack status unavailable</StatusLine>;
  if (!status) return <StatusLine>connecting</StatusLine>;
  if (!status.connected) return <StatusLine tone="error">slack disconnected</StatusLine>;
  if (!status.postsAs) {
    return <StatusLine tone="pending">{`no user token: messages would post as ${status.botName}, not you`}</StatusLine>;
  }
  return <StatusLine>{`posting as ${status.postsAs.name} via ${SOURCE_LABEL[status.userTokenSource]}`}</StatusLine>;
}
