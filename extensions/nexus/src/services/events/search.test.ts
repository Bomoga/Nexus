import { describe, expect, it } from "vitest";
import { fx } from "../../contracts/fixtures";
import type { NexusEvent } from "../../contracts";
import { EventSearchIndex, searchEvents } from "./search";

const ev = (id: string, title: string, at: string, over: Partial<NexusEvent> = {}): NexusEvent => ({ ...fx.event, id, title, at, ...over });

describe("event search", () => {
  const SHA = "abc123def4567890abc123def4567890abc123de";
  const events = [
    ev("1", "unrelated", "2026-11-07T05:00:00Z", { target: { type: "commit", sha: SHA } }),
    ev("2", "fix ABC parser", "2026-11-07T04:00:00Z"),
    ev("3", "fix abc lexer", "2026-11-07T06:00:00Z"),
    ev("4", "other", "2026-11-07T07:00:00Z", { orbit: "feature/abc", target: { type: "session", sessionId: "s" } }),
  ];

  it("ranks title above sha above orbit, newest first within a score, case-insensitively", () => {
    expect(searchEvents(events, "  AbC ", 10).map(h => [h.event.id, h.score])).toEqual([["3", 3], ["2", 3], ["1", 2], ["4", 1]]);
  });

  it("matches actor names and respects the limit", () => {
    expect(searchEvents(events, "adrian", 2)).toHaveLength(2);
    expect(searchEvents(events, "nomatch", 5)).toEqual([]);
    expect(searchEvents(events, "   ", 5)).toEqual([]);
  });

  it("ignores a repeated id", () => {
    const idx = new EventSearchIndex();
    idx.add(ev("1", "first", "2026-11-07T05:00:00Z"));
    idx.add(ev("1", "second", "2026-11-07T05:00:00Z"));
    expect(idx.search("second", 5)).toEqual([]);
    expect(idx.search("first", 5)).toHaveLength(1);
  });

  it("orders newest first by instant across UTC offsets", () => {
    const mixed = [
      ev("a", "t", "2026-11-07T10:00:00-05:00"),   // 15:00Z
      ev("b", "t", "2026-11-07T20:00:00+09:00"),   // 11:00Z
      ev("c", "t", "2026-11-07T12:00:00Z"),
    ];
    expect(searchEvents(mixed, "t", 10).map(h => h.event.id)).toEqual(["a", "c", "b"]);
  });
});
