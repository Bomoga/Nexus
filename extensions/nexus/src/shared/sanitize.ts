import { redact } from "./redact";

// Bounds and redaction for anything that goes into an AgentEvent (PLAN L1-09, CLAUDE.md §14). Events end up in the
// shared store and in Slack, and their content is chosen by a model, so every string is redacted and clipped, and the
// whole value is capped in depth, breadth and total size. Both the agent process and the host apply it: the host never
// trusts what the child already did.
//
// The size bound is real: EVERY node (a string, a number, a key, a placeholder) is charged to one budget, the walk stops
// as soon as it is spent, cycles are cut, and a property that throws is skipped.

export const MAX_EVENT_STRING = 2000;
export const MAX_EVENT_DEPTH = 6;
export const MAX_EVENT_ITEMS = 50;
export const MAX_EVENT_TOTAL = 20_000;
export const MAX_KEY_CHARS = 100;

/** Room kept for the "…[clipped N chars]" marker, so the clipped result never exceeds `max` and clipping is idempotent. */
const MARKER_RESERVE = 32;
const NODE_COST = 8;                                  // every non-string value costs at least this
const TRUNCATED = "[omitted: event too large]";

export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - MARKER_RESERVE);
  return `${text.slice(0, keep)}…[clipped ${text.length - keep} chars]`;
}

/** Redacts, then clips, one string. */
export function cleanString(value: string, max = MAX_EVENT_STRING): string {
  return clipText(redact(value), max);
}

interface Budget { left: number; truncated: boolean }

export function sanitizeForEvent(value: unknown): unknown {
  const budget: Budget = { left: MAX_EVENT_TOTAL, truncated: false };
  const out = walk(value, 0, budget, new WeakSet());
  if (budget.truncated) {
    if (Array.isArray(out)) out.push(TRUNCATED);
    else if (out && typeof out === "object") (out as Record<string, unknown>)["[truncated]"] = TRUNCATED;
  }
  return out;
}

function walk(value: unknown, depth: number, budget: Budget, seen: WeakSet<object>): unknown {
  if (budget.left <= 0) { budget.truncated = true; return undefined; }
  if (typeof value === "string") {
    const clean = cleanString(value);
    budget.left -= Math.max(clean.length, NODE_COST);
    return clean;
  }
  if (value === null || typeof value === "boolean") { budget.left -= NODE_COST; return value; }
  if (typeof value === "number") { budget.left -= NODE_COST; return Number.isFinite(value) ? value : null; }
  if (typeof value !== "object") return undefined;                    // functions, symbols, bigints and undefined are dropped
  if (seen.has(value)) { budget.left -= NODE_COST; return "[circular]"; }
  if (depth >= MAX_EVENT_DEPTH) { budget.left -= NODE_COST; return "[nested value omitted]"; }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) { budget.left -= NODE_COST; return `[binary, ${value.byteLength} bytes]`; }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (let i = 0; i < value.length && i < MAX_EVENT_ITEMS; i++) {
        if (budget.left <= 0) { budget.truncated = true; break; }
        let child: unknown;
        try { child = value[i]; } catch { child = undefined; }
        items.push(walk(child, depth + 1, budget, seen) ?? null);
      }
      if (value.length > MAX_EVENT_ITEMS) items.push(`[+${value.length - MAX_EVENT_ITEMS} more]`);
      return items;
    }
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) { budget.left -= NODE_COST; return `[${(proto as { constructor?: { name?: string } }).constructor?.name ?? "object"}]`; }   // Map, Set, Date, class instances
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key in value as Record<string, unknown>) {
      if (!Object.hasOwn(value, key)) continue;
      if (count >= MAX_EVENT_ITEMS) {
        let more = 1;                                                 // this key plus the rest, counted without reading values
        for (const rest in value as Record<string, unknown>) if (Object.hasOwn(value, rest)) more++;
        out["[omitted]"] = `${more - 1 - count} more fields`;
        break;
      }
      if (budget.left <= 0) { budget.truncated = true; break; }
      count++;
      const cleanKey = cleanString(key, MAX_KEY_CHARS);
      budget.left -= cleanKey.length + NODE_COST;
      let child: unknown;
      try { child = (value as Record<string, unknown>)[key]; } catch { continue; }      // a getter that throws is skipped
      const clean = walk(child, depth + 1, budget, seen);
      if (clean !== undefined) out[cleanKey] = clean;
    }
    return out;
  } finally {
    seen.delete(value);                                               // shared references are fine; only true cycles are cut
  }
}
