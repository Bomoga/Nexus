// "Nexus: Merge agent branch": pick a done session, confirm, merge its branch (git.mergeAgentBranch). A human action:
// agents propose, humans dispose. Dependencies are injected; src/register/lane-3.ts supplies the real ones.
import type { AgentSession } from "../../contracts";
import type { Request } from "./open-commit";

export interface SessionPickItem {
  label: string;
  description: string;
  detail?: string;
  sessionId: string;
}

export interface MergeDeps {
  request: Request;
  showQuickPick(items: SessionPickItem[], options: { placeHolder: string }): Promise<SessionPickItem | undefined>;
  /** Resolves true only when the human chose the MERGE button. */
  confirm(message: string): Promise<boolean>;
  showInfo(message: string): void;
  showError(message: string): void;
}

const short = (id: string): string => id.slice(0, 7);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function mergeAgentBranch(deps: MergeDeps, sessionId?: string): Promise<void> {
  try {
    const sessions: AgentSession[] = (await deps.request("sessions.list", { status: "done" })).filter(s => s.status === "done");
    let chosen: AgentSession | undefined;
    if (sessionId !== undefined) {
      chosen = sessions.find(s => s.id === sessionId);
      if (!chosen) { deps.showError(`Nexus: no finished agent session ${sessionId}.`); return; }
    } else {
      if (sessions.length === 0) { deps.showInfo("Nexus: no finished agent sessions to merge."); return; }
      const picked = await deps.showQuickPick(
        sessions.map(s => ({ label: s.branch, description: `${s.model.modelId} · ${short(s.id)}`, detail: s.endedAt, sessionId: s.id })),
        { placeHolder: "Merge which agent branch?" },
      );
      if (!picked) return;
      chosen = sessions.find(s => s.id === picked.sessionId);
      if (!chosen) return;
    }
    if (!(await deps.confirm(`Merge ${chosen.branch} into the current branch?`))) return;
    const res = await deps.request("git.mergeAgentBranch", { sessionId: chosen.id });
    if (res.ok) deps.showInfo(`Nexus: merged as ${short(res.mergeSha ?? "")}`.trimEnd());
    else deps.showError(`Nexus: ${res.message}`);
  } catch (e) {
    deps.showError(`Nexus: could not merge agent branch: ${messageOf(e)}`);
  }
}
