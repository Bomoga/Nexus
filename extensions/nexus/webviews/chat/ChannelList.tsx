import { useEffect, useState } from "react";
import type { Channel } from "../../src/contracts";
import { EmptyState, getBridge } from "../shared";
import type { BridgeClient } from "../shared";

export const INVITE_TOOLTIP = "invite @Nexus for live updates";

export interface ChannelListProps {
  bridge?: BridgeClient;
  selectedId: string | undefined;
  onSelect: (channel: Channel) => void;
  /** Called once the channels load, so the app can pick a default. */
  onLoaded?: (channels: Channel[]) => void;
}

export function ChannelList({ bridge, selectedId, onSelect, onLoaded }: ChannelListProps) {
  const [channels, setChannels] = useState<Channel[] | undefined>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    (bridge ?? getBridge())
      .request("slack.channels", {})
      .then((c) => {
        if (!live) return;
        setChannels(c);
        onLoaded?.(c);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  if (failed) return <EmptyState message="could not load channels" />;
  if (!channels) return <div className="chat-channels" />;
  if (channels.length === 0) return <EmptyState message="no channels" />;
  return (
    <ul className="chat-channels" aria-label="channels">
      {channels.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            className={`chat-channel${c.id === selectedId ? " chat-channel--selected" : ""}`}
            aria-current={c.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(c)}
          >
            <span className="chat-channel-name">
              <span className="nx-data">{c.isPrivate ? "!" : "#"}</span>
              {c.name}
            </span>
            {c.botIsMember ? null : <span className="chat-dot" title={INVITE_TOOLTIP} />}
            {c.unreadCount ? <span className="chat-unread nx-data">{c.unreadCount}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
