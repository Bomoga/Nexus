import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import type { ActivityBucket, TimeWindow } from "../../src/contracts";
import { Button, StatusLine, friendlyError } from "../shared";
import type { BridgeClient } from "../shared";
import { windowMs } from "./model";
import { BUCKET_MS, buildActivity, columnAtFraction, orbitOpacity } from "./model/activity";
import { formatEventTime } from "./model/picking";

export interface ActivityStripProps {
  bridge: BridgeClient;
  /** The time the globe shows (the live clock, or the pinned time). */
  now: number;
  window: TimeWindow;
  /** Orbit order for stacking, main first. */
  families: readonly string[];
  /** A column was clicked: the end of its bucket, epoch ms. */
  onPin: (atMs: number) => void;
}

const HEIGHT = 100;

export function ActivityStrip({ bridge, now, window: w, families, onPin }: ActivityStripProps) {
  const [buckets, setBuckets] = useState<ActivityBucket[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);
  // The time a query was last anchored to: "now" moving 5 s at a time does not refetch, 15 minutes does.
  const [anchor, setAnchor] = useState(now);
  useEffect(() => {
    if (Math.abs(now - anchor) >= BUCKET_MS) setAnchor(now);
  }, [now, anchor]);

  useEffect(() => {
    let live = true;
    // One bucket of slack on the left: a pin or unpin under 15 minutes away does not refetch, so the edge column stays filled.
    const from = new Date(anchor - windowMs(w) - BUCKET_MS).toISOString();
    const to = new Date(anchor + BUCKET_MS).toISOString();
    bridge
      .request("events.activity", { from, to })
      .then((res) => {
        if (!live) return;
        setBuckets(res);
        setError(undefined);
      })
      .catch((e: unknown) => live && setError(friendlyError(e, "activity")));
    return () => {
      live = false;
    };
  }, [bridge, w, anchor, attempt]);

  // Columns only change when "now" crosses a bucket boundary: rebuild then, not on every 5 s tick (30d is ~2,900 columns).
  const nowBucket = Math.floor(now / BUCKET_MS);
  const model = useMemo(() => buildActivity(buckets ?? [], families, now, windowMs(w)), [buckets, families, nowBucket, w]);
  const order = useMemo(() => {
    const extra = [...new Set((buckets ?? []).map((b) => b.orbit))].filter((o) => !families.includes(o));
    return [...families, ...extra.sort((a, b) => a.localeCompare(b, "en", { numeric: true }))];
  }, [buckets, families]);

  const onClick = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const col = columnAtFraction((e.clientX - rect.left) / rect.width, model.columns);
    if (col) onPin(col.end);
  };

  let body;
  if (error) {
    const quiet = error.includes("isn't connected yet");
    body = (
      <StatusLine tone={quiet ? "muted" : "error"}>
        {error} {quiet ? null : <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>RETRY</Button>}
      </StatusLine>
    );
  } else if (buckets === undefined) {
    body = null;
  } else if (model.max === 0) {
    body = <StatusLine tone="muted">no activity in this window</StatusLine>;
  } else {
    const n = model.columns.length;
    body = (
      <svg
        className="globe-activity-svg"
        viewBox={`0 0 ${n} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Activity per 15 minutes; click a bar to view that time"
        onClick={onClick}
      >
        {model.columns.map((c, i) => {
          let y = HEIGHT;
          return (
            <g key={c.start} data-column={new Date(c.start).toISOString()}>
              <title>{`${formatEventTime(c.start)} · ${c.total} ${c.total === 1 ? "event" : "events"}`}</title>
              <rect x={i} y={0} width={1} height={HEIGHT} fill="transparent" />
              {c.segments.map((s) => {
                const h = (s.count / model.max) * HEIGHT;
                y -= h;
                return <rect key={s.orbit} data-orbit={s.orbit} x={i} y={y} width={1} height={h} fill="var(--nx-accent)" fillOpacity={orbitOpacity(order.indexOf(s.orbit))} />;
              })}
            </g>
          );
        })}
      </svg>
    );
  }
  return (
    <div className="globe-activity">
      <span className="globe-activity-legend nx-data" title="One column per 15 minutes">
        15M
      </span>
      <div className="globe-activity-body">{body}</div>
    </div>
  );
}
