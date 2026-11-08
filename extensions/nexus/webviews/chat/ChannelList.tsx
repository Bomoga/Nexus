import { useEffect, useState } from "react";
import type { Channel } from "../../src/contracts";
import { EmptyState, ListRow, PanelHeader, StatusLine, friendlyError, getBridge } from "../shared";
import type { BridgeClient } from "../shared";

export const INVITE_TOOLTIP = "bot not in channel: no live updates";

export interface ChannelListProps {
  bridge?: BridgeClient;
  selectedId: string | undefined;
  onSelect: (channel: Channel) => void;
  /** Called once the channels load, so the app can pick a default. */
  onLoaded?: (channels: Channel[]) => void;
}

export function ChannelList({ bridge, selectedId, onSelect, onLoaded }: ChannelListProps) {
  const [channels, setChannels] = useState<Channel[] | undefined>();
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setFailure("");
    (bridge ?? getBridge())
      .request("slack.channels", {})
      .then((c) => {
        if (!live) return;
        setChannels(c);
        onLoaded?.(c);
      })
      .catch((e: unknown) => live && setFailure(friendlyError(e, "slack")));
    return () => {
      live = false;
    };
  }, [bridge, attempt]);

  if (failure) return <EmptyState message={failure} action={{ label: "RETRY", onClick: () => setAttempt((n) => n + 1) }} />;
  if (!channels) return <StatusLine>… loading</StatusLine>;
  if (channels.length === 0) return <EmptyState message="no channels" />;
  return (
    <div className="chat-channels">
      <PanelHeader title="CHANNELS" count={channels.length} />
      <div className="chat-channel-list" role="group" aria-label="channels">
        {channels.map((c) => (
          <ListRow
            key={c.id}
            small
            aria-current={c.id === selectedId ? "true" : undefined}
            selected={c.id === selectedId}
            onClick={() => onSelect(c)}
            leading={<span className="nx-data">{c.isPrivate ? "!" : "#"}</span>}
            title={c.name}
            titleText={c.name}
            trailing={
              <>
                {c.botIsMember ? null : <span className="chat-dot" role="img" title={INVITE_TOOLTIP} aria-label={INVITE_TOOLTIP} />}
                {c.unreadCount ? <span className="chat-unread nx-data">{c.unreadCount}</span> : null}
              </>
            }
          />
        ))}
      </div>
    </div>
  );
}
