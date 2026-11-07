import { useCallback, useEffect, useMemo, useState } from "react";
import type { NexusEvent, TimeWindow } from "../../src/contracts";
import { T0 } from "../../src/contracts/fixtures";
import { Select, StatusLine, isFakeMode, request } from "../shared";
import { TIME_WINDOWS, visibleEvents, windowMs } from "./model";
import { Scene } from "./scene/Scene";

const FAKE_NOW = Date.parse(T0) + 36 * 3_600_000;
const NOW_TICK_MS = 5_000;

const OPTIONS = TIME_WINDOWS.map((w) => ({ value: w, label: w }));

export function App() {
  const [window_, setWindow] = useState<TimeWindow>("36h");
  const [events, setEvents] = useState<NexusEvent[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [now, setNow] = useState(() => (isFakeMode() ? FAKE_NOW : Date.now()));

  useEffect(() => {
    if (isFakeMode()) return;
    const id = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let live = true;
    const from = new Date(now - windowMs(window_)).toISOString();
    const to = new Date(now + 60_000).toISOString();
    request("events.query", { from, to, limit: 5000 })
      .then((res) => {
        if (!live) return;
        setEvents(res);
        setError(undefined);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // Re-query only when the window changes; "now" drift moves markers but does not refetch.
  }, [window_]);

  const onWindow = useCallback((value: string) => {
    const w = value as TimeWindow;
    setWindow(w);
    request("ui.setTimeWindow", { window: w }).catch(() => undefined);
  }, []);

  const visible = useMemo(() => visibleEvents(events, now, window_), [events, now, window_]);

  return (
    <div className="globe-app">
      <div className="globe-bar">
        <Select aria-label="Time window" value={window_} options={OPTIONS} onChange={(e) => onWindow(e.target.value)} />
        <span className="nx-data">{visible.length} events</span>
      </div>
      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      <div className="globe-stage">
        <Scene events={visible} now={now} window={window_} />
      </div>
    </div>
  );
}
