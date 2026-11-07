// Event search: case-insensitive substring over title, sha, orbit and actor.
// Ranking: title match (3) above sha match (2) above orbit/actor match (1); newest first within a score.
import type { EventSearchHit, NexusEvent } from "../../contracts";

const TITLE = 3, SHA = 2, OTHER = 1;

interface Entry { event: NexusEvent; ms: number; title: string; sha: string; other: string }

function entryOf(event: NexusEvent): Entry {
  return {
    event,
    ms: Date.parse(event.at),   // newest-first is by instant, not by string, so mixed UTC offsets order correctly
    title: event.title.toLowerCase(),
    sha: event.target.type === "commit" ? event.target.sha.toLowerCase() : "",
    other: `${event.orbit}\n${event.actor.name}`.toLowerCase(),
  };
}

/** Scores one event against an already-lowercased, trimmed query; 0 means no match. */
function scoreOf(entry: Entry, q: string): number {
  if (entry.title.includes(q)) return TITLE;
  if (entry.sha.includes(q)) return SHA;
  if (entry.other.includes(q)) return OTHER;
  return 0;
}

/** Unparseable times sort as oldest. */
function newestFirst(a: number, b: number): number {
  const x = Number.isFinite(a) ? a : -Infinity, y = Number.isFinite(b) ? b : -Infinity;
  return x === y ? 0 : y > x ? 1 : -1;
}

/** Holds lowercased search keys so repeated searches over a large store stay fast. Returned events are the stored objects: callers must clone. */
export class EventSearchIndex {
  private entries = new Map<string, Entry>();

  /** Adds an event; a repeated id is ignored (events are append-only). */
  add(event: NexusEvent): void {
    if (!this.entries.has(event.id)) this.entries.set(event.id, entryOf(event));
  }

  search(text: string, limit: number): EventSearchHit[] {
    const q = text.trim().toLowerCase();
    if (!q || limit <= 0) return [];
    const hits: { entry: Entry; score: number }[] = [];
    for (const entry of this.entries.values()) {
      const score = scoreOf(entry, q);
      if (score) hits.push({ entry, score });
    }
    hits.sort((a, b) => b.score - a.score || newestFirst(a.entry.ms, b.entry.ms));
    return hits.slice(0, limit).map(h => ({ event: h.entry.event, score: h.score }));
  }
}

/** One-shot search over any collection of events. */
export function searchEvents(events: Iterable<NexusEvent>, text: string, limit: number): EventSearchHit[] {
  const index = new EventSearchIndex();
  for (const e of events) index.add(e);
  return index.search(text, limit);
}
