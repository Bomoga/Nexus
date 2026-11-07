// Merging an agent branch into the user's current branch (PLAN 5.2 L2-06). The only write to the user's checkout.
// Never pushes. A conflict aborts the merge and leaves the checkout exactly as it was.
import { humanIdentity, resolveAgentBranch } from "./worktrees";
import type { GitContext } from "./worktrees";
import type { MergeResult } from "./types";

export async function mergeAgentBranch(ctx: GitContext, sessionId: string): Promise<MergeResult> {
  const { branch, exists } = await resolveAgentBranch(ctx, sessionId);
  const git = (args: string[], allowExit?: number[]) => ctx.run(ctx.repoRoot, args, allowExit ? { allowExit } : {});
  const mergeInProgress = async () => (await git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], [1])).code === 0;
  if (!exists) return { ok: false, message: `branch ${branch} does not exist` };
  const head = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], [1])).stdout.trim();
  if (!head) return { ok: false, message: "the checkout is on a detached HEAD; switch to a branch before merging" };
  if (await mergeInProgress()) return { ok: false, message: "a merge is already in progress in your checkout" };
  if ((await git(["status", "--porcelain=v1", "--untracked-files=no"])).stdout.length > 0) {
    return { ok: false, message: "your checkout has uncommitted changes; commit or stash them before merging" };
  }
  try { await humanIdentity(ctx); } catch (e) { return { ok: false, message: (e as Error).message }; }
  if ((await git(["merge-base", "--is-ancestor", `refs/heads/${branch}`, "HEAD"], [1])).code === 0) {
    const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
    return { ok: true, mergeSha: sha, message: `${branch} is already merged into ${head}` };
  }
  const ignored = await ignoredFilesTheMergeWouldReplace(ctx, branch);
  if (ignored.length) {
    return { ok: false, message: `the merge would overwrite files you ignore in your checkout (${ignored.slice(0, 10).join(", ")}${ignored.length > 10 ? ", ..." : ""}); move them away first` };
  }
  let failure: string | undefined;
  try {
    // --no-overwrite-ignore is passed too, but the ort strategy does not honor it, hence the explicit check above.
    const r = await git(["-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-overwrite-ignore", "--no-edit", "-m", `Merge ${branch} into ${head}`, `refs/heads/${branch}`], [1]);
    if (r.code !== 0) {
      const files = (await git(["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
      failure = files.length
        ? `merge conflicts in ${files.slice(0, 10).join(", ")}${files.length > 10 ? ` and ${files.length - 10} more` : ""}`
        : `the merge did not complete: ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
    }
  } catch (e) {
    failure = (e as Error).message;
  }
  if (failure !== undefined) {
    try {
      if (await mergeInProgress()) await git(["merge", "--abort"]);
    } catch (e) {
      return { ok: false, message: `${failure}; aborting the merge failed, check your checkout: ${(e as Error).message}` };
    }
    return { ok: false, message: `${failure}; the merge was aborted and your checkout is unchanged` };
  }
  const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  return { ok: true, mergeSha: sha, message: `merged ${branch} into ${head}` };
}

/** Paths the branch changed since the merge base that exist in the user's checkout as untracked, ignored files (a .env, say): git would replace them silently. */
async function ignoredFilesTheMergeWouldReplace(ctx: GitContext, branch: string): Promise<string[]> {
  const run = (args: string[]) => ctx.run(ctx.repoRoot, args).then(r => r.stdout);
  const base = (await run(["merge-base", "HEAD", `refs/heads/${branch}`])).trim();
  const touched = (await run(["diff", "--name-only", "-z", "--no-renames", base, `refs/heads/${branch}`, "--"])).split("\0").filter(Boolean);
  const found: string[] = [];
  for (let i = 0; i < touched.length; i += 200) {
    found.push(...(await run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...touched.slice(i, i + 200)])).split("\0").filter(Boolean));
  }
  return found;
}
