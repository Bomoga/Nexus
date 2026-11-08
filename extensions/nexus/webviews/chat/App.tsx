import { useCallback, useMemo, useState } from "react";
import type { Channel, ChatMessage } from "../../src/contracts";
import { EmptyState, StoreStatusLine, getBridge } from "../shared";
import type { BridgeClient } from "../shared";
import { ChannelList } from "./ChannelList";
import { History } from "./History";
import { OutboxContext, createOutbox } from "./outbox";
import { StatusBar } from "./StatusBar";
import { ThreadPane } from "./ThreadPane";

export interface AppProps {
  bridge?: BridgeClient;
}

export function App({ bridge }: AppProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [thread, setThread] = useState<{ channelId: string; threadTs: string } | undefined>();
  // One outbox for the page: sends and drafts outlive the history and thread views (not a webview reload).
  const outbox = useMemo(() => createOutbox(bridge ?? getBridge()), [bridge]);
  // Links in Slack text are untrusted: only https goes to the host, which validates again before opening the system browser.
  const openLink = useCallback(
    (url: string) => {
      if (!/^https:\/\//i.test(url)) return;
      (bridge ?? getBridge()).request("ui.openExternal", { url }).catch(() => undefined);
    },
    [bridge],
  );
  const selected = channels.find((c) => c.id === selectedId);
  return (
    <OutboxContext.Provider value={outbox}>
      <div className="chat-app">
        <StoreStatusLine bridge={bridge} />
        <div className="chat-panes">
          <aside className="chat-left">
            <ChannelList
              bridge={bridge}
              selectedId={selectedId}
              onSelect={(c: Channel) => {
                setSelectedId(c.id);
                setThread(undefined);
              }}
              onLoaded={(cs) => {
                setChannels(cs);
                setSelectedId((cur) => cur ?? cs[0]?.id);
              }}
            />
          </aside>
          <main className="chat-right">
            {selectedId ? (
              <History
                bridge={bridge}
                channelId={selectedId}
                channelName={selected?.name}
                channel={selected}
                onOpenLink={openLink}
                onOpenThread={(m: ChatMessage) => setThread({ channelId: m.channelId, threadTs: m.threadTs ?? m.ts })}
              />
            ) : (
              <EmptyState message="select a channel" />
            )}
          </main>
          {thread && thread.channelId === selectedId ? (
            <aside className="chat-thread">
              <ThreadPane
                bridge={bridge}
                channelId={thread.channelId}
                threadTs={thread.threadTs}
                onClose={() => setThread(undefined)}
                onOpenLink={openLink}
              />
            </aside>
          ) : null}
        </div>
        <StatusBar bridge={bridge} />
      </div>
    </OutboxContext.Provider>
  );
}
