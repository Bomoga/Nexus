import { ApprovalRequest, DecidedBy, type ApprovalAction, type Req, type Res } from "../../contracts";
import { redact } from "../../shared/redact";
import type { Clock, StorePort, Unsubscribe } from "../ports";
import type { ApprovalRequester, SessionEvents } from "../sessions/sessions-controller";

// Approvals controller (PLAN L1-12). The gate asks for a human's decision; the first human answer on any surface and
// any machine wins (a conditional write in the store); the agent waits with no timeout; nothing but resolve() with a
// human DecidedBy can set a decision, and the agent process has no path to it (CLAUDE.md §5, §14).

type Decision = "approved" | "rejected";

export interface NotifyPort {
  /** Shows "Agent wants to … (model-written)" with APPROVE / REJECT; calls back with the button pressed. */
  show(approval: ApprovalRequest, text: string, onChoice: (decision: Decision) => void): void;
  /** Replaces the notification text once the approval is decided. */
  update(approvalId: string, text: string): void;
}

/** A surface that wants to know about new approvals: the Slack message (Lane 2) and the swarm review (L1-18). */
export interface ApprovalHook {
  name: string;
  onCreated(approval: ApprovalRequest): Promise<void>;
}

export interface ApprovalsDeps {
  store: StorePort;
  clock: Clock;
  sessions: SessionEvents;
  /** The agent host: wakes a waiting cmd.run / git.commit. Informational, the awaited call itself also completes. */
  host: { sendEvent(name: "approval.resolved", body: { approvalId: string; decision: Decision }): boolean };
  notify: NotifyPort;
  /** Who is clicking in this window (shown as "decided by"). */
  identity(): string;
  hooks?: ApprovalHook[];
  log?: (message: string) => void;
}

export class ApprovalConflict extends Error {
  constructor(readonly winner: ApprovalRequest) {
    super(`Already decided by ${winner.decidedBy?.userId ?? "someone"} via ${winner.decidedBy?.via ?? "another surface"}.`);
    this.name = "ApprovalConflict";
  }
}

export function describeAction(action: ApprovalAction): string {
  switch (action.kind) {
    case "run_command": return `run: ${action.command}`;
    case "write_outside_scope": return `write outside its worktree: ${action.path}`;
    case "commit": return `commit: "${action.message}"`;
    case "other": return action.description;
  }
}

function redactAction(action: ApprovalAction): ApprovalAction {
  switch (action.kind) {
    case "run_command": return { kind: "run_command", command: redact(action.command) };
    case "write_outside_scope": return { kind: "write_outside_scope", path: redact(action.path) };
    case "commit": return { kind: "commit", message: redact(action.message) };
    case "other": return { kind: "other", description: redact(action.description) };
  }
}

export class ApprovalsController implements ApprovalRequester {
  /** Approvals created by sessions on THIS machine that are still waiting: only the owner wakes the agent. */
  private readonly pending = new Map<string, string>();               // approvalId -> sessionId
  private readonly waiters = new Map<string, Array<(d: Decision) => void>>();
  private readonly known = new Set<string>();                         // ids already announced on this machine
  /** Approvals being created right now: a decision that arrives early is parked here and applied, in order, afterwards. */
  private readonly creating = new Map<string, ApprovalRequest | undefined>();
  /** Sessions that are over: their approvals can no longer be decided (an APPROVE must not run a command in a dead worktree). */
  private readonly ended = new Set<string>();
  /** Approvals whose creation failed after they were announced: nobody waits on them, so no decision may ever be written. */
  private readonly dead = new Map<string, ApprovalRequest>();
  private readonly listeners = new Set<(a: ApprovalRequest) => void>();

  constructor(private readonly deps: ApprovalsDeps) {}

  // ---- creating and waiting (the gate's side) ----

