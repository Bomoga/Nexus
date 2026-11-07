import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { EventSearchHit, NexusEvent } from "../../src/contracts";
import { Button, Input, StatusLine, friendlyError, request } from "../shared";
import { DEFAULT_T0_MS, formatEventTime, shortId } from "./model/picking";
import { newestFirst } from "./model/tracking";

export const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_LIMIT = 20;

export interface SearchProps {
  /** Chooses an event (top result on Enter, or a clicked row). */
  onPick: (event: NexusEvent) => void;
  /** Runs one search against the whole store. Defaults to the bridge's events.search. */
  search?: (q: string) => Promise<EventSearchHit[]>;
  t0Ms?: number;
}

const defaultSearch = (q: string) => request("events.search", { q, limit: SEARCH_LIMIT });

/** Events-only search box with a newest-first dropdown. Selection and tracking are the parent's job. */
export function Search({ onPick, search = defaultSearch, t0Ms = DEFAULT_T0_MS }: SearchProps) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<EventSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  });

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setHits([]);
      setOpen(false);
      setError(undefined);
      return;
    }
    // Cleanup flips `live`, so a response for an older query (or after unmount) is dropped.
    let live = true;
    const timer = setTimeout(() => {
      searchRef
        .current(query)
        .then((res) => {
          if (!live) return;
          setHits(newestFirst(res));
          setActive(0);
          setOpen(true);
          setError(undefined);
        })
        .catch((e: unknown) => {
          if (!live) return;
          setHits([]);
          setOpen(false);
          setError(friendlyError(e, "search"));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, attempt]);

  // "/" (outside inputs) and Ctrl+F focus the box; the host cannot push a focus message (contracts are frozen).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      const slash = e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey;
      const find = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f";
      if (!slash && !find) return;
      e.preventDefault();
      const el = wrap.current?.querySelector("input");
      el?.focus();
      el?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const pick = (hit: EventSearchHit | undefined) => {
    if (!hit) return;
    setOpen(false);
    onPick(hit.event);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (hits.length === 0) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.min(hits.length - 1, Math.max(0, i + step)));
    } else if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      pick(hits[active]);
    } else if (e.key === "Escape") {
      // Only an open dropdown consumes Escape; otherwise it reaches the page (stop tracking).
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  };

  return (
    <div className="globe-search" ref={wrap}>
      <Input
        role="combobox"
        aria-label="Search events"
        aria-expanded={open}
        aria-controls="globe-search-list"
        aria-autocomplete="list"
        placeholder="SEARCH EVENTS  /"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {open && hits.length > 0 ? (
        <ul id="globe-search-list" role="listbox" aria-label="Search results" className="globe-search-list">
          {hits.map(({ event }, i) => (
            <li
              key={event.id}
              role="option"
              aria-selected={i === active}
              className={i === active ? "globe-search-row is-active" : "globe-search-row"}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(hits[i]);
              }}
            >
              <span className="globe-search-title">{event.title}</span>
              <span className="globe-search-cell">{event.kind}</span>
              <span className="globe-search-cell">{event.orbit}</span>
              <span className="globe-search-cell nx-data">{formatEventTime(Date.parse(event.at), t0Ms)}</span>
              <span className="globe-search-cell nx-data">{shortId(event.target)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <StatusLine tone="error">
          {error} <Button onClick={() => setAttempt((n) => n + 1)}>RETRY</Button>
        </StatusLine>
      ) : null}
    </div>
  );
}
