import type { ApprovalRequest, DecidedBy } from "../../contracts";
import type { ApprovalHook } from "./approvals-controller";
import type { CibaClient } from "./ciba";

// Phone approvals as an ApprovalHook (PLAN L1-16 wiring). The controller only calls hooks for approvals created on THIS
// machine, so only the requesting machine pushes to the approver's phone. A phone answer is recorded through the
// controller's normal resolve(), so first-answer-wins still applies; no answer (timeout, expiry, error) decides nothing.

export interface CibaHookDeps {
  client: Pick<CibaClient, "requestApproval">;
  /** Auth0 user ID of the person who should confirm; undefined (not signed in, no CIBA) skips the push. */
  approverAuth0UserId(): string | undefined;
  /** The controller's resolve(): conditional write, first human answer wins. */
  resolve(approvalId: string, decision: "approved" | "rejected", decidedBy: DecidedBy): Promise<unknown>;
  log?: (message: string) => void;
}

export function makeCibaHook(deps: CibaHookDeps): ApprovalHook & { cancel(approvalId: string): void } {
  const running = new Map<string, AbortController>();
  return {
    name: "ciba-phone",
    cancel(approvalId) { running.get(approvalId)?.abort(); },
    async onCreated(approval: ApprovalRequest): Promise<void> {
      const approver = deps.approverAuth0UserId();
      if (!approver) return;
      const ctl = new AbortController();
      running.set(approval.id, ctl);
      try {
        const out = await deps.client.requestApproval({ approval, approverAuth0UserId: approver, signal: ctl.signal });
        if (out.status === "no_answer") { deps.log?.(`phone approval for ${approval.id}: no answer (${out.reason})`); return; }
        await deps.resolve(approval.id, out.status, out.decidedBy);
      } catch (e) {
        deps.log?.(`phone approval for ${approval.id} failed: ${e instanceof Error ? e.message : "unknown error"}`);
      } finally {
        running.delete(approval.id);
      }
    },
  };
}
