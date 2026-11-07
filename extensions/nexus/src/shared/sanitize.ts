import { redact } from "./redact";

// Bounds and redaction for anything that goes into an AgentEvent (PLAN L1-09, CLAUDE.md §14). Events end up in the
// shared store and in Slack, and their content is chosen by a model, so every string is redacted and clipped, and the
// whole value is capped in depth, breadth and total size. Both the agent process and the host apply it: the host never
// trusts what the child already did.

export const MAX_EVENT_STRING = 2000;
export const MAX_EVENT_DEPTH = 6;
export const MAX_EVENT_ITEMS = 50;
export const MAX_EVENT_TOTAL = 20_000;
export const MAX_KEY_CHARS = 100;

/** Room kept for the "…[clipped N chars]" marker, so the clipped result never exceeds `max` and clipping is idempotent. */
const MARKER_RESERVE = 32;

export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - MARKER_RESERVE);
  return `${text.slice(0, keep)}…[clipped ${text.length - keep} chars]`;
}

/** Redacts, then clips, one string. */
export function cleanString(value: string, max = MAX_EVENT_STRING): string {
  return clipText(redact(value), max);
}

export function sanitizeForEvent(value: unknown): unknown {
  const budget = { left: MAX_EVENT_TOTAL };
  return walk(value, 0, budget);
}

function walk(value: unknown, depth: number, budget: { left: number }): unknown {
  if (typeof value === "string") {
    if (budget.left <= 0) return "[omitted: event too large]";
    const clean = cleanString(value);
    budget.left -= clean.length;
    return clean;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return undefined;                  // functions, symbols, bigints and undefined are dropped
  if (depth >= MAX_EVENT_DEPTH) return "[nested value omitted]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_EVENT_ITEMS).map(v => walk(v, depth + 1, budget) ?? null);
    if (value.length > MAX_EVENT_ITEMS) items.push(`[+${value.length - MAX_EVENT_ITEMS} more]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [k, v] of entries.slice(0, MAX_EVENT_ITEMS)) {
    const clean = walk(v, depth + 1, budget);
    if (clean !== undefined) out[cleanString(k, MAX_KEY_CHARS)] = clean;
  }
  if (entries.length > MAX_EVENT_ITEMS) out["[omitted]"] = `${entries.length - MAX_EVENT_ITEMS} more fields`;
  return out;
}
