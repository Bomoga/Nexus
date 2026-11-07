import { useEffect, useState } from "react";
import { StatusLine } from "./StatusLine";

const MINUTE_MS = 60_000;

/** "waiting 3m" (minutes since the request), or "waiting <1m" under a minute. */
export function waitingLabel(requestedAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(requestedAt)) / MINUTE_MS);
  return minutes >= 1 ? `waiting ${minutes}m` : "waiting <1m";
}

/** The current time, refreshed on one interval per call: call it once per view, not per row. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Shown under an undecided approval. Display only: nothing here ever decides it. */
export function PendingNote({ requestedAt, now }: { requestedAt: string; now: number }) {
  return (
    <>
      <StatusLine tone="pending">{waitingLabel(requestedAt, now)}</StatusLine>
      <StatusLine>no timeout: the agent waits until someone decides</StatusLine>
    </>
  );
}
