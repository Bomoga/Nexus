// Session worktrees and gated commits (PLAN 5.2 L2-06). An agent session works in its own worktree under `sessionsDir`
// (never inside the user's checkout) on its own branch nexus/agent-<id>. Everything goes through GitCli's hardened runner.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertRelativePath } from "./git-cli";
import type { FullSha, SessionWorktree } from "./types";

const SHA_RE = /^[0-9a-f]{40}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const BASE_FILE = "nexus-base";

export interface RunResult { stdout: string; stderr: string; code: number }
export interface RunOptions { allowExit?: number[]; env?: Record<string, string> }

/** What the write half needs from GitCli: a git runner with a working directory, and the configured directories. */
export interface GitContext {
  repoRoot: string;
  sessionsDir: string | undefined;
  run(cwd: string, args: string[], options?: RunOptions): Promise<RunResult>;
}

/** Throws unless `id` is a safe session id. */
export function assertSessionId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > 128 || !SESSION_ID_RE.test(id)) throw new Error("invalid session id: use letters, digits, '_' and '-'");
}

/**
 * The session's branch name. Refuses when another branch under nexus/ differs from it only by case: on a case-insensitive
 * file system those would be the same ref, and one session could act on another's branch.
 */
export async function resolveAgentBranch(ctx: GitContext, sessionId: string): Promise<{ branch: string; exists: boolean }> {
  assertSessionId(sessionId);
  const branch = `nexus/agent-${sessionId}`;
  const names = (await ctx.run(ctx.repoRoot, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/nexus/"])).stdout.split("\n").filter(Boolean);
  const lower = branch.toLowerCase();
  if (names.some(n => n !== branch && n.toLowerCase() === lower)) throw new Error(`refused: another branch differs from ${branch} only by letter case`);
  return { branch, exists: names.includes(branch) };
}

function real(p: string): string {
  return realpathSync.native(p);
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The sessions directory, created if needed; refused if it lies inside the user's checkout or contains it. */
async function sessionsRoot(ctx: GitContext): Promise<string> {
  if (!ctx.sessionsDir) throw new Error("session worktrees are not configured: no sessions directory");
  await mkdir(ctx.sessionsDir, { recursive: true });
  const dir = real(ctx.sessionsDir);
  const repo = real(ctx.repoRoot);
  if (inside(repo, dir)) throw new Error("the sessions directory must be outside the user's checkout");
  if (inside(dir, repo)) throw new Error("the sessions directory must not contain the user's checkout");
  return dir;
}

async function commonDir(ctx: GitContext, cwd: string): Promise<string> {
  return real((await ctx.run(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim());
}

/** Resolves `worktreePath` to a real linked worktree of this repository that is a direct child of the sessions directory, or throws. */
async function ownedWorktree(ctx: GitContext, worktreePath: string): Promise<{ dir: string; sessionId: string; gitDir: string }> {
  if (typeof worktreePath !== "string" || worktreePath.includes("\0")) throw new Error("invalid worktree path");
  const root = await sessionsRoot(ctx);
  let dir: string;
  try { dir = real(worktreePath); } catch { throw new Error("worktree path does not exist"); }
  if (path.dirname(dir) !== root) throw new Error("refused: the path is not a session worktree under the sessions directory");
  const sessionId = path.basename(dir);
  assertSessionId(sessionId);
  const top = (await ctx.run(dir, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (real(top) !== dir) throw new Error("refused: the path is not the root of a git worktree");
  // The worktree's .git file is writable by the agent: it must still point at a linked worktree of this very repository.
  const common = await commonDir(ctx, ctx.repoRoot);
  const gitDir = real((await ctx.run(dir, ["rev-parse", "--absolute-git-dir"])).stdout.trim());
  if (await commonDir(ctx, dir) !== common || path.dirname(gitDir) !== path.join(common, "worktrees")) {
    throw new Error("refused: the worktree does not belong to this repository");
  }
  // ...and at its OWN entry: git's back-link from the entry to this directory's .git, so a .git file pointing at another
  // session's entry is refused.
  let back: string;
  try { back = readFileSync(path.join(gitDir, "gitdir"), "utf8").trim(); } catch { throw new Error("refused: the worktree's git entry has no back-link"); }
  if (real(path.dirname(back)) !== dir) throw new Error("refused: the worktree's .git points at another worktree's entry");
  return { dir, sessionId, gitDir };
}

export async function createSessionWorktree(ctx: GitContext, input: { sessionId: string; workspaceId: string }): Promise<SessionWorktree> {
  const { branch } = await resolveAgentBranch(ctx, input.sessionId);
  const root = await sessionsRoot(ctx);
  const head = await ctx.run(ctx.repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowExit: [1] });
  const baseBranch = head.stdout.trim();
  if (head.code !== 0 || !baseBranch) throw new Error("refused: the checkout is on a detached HEAD; switch to a branch first");
  const sha = (await ctx.run(ctx.repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"], { allowExit: [1] })).stdout.trim();
  if (!SHA_RE.test(sha)) throw new Error("refused: the repository has no commits");
  const worktreePath = path.join(root, input.sessionId);
  await ctx.run(ctx.repoRoot, ["worktree", "add", "-b", branch, worktreePath, sha]);
  // The base lives in the worktree's private git directory, which the agent cannot reach through the gate.
  const gitDir = (await ctx.run(worktreePath, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  writeFileSync(path.join(gitDir, BASE_FILE), `${sha}\n`);
  return { branch, worktreePath, baseCommit: sha, baseBranch };
}

export async function removeSessionWorktree(ctx: GitContext, sessionId: string): Promise<void> {
  const { branch, exists } = await resolveAgentBranch(ctx, sessionId);
  const root = await sessionsRoot(ctx);
  const dir = path.join(root, sessionId);
  const listed = (await ctx.run(ctx.repoRoot, ["worktree", "list", "--porcelain"])).stdout.split("\n");
  if (listed.some(l => l.startsWith("worktree ") && path.resolve(l.slice(9)) === dir)) {
    await ctx.run(ctx.repoRoot, ["worktree", "remove", "--force", dir]);
  } else {
    await ctx.run(ctx.repoRoot, ["worktree", "prune"]);
  }
  if (!exists) return;
  // Keep the branch if it holds any commit that no other ref can reach (the agent's unmerged work).
  const ahead = await ctx.run(ctx.repoRoot, ["rev-list", "--count", `refs/heads/${branch}`, "--not", `--exclude=refs/heads/${branch}`, "--all"]);
  if (ahead.stdout.trim() === "0") await ctx.run(ctx.repoRoot, ["branch", "-D", branch]);
}

// --ignore-submodules=none and --submodule=short: a gitlink always shows, with its full id, whatever .gitmodules or the
// user's diff config says, so a submodule can never reach a commit without appearing in the approved diff.
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--full-index", "--binary", "--ignore-submodules=none", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * Stages the worktree's contents into a temporary index that starts from the branch's HEAD tree, so nothing touches the
 * worktree's own index, and hands that index to `fn`. Objects are written as they are staged: later writes to the
 * worktree cannot change what `fn` sees.
 */
async function withStagedIndex<T>(ctx: GitContext, dir: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const tmp = mkdtempSync(path.join(tmpdir(), "nexus-index-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    await ctx.run(dir, ["read-tree", "HEAD"], { env });
    await ctx.run(dir, ["add", "-A"], { env });
    return await fn(env);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function stagedDiff(ctx: GitContext, dir: string, env: Record<string, string>, baseCommit: FullSha, paths: string[] = []): Promise<string> {
  return ctx.run(dir, ["diff", "--cached", ...DIFF_FLAGS, baseCommit, "--", ...paths], { env }).then(r => r.stdout);
}

function assertSha(sha: string): void {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new Error("invalid commit sha: expected 40 lowercase hex characters");
}

/** The unified diff of everything in the worktree (untracked files included) against `baseCommit`. Full object ids and binary patches, so any content change changes the text. */
export async function diff(ctx: GitContext, worktreePath: string, baseCommit: FullSha, paths?: string[]): Promise<string> {
  assertSha(baseCommit);
  for (const p of paths ?? []) assertRelativePath(p);
  const { dir } = await ownedWorktree(ctx, worktreePath);
  return withStagedIndex(ctx, dir, env => stagedDiff(ctx, dir, env, baseCommit, paths));
}

/** Paths whose patch in `diffText` is a binary patch, so a reviewer can be told which changes they cannot read. */
export function binaryPathsInDiff(diffText: string): string[] {
  const out: string[] = [];
  let current: string | undefined;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const rest = line.slice("diff --git ".length);
      const half = (rest.length - 5) / 2;   // "a/<p> b/<p>": the diff is run with --no-renames, so both sides are the same path
      current = rest.startsWith("a/") && Number.isInteger(half) && half > 0 ? rest.slice(2, 2 + half) : rest;
    } else if (current !== undefined && (line === "GIT binary patch" || line.startsWith("Binary files "))) {
      out.push(current);
      current = undefined;
    }
  }
  return out;
}

const SCISSORS = /^.*-{3,}\s*>8\s*-{3,}.*$/m;

export async function commitIn(ctx: GitContext, worktreePath: string, message: string, sessionId: string, approvedDiff: string): Promise<FullSha> {
  const { branch } = await resolveAgentBranch(ctx, sessionId);
  if (typeof message !== "string" || message.includes("\0") || message.trim().length === 0) throw new Error("invalid commit message");
  // git's trailer parser stops at a scissors line, so a model-written message could forge the Nexus-Agent trailer or hide it.
  if (SCISSORS.test(message)) throw new Error("refused: the commit message contains a scissors line");
  if (typeof approvedDiff !== "string") throw new Error("invalid approved diff");
  const { dir, sessionId: dirId, gitDir } = await ownedWorktree(ctx, worktreePath);
  if (dirId !== sessionId) throw new Error("refused: the worktree belongs to a different session");
  const current = (await ctx.run(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowExit: [1] })).stdout.trim();
  if (current !== branch) throw new Error(`refused: the worktree is not on ${branch}`);
  const identity = await humanIdentity(ctx);
  const oldHead = (await ctx.run(dir, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
  let baseCommit: string;
  try { baseCommit = readFileSync(path.join(gitDir, BASE_FILE), "utf8").trim(); } catch { throw new Error("refused: the session's base commit is unknown"); }
  assertSha(baseCommit);
  if ((await ctx.run(dir, ["merge-base", "--is-ancestor", baseCommit, oldHead], { allowExit: [1] })).code !== 0) throw new Error("refused: the session branch does not descend from its base commit");

  const { tree, headTree } = await withStagedIndex(ctx, dir, async env => {
    if (await stagedDiff(ctx, dir, env, baseCommit) !== approvedDiff) throw new Error("refused: the staged changes differ from the diff the human approved");
    return {
      tree: (await ctx.run(dir, ["write-tree"], { env })).stdout.trim(),
      headTree: (await ctx.run(dir, ["rev-parse", "--verify", "HEAD^{tree}"])).stdout.trim(),
    };
  });
  if (!SHA_RE.test(tree)) throw new Error("unexpected git output after write-tree");
  if (tree === headTree) throw new Error("nothing to commit");
  const sha = (await ctx.run(dir, ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`,
    "commit-tree", tree, "-p", oldHead, "-m", message.trim(), "-m", `Nexus-Agent: ${sessionId}`])).stdout.trim();
  if (!SHA_RE.test(sha)) throw new Error("unexpected git output after commit-tree");
  await ctx.run(dir, ["update-ref", "-m", `commit: ${message.trim().split("\n")[0].slice(0, 100)}`, `refs/heads/${branch}`, sha, oldHead]);
  // Bring the worktree's own index in line with the new HEAD; the files themselves are not touched.
  await ctx.run(dir, ["reset", "-q"], { allowExit: [1] }).catch(() => undefined);
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
