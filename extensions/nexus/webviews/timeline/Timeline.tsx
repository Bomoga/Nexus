import { memo, useLayoutEffect, useMemo, useRef } from "react";
import type { MouseEvent } from "react";
import type { NexusEvent, TimeWindow } from "../../src/contracts";
import { familiesOf, windowMs } from "../globe/model";
import { DEFAULT_T0_MS, formatEventTime } from "../globe/model/picking";
import { ACTIVITY_H, BLOCK_H, LANE_H, MARK, PLOT_W, eventX, layoutEvents, plotHeight, scrollFor, ticksFor } from "./model";
import type { Layout, Mark } from "./model";

/** Height of the time axis row above the lanes. */
export const AXIS_H = 16;

export interface Reveal {
  eventId: string;
  /** Changes for every request, so revealing the same event twice scrolls twice. */
  n: number;
}

export interface TimelineProps {
  /** Events already filtered to the window. */
  events: readonly NexusEvent[];
  now: number;
  window: TimeWindow;
  selected?: NexusEvent;
  onSelect: (event: NexusEvent) => void;
  /** Centers this event horizontally once it is on the plot. */
  reveal?: Reveal;
  t0Ms?: number;
}

const half = MARK / 2;

function MarkShape({ mark }: { mark: Mark }) {
  const { shape, x, y, event } = mark;
  return (
    <g data-testid="mark" data-event-id={event.id} data-cx={x} data-cy={y} className={`tl-mark tl-${shape}`}>
      <title>{event.title}</title>
      {shape === "diamond" ? (
        <polygon points={`${x},${y - half - 1} ${x + half + 1},${y} ${x},${y + half + 1} ${x - half - 1},${y}`} />
      ) : (
        <rect x={x - half} y={y - half} width={MARK} height={MARK} />
      )}
    </g>
  );
}

const Marks = memo(function Marks({ layout, families }: { layout: Layout; families: readonly string[] }) {
  void families;
  return (
    <>
      {layout.connectors.map((c) => (
        <g key={c.event.id} data-testid="merge" data-event-id={c.event.id} data-from={c.event.fromOrbit} data-to={c.event.orbit} data-x={c.x} data-from-y={c.fromY} data-to-y={c.toY} className="tl-merge">
          <title>{c.event.title}</title>
          <line className="tl-merge-hit" x1={c.x} x2={c.x} y1={c.fromY} y2={c.toY} />
          <line className="tl-merge-line" x1={c.x} x2={c.x} y1={c.fromY} y2={c.toY} />
          <rect x={c.x - 2} y={c.fromY - 2} width={4} height={4} className="tl-merge-end" />
          <rect x={c.x - 2} y={c.toY - 2} width={4} height={4} className="tl-merge-end" />
        </g>
      ))}
      {layout.marks.map((m) => (
        <MarkShape key={m.event.id} mark={m} />
      ))}
    </>
  );
});

/** Horizontal lanes (one per branch family), time on the x-axis, now at the right edge. DOM/SVG only. */
export function Timeline({ events, now, window: w, selected, onSelect, reveal, t0Ms = DEFAULT_T0_MS }: TimelineProps) {
  const families = useMemo(() => familiesOf(events), [events]);
  // Marks are laid out against a reference time and the whole group is shifted by the drift since then,
  // so the 5 s clock tick moves one transform instead of recreating every mark. The reference moves
  // only when the events or window change, or the drift reaches 1 px.
  const ref = useRef({ now, events, w });
  if (ref.current.events !== events || ref.current.w !== w || now < ref.current.now || ((now - ref.current.now) / windowMs(w)) * PLOT_W >= 1) {
    ref.current = { now, events, w };
  }
  const refNow = ref.current.now;
  const drift = ((now - refNow) / windowMs(w)) * PLOT_W;
  const layout = useMemo(() => layoutEvents(events, families, refNow, w), [events, families, refNow, w]);
  const ticks = useMemo(() => ticksFor(now, w, t0Ms), [now, w, t0Ms]);
  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const scroller = useRef<HTMLDivElement>(null);
  const height = plotHeight(families.length);

  // Start at the right edge: that is "now".
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = PLOT_W;
  }, []);

  const handled = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !reveal || handled.current === reveal.n) return;
    const e = byId.get(reveal.eventId);
    if (!e) return; // the window is still widening; try again when the events arrive
    handled.current = reveal.n;
    el.scrollLeft = scrollFor(eventX(e, now, w), el.clientWidth);
  }, [reveal, byId, now, w]);

  const onClick = (ev: MouseEvent<SVGSVGElement>) => {
    const target = ev.target instanceof Element ? ev.target.closest("[data-event-id]") : null;
    const hit = target ? byId.get(target.getAttribute("data-event-id") ?? "") : undefined;
    if (hit) onSelect(hit);
  };

  const selection = useMemo(() => {
    if (!selected) return undefined;
    const m = layout.marks.find((k) => k.event.id === selected.id);
    if (m) return { x: m.x - half - 2, y: m.y - half - 2, w: MARK + 4, h: MARK + 4 };
    const c = layout.connectors.find((k) => k.event.id === selected.id);
    if (c) return { x: c.x - 4, y: Math.min(c.fromY, c.toY) - 4, w: 8, h: Math.abs(c.fromY - c.toY) + 8 };
    return undefined;
  }, [selected, layout]);

  return (
    <div className="tl" data-testid="timeline">
      <div className="tl-gutter" style={{ paddingTop: AXIS_H }}>
        {families.map((f) => (
          <div key={f} className="tl-lane-label nx-data" data-testid="lane-label" style={{ height: BLOCK_H }} title={f}>
            {f}
          </div>
        ))}
      </div>
      <div className="tl-scroll" ref={scroller}>
        <svg className="tl-svg" width={PLOT_W} height={AXIS_H + height} role="img" aria-label="Event timeline" onClick={onClick}>
          {ticks.map((k) => (
            <g key={k.atMs} className="tl-tick">
              <line x1={k.x} x2={k.x} y1={AXIS_H - 4} y2={AXIS_H + height} />
              <text x={Math.min(k.x + 3, PLOT_W - 40)} y={AXIS_H - 5} className="nx-data">
                {formatEventTime(k.atMs, t0Ms)}
              </text>
            </g>
          ))}
          <g transform={`translate(0,${AXIS_H})`}>
            {families.map((f, i) => (
              <line key={f} className="tl-lane-line" x1={0} x2={PLOT_W} y1={i * BLOCK_H + LANE_H / 2} y2={i * BLOCK_H + LANE_H / 2} />
            ))}
            {families.map((f, i) => (
              <rect key={`a-${f}`} className="tl-activity" x={0} y={i * BLOCK_H + LANE_H} width={PLOT_W} height={ACTIVITY_H} />
            ))}
            <g data-testid="marks" transform={`translate(${-drift},0)`}>
              <Marks layout={layout} families={families} />
              {selection ? <rect data-testid="selection" data-event-id={selected?.id} className="tl-selection" x={selection.x} y={selection.y} width={selection.w} height={selection.h} /> : null}
            </g>
          </g>
          <line className="tl-now" x1={PLOT_W - 0.5} x2={PLOT_W - 0.5} y1={0} y2={AXIS_H + height} />
        </svg>
      </div>
    </div>
  );
}
