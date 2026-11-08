import { useCallback, useEffect, useState } from "react";
import type { EventTarget, NexusEvent } from "../../src/contracts";
import { Button, StatusLine, friendlyError, request } from "../shared";
import { DEFAULT_T0_MS, formatEventTime, shortId } from "./model/picking";

export interface DetailStripProps {
  /** The selected event; undefined shows the empty state. Selection is owned by the parent (picking, search). */
  event: NexusEvent | undefined;
  /** T+0 in epoch ms. Defaults to the hackathon start. */
  t0Ms?: number;
  /** Opens the event's target. Defaults to the bridge's ui.openTarget. */
  open?: (target: EventTarget) => Promise<unknown>;
}

const defaultOpen = (target: EventTarget) => request("ui.openTarget", target);

/** One-row detail for the selected event: kind, title, orbit, T+, short id, actor, and an OPEN button. All text is rendered as text. */
export function DetailStrip({ event, t0Ms = DEFAULT_T0_MS, open = defaultOpen }: DetailStripProps) {
  // The error is tied to the event it came from, so selecting another event hides it (and a late rejection stays hidden).
  const [failure, setFailure] = useState<{ event: NexusEvent; message: string } | undefined>();
  const error = failure && failure.event === event ? failure.message : undefined;
  const openTarget = useCallback(() => {
    if (!event) return;
    setFailure(undefined);
    open(event.target).catch((e: unknown) => setFailure({ event, message: friendlyError(e, "open") }));
  }, [event, open]);

  // After a click-pick focus is on the canvas/body, so Enter is handled at the document while an event is selected.
  // Controls that own Enter (inputs, buttons including OPEN, selects, editables) are left alone: no double-open.
  // Exception: the search box right after a search pick (data-picked, dropdown closed, query unchanged) — Enter opens.
  useEffect(() => {
    if (!event) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target;
      const pickedSearch = t instanceof Element && t.matches('input[data-picked="true"]');
      if (!pickedSearch && t instanceof Element && t.closest("input, textarea, select, button, a[href], [contenteditable]:not([contenteditable=false])")) return;
      e.preventDefault();
      openTarget();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [event, openTarget]);

  if (!event) {
    return (
      <div className="globe-strip" role="group" aria-label="Selected event" tabIndex={0}>
        <span className="globe-strip-empty">No event selected</span>
      </div>
    );
  }
  return (
    <div className="globe-strip" role="group" aria-label="Selected event" tabIndex={0}>
      <span className="globe-strip-kind">{event.kind}</span>
      <span className="globe-strip-title" title={event.title}>
        {event.title}
      </span>
      <span className="globe-strip-cell nx-data">{event.orbit}</span>
      <span className="globe-strip-cell nx-data">{formatEventTime(Date.parse(event.at), t0Ms)}</span>
      <span className="globe-strip-cell nx-data">{shortId(event.target)}</span>
      <span className="globe-strip-cell">{event.actor.name}</span>
      {error ? <span className="globe-strip-error"><StatusLine tone="error">{error}</StatusLine></span> : null}
      <Button variant="primary" kbd="↵" onClick={openTarget}>
        OPEN
      </Button>
    </div>
  );
}
