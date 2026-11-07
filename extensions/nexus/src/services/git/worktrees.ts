// Session worktrees and gated commits (PLAN 5.2 L2-06). An agent session works in its own worktree under `sessionsDir`
// (never inside the user's checkout) on its own branch nexus/agent-<id>. Everything goes through GitCli's hardened runner.
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { assertRelativePath } from "./git-cli";
import type { FullSha, SessionWorktree } from "./types";

const SHA_RE = /^[0-9a-f]{40}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const ADD_CHUNK = 200;

export interface RunResult { stdout: string; code: number }

/** What the write half needs from GitCli: a git runner with a working directory, and the configured directories. */
export interface GitContext {
  repoRoot: string;
  sessionsDir: string | undefined;
  run(cwd: string, args: string[], options?: { allowExit?: number[] }): Promise<RunResult>;
}

/** Throws unless `id` is a safe session id. */
export function assertSessionId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > 128 || !SESSION_ID_RE.test(id)) throw new Error("invalid session id: use letters, digits, '_' and '-'");
}

export function agentBranch(sessionId: string): string {
  assertSessionId(sessionId);
  return `nexus/agent-${sessionId}`;
}

function real(p: string): string {
  return realpathSync.native(p);
}

/** The sessions directory, created if needed; refused if it lies inside the user's checkout. */
async function sessionsRoot(ctx: GitContext): Promise<string> {
  if (!ctx.sessionsDir) throw new Error("session worktrees are not configured: no sessions directory");
  await mkdir(ctx.sessionsDir, { recursive: true });
  const dir = real(ctx.sessionsDir);
  const repo = real(ctx.repoRoot);
  const rel = path.relative(repo, dir);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new Error("the sessions directory must be outside the user's checkout");
  return dir;
}

/** Resolves `worktreePath` to a real worktree root that is a direct child of the sessions directory, or throws. */
async function ownedWorktree(ctx: GitContext, worktreePath: string): Promise<{ dir: string; sessionId: string }> {
  if (typeof worktreePath !== "string" || worktreePath.includes("\0")) throw new Error("invalid worktree path");
  const root = await sessionsRoot(ctx);
  let dir: string;
  try { dir = real(worktreePath); } catch { throw new Error("worktree path does not exist"); }
  if (path.dirname(dir) !== root) throw new Error("refused: the path is not a session worktree under the sessions directory");
  const sessionId = path.basename(dir);
  assertSessionId(sessionId);
  const top = (await ctx.run(dir, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (real(top) !== dir) throw new Error("refused: the path is not the root of a git worktree");
  return { dir, sessionId };
}

export async function createSessionWorktree(ctx: GitContext, input: { sessionId: string; workspaceId: string }): Promise<SessionWorktree> {
  const branch = agentBranch(input.sessionId);
  const root = await sessionsRoot(ctx);
  const head = await ctx.run(ctx.repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowExit: [1] });
  const baseBranch = head.stdout.trim();
  if (head.code !== 0 || !baseBranch) throw new Error("refused: the checkout is on a detached HEAD; switch to a branch first");
  const sha = (await ctx.run(ctx.repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"], { allowExit: [1] })).stdout.trim();
  if (!SHA_RE.test(sha)) throw new Error("refused: the repository has no commits");
  const worktreePath = path.join(root, input.sessionId);
  await ctx.run(ctx.repoRoot, ["worktree", "add", "-b", branch, worktreePath, sha]);
  return { branch, worktreePath, baseCommit: sha, baseBranch };
}

export async function removeSessionWorktree(ctx: GitContext, sessionId: string): Promise<void> {
  const branch = agentBranch(sessionId);
  const root = await sessionsRoot(ctx);
  const dir = path.join(root, sessionId);
  const listed = (await ctx.run(ctx.repoRoot, ["worktree", "list", "--porcelain"])).stdout.split("\n");
  if (listed.some(l => l.startsWith("worktree ") && path.resolve(l.slice(9)) === dir)) {
    await ctx.run(ctx.repoRoot, ["worktree", "remove", "--force", dir]);
  } else {
    await ctx.run(ctx.repoRoot, ["worktree", "prune"]);
  }
  const exists = await ctx.run(ctx.repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}`], { allowExit: [1] });
  if (exists.code !== 0) return;
  // Keep the branch if it holds any commit that no other ref can reach (the agent's unmerged work).
  const ahead = await ctx.run(ctx.repoRoot, ["rev-list", "--count", `refs/heads/${branch}`, "--not", `--exclude=refs/heads/${branch}`, "--all"]);
  if (ahead.stdout.trim() === "0") await ctx.run(ctx.repoRoot, ["branch", "-D", branch]);
}

export async function diff(ctx: GitContext, worktreePath: string, baseCommit: FullSha, paths?: string[]): Promise<string> {
  if (typeof baseCommit !== "string" || !SHA_RE.test(baseCommit)) throw new Error("invalid commit sha: expected 40 lowercase hex characters");
  for (const p of paths ?? []) assertRelativePath(p);
  const { dir } = await ownedWorktree(ctx, worktreePath);
  // Intent-to-add makes untracked files show up as new files in the diff (and later in the commit's `add -A`).
  const untracked = (await ctx.run(dir, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
  for (let i = 0; i < untracked.length; i += ADD_CHUNK) await ctx.run(dir, ["add", "-N", "--", ...untracked.slice(i, i + ADD_CHUNK)]);
  const out = await ctx.run(dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", baseCommit, "--", ...(paths ?? [])]);
  return out.stdout;
}

export async function commitIn(ctx: GitContext, worktreePath: string, message: string, sessionId: string): Promise<FullSha> {
  const branch = agentBranch(sessionId);
  if (typeof message !== "string" || message.includes("\0") || message.trim().length === 0) throw new Error("invalid commit message");
  const { dir, sessionId: dirId } = await ownedWorktree(ctx, worktreePath);
  if (dirId !== sessionId) throw new Error("refused: the worktree belongs to a different session");
  const current = (await ctx.run(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowExit: [1] })).stdout.trim();
  if (current !== branch) throw new Error(`refused: the worktree is not on ${branch}`);
  const identity = await humanIdentity(ctx);
  await ctx.run(dir, ["add", "-A"]);
  await ctx.run(dir, ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "-c", "commit.gpgsign=false",
    "commit", "-m", message.trim(), "-m", `Nexus-Agent: ${sessionId}`]);
  const sha = (await ctx.run(dir, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
  if (!SHA_RE.test(sha)) throw new Error("unexpected git output after commit");
  return sha;
}

/** The human's git identity from the user's repo config; refused clearly if unset. */
export async function humanIdentity(ctx: GitContext): Promise<{ name: string; email: string }> {
  const get = async (key: string) => (await ctx.run(ctx.repoRoot, ["config", "--get", key], { allowExit: [1] })).stdout.trim();
  const name = await get("user.name");
  const email = await get("user.email");
  if (!name || !email) throw new Error("refused: git user.name and user.email are not set in the repository; set them so commits carry your identity");
  return { name, email };
}
