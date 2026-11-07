import { useCallback, useState } from "react";
import type { KeyboardEvent } from "react";
import type { EventTarget, NexusEvent } from "../../src/contracts";
import { Button, StatusLine, request } from "../shared";
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
  const [error, setError] = useState<string | undefined>();
  const openTarget = useCallback(() => {
    if (!event) return;
    setError(undefined);
    open(event.target).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [event, open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Only when the strip itself has focus: Enter on the OPEN button is that button's own click.
    if (e.key === "Enter" && e.target === e.currentTarget) {
      e.preventDefault();
      openTarget();
    }
  };

  if (!event) {
    return (
      <div className="globe-strip" role="group" aria-label="Selected event" tabIndex={0}>
        <span className="globe-strip-empty">No event selected</span>
      </div>
    );
  }
  return (
    <div className="globe-strip" role="group" aria-label="Selected event" tabIndex={0} onKeyDown={onKeyDown}>
      <span className="globe-strip-kind nx-data">{event.kind}</span>
      <span className="globe-strip-title" title={event.title}>
        {event.title}
      </span>
      <span className="globe-strip-cell">{event.orbit}</span>
      <span className="globe-strip-cell nx-data">{formatEventTime(Date.parse(event.at), t0Ms)}</span>
      <span className="globe-strip-cell nx-data">{shortId(event.target)}</span>
      <span className="globe-strip-cell">{event.actor.name}</span>
      {error ? <span className="globe-strip-error"><StatusLine tone="error">{error}</StatusLine></span> : null}
      <Button variant="primary" kbd="ENTER" onClick={openTarget}>
        OPEN
      </Button>
    </div>
  );
}
