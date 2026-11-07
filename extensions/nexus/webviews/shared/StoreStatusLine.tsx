import { useEffect, useState } from "react";
import { StatusLine } from "./StatusLine";
import { getBridge } from "./bridgeClient";
import type { BridgeClient } from "./bridgeClient";

/** Nothing while online (or while the store state is unknown); one amber line when offline. */
export function StoreStatusLine({ bridge }: { bridge?: BridgeClient }) {
  const [state, setState] = useState<{ online: boolean; outboxDepth: number } | undefined>();

  useEffect(() => {
    const b = bridge ?? getBridge();
    let live = true;
    // A failing store.status (no handler yet) is not worth an error line: the state stays unknown.
    b.request("store.status", {}).then(
      (s) => live && setState((cur) => cur ?? { online: s.online, outboxDepth: s.outboxDepth }),
      () => undefined,
    );
    const unsub = b.subscribe("store.subscribe", {}, (e) => setState({ online: e.online, outboxDepth: e.outboxDepth }));
    return () => {
      live = false;
      unsub();
    };
  }, [bridge]);

  if (!state || state.online) return null;
  const queued = state.outboxDepth > 0 ? ` · ${state.outboxDepth} queued` : "";
  return <StatusLine tone="pending">{`offline · showing this machine's copy${queued}`}</StatusLine>;
}
