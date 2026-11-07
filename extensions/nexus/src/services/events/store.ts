// The EventStore port: everything the bridge, controllers and watcher read and write.
// Implemented by LocalStore (JSONL + outbox) and, later, the Tiger-backed store; faked by fake-store.ts.
import type {
  AgentEvent, AgentSession, ApprovalRequest, DecidedBy, EventQuery, EventSearchHit, ModelCallReceipt,
  NexusEvent, SwarmReview, Task, TaskPlan,
} from "../../contracts";

export type Unsubscribe = () => void;

/** Result of a conditional decision: `won` is true only for the call that actually set it. */
export interface DecideResult { approval: ApprovalRequest; won: boolean }

/** Mirrors the `store.status` response in the protocol. */
export interface StoreStatus { online: boolean; outboxDepth: number; lastSyncAt?: string }

export interface EventStore {
  putTask(task: Task): Promise<void>;
  getTask(id: string): Promise<Task | undefined>;
  listTasks(): Promise<Task[]>;

  putSession(session: AgentSession): Promise<void>;
  getSession(id: string): Promise<AgentSession | undefined>;
  listSessions(): Promise<AgentSession[]>;

  appendAgentEvent(event: AgentEvent): Promise<void>;
  agentEvents(sessionId: string, fromSeq: number): Promise<AgentEvent[]>;

  putApproval(approval: ApprovalRequest): Promise<void>;
  getApproval(id: string): Promise<ApprovalRequest | undefined>;
  listApprovals(): Promise<ApprovalRequest[]>;
  /** Conditional: sets the decision only while undecided; the first answer wins. */
  decideApproval(id: string, decision: "approved" | "rejected", decidedBy: DecidedBy, at: string): Promise<DecideResult>;

  putNexusEvent(event: NexusEvent): Promise<void>;

  putReview(review: SwarmReview): Promise<void>;
  /** The latest review for an approval. */
  getReviewForApproval(approvalId: string): Promise<SwarmReview | undefined>;

  putReceipt(receipt: ModelCallReceipt): Promise<void>;
  /** Oldest first. */
  listReceipts(sessionId?: string): Promise<ModelCallReceipt[]>;

  putPlan(plan: TaskPlan): Promise<void>;
  getPlan(id: string): Promise<TaskPlan | undefined>;

  // ---- read side for the bridge ----
  queryEvents(query: EventQuery): Promise<NexusEvent[]>;
  searchEvents(text: string, limit: number): Promise<EventSearchHit[]>;
  subscribeEvents(listener: (event: NexusEvent) => void): Unsubscribe;
  /** Fires on every approval create and decision. */
  subscribeApprovals(listener: (approval: ApprovalRequest) => void): Unsubscribe;
  status(): Promise<StoreStatus>;
}
