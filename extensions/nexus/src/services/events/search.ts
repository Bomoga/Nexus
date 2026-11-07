// Event search: case-insensitive substring over title, sha, orbit and actor.
// Ranking: title match (3) above sha match (2) above orbit/actor match (1); newest first within a score.
import type { EventSearchHit, NexusEvent } from "../../contracts";

const TITLE = 3, SHA = 2, OTHER = 1;

interface Entry { event: NexusEvent; title: string; sha: string; other: string }

function entryOf(event: NexusEvent): Entry {
  return {
    event,
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
    const hits: EventSearchHit[] = [];
    for (const entry of this.entries.values()) {
      const score = scoreOf(entry, q);
      if (score) hits.push({ event: entry.event, score });
    }
    hits.sort((a, b) => b.score - a.score || b.event.at.localeCompare(a.event.at));
    return hits.slice(0, limit);
  }
}

/** One-shot search over any collection of events. */
export function searchEvents(events: Iterable<NexusEvent>, text: string, limit: number): EventSearchHit[] {
  const index = new EventSearchIndex();
  for (const e of events) index.add(e);
  return index.search(text, limit);
}