  async create(input: { sessionId: string; action: ApprovalAction; reason: string; diffPreview?: string }): Promise<ApprovalRequest> {
    const { store, clock, sessions } = this.deps;
    if (this.ended.has(input.sessionId)) throw new Error("That session has ended; there is nothing to approve.");
    const approval = ApprovalRequest.parse({
      id: clock.newId("apr"), sessionId: input.sessionId, action: redactAction(input.action),
      reason: redact(input.reason), requestedAt: clock.now(),
      ...(input.diffPreview !== undefined ? { diffPreview: redact(input.diffPreview) } : {}),
    });
    this.creating.set(approval.id, undefined);
    this.pending.set(approval.id, approval.sessionId);
    this.known.add(approval.id);
    // From here on the approval may exist in the store, on screen and on other machines. ANY failure before it is handed back
    // means the caller (the gate) fails, so nobody waits on it: it must never be decidable afterwards (see abandon()).
    let early: ApprovalRequest | undefined;
    try {
      await store.putApproval(approval);
      this.assertLive(approval);                                       // the session may have ended while the write was in flight
      await sessions.emit(approval.sessionId, { type: "approval_request", approvalId: approval.id });
      await sessions.setStatus(approval.sessionId, "awaiting_approval");
      this.assertLive(approval);                                       // no live card for a dead session
      this.announce(approval);
      this.emitChange(approval);
      for (const hook of this.deps.hooks ?? []) {
        // A broken surface must never block the human from deciding on another one (also when the hook throws before returning a promise).
        Promise.resolve().then(() => hook.onCreated(approval)).catch(e => this.deps.log?.(`approval hook ${hook.name} failed: ${e instanceof Error ? e.message : "unknown error"}`));
      }
      // A decision made while we were still creating (another machine, a Slack button) is applied after approval_request.
      const stored = await store.getApproval(approval.id);
      early = this.creating.get(approval.id) ?? stored;                // read the parked decision AFTER the await: one may land during it
      if (!early?.decision) this.assertLive(approval);                 // a decision that landed is real; otherwise an ended session means nobody can wake the gate
    } catch (e) {
      await this.abandon(approval);
      throw e;
    }
    this.creating.delete(approval.id);
    if (early?.decision) await this.settle(early);
    return approval;
  }

  /** Throws unless the approval's session is still running and this machine still owns the approval (see sessionEnded()). */
  private assertLive(approval: ApprovalRequest): void {
    if (this.ended.has(approval.sessionId) || !this.pending.has(approval.id)) throw new Error("That session has ended; there is nothing to approve.");
  }

  /**
   * create() failed after registering the approval. A human decision that already landed is real, so it is recorded and delivered;
   * otherwise the approval is dead: no decision is ever written for it, its notification says so, the session stops showing "awaiting".
   */
  private async abandon(approval: ApprovalRequest): Promise<void> {
    const parked = this.creating.get(approval.id);
    this.creating.delete(approval.id);
    if (parked?.decision) await this.settle(parked);
    else await this.markDead(approval);
  }

  /** Resolves when ANY surface or machine decides. There is no timeout path: a silent human leaves it pending. */
  async waitForDecision(approvalId: string): Promise<Decision> {
    // Register first, then look at the store: a decision that lands in between must not leave this waiting forever.
    let register!: (d: Decision) => void;
    const waiting = new Promise<Decision>(resolve => {
      register = resolve;
      const list = this.waiters.get(approvalId) ?? [];
      list.push(resolve);
      this.waiters.set(approvalId, list);
    });
    let stored: ApprovalRequest | undefined;
    try {
      stored = await this.deps.store.getApproval(approvalId);
    } catch (e) {
      // The caller sees the error; do not leave a dead waiter behind.
      const rest = (this.waiters.get(approvalId) ?? []).filter(w => w !== register);
      if (rest.length > 0) this.waiters.set(approvalId, rest); else this.waiters.delete(approvalId);
      throw e;
    }
    if (stored?.decision && !this.pending.has(approvalId)) this.wake(approvalId, stored.decision);
    else if (!stored?.decision && (this.dead.has(approvalId) || !this.pending.has(approvalId) || (stored && this.ended.has(stored.sessionId)))) {
      // Nothing can ever wake this waiter (its session ended, or it was abandoned): release the gate as rejected, writing no decision.
      const rest = (this.waiters.get(approvalId) ?? []).filter(w => w !== register);
      if (rest.length > 0) this.waiters.set(approvalId, rest); else this.waiters.delete(approvalId);
      throw new Error("That session has ended; there is nothing to approve.");
    }
    return waiting;
  }

  async request(input: { sessionId: string; action: ApprovalAction; reason: string; diffPreview?: string }): Promise<{ approval: ApprovalRequest; decision: Decision }> {
    const created = await this.create(input);
    let decision: Decision;
    try {
      decision = await this.waitForDecision(created.id);
    } catch (e) {
      // The gate gets this error, so nobody waits on the approval any more: a later click must not "approve" a call that already failed.
      if (this.pending.has(created.id)) await this.markDead(created);
      throw e;
    }
    // The decision is already known; the read-back only adds who decided, so a store failure here must not turn it into an error.
    const stored = await this.deps.store.getApproval(created.id).catch(e => { this.deps.log?.(`could not read back approval ${created.id}: ${e instanceof Error ? e.message : "unknown error"}`); return undefined; });
    return { approval: stored ?? created, decision };
  }

  // ---- deciding (the humans' side) ----

