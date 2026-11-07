import type { AgentRequestName } from "../contracts";
import type { AgentReqIn, AgentResOut } from "./channel";
import type { Gate } from "./tools";

// In-process stand-in for the host's gate (PLAN L1-09): an in-memory worktree and a scriptable approval queue.
// Used by the runtime tests and by anything that needs an agent loop without the real gate.

export type ApprovalDecision = "approved" | "rejected";

interface PendingApproval {
  id: string;
  kind: string;
  detail: string;
  resolve(decision: ApprovalDecision): void;
}

export interface FakeGateOptions {
  files?: Record<string, string>;
  /** "auto": approvals resolve immediately as approved. "manual": they wait for resolveApproval(). */
  approvals?: "auto" | "manual";
  commitSha?: string;
}

export class FakeGate implements Gate {
  readonly files = new Map<string, string>();
  readonly calls: Array<{ name: AgentRequestName; body: unknown }> = [];
  readonly emitted: Array<{ type: string; payload: unknown }> = [];
  readonly progress: string[] = [];
  readonly credentialCalls: Array<{ provider: string; callId: string }> = [];
  private approvalSeq = 0;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly mode: "auto" | "manual";
  private readonly commitSha: string;

  constructor(opts: FakeGateOptions = {}) {
    for (const [p, c] of Object.entries(opts.files ?? {})) this.files.set(p, c);
    this.mode = opts.approvals ?? "auto";
    this.commitSha = opts.commitSha ?? "9d4e1b7c2a5f8e3d6c0b9a8f7e6d5c4b3a2f1e0d";
  }

  get pendingApprovals(): string[] {
    return [...this.pending.keys()];
  }

  resolveApproval(id: string, decision: ApprovalDecision): void {
    const p = this.pending.get(id);
    if (!p) throw new Error(`no pending approval ${id}`);
    this.pending.delete(id);
    p.resolve(decision);
  }

  private checkPath(path: string): string {
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes("..")) throw new Error(`path outside the session worktree: ${path}`);
    return path.replace(/^\.\//, "");
  }

  private approval(kind: string, detail: string): Promise<{ id: string; decision: ApprovalDecision }> {
    const id = `apr_${++this.approvalSeq}`;
    if (this.mode === "auto") return Promise.resolve({ id, decision: "approved" });
    return new Promise(resolve => this.pending.set(id, { id, kind, detail, resolve: decision => resolve({ id, decision }) }));
  }

  async request<K extends AgentRequestName>(name: K, body: AgentReqIn<K>): Promise<AgentResOut<K>> {
    this.calls.push({ name, body });
    const b = body as Record<string, unknown>;
    const out = await this.handle(name, b);
    return out as AgentResOut<K>;
  }

  private async handle(name: AgentRequestName, b: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "fs.read": {
        const content = this.files.get(this.checkPath(String(b.path)));
        if (content === undefined) throw new Error(`ENOENT: ${String(b.path)}`);
        return { content, truncated: false };
      }
      case "fs.write": {
        this.files.set(this.checkPath(String(b.path)), String(b.content));
        return { bytes: Buffer.byteLength(String(b.content)) };
      }
      case "fs.list": return { entries: [...this.files.keys()].sort() };
      case "cmd.run": {
        const { id, decision } = await this.approval("run_command", String(b.command));
        if (decision === "rejected") throw new Error("rejected by a human");
        return { exitCode: 0, stdoutTail: "Tests  12 passed (12)", stderrTail: "", approvalId: id };
      }
      case "git.diff": return { diff: this.files.size === 0 ? "" : "--- a/src/cart.ts\n+++ b/src/cart.ts\n" };
      case "git.commit": {
        const { id, decision } = await this.approval("commit", String(b.message));
        if (decision === "rejected") throw new Error("rejected by a human");
        return { sha: this.commitSha, approvalId: id };
      }
      case "approval.request": {
        const { id, decision } = await this.approval("other", String(b.description));
        return { approvalId: id, decision };
      }
      case "slack.progress": this.progress.push(String(b.text)); return { ok: true };
      case "credentials.get": {
        this.credentialCalls.push({ provider: String(b.provider), callId: String(b.callId) });
        return { apiKey: `fake-key-${String(b.callId)}` };
      }
      case "event.emit": {
        this.emitted.push({ type: String(b.type), payload: b.payload });
        return { seq: this.emitted.length - 1 };
      }
    }
  }
}
