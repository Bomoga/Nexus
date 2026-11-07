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
  private readonly listeners = new Set<(a: ApprovalRequest) => void>();

  constructor(private readonly deps: ApprovalsDeps) {}

  // ---- creating and waiting (the gate's side) ----

  async create(input: { sessionId: string; action: ApprovalAction; reason: string; diffPreview?: string }): Promise<ApprovalRequest> {
    const { store, clock, sessions } = this.deps;
    const approval = ApprovalRequest.parse({
      id: clock.newId("apr"), sessionId: input.sessionId, action: redactAction(input.action),
      reason: redact(input.reason), requestedAt: clock.now(),
      ...(input.diffPreview !== undefined ? { diffPreview: redact(input.diffPreview) } : {}),
    });
    await store.putApproval(approval);
    this.pending.set(approval.id, approval.sessionId);
    this.known.add(approval.id);
    await sessions.emit(approval.sessionId, { type: "approval_request", approvalId: approval.id });
    await sessions.setStatus(approval.sessionId, "awaiting_approval");
    this.announce(approval);
    this.emitChange(approval);
    for (const hook of this.deps.hooks ?? []) {
      // A broken surface must never block the human from deciding on another one.
      hook.onCreated(approval).catch(e => this.deps.log?.(`approval hook ${hook.name} failed: ${e instanceof Error ? e.message : "unknown error"}`));
    }
    return approval;
  }

  /** Resolves when ANY surface or machine decides. There is no timeout path: a silent human leaves it pending. */
  async waitForDecision(approvalId: string): Promise<Decision> {
    const stored = await this.deps.store.getApproval(approvalId);
    if (stored?.decision) return stored.decision;
    return new Promise<Decision>(resolve => {
      const list = this.waiters.get(approvalId) ?? [];
      list.push(resolve);
      this.waiters.set(approvalId, list);
    });
  }

  async request(input: { sessionId: string; action: ApprovalAction; reason: string; diffPreview?: string }): Promise<{ approval: ApprovalRequest; decision: Decision }> {
    const created = await this.create(input);
    const decision = await this.waitForDecision(created.id);
    return { approval: (await this.deps.store.getApproval(created.id)) ?? created, decision };
  }

  // ---- deciding (the humans' side) ----

  /** Sets the decision if nobody has; always returns the stored winner. `won` says whether this call set it. */
  async resolve(approvalId: string, decision: Decision, decidedBy: DecidedBy): Promise<{ approval: ApprovalRequest; won: boolean }> {
    const by = DecidedBy.parse(decidedBy);
    if (by.userId.trim().length === 0) throw new Error("A decision needs the name of the person who made it.");
    if (!(await this.deps.store.getApproval(approvalId))) throw new Error(`No approval ${approvalId}.`);
    const res = await this.deps.store.decideApproval(approvalId, decision, by, this.deps.clock.now());
    await this.settle(res.approval);
    return res;
  }

  /** Called when the shared store reports a change made elsewhere (another machine's click, a Slack button). */
  async observe(approval: ApprovalRequest): Promise<void> {
    if (approval.decision) { await this.settle(approval); return; }
    if (!this.known.has(approval.id)) {                               // a teammate's agent asking: tell this window too
      this.known.add(approval.id);
      this.announce(approval);
      this.emitChange(approval);
    }
  }

  /** `nexus.approve` / `nexus.reject`: act on one approval, or on the newest undecided one when no id is given. */
  async decideFromCommand(decision: Decision, approvalId?: string): Promise<{ approval: ApprovalRequest; won: boolean } | undefined> {
    const id = approvalId ?? (await this.list({ pendingOnly: true })).at(-1)?.id;
    if (!id) return undefined;
    return this.resolve(id, decision, { via: "app", userId: this.deps.identity() });
  }

  // ---- reading ----

  async list(filter: { sessionId?: string; pendingOnly?: boolean } = {}): Promise<ApprovalRequest[]> {
    return (await this.deps.store.listApprovals())
      .filter(a => (!filter.sessionId || a.sessionId === filter.sessionId) && (!filter.pendingOnly || !a.decision))
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
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
    const who = approval.decidedBy ? `${approval.decidedBy.userId} via ${approval.decidedBy.via.replace("_", " ")}` : "a teammate";
    this.deps.notify.update(approval.id, `Decided by ${who}: ${decision}`);
    this.emitChange(approval);
    const sessionId = this.pending.get(approval.id);
    if (sessionId === undefined) return;                              // not ours: nothing to wake
    this.pending.delete(approval.id);
    await this.deps.sessions.emit(sessionId, { type: "approval_resolved", approvalId: approval.id, decision });
    this.deps.host.sendEvent("approval.resolved", { approvalId: approval.id, decision });
    for (const w of this.waiters.get(approval.id) ?? []) w(decision);
    this.waiters.delete(approval.id);
    if (![...this.pending.values()].includes(sessionId)) await this.deps.sessions.setStatus(sessionId, "running");
  }
}

/** The webview-protocol handlers this controller serves; Lane 2's bridge router registers them by name. */
export function approvalsBridgeHandlers(c: ApprovalsController, identity: () => string) {
  return {
    "approvals.list": async (r: Req<"approvals.list">): Promise<Res<"approvals.list">> => c.list({ sessionId: r.sessionId, pendingOnly: r.pendingOnly }),
    "approvals.resolve": async (r: Req<"approvals.resolve">): Promise<Res<"approvals.resolve">> => {
      const res = await c.resolve(r.approvalId, r.decision, { via: "app", userId: identity() });
      if (!res.won) throw new ApprovalConflict(res.approval);          // the router maps this to error code "conflict" with the winner
      return res.approval;
    },
  };
}
