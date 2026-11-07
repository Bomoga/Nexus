import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NexusEvent, TimeWindow } from "../../src/contracts";
import { Button, EmptyState, Select, StatusLine, StoreStatusLine, friendlyError, getBridge, isFakeMode } from "../shared";
import type { BridgeClient } from "../shared";
import { QUERY_LIMIT, TIME_WINDOWS, keepNewest, visibleEvents, windowMs } from "./model";
import { insertLive, scriptedNow } from "./model/arcs";
import { markLive, useDriftNow, useLiveEvents } from "./scene/live";
import { Scene } from "./scene/Scene";
import { chooseWindow, shouldRelease, withEvent } from "./model/tracking";
import { DetailStrip } from "./DetailStrip";
import { Search } from "./Search";

const NOW_TICK_MS = 5_000;
const FAKE_SPAN_MS = 36 * 3_600_000;

const OPTIONS = TIME_WINDOWS.map((w) => ({ value: w, label: w }));

export interface AppProps {
  /** Defaults to the real bridge. */
  bridge?: BridgeClient;
}

export function App({ bridge: injected }: AppProps = {}) {
  const bridge = useMemo(() => injected ?? getBridge(), [injected]);
  const [window_, setWindow] = useState<TimeWindow>("36h");
  const [events, setEvents] = useState<NexusEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // In fake mode "now" is pinned to the end of the scripted 36 h; the fixtures are loaded lazily
  // so normal builds don't ship demo data. Until it's known, nothing is queried or drawn.
  const [now, setNow] = useState<number | null>(() => (isFakeMode() ? null : Date.now()));
  const ready = now !== null;
  // Selected event: set by picking today; L3-05 search/tracking sets it through the same setter.
  const [selected, setSelected] = useState<NexusEvent | undefined>();
  // Tracked event (search): the camera follows and rings it until a drag, STOP TRACKING, or it leaves the window.
  const [tracked, setTracked] = useState<NexusEvent | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

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
        .catch((e: unknown) => live && setError(friendlyError(e, "events")));
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
    bridge
      .request("events.query", { from, to, limit: QUERY_LIMIT })
      .then((res) => {
        if (!live) return;
        const kept = keepNewest(res, QUERY_LIMIT);
        setEvents(kept.events);
        setTruncated(kept.truncated);
        setLoaded(true);
        setError(undefined);
      })
      .catch((e: unknown) => live && setError(friendlyError(e, "events")));
    return () => {
      live = false;
    };
    // Re-query only when the window changes (or "now" first becomes known) or on RETRY; drift moves markers but does not refetch.
  }, [window_, ready, bridge, attempt]);

  const onWindow = useCallback((value: string) => {
    const w = value as TimeWindow;
    setWindow(w);
    bridge.request("ui.setTimeWindow", { window: w }).catch(() => undefined);
  }, [bridge]);

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

  const release = useCallback(() => setTracked(undefined), []);
  // Escape stops tracking unless something consumed it (an open search dropdown) or focus is in another input.
  useEffect(() => {
    if (!tracked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target;
      if (t instanceof Element && t.closest("textarea, select, [contenteditable]:not([contenteditable=false]), input:not([role=combobox])")) return;
      setTracked(undefined);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tracked]);
  const search = useCallback((q: string) => bridge.request("events.search", { q, limit: 20 }), [bridge]);
  const open = useCallback((target: NexusEvent["target"]) => bridge.request("ui.openTarget", target), [bridge]);
  useEffect(() => {
    if (tracked && now !== null && shouldRelease(tracked, now, window_)) setTracked(undefined);
  }, [tracked, now, window_]);

  const onSearchPick = useCallback(
    (event: NexusEvent) => {
      setSelected(event);
      const choice = chooseWindow(Date.parse(event.at), driftNow(), windowRef.current);
      if (choice.kind === "outside") {
        setTracked(undefined);
        setNotice(`${event.title}: outside the 30d window`);
        return;
      }
      setNotice(undefined);
      if (choice.kind === "widen") onWindow(choice.window);
      const next = withEvent(eventsRef.current, event);
      eventsRef.current = next;
      setEvents(next);
      setTracked(event);
    },
    [driftNow, onWindow],
  );

  const visible = useMemo(() => (now === null ? [] : visibleEvents(events, now, window_)), [events, now, window_]);

  return (
    <div className="globe-app">
      <StoreStatusLine bridge={bridge} />
      <div className="globe-bar">
        <Select aria-label="Time window" value={window_} options={OPTIONS} onChange={(e) => onWindow(e.target.value)} />
        <Search onPick={onSearchPick} search={search} />
        {tracked ? <Button kbd="ESC" onClick={release}>STOP TRACKING</Button> : null}
        <span className="nx-data">{visible.length} events</span>
      </div>
      {truncated ? <StatusLine tone="pending">{`truncated: showing newest ${events.length}`}</StatusLine> : null}
      {error ? (
        <StatusLine tone="error">
          {error} <Button onClick={() => setAttempt((n) => n + 1)}>RETRY</Button>
        </StatusLine>
      ) : null}
      {loaded && !error && visible.length === 0 ? <EmptyState message="no events in this window" /> : null}
      {notice ? <StatusLine tone="pending">{notice}</StatusLine> : null}
      <div className="globe-stage">
        {now === null ? null : <Scene events={visible} now={now} window={window_} onPick={setSelected} tracked={tracked} onRelease={release} />}
      </div>
      <DetailStrip event={selected} open={open} />
    </div>
  );
}
