import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NexusEvent, TimeWindow } from "../../src/contracts";
import { Select, StatusLine, isFakeMode, request } from "../shared";
import { QUERY_LIMIT, TIME_WINDOWS, keepNewest, visibleEvents, windowMs } from "./model";
import { insertLive, scriptedNow } from "./model/arcs";
import { markLive, useDriftNow, useLiveEvents } from "./scene/live";
import { Scene } from "./scene/Scene";

const NOW_TICK_MS = 5_000;
const FAKE_SPAN_MS = 36 * 3_600_000;

const OPTIONS = TIME_WINDOWS.map((w) => ({ value: w, label: w }));

export function App() {
  const [window_, setWindow] = useState<TimeWindow>("36h");
  const [events, setEvents] = useState<NexusEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // In fake mode "now" is pinned to the end of the scripted 36 h; the fixtures are loaded lazily
  // so normal builds don't ship demo data. Until it's known, nothing is queried or drawn.
  const [now, setNow] = useState<number | null>(() => (isFakeMode() ? null : Date.now()));
  const ready = now !== null;

  useEffect(() => {
    if (isFakeMode()) {
      // Fake "now" starts pinned at the end of the scripted span and then advances in real time at the
      // same cadence as the real clock, so the render filter and the live-event stamp share one clock.
      let live = true;
      let timer: ReturnType<typeof setInterval> | undefined;
      import("../../src/contracts/fixtures")
        .then((m) => {
          if (!live) return;
          const start = Date.parse(m.T0) + FAKE_SPAN_MS;
          const t0 = performance.now();
          setNow(start);
          timer = setInterval(() => setNow(scriptedNow(start, performance.now() - t0)), NOW_TICK_MS);
        })
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
      return () => {
        live = false;
        if (timer) clearInterval(timer);
      };
    }
    const id = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (now === null) return;
    let live = true;
    const from = new Date(now - windowMs(window_)).toISOString();
    const to = new Date(now + 60_000).toISOString();
    request("events.query", { from, to, limit: QUERY_LIMIT })
      .then((res) => {
        if (!live) return;
        const kept = keepNewest(res, QUERY_LIMIT);
        setEvents(kept.events);
        setTruncated(kept.truncated);
        setError(undefined);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // Re-query only when the window changes (or "now" first becomes known); drift moves markers but does not refetch.
  }, [window_, ready]);

  const onWindow = useCallback((value: string) => {
    const w = value as TimeWindow;
    setWindow(w);
    request("ui.setTimeWindow", { window: w }).catch(() => undefined);
  }, []);

  // Live events: "now" and the window are read from refs so the subscription is never re-created.
  const driftNow = useDriftNow(now ?? 0);
  const eventsRef = useRef(events);
  const windowRef = useRef(window_);
  useEffect(() => {
    eventsRef.current = events;
    windowRef.current = window_;
  }, [events, window_]);
  const onLive = useCallback(
    (incoming: NexusEvent) => {
      if (!ready) return;
      // The fake host stamps live events with the wall clock, but fake "now" is scripted: land them on the now line.
      const e = isFakeMode() ? { ...incoming, at: new Date(driftNow()).toISOString() } : incoming;
      const next = insertLive(eventsRef.current, e, driftNow(), windowRef.current);
      if (next === eventsRef.current) return;
      eventsRef.current = next;
      markLive(e);
      setEvents(next);
      setTruncated((t) => t || next.length >= QUERY_LIMIT);
    },
    [ready, driftNow],
  );
  useLiveEvents(onLive, ready);

  const visible = useMemo(() => (now === null ? [] : visibleEvents(events, now, window_)), [events, now, window_]);

  return (
    <div className="globe-app">
      <div className="globe-bar">
        <Select aria-label="Time window" value={window_} options={OPTIONS} onChange={(e) => onWindow(e.target.value)} />
        <span className="nx-data">{visible.length} events</span>
      </div>
      {truncated ? <StatusLine tone="pending">{`truncated: showing newest ${events.length}`}</StatusLine> : null}
      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      <div className="globe-stage">
        {now === null ? null : <Scene events={visible} now={now} window={window_} />}
      </div>
    </div>
  );
}
