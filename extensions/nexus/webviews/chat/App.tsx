import { useMemo, useState } from "react";
import type { Channel, ChatMessage } from "../../src/contracts";
import { EmptyState, getBridge } from "../shared";
import type { BridgeClient } from "../shared";
import { ChannelList } from "./ChannelList";
import { History } from "./History";
import { OutboxContext, createOutbox } from "./outbox";
import { StatusBar } from "./StatusBar";
import { ThreadPane } from "./ThreadPane";

export interface AppProps {
  bridge?: BridgeClient;
}

// The bridge has no "open external URL" request yet, so links stay inert until the contract adds one.
function openLink(url: string): void {
  void url;
}

export function App({ bridge }: AppProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [thread, setThread] = useState<{ channelId: string; threadTs: string } | undefined>();
  // One outbox for the page: sends and drafts outlive the history and thread views (not a webview reload).
  const outbox = useMemo(() => createOutbox(bridge ?? getBridge()), [bridge]);
  return (
    <OutboxContext.Provider value={outbox}>
      <div className="chat-app">
        <div className="chat-panes">
          <aside className="chat-left">
            <ChannelList
              bridge={bridge}
              selectedId={selectedId}
              onSelect={(c: Channel) => {
                setSelectedId(c.id);
                setThread(undefined);
              }}
              onLoaded={(cs) => setSelectedId((cur) => cur ?? cs[0]?.id)}
            />
          </aside>
          <main className="chat-right">
            {selectedId ? (
              <History
                bridge={bridge}
                channelId={selectedId}
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
