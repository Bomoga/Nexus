import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NexusEvent, TimeWindow } from "../../src/contracts";
import { Badge, Button, EmptyState, SegmentedControl, StatusLine, StoreStatusLine, friendlyError, getBridge, isFakeMode } from "../shared";
import type { BridgeClient } from "../shared";
import { DetailStrip } from "../globe/DetailStrip";
import { Search } from "../globe/Search";
import { QUERY_LIMIT, WINDOW_OPTIONS, keepNewest, visibleEvents, windowMs } from "../globe/model";
import { insertLive, scriptedNow } from "../globe/model/arcs";
import { chooseWindow, withEvent } from "../globe/model/tracking";
import { useDriftNow } from "../globe/scene/live";
import { keepIfSame } from "./model";
import { Timeline } from "./Timeline";
import type { Reveal } from "./Timeline";

const NOW_TICK_MS = 5_000;
const FAKE_SPAN_MS = 36 * 3_600_000;
const SEARCH_LIMIT = 20;

export interface AppProps {
  /** Defaults to the real bridge. */
  bridge?: BridgeClient;
  /** Pins "now" (tests): no clock, no fake-mode fixtures. */
  nowMs?: number;
}

/** The globe's fallback: same data flow as the globe (query per window, live inserts, search, detail strip), drawn as lanes. */
export function App({ bridge: injected, nowMs }: AppProps) {
  const bridge = useMemo(() => injected ?? getBridge(), [injected]);
  const [window_, setWindow] = useState<TimeWindow>("36h");
  const [events, setEvents] = useState<NexusEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // In fake mode "now" is pinned to the end of the scripted 36 h; fixtures load lazily so normal builds ship no demo data.
  const [now, setNow] = useState<number | null>(() => (nowMs !== undefined ? nowMs : isFakeMode() ? null : Date.now()));
  const ready = now !== null;
  const [selected, setSelected] = useState<NexusEvent | undefined>();
  const [reveal, setReveal] = useState<Reveal | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  useEffect(() => {
    if (nowMs !== undefined) return;
    if (isFakeMode()) {
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
        .catch((e: unknown) => live && setError(friendlyError(e, "events")));
      return () => {
        live = false;
        if (timer) clearInterval(timer);
      };
    }
    const id = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, [nowMs]);

  const eventsRef = useRef(events);
  const windowRef = useRef(window_);
  // The event a search pick put on screen: kept through the requery that follows a window change.
  const pinned = useRef<NexusEvent | undefined>(undefined);
  useEffect(() => {
    eventsRef.current = events;
    windowRef.current = window_;
  }, [events, window_]);

  useEffect(() => {
    if (now === null) return;
    let live = true;
    const from = new Date(now - windowMs(window_)).toISOString();
    const to = new Date(now + 60_000).toISOString();
    bridge
      .request("events.query", { from, to, limit: QUERY_LIMIT })
      .then((res) => {
        if (!live) return;
        const kept = keepNewest(res, QUERY_LIMIT);
        const next = pinned.current ? withEvent(kept.events, pinned.current) : kept.events;
        eventsRef.current = next;
        setEvents(next);
        setTruncated(kept.truncated);
        setLoaded(true);
        setError(undefined);
      })
      .catch((e: unknown) => live && setError(friendlyError(e, "events")));
    return () => {
      live = false;
    };
    // Re-query only when the window changes (or "now" first becomes known); drift moves marks but does not refetch.
  }, [window_, ready, bridge, attempt]);

  const onWindow = useCallback(
    (w: TimeWindow) => {
      setWindow(w);
      bridge.request("ui.setTimeWindow", { window: w }).catch(() => undefined);
    },
    [bridge],
  );

  const driftNow = useDriftNow(now ?? 0);
  useEffect(() => {
    if (!ready) return;
    return bridge.subscribe("events.subscribe", {}, (incoming) => {
      // The fake host stamps live events with the wall clock, but fake "now" is scripted: land them on the now line.
      const e = isFakeMode() && nowMs === undefined ? { ...incoming, at: new Date(driftNow()).toISOString() } : incoming;
      const next = insertLive(eventsRef.current, e, driftNow(), windowRef.current);
      if (next === eventsRef.current) return;
      eventsRef.current = next;
      setEvents(next);
      setTruncated((t) => t || next.length >= QUERY_LIMIT);
    });
  }, [ready, bridge, driftNow, nowMs]);

  const reveals = useRef(0);
  const onSearchPick = useCallback(
    (event: NexusEvent) => {
      setSelected(event);
      const choice = chooseWindow(Date.parse(event.at), driftNow(), windowRef.current);
      if (choice.kind === "outside") {
        pinned.current = undefined;
        setNotice(`${event.title}: outside the 30d window`);
        return;
      }
      setNotice(undefined);
      pinned.current = event;
      if (choice.kind === "widen") onWindow(choice.window);
      const next = withEvent(eventsRef.current, event);
      eventsRef.current = next;
      setEvents(next);
      setReveal({ eventId: event.id, n: ++reveals.current });
    },
    [driftNow, onWindow],
  );

  const onSelect = useCallback((event: NexusEvent) => {
    pinned.current = undefined;
    setSelected(event);
  }, []);

  const search = useCallback((q: string) => bridge.request("events.search", { q, limit: SEARCH_LIMIT }), [bridge]);
  const open = useCallback((target: NexusEvent["target"]) => bridge.request("ui.openTarget", target), [bridge]);

  // Keep the same array while the visible set is unchanged, so a "now" tick alone doesn't make Timeline re-lay out every mark
  // (it shifts the mark group by the drift instead).
  const lastVisible = useRef<NexusEvent[]>([]);
  const visible = useMemo(() => {
    const next = now === null ? [] : visibleEvents(events, now, window_);
    lastVisible.current = keepIfSame(lastVisible.current, next);
    return lastVisible.current;
  }, [events, now, window_]);

  return (
    <div className="tl-app">
      <div className="nx-panel-header globe-bar" role="toolbar" aria-label="Timeline controls">
        <SegmentedControl aria-label="Time window" options={WINDOW_OPTIONS} value={window_} onChange={onWindow} />
        <div className="globe-bar-center">
          <Search onPick={onSearchPick} search={search} />
          {selected ? (
            <Button size="sm" onClick={() => setSelected(undefined)}>
              CLEAR
            </Button>
          ) : null}
        </div>
        <span className="globe-bar-right">
          <Badge kind="live">LIVE</Badge>
          <span className="nx-count">{`${visible.length} EVENTS`}</span>
        </span>
      </div>
      {truncated ? <StatusLine tone="pending">{`truncated: showing newest ${events.length}`}</StatusLine> : null}
      {error ? (
        <StatusLine tone="error">
          {error} <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>RETRY</Button>
        </StatusLine>
      ) : null}
      {loaded && !error && visible.length === 0 ? <EmptyState message="no events in this window" /> : null}
      {notice ? <StatusLine tone="pending">{notice}</StatusLine> : null}
      <div className="tl-stage">{now === null ? null : <Timeline events={visible} now={now} window={window_} selected={selected} onSelect={onSelect} reveal={reveal} />}</div>
      <DetailStrip event={selected} open={open} />
      <StoreStatusLine bridge={bridge} />
    </div>
  );
}
