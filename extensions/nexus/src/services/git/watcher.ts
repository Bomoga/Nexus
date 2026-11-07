// Turns repository changes into NexusEvents (PLAN 5.2 L2-07). On start and whenever refs change it diffs the known
// ref -> sha map against GitService.refs(), walks the recent commits, and writes one event per commit, merge, new
// branch and new tag through the injected putNexusEvent. Event ids are deterministic, so a re-scan, a restart or a
// force push never duplicates; a force push only adds. Read-only on the repository. Everything that comes from the
// repository (subjects, author names, ref names) is untrusted data and is only ever copied into event fields.
import { NexusEvent, orbitOf } from "../../contracts";
import type { FullSha, GitService, LogEntry, RefInfo } from "./types";

export const MAX_EVENTS_PER_SCAN = 5000;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_DEBOUNCE_MS = 500;

export interface GitWatcherOptions {
  git: GitService;
  putNexusEvent: (event: NexusEvent) => Promise<void>;
  /** Registers a change callback (production: a FileSystemWatcher on .git/refs/**, packed-refs and HEAD) and returns its disposer. */
  watch: (onChange: () => void) => () => void;
  /** True when the store knows this agent session. A Nexus-Agent trailer naming any other id is just text: the commit is human. */
  isKnownSession: (sessionId: string) => Promise<boolean>;
  workspaceId: string;
  machineId: string;
  auth0UserId?: string;
  logger: { warn(message: string): void };
  debounceMs?: number;
  maxEventsPerScan?: number;
  /** First retry delay after a failed scan; doubles each time. */
  retryBaseMs?: number;
  maxRetries?: number;
  now?: () => number;
}

export class GitWatcher {
  private knownRefs = new Map<string, string>();
  private readonly emitted = new Set<string>();
  private scanning = false;
  private rescan = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unwatch: (() => void) | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private disposed = false;
  private current: Promise<void> = Promise.resolve();

  constructor(private readonly o: GitWatcherOptions) {}

  /** Starts watching and runs the first scan. Resolves when that scan is done; never rejects. */
  async start(): Promise<void> {
    if (this.unwatch || this.disposed) return;
    this.unwatch = this.o.watch(() => this.onChange());
    await this.scan();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = undefined;
    this.retryTimer = undefined;
    this.unwatch?.();
    this.unwatch = undefined;
  }

  /** Resolves when the scan in flight (if any) and any scan queued behind it are done. */
  async idle(): Promise<void> {
    do { await this.current; } while (this.scanning || this.rescan);
  }

