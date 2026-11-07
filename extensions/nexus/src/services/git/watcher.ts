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
  workspaceId: string;
  machineId: string;
  auth0UserId?: string;
  logger: { warn(message: string): void };
  debounceMs?: number;
  maxEventsPerScan?: number;
  now?: () => number;
}

export class GitWatcher {
  private knownRefs = new Map<string, string>();
  private readonly emitted = new Set<string>();
  private scanning = false;
  private rescan = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unwatch: (() => void) | undefined;
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
    this.timer = undefined;
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
          try { await this.scanOnce(); }
          catch (e) { this.o.logger.warn(`git watcher scan failed: ${e instanceof Error ? e.message : String(e)}`); }
        } while (this.rescan && !this.disposed);
      } finally { this.scanning = false; }
    })();
    return this.current;
  }

  private async scanOnce(): Promise<void> {
    const { git } = this.o;
    const refs = await git.refs();
    const next = new Map(refs.map(r => [`${r.kind}:${r.name}`, r.sha]));
    const changed = next.size !== this.knownRefs.size || [...next].some(([k, v]) => this.knownRefs.get(k) !== v);
    if (!changed) return;

    const now = (this.o.now ?? Date.now)();
    const log = await git.log({ since: new Date(now - WINDOW_MS).toISOString() });
    const bySha = new Map(log.map(e => [e.sha, e]));
    const owners = this.assignOwners(refs, bySha);
    const events: NexusEvent[] = [];
    const add = (e: NexusEvent) => { if (!this.emitted.has(e.id)) events.push(e); };

    // Commits and merges.
    for (const entry of log) {
      if (entry.parents.length >= 2) add(await this.mergeEvent(entry, owners));
      else add(this.commitEvent(entry, await this.orbitFor(entry.sha, owners)));
    }
    // New branches and tags.
    for (const ref of refs) {
      if (ref.kind === "remote" || this.knownRefs.has(`${ref.kind}:${ref.name}`)) continue;
      const tip = bySha.get(ref.sha);
      if (!tip) continue;   // older than the window: not on the globe
      const orbit = ref.kind === "branch" ? this.branchOrbit(ref.name, ref.sha, owners) : await this.orbitFor(ref.sha, owners);
      add(this.base(`${this.o.workspaceId}:${ref.kind}:${ref.sha}:${ref.name}`,
        ref.kind, tip.committedAt, orbit, ref.name, { name: tip.authorName, kind: tip.agentSessionId ? "agent" : "human" }, ref.sha));
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
    if (!truncated) this.knownRefs = next;   // when truncated, the next change scans the rest
  }

  private base(id: string, kind: NexusEvent["kind"], at: string, orbit: string, title: string, actor: NexusEvent["actor"], sha: FullSha): NexusEvent {
    return {
      id, kind, at, orbit, title, actor, target: { type: "commit", sha },
      workspaceId: this.o.workspaceId, machineId: this.o.machineId,
      ...(this.o.auth0UserId ? { auth0UserId: this.o.auth0UserId } : {}),
    };
  }

  private commitEvent(e: LogEntry, orbit: string): NexusEvent {
    return this.base(`${this.o.workspaceId}:commit:${e.sha}`, "commit", e.committedAt, orbit, e.subject,
      { name: e.authorName, kind: e.agentSessionId ? "agent" : "human" }, e.sha);
  }

  private async mergeEvent(e: LogEntry, owners: Map<FullSha, string>): Promise<NexusEvent> {
    const orbit = await this.orbitFor(e.sha, owners);
    let from = e.parents[1] ? await this.orbitFor(e.parents[1], owners) : undefined;
    if (from === orbit) from = undefined;
    const ev = this.commitEvent(e, orbit);
    return { ...ev, id: `${this.o.workspaceId}:merge:${e.sha}`, kind: "merge", ...(from ? { fromOrbit: from } : {}) };
  }

  /**
   * Gives every recent commit the branch family it was made on: walk each branch's first-parent chain from its tip,
   * main first, and claim commits nobody claimed yet. A nexus/agent-* branch's commits take the family of the commit
   * the branch was based on (the first already-claimed ancestor).
   */
  private assignOwners(refs: RefInfo[], bySha: Map<FullSha, LogEntry>): Map<FullSha, string> {
    const owners = new Map<FullSha, string>();
    const rank = (n: string) => (n === "main" ? 0 : n.startsWith("nexus/agent-") ? 3 : /^lane-\d+/.test(n) ? 1 : 2);
    const heads = refs.filter(r => r.kind !== "tag").map(r => ({ name: r.kind === "remote" ? r.name.replace(/^[^/]+\//, "") : r.name, local: r.kind === "branch", sha: r.sha }))
      .sort((a, b) => rank(a.name) - rank(b.name) || Number(b.local) - Number(a.local) || a.name.localeCompare(b.name));
    for (const h of heads) {
      const chain: FullSha[] = [];
      let cur: FullSha | undefined = h.sha;
      while (cur && bySha.has(cur) && !owners.has(cur)) { chain.push(cur); cur = bySha.get(cur)!.parents[0]; }
      const isAgent = h.name.startsWith("nexus/agent-");
      const orbit = isAgent ? (cur && owners.get(cur)) || "main" : orbitOf(h.name);
      for (const s of chain) owners.set(s, orbit);
    }
    return owners;
  }

  private branchOrbit(name: string, sha: FullSha, owners: Map<FullSha, string>): string {
    return name.startsWith("nexus/agent-") ? owners.get(sha) ?? "main" : orbitOf(name);
  }

  private async orbitFor(sha: FullSha, owners: Map<FullSha, string>): Promise<string> {
    const known = owners.get(sha);
    if (known) return known;
    // Unclaimed (for example the far side of a merge whose branch was deleted): the first branch that contains it.
    const names = (await this.o.git.branchesContaining(sha)).filter(n => !n.startsWith("nexus/agent-"));
    const best = names.map(n => orbitOf(n)).sort((a, b) => Number(a === "main") - Number(b === "main"))[0];
    return best ?? "main";
  }
}