  /** Sets the decision if nobody has; always returns the stored winner. `won` says whether this call set it. */
  async resolve(approvalId: string, decision: Decision, decidedBy: DecidedBy): Promise<{ approval: ApprovalRequest; won: boolean }> {
    const by = DecidedBy.parse(decidedBy);
    if (by.userId.trim().length === 0) throw new Error("A decision needs the name of the person who made it.");
    const gone = this.dead.get(approvalId);
    if (gone) return { approval: gone, won: false };                  // refused: nothing is written
    const existing = await this.deps.store.getApproval(approvalId);
    if (!existing) throw new Error(`No approval ${approvalId}.`);
    if (this.ended.has(existing.sessionId) && !existing.decision) throw new Error("That session has ended; there is nothing to approve.");
    const res = await this.deps.store.decideApproval(approvalId, decision, by, this.deps.clock.now());
    await this.settle(res.approval);
    return res;
  }

  /** Called when the shared store reports a change made elsewhere (another machine's click, a Slack button). */
  async observe(approval: ApprovalRequest): Promise<void> {
    if (approval.decision) { await this.settle(approval); return; }
    if (!this.known.has(approval.id)) {                               // a teammate's agent asking: tell this window too
      this.known.add(approval.id);
      // A teammate's approval is not ours to wait on: a broken surface is logged, never thrown at the store subscription.
      try { this.announce(approval); this.emitChange(approval); } catch (e) { this.deps.log?.(`could not announce approval ${approval.id}: ${e instanceof Error ? e.message : "unknown error"}`); }
    }
  }

  /** `nexus.approve` / `nexus.reject`: act on one approval, or on the newest undecided one when no id is given. */
  async decideFromCommand(decision: Decision, approvalId?: string): Promise<{ approval: ApprovalRequest; won: boolean } | undefined> {
    let id = approvalId;
    if (!id) {
      const waiting = await this.list({ pendingOnly: true });
      if (waiting.length === 0) return undefined;
      // With several waiting, a keypress could approve something the user never looked at: make them pick.
      if (waiting.length > 1) throw new Error(`${waiting.length} approvals are waiting; choose one in the approvals view.`);
      id = waiting[0].id;
    }
    return this.resolve(id, decision, { via: "app", userId: this.deps.identity() });
  }

  // ---- reading ----

