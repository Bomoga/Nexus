// In-memory EventStore seeded from the contract fixtures. For tests and fixture-first development.
import type {
  AgentEvent, AgentSession, ApprovalRequest, DecidedBy, EventQuery, EventSearchHit, ModelCallReceipt,
  NexusEvent, SwarmReview, Task, TaskPlan,
} from "../../contracts";
import { demoScenario } from "../../contracts/fixtures/scenario";
import { scriptedNexusEvents } from "../../contracts/fixtures/stream";
import type { DecideResult, EventStore, StoreStatus, Unsubscribe } from "./store";

export class FakeEventStore implements EventStore {
  private tasks = new Map<string, Task>();
  private sessions = new Map<string, AgentSession>();
  private agentLog = new Map<string, AgentEvent[]>();
  private approvals = new Map<string, ApprovalRequest>();
  private events = new Map<string, NexusEvent>();
  private reviews: SwarmReview[] = [];
  private receipts: ModelCallReceipt[] = [];
  private plans = new Map<string, TaskPlan>();
  private eventListeners = new Set<(event: NexusEvent) => void>();
  private approvalListeners = new Set<(approval: ApprovalRequest) => void>();

  /** Seeds from the demo scenario; pass `{ seed: false }` for an empty store. */
  constructor(opts: { seed?: boolean } = {}) {
    if (opts.seed === false) return;
    this.tasks.set(demoScenario.task.id, demoScenario.task);
    this.sessions.set(demoScenario.session.id, demoScenario.session);
    this.agentLog.set(demoScenario.session.id, [...demoScenario.agentEvents]);
    for (const a of demoScenario.approvals) this.approvals.set(a.id, a);
    for (const e of scriptedNexusEvents()) this.events.set(e.id, e);
    this.reviews.push(demoScenario.review);
    this.receipts.push(...demoScenario.receipts);
    this.plans.set(demoScenario.plan.id, demoScenario.plan);
  }

  async putTask(task: Task) { this.tasks.set(task.id, task); }
  async getTask(id: string) { return this.tasks.get(id); }
  async listTasks() { return [...this.tasks.values()]; }

  async putSession(session: AgentSession) { this.sessions.set(session.id, session); }
  async getSession(id: string) { return this.sessions.get(id); }
  async listSessions() { return [...this.sessions.values()]; }

  async appendAgentEvent(event: AgentEvent) {
    const log = this.agentLog.get(event.sessionId) ?? [];
    if (log.some(e => e.seq === event.seq)) return;   // same event never stored twice
    log.push(event);
    log.sort((a, b) => a.seq - b.seq);
    this.agentLog.set(event.sessionId, log);
  }
  async agentEvents(sessionId: string, fromSeq: number) {
    return (this.agentLog.get(sessionId) ?? []).filter(e => e.seq >= fromSeq);
  }

  async putApproval(approval: ApprovalRequest) {
    this.approvals.set(approval.id, approval);
    this.emitApproval(approval);
  }
  async getApproval(id: string) { return this.approvals.get(id); }
  async listApprovals() { return [...this.approvals.values()]; }
  async decideApproval(id: string, decision: "approved" | "rejected", decidedBy: DecidedBy, at: string): Promise<DecideResult> {
    const current = this.approvals.get(id);
    if (!current) throw new Error(`unknown approval ${id}`);
    if (current.decision) return { approval: current, won: false };   // first answer wins
    const approval: ApprovalRequest = { ...current, decision, decidedBy, decidedAt: at };
    this.approvals.set(id, approval);
    this.emitApproval(approval);
    return { approval, won: true };
  }

  async putNexusEvent(event: NexusEvent) {
    const isNew = !this.events.has(event.id);
    this.events.set(event.id, event);
    if (isNew) for (const l of [...this.eventListeners]) l(event);
  }

  async putReview(review: SwarmReview) { this.reviews.push(review); }
  async getReviewForApproval(approvalId: string) {
    const mine = this.reviews.filter(r => r.approvalId === approvalId);
    return mine.length ? mine.reduce((a, b) => (b.at >= a.at ? b : a)) : undefined;
  }

  async putReceipt(receipt: ModelCallReceipt) {
    if (this.receipts.some(r => r.callId === receipt.callId)) return;
    this.receipts.push(receipt);
  }
  async listReceipts(sessionId?: string) {
    return this.receipts.filter(r => !sessionId || r.sessionId === sessionId).sort((a, b) => a.at.localeCompare(b.at));
  }

  async putPlan(plan: TaskPlan) { this.plans.set(plan.id, plan); }
  async getPlan(id: string) { return this.plans.get(id); }

  async queryEvents(query: EventQuery) {
    const from = Date.parse(query.from), to = Date.parse(query.to);
    return [...this.events.values()]
      .filter(e => { const t = Date.parse(e.at); return t >= from && t <= to; })
      .filter(e => !query.orbits || query.orbits.includes(e.orbit))
      .filter(e => !query.kinds || query.kinds.includes(e.kind))
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(0, query.limit ?? 2000);
  }

  async searchEvents(text: string, limit: number): Promise<EventSearchHit[]> {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const hits: EventSearchHit[] = [];
    for (const event of this.events.values()) {
      const sha = event.target.type === "commit" ? event.target.sha.toLowerCase() : "";
      let score = 0;
      if (event.title.toLowerCase().includes(q)) score = 3;
      else if (sha.includes(q)) score = 2;
      else if (event.orbit.toLowerCase().includes(q) || event.actor.name.toLowerCase().includes(q)) score = 1;
      if (score) hits.push({ event, score });
    }
    return hits.sort((a, b) => b.score - a.score || b.event.at.localeCompare(a.event.at)).slice(0, limit);
  }

  subscribeEvents(listener: (event: NexusEvent) => void): Unsubscribe {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }
  subscribeApprovals(listener: (approval: ApprovalRequest) => void): Unsubscribe {
    this.approvalListeners.add(listener);
    return () => { this.approvalListeners.delete(listener); };
  }
  async status(): Promise<StoreStatus> { return { online: true, outboxDepth: 0 }; }

  private emitApproval(approval: ApprovalRequest) {
    for (const l of [...this.approvalListeners]) l(approval);
  }
}
