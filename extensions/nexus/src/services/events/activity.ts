// Activity strip data: events per orbit per 15 minutes (events.activity). Remote first from the Tiger continuous aggregate
// events_15m (real-time aggregation on), with an identical local computation as the fallback. vscode-free.
import { ActivityBucket, IsoTime } from "../../contracts";
import type { NexusEvent, Req, Res } from "../../contracts";
import { BridgeError } from "../../bridge/types";
import type { BridgeRouter, Disposable } from "../../bridge/types";

const BUCKET_MS = 15 * 60 * 1000;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 5000;

/** The minimal pg-like client: Pool and Client both fit. */
export interface ActivityQueryClient { query(text: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }

export interface ActivityDeps {
  query?: ActivityQueryClient;
  /** Local events with from <= at <= to (inclusive, like EventStore.queryEvents), at most `limit`. */
  localEvents(window: { from: string; to: string; limit: number }): Promise<NexusEvent[]>;
  remoteBudgetMs?: number;
}

export const ACTIVITY_SQL =
  "SELECT bucket, orbit, count FROM events_15m WHERE bucket >= time_bucket('15 minutes', $1::timestamptz) AND bucket < $2::timestamptz ORDER BY bucket, orbit";

export type ActivityFn = (from: string, to: string) => Promise<ActivityBucket[]>;

function parseWindow(from: string, to: string): { fromMs: number; toMs: number } {
  const f = IsoTime.safeParse(from), t = IsoTime.safeParse(to);
  if (!f.success || !t.success) throw new BridgeError("invalid_request", "from and to must be ISO times");
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  if (!(fromMs < toMs)) throw new BridgeError("invalid_request", "from must be before to");
  if (toMs - fromMs > MAX_WINDOW_MS) throw new BridgeError("invalid_request", "the window is at most 31 days");
  return { fromMs, toMs };
}

function parseCount(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  if (typeof v === "bigint") return v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : undefined;
  if (typeof v === "string" && /^\d{1,16}$/.test(v)) { const n = Number(v); return Number.isSafeInteger(n) ? n : undefined; }
  return undefined;
}

function bucketIso(v: unknown): string | undefined {
  const ms = v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function mapRows(rows: Record<string, unknown>[]): ActivityBucket[] {
  const out: ActivityBucket[] = [];
  for (const row of rows) {
    const bucketStart = bucketIso(row.bucket), count = parseCount(row.count);
    if (bucketStart === undefined || count === undefined) throw new Error("malformed activity row");
    out.push(ActivityBucket.parse({ bucketStart, orbit: row.orbit, count }));
  }
  return out;
}

const floorBucket = (ms: number): number => Math.floor(ms / BUCKET_MS) * BUCKET_MS;

/** Local events in [fromMs, toMs] inclusive, paged by halving the window whenever a page is full. */
async function collectLocal(deps: ActivityDeps, fromMs: number, toMs: number, out: NexusEvent[]): Promise<void> {
  const page = await deps.localEvents({ from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), limit: PAGE_LIMIT });
  if (page.length < PAGE_LIMIT || toMs <= fromMs) { out.push(...page); return; }
  const mid = floorBucket(fromMs + (toMs - fromMs) / 2);
  if (mid <= fromMs) { out.push(...page); return; }      // cannot split further; accept truncation
  await collectLocal(deps, fromMs, mid - 1, out);
  await collectLocal(deps, mid, toMs, out);
}

async function localBuckets(deps: ActivityDeps, fromMs: number, toMs: number): Promise<ActivityBucket[]> {
  const first = floorBucket(fromMs);
  const lastBucketEnd = floorBucket(toMs) + BUCKET_MS;   // events up to the end of the bucket holding `to`
  const events: NexusEvent[] = [];
  await collectLocal(deps, first, lastBucketEnd - 1, events);
  const seen = new Set<string>();
  const counts = new Map<string, { start: number; orbit: string; count: number }>();
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const t = Date.parse(e.at);
    if (!Number.isFinite(t)) continue;
    const start = floorBucket(t);
    if (start < first || start >= toMs) continue;        // bucket >= time_bucket(from) AND bucket < to
    const key = `${start}\u0000${e.orbit}`;
    const cur = counts.get(key);
    if (cur) cur.count++; else counts.set(key, { start, orbit: e.orbit, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => a.start - b.start || (a.orbit < b.orbit ? -1 : a.orbit > b.orbit ? 1 : 0))
    .map(b => ({ bucketStart: new Date(b.start).toISOString(), orbit: b.orbit, count: b.count }));
}

export function createActivity(deps: ActivityDeps): ActivityFn {
  const budget = deps.remoteBudgetMs ?? 1500;
  return async (from, to) => {
    const { fromMs, toMs } = parseWindow(from, to);
    const client = deps.query;
    if (client) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("remote budget exceeded")), budget); });
        const result = await Promise.race([client.query(ACTIVITY_SQL, [new Date(fromMs).toISOString(), new Date(toMs).toISOString()]), timeout]);
        return mapRows(result.rows);
      } catch {
        // fall through to the local copy; the error text may carry connection details, so it is not logged
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return localBuckets(deps, fromMs, toMs);
  };
}

/** Registers the `events.activity` bridge handler. */
export function registerActivity(router: BridgeRouter, activity: ActivityFn): Disposable {
  return router.handle("events.activity", async (req: Req<"events.activity">): Promise<Res<"events.activity">> => activity(req.from, req.to));
}