  private onChange(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.scan(); }, this.o.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  /** Runs one scan; never overlaps itself (a call during a scan queues exactly one more scan) and never throws. */
  scan(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.scanning) { this.rescan = true; return this.current; }
    this.scanning = true;
    this.current = (async () => {
      try {
        do {
          this.rescan = false;
          try {
            const more = await this.scanOnce();
            this.retries = 0;
            if (more) this.rescan = true;   // capped: the rest is written right away, no ref change needed
          } catch (e) {
            this.o.logger.warn(`git watcher scan failed: ${e instanceof Error ? e.message : String(e)}`);
            this.scheduleRetry();
          }
        } while (this.rescan && !this.disposed);
      } finally { this.scanning = false; }
    })();
    return this.current;
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer || this.retries >= (this.o.maxRetries ?? 5)) return;
    const delay = (this.o.retryBaseMs ?? 1000) * 2 ** this.retries++;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.scan(); }, delay);
  }

  /** One pass. Returns true when it was capped and more events are waiting. */
  private async scanOnce(): Promise<boolean> {
    const { git } = this.o;
    const refs = await git.refs();
    const next = new Map(refs.map(r => [`${r.kind}:${r.name}`, r.sha]));
    const changed = next.size !== this.knownRefs.size || [...next].some(([k, v]) => this.knownRefs.get(k) !== v);
    if (!changed) return false;

    const now = (this.o.now ?? Date.now)();
    const log = await git.log({ since: new Date(now - WINDOW_MS).toISOString() });
    const bySha = new Map(log.map(e => [e.sha, e]));
    const head = await git.headOf().catch(() => undefined);
    const owners = assignOwners(refs, head, log, bySha);
    const known = new Map<string, boolean>();
    const isAgent = async (e: LogEntry): Promise<boolean> => {
      const id = e.agentSessionId;
      if (!id) return false;
      let v = known.get(id);
      if (v === undefined) { v = await this.o.isKnownSession(id); known.set(id, v); }
      return v;
    };
    const events: NexusEvent[] = [];
    const add = (e: NexusEvent) => { if (!this.emitted.has(e.id)) events.push(e); };
    const ws = this.o.workspaceId;

    for (const entry of log) {
      const orbit = owners.get(entry.sha) ?? "detached";
      const actor = { name: entry.authorName, kind: (await isAgent(entry)) ? "agent" as const : "human" as const };
      if (entry.parents.length >= 2) {
        const from = owners.get(entry.parents[1]);
        add({ ...this.base(`${ws}:merge:${entry.sha}`, "merge", entry.committedAt, orbit, entry.subject, actor, entry.sha),
          ...(from && from !== orbit ? { fromOrbit: from } : {}) });
      } else add(this.base(`${ws}:commit:${entry.sha}`, "commit", entry.committedAt, orbit, entry.subject, actor, entry.sha));
    }
    // New branches and tags. Ids carry the name, not the sha, so a restart or a moved tip never makes a second event.
    for (const ref of refs) {
      if (ref.kind === "remote" || this.knownRefs.has(`${ref.kind}:${ref.name}`)) continue;
      const tip = bySha.get(ref.sha);
      if (!tip) continue;   // older than the window: not on the globe
      const orbit = ref.kind === "branch" && !ref.name.startsWith("nexus/agent-") ? orbitOf(ref.name) : owners.get(ref.sha) ?? "detached";
      add(this.base(`${ws}:${ref.kind}:${ref.name}`, ref.kind, tip.committedAt, orbit, ref.name,
        { name: tip.authorName, kind: (await isAgent(tip)) ? "agent" : "human" }, ref.sha));
    }

    events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const max = this.o.maxEventsPerScan ?? MAX_EVENTS_PER_SCAN;
    const truncated = events.length > max;
    const batch = events.slice(0, max).reverse();   // newest kept, written oldest first
    for (const e of batch) {
      const parsed = NexusEvent.safeParse(e);
      if (!parsed.success) { this.o.logger.warn(`git watcher dropped an invalid event ${e.id}`); this.emitted.add(e.id); continue; }
      await this.o.putNexusEvent(parsed.data);
      this.emitted.add(e.id);
    }
    if (!truncated) this.knownRefs = next;   // when truncated, the refs stay "changed" so the follow-up scan continues
    return truncated;
  }

  private base(id: string, kind: NexusEvent["kind"], at: string, orbit: string, title: string, actor: NexusEvent["actor"], sha: FullSha): NexusEvent {
    return {
      id, kind, at, orbit, title, actor, target: { type: "commit", sha },
      workspaceId: this.o.workspaceId, machineId: this.o.machineId,
      ...(this.o.auth0UserId ? { auth0UserId: this.o.auth0UserId } : {}),
    };
  }
}

// A branch name from a merge subject (untrusted text). It may only pick an orbit name: plain segments, no "." or ".."
// segment, no leading dot or slash, no doubled slash.
const NAME_RE = /^(?!.*(?:^|\/)\.)(?!.*\/\/)(?!\/)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const MAX_NAME = 100;

/**
 * The source family a merge subject claims, one per secondary parent, or undefined when it names none: those commits then
 * stay on the orbit they merged into (no arc), rather than on an invented orbit. Untrusted text: it can only pick an orbit
 * name. Understands git's own subjects, GitHub's PR subjects, and this repo's `lane-N: ...` convention for lane merges.
 */
