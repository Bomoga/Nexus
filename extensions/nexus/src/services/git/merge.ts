// Merging an agent branch into the user's current branch (PLAN 5.2 L2-06). The only write to the user's checkout.
// Never pushes. A conflict aborts the merge and leaves the checkout exactly as it was.
import { agentBranch, humanIdentity } from "./worktrees";
import type { GitContext } from "./worktrees";
import type { MergeResult } from "./types";

export async function mergeAgentBranch(ctx: GitContext, sessionId: string): Promise<MergeResult> {
  const branch = agentBranch(sessionId);
  const git = (args: string[], allowExit?: number[]) => ctx.run(ctx.repoRoot, args, allowExit ? { allowExit } : {});
  const exists = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}^{commit}`], [1]);
  if (exists.code !== 0) return { ok: false, message: `branch ${branch} does not exist` };
  const head = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], [1])).stdout.trim();
  if (!head) return { ok: false, message: "the checkout is on a detached HEAD; switch to a branch before merging" };
  if ((await git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], [1])).code === 0) return { ok: false, message: "a merge is already in progress in your checkout" };
  if ((await git(["status", "--porcelain=v1", "--untracked-files=no"])).stdout.length > 0) {
    return { ok: false, message: "your checkout has uncommitted changes; commit or stash them before merging" };
  }
  try { await humanIdentity(ctx); } catch (e) { return { ok: false, message: (e as Error).message }; }
  if ((await git(["merge-base", "--is-ancestor", `refs/heads/${branch}`, "HEAD"], [1])).code === 0) {
    const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
    return { ok: true, mergeSha: sha, message: `${branch} is already merged into ${head}` };
  }
  let failure: string | undefined;
  try {
    const r = await git(["-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-edit", "-m", `Merge ${branch} into ${head}`, `refs/heads/${branch}`], [1]);
    if (r.code !== 0) {
      const files = (await git(["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
      failure = files.length ? `merge conflicts in ${files.slice(0, 10).join(", ")}${files.length > 10 ? ` and ${files.length - 10} more` : ""}` : "the merge did not complete";
    }
  } catch (e) {
    failure = (e as Error).message;
  }
  if (failure !== undefined) {
    if ((await git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], [1])).code === 0) await git(["merge", "--abort"], [1]);
    return { ok: false, message: `${failure}; the merge was aborted and your checkout is unchanged` };
  }
  const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  return { ok: true, mergeSha: sha, message: `merged ${branch} into ${head}` };
}