  async list(filter: { sessionId?: string; pendingOnly?: boolean } = {}): Promise<ApprovalRequest[]> {
    const all = (await this.deps.store.listApprovals())
      .filter(a => (!filter.sessionId || a.sessionId === filter.sessionId) && (!filter.pendingOnly || (!a.decision && !this.dead.has(a.id))));
    let shown = all;
    if (filter.pendingOnly) {
      // An undecided approval of a session that already ended can never be decided (decisions are refused), so it is not "waiting".
      const live = new Map<string, boolean>();
      for (const id of new Set(all.map(a => a.sessionId))) {
        const s = this.ended.has(id) ? undefined : await this.deps.store.getSession(id);
        live.set(id, !!s && !["done", "failed", "cancelled"].includes(s.status));
      }
      shown = all.filter(a => live.get(a.sessionId));
    }
    return shown.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  get(approvalId: string): Promise<ApprovalRequest | undefined> {
    return this.deps.store.getApproval(approvalId);
  }

  /** approvals.subscribe: every create and resolve, from any machine. */
  subscribe(cb: (a: ApprovalRequest) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  // ---- internals ----

  private announce(approval: ApprovalRequest): void {
    this.deps.notify.show(approval, `Agent wants to ${describeAction(approval.action)}: ${approval.reason} (model-written)`, decision => {
      this.resolve(approval.id, decision, { via: "app", userId: this.deps.identity() }).catch(e => this.deps.log?.(`could not record the decision: ${e instanceof Error ? e.message : "unknown error"}`));
    });
  }

  private emitChange(approval: ApprovalRequest): void {
    for (const cb of this.listeners) cb(approval);
  }

  /** Runs once per decided approval on every machine; on the owning machine it also wakes the agent. */
  private async settle(approval: ApprovalRequest): Promise<void> {
    const decision = approval.decision;
    if (!decision) return;
    if (this.creating.has(approval.id)) { this.creating.set(approval.id, approval); return; }
    if (this.dead.has(approval.id)) {                                 // a click that was already in flight when the request failed
      this.deps.log?.(`approval ${approval.id} decided after the request failed; nothing was woken`);
      return;
    }
    const sessionId = this.pending.get(approval.id);
    if (sessionId !== undefined) this.pending.delete(approval.id);
    try {
      // A throwing UI surface must neither skip the agent's wake-up nor the rest of the bookkeeping.
      const who = approval.decidedBy ? `${approval.decidedBy.userId} via ${approval.decidedBy.via.replace("_", " ")}` : "a teammate";
      try { this.deps.notify.update(approval.id, `Decided by ${who}: ${decision}`); } catch (e) { this.deps.log?.(`could not update the notification: ${e instanceof Error ? e.message : "unknown error"}`); }
      try { this.emitChange(approval); } catch (e) { this.deps.log?.(`an approval subscriber failed: ${e instanceof Error ? e.message : "unknown error"}`); }
      if (sessionId === undefined) return;                            // not ours: nothing to wake
      // Each step stands alone: a failed event write must not leave the session showing "awaiting_approval" or skip waking the host.
      await this.attempt("record the approval decision", () => this.deps.sessions.emit(sessionId, { type: "approval_resolved", approvalId: approval.id, decision }));
      // The session reads "running" again before the agent is woken, so no surface shows a working agent as waiting.
      if (![...this.pending.values()].includes(sessionId)) await this.attempt("restore the session status", () => this.deps.sessions.setStatus(sessionId, "running"));
      this.deps.host.sendEvent("approval.resolved", { approvalId: approval.id, decision });
    } catch (e) {
      // A store hiccup must never leave the agent waiting on a decision a human already made.
      this.deps.log?.(`could not record the approval decision: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      if (sessionId !== undefined) this.wake(approval.id, decision);
    }
  }

  /** The request failed and nothing waits on it: no decision may ever be written, its notification says so, the session stops showing "awaiting". */
  private async markDead(approval: ApprovalRequest): Promise<void> {
    this.pending.delete(approval.id);
    this.dead.set(approval.id, approval);
    try { this.deps.notify.update(approval.id, "The request could not be completed; there is nothing to approve."); } catch (err) { this.deps.log?.(`could not update the notification: ${err instanceof Error ? err.message : "unknown error"}`); }
    if (!this.ended.has(approval.sessionId) && ![...this.pending.values()].includes(approval.sessionId)) await this.attempt("restore the session status", () => this.deps.sessions.setStatus(approval.sessionId, "running"));
  }

  private async attempt(what: string, fn: () => Promise<unknown>): Promise<void> {
    try { await fn(); } catch (e) { this.deps.log?.(`could not ${what}: ${e instanceof Error ? e.message : "unknown error"}`); }
  }

  private wake(approvalId: string, decision: Decision): void {
    for (const w of this.waiters.get(approvalId) ?? []) w(decision);
    this.waiters.delete(approvalId);
  }

  /**
   * The session is over. If a human cancelled it, what was waiting counts as their "no" (recorded under their name);
   * for any other ending the waiting gate is released as rejected, locally, without writing a decision. Either way the
   * approvals can no longer be decided afterwards.
   */
  async sessionEnded(sessionId: string, how: "cancelled" | "failed" | "done"): Promise<void> {
    const waiting = [...this.pending].filter(([, s]) => s === sessionId).map(([id]) => id);
    if (how === "cancelled") {
      for (const id of waiting) {
        await this.resolve(id, "rejected", { via: "app", userId: this.deps.identity() }).catch(e => this.deps.log?.(`could not record the cancel: ${e instanceof Error ? e.message : "unknown error"}`));
      }
    }
    this.ended.add(sessionId);
    for (const id of waiting) {
      if (!this.pending.has(id)) continue;                            // already settled above
      this.pending.delete(id);
      // A throwing notification must never keep the gate waiting.
      try { this.deps.notify.update(id, "The session ended; there is nothing to approve."); } catch (e) { this.deps.log?.(`could not update the notification: ${e instanceof Error ? e.message : "unknown error"}`); } finally { this.wake(id, "rejected"); }
    }
  }
}

/** The webview-protocol handlers this controller serves; Lane 2's bridge router registers them by name. */
export function approvalsBridgeHandlers(c: ApprovalsController, identity: () => string) {
  return {
    "approvals.list": async (r: Req<"approvals.list">): Promise<Res<"approvals.list">> => c.list({ sessionId: r.sessionId, pendingOnly: r.pendingOnly }),
    "approvals.resolve": async (r: Req<"approvals.resolve">): Promise<Res<"approvals.resolve">> => {
      const res = await c.resolve(r.approvalId, r.decision, { via: "app", userId: identity() });
      if (!res.won) {
        if (!res.approval.decision) throw new Error("This approval is no longer pending.");   // refused, not lost: nobody decided it
        throw new ApprovalConflict(res.approval);                        // the router maps this to error code "conflict" with the winner
      }
      return res.approval;
    },
  };
}