function sourceFamilies(subject: string, count: number): (string | undefined)[] {
  const names: string[] = [];
  const m = /^Merge (?:branches|branch|tag|tags) (.+?)(?: into .*)?$/.exec(subject);
  if (m) for (const q of m[1].matchAll(/'([^']*)'/g)) names.push(q[1]);
  else {
    const pr = /^Merge pull request #\d+ from [^/\s]+\/(\S+)$/.exec(subject);
    const lane = /^(lane-\d+):\s/.exec(subject);
    if (pr) names.push(pr[1]);
    else if (lane && count === 1) names.push(lane[1]);
  }
  return Array.from({ length: count }, (_, i) => (names.length === count && names[i].length <= MAX_NAME && NAME_RE.test(names[i]) ? orbitOf(names[i]) : undefined));
}

/**
 * Gives every recent commit the branch family it was made on, in memory from the log's parents (no git call per commit).
 * 1. Walk each live branch's first-parent chain from its tip, main first, then lane-N, then others, then nexus/agent-*,
 *    claiming unclaimed commits. Agent branches and a detached HEAD take the family of their first owned ancestor.
 * 2. Commits no live branch reaches came in through a merge whose source branch is gone: walk that merge's second-parent
 *    chain to the first owned commit and give it the family named by the merge subject (or "merged").
 */
function assignOwners(refs: RefInfo[], head: FullSha | undefined, log: LogEntry[], bySha: Map<FullSha, LogEntry>): Map<FullSha, string> {
  const owners = new Map<FullSha, string>();
  const rank = (n: string) => (n === "main" ? 0 : n.startsWith("nexus/agent-") ? 3 : /^lane-\d+/.test(n) ? 1 : 2);
  const heads = refs.filter(r => r.kind !== "tag").map(r => ({ name: r.kind === "remote" ? r.name.replace(/^[^/]+\//, "") : r.name, local: r.kind === "branch", sha: r.sha }))
    .sort((a, b) => rank(a.name) - rank(b.name) || Number(b.local) - Number(a.local) || a.name.localeCompare(b.name));
  const claim = (tip: FullSha, family: (base: FullSha | undefined) => string): void => {
    const chain: FullSha[] = [];
    let cur: FullSha | undefined = tip;
    while (cur && bySha.has(cur) && !owners.has(cur)) { chain.push(cur); cur = bySha.get(cur)!.parents[0]; }
    const family_ = family(cur && owners.has(cur) ? cur : undefined);
    for (const s of chain) owners.set(s, family_);
  };
  for (const h of heads) {
    if (h.name.startsWith("nexus/agent-")) claim(h.sha, base => (base && owners.get(base)) || "main");
    else claim(h.sha, () => orbitOf(h.name));
  }
  if (head) claim(head, base => (base && owners.get(base)) || "detached");

  // Merged-in history from deleted branches. Queue merges that are owned; claiming may reveal more merges inside.
  const queue = log.filter(e => e.parents.length >= 2 && owners.has(e.sha));
  for (let i = 0; i < queue.length; i++) {
    const merge = queue[i];
    const fams = sourceFamilies(merge.subject, merge.parents.length - 1);
    merge.parents.slice(1).forEach((p, idx) => {
      let cur: FullSha | undefined = p;
      while (cur && bySha.has(cur) && !owners.has(cur)) {
        owners.set(cur, fams[idx] ?? owners.get(merge.sha)!);
        const e: LogEntry = bySha.get(cur)!;
        if (e.parents.length >= 2) queue.push(e);
        cur = e.parents[0];
      }
    });
  }
  for (const e of log) if (!owners.has(e.sha)) claim(e.sha, base => (base && owners.get(base)) || "detached");
  return owners;
}
