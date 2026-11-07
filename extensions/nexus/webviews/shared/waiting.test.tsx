// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PendingNote, waitingLabel } from "./waiting";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("waitingLabel", () => {
  test("minutes since the request, <1m under a minute", () => {
    const t = Date.parse("2026-11-07T04:00:00Z");
    expect(waitingLabel("2026-11-07T04:00:00Z", t + 59_000)).toBe("waiting <1m");
    expect(waitingLabel("2026-11-07T04:00:00Z", t + 60_000)).toBe("waiting 1m");
    expect(waitingLabel("2026-11-07T04:00:00Z", t + 7 * 60_000 + 5_000)).toBe("waiting 7m");
    expect(waitingLabel("not a date", t)).toBe("waiting <1m");
  });
});

describe("PendingNote", () => {
  test("shows amber waiting time and the no-timeout line", () => {
    render(<PendingNote requestedAt="2026-11-07T04:00:00Z" now={Date.parse("2026-11-07T04:03:10Z")} />);
    expect(screen.getByText("waiting 3m").className).toContain("nx-tone-pending");
    expect(screen.getByText("no timeout: the agent waits until someone decides")).toBeTruthy();
  });
});
