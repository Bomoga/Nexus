import { describeAction } from "./approvals/approvals-controller";
import type { Lane1 } from "./compose";

// The palette commands Lane 1 owns (COMMAND_OWNER in contracts/commands.ts). vscode-free: the register file binds these to
// vscode.commands and supplies the UI. Arguments come from Lane 3's views (a thread, an approval card); without one the
// command falls back to the obvious target or says what it needs.

export interface CommandUi {
  info(message: string): void;
  error(message: string): void;
  /** Lets the person choose one of several waiting approvals; undefined when they dismiss it. */
  pickApproval(items: Array<{ id: string; label: string; detail: string }>): Promise<string | undefined>;
}

const failure = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function lane1Commands(lane: Lane1, ui: CommandUi, identity: () => string) {
  async function decide(approvalId: string | undefined, decision: "approved" | "rejected"): Promise<void> {
    try {
      let id = approvalId;
      if (!id) {
        const pending = await lane.approvals.list({ pendingOnly: true });
        if (pending.length === 0) { ui.info("Nothing is waiting for approval."); return; }
        id = pending.length === 1
          ? pending[0].id
          : await ui.pickApproval(pending.map(a => ({ id: a.id, label: `Agent wants to ${describeAction(a.action)}`, detail: `${a.reason} (model-written)` })));
        if (!id) return;                                         // dismissed: a decision is only ever an explicit click
      }
      const res = await lane.approvals.resolve(id, decision, { via: "app", userId: identity() });
      if (!res.won) ui.info(`Already decided by ${res.approval.decidedBy?.userId ?? "someone"} via ${res.approval.decidedBy?.via ?? "another surface"}.`);
    } catch (e) {
      ui.error(failure(e, "Could not record the decision."));
    }
  }

  return {
    "nexus.approve": (approvalId?: string) => decide(approvalId, "approved"),
    "nexus.reject": (approvalId?: string) => decide(approvalId, "rejected"),

    "nexus.makeTaskFromThread": async (channelId?: string, threadTs?: string) => {
      if (!channelId || !threadTs) { ui.info("Choose \"Make task\" on a thread in the Slack view."); return; }
      try {
        const task = await lane.tasks.createFromThread(channelId, threadTs);
        ui.info(`Created a draft task: ${task.title}`);
      } catch (e) { ui.error(failure(e, "Could not make a task from that thread.")); }
    },

    "nexus.decomposeTask": async (taskId?: string) => {
      if (!taskId) { ui.info("Choose \"Break into subtasks\" on a task."); return; }
      try {
        const plan = await lane.decompose.decompose(taskId);
        ui.info(`A plan with ${plan.subtasks.length} subtasks is ready to review.`);
      } catch (e) { ui.error(failure(e, "Could not break the task into subtasks.")); }
    },

    "nexus.rerunSwarmReview": async (approvalId?: string) => {
      try {
        const review = approvalId ? await lane.review.rerun(approvalId) : await lane.review.rerunLatestPending();
        if (!review) ui.info("No approval is waiting for a review.");
        else ui.info(`Swarm review: ${review.status}.`);
      } catch (e) { ui.error(failure(e, "Could not re-run the swarm review.")); }
    },

    "nexus.toggleOptimizer": async () => {
      try {
        const setting = await lane.optimizer.toggle();
        ui.info(`Optimize with Prune is ${setting.enabled ? "on" : "off"}.`);
      } catch (e) { ui.error(failure(e, "Could not change Optimize with Prune.")); }
    },

    "nexus.cancelSession": async (sessionId?: string) => {
      const id = sessionId ?? lane.sessions.activeSession?.id;
      if (!id) { ui.info("No agent session is running."); return; }
      try { await lane.sessions.cancel(id); ui.info("Agent session cancelled."); }
      catch (e) { ui.error(failure(e, "Could not cancel the session.")); }
    },
  };
}
