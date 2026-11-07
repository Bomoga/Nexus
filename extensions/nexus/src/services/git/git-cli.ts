// The read half of GitService, over the git CLI (PLAN 5.2 L2-05, L2-06). git is always run with execFile and an argv array,
// never a shell string. Everything that comes from a repository (names, paths, messages) is untrusted: SHAs are
// validated, paths are checked and follow `--`, and output is bounded. The write half is in worktrees.ts and merge.ts.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { emptyGitConfig } from "./empty-config";
import path from "node:path";
import { mergeAgentBranch } from "./merge";
import * as wt from "./worktrees";
import type { RunOptions, RunResult } from "./worktrees";
import type { BranchInfo, CommitDetail, FullSha, GitService, LogEntry, MergeResult, RefInfo, SessionWorktree } from "./types";

const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_LOG_ENTRIES = 20000;
const MAX_FILES = 2000;
const SHA_RE = /^[0-9a-f]{40}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const NUL = "\0";
/** Field separator for ref listings only: git refuses control characters in ref names, so it cannot appear in one. */
const US = "\x1f";

/** Throws unless `sha` is a full 40-char lowercase hex SHA. */
export function assertSha(sha: string): void {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new Error("invalid commit sha: expected 40 lowercase hex characters");
}

/** Throws unless `p` is a repo-relative path: no empty, "." or ".." segment, no NUL, no drive or root prefix. */
export function assertRelativePath(p: string): void {
  if (typeof p !== "string" || p.length === 0) throw new Error("invalid path: empty");
  if (p.includes("\0")) throw new Error("invalid path: contains NUL");
  if (path.posix.isAbsolute(p) || path.win32.isAbsolute(p) || /^[A-Za-z]:/.test(p)) throw new Error("invalid path: must be relative to the repository root");
  if (p.split(/[\\/]/).some(seg => seg === "" || seg === "." || seg === "..")) throw new Error("invalid path: must not contain empty, '.' or '..' segments");
}

function assertRef(ref: string): void {
  if (typeof ref !== "string" || ref.length === 0 || ref.startsWith("-") || ref.includes("..") || ref.includes("@{")
    || [...ref].some(c => c <= " " || c === "\x7f" || "~^:?*[\\".includes(c))) throw new Error("invalid ref name");
}

function isIso(value: string): boolean {
  return typeof value === "string" && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function assertIso(value: string): void {
  if (!isIso(value)) throw new Error("invalid time: expected an ISO 8601 date with an offset");
}

/** The git subcommand in an argv that may start with `-c key=value` pairs, for error messages. */
function subcommand(args: string[]): string {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] ?? "command";
}

/** Optional hooks for the git service. */
export interface GitCliOptions {
  /** Where truncation warnings go. The frozen contract shapes carry no "partial" flag, so partial results are reported here. */
  logger?: { warn(message: string): void };
  /** Ignore the user's and the system's git config (tests). */
  isolatedConfig?: boolean;
  /** Where session worktrees live (production: the extension's global storage). Must be outside the user's checkout; required for the write half. */
  sessionsDir?: string;
}


export class GitCli implements GitService {
  constructor(private readonly repoRoot: string, private readonly options: GitCliOptions = {}) {}

  /** The child environment: every inherited GIT_* override is dropped (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG*, GIT_EXEC_PATH...), then ours is set. */
  private env(extra?: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith("GIT_")) env[k] = v;
    Object.assign(env, { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" });
    if (this.options.isolatedConfig) { const empty = emptyGitConfig(); Object.assign(env, { GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_NOSYSTEM: "1" }); }
    if (extra) Object.assign(env, extra);
    return env;
  }

  private run(args: string[], options: RunOptions = {}): Promise<RunResult> {
    return this.runIn(this.repoRoot, args, options);
  }

  private runIn(cwd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      execFile("git", ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-c", "core.attributesFile=", ...args], {
        cwd,
        maxBuffer: MAX_OUTPUT,
        encoding: "utf8",
        env: this.env(options.env),
      }, (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr: String(stderr), code: 0 });
        const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
        if (options.allowExit?.includes(code)) return resolve({ stdout, stderr: String(stderr), code });
        const detail = String(stderr || error.message).trim().slice(0, 500);
        reject(new Error(`git ${subcommand(args)} failed: ${detail}`));
      });
    });
  }

  /** True if `ref` resolves to a commit. */
  private async resolves(ref: string): Promise<boolean> {
    const { stdout } = await this.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { allowExit: [1] });
    return SHA_RE.test(stdout.trim());
  }

  /**
   * sha1 of the first root commit reachable from HEAD (roots sorted, smallest first, so it is stable). A shallow clone or
   * an orphan checkout has a different root than the full repository and so gets a different id.
   */
  async workspaceId(): Promise<string> {
    if (!await this.resolves("HEAD")) throw new Error("repository has no commits");
    const { stdout } = await this.run(["rev-list", "--max-parents=0", "HEAD"]);
    const roots = stdout.split("\n").filter(l => SHA_RE.test(l)).sort();
    if (!roots.length) throw new Error("repository has no commits");
    return createHash("sha1").update(roots[0]).digest("hex");
  }

  async log(options: { since?: string } = {}): Promise<LogEntry[]> {
    // Fields are NUL-separated and git cannot emit NUL inside commit data, so a forged \x1f, newline or fake date in a
    // subject or author name cannot shift fields: every record is exactly FIELDS fields.
    const FIELDS = 6;
    const args = ["log", "--no-show-signature", ...(await this.resolves("HEAD") ? ["HEAD"] : []), "--branches", "--tags", "--remotes",
      `--max-count=${MAX_LOG_ENTRIES + 1}`, "-z",
      "--format=%H%x00%P%x00%an%x00%cI%x00%s%x00%(trailers:key=Nexus-Agent,valueonly,unfold,separator=%x1e)"];
    let sinceMs = -Infinity;
    if (options.since !== undefined) {
      assertIso(options.since);
      sinceMs = Date.parse(options.since);
      args.push(`--since=${options.since}`);
    }
    args.push("--");
    const { stdout } = await this.run(args);
    const fields = stdout.split(NUL);
    if (fields[fields.length - 1] === "") fields.pop();
    if (fields.length % FIELDS !== 0) throw new Error("unexpected git log output");
    const entries: LogEntry[] = [];
    for (let i = 0; i < fields.length; i += FIELDS) {
      const [sha, parents, authorName, committedAt, subject, trailer] = fields.slice(i, i + FIELDS);
      if (!SHA_RE.test(sha) || !isIso(committedAt)) continue;
      if (Date.parse(committedAt) < sinceMs) continue;
      const entry: LogEntry = { sha, parents: parents.split(" ").filter(p => SHA_RE.test(p)), authorName, committedAt, subject };
      const session = trailer.split("\x1e").map(t => t.trim()).find(t => SESSION_ID_RE.test(t));
      if (session) entry.agentSessionId = session;
      entries.push(entry);
    }
    if (entries.length > MAX_LOG_ENTRIES) {
      this.options.logger?.warn(`git log truncated to ${MAX_LOG_ENTRIES} entries: the result is partial`);
      entries.length = MAX_LOG_ENTRIES;
    }
    return entries.sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt));
  }

  async show(sha: FullSha): Promise<CommitDetail> {
    assertSha(sha);
    // NUL-separated; the body (free text, last) is the sixth field.
    const { stdout } = await this.run(["show", "--no-patch", "--no-show-signature", "--format=%H%x00%P%x00%an%x00%cI%x00%s%x00%b", sha, "--"]);
    const [full, parentsRaw, author, at, subject, ...bodyParts] = stdout.split(NUL);
    if (!SHA_RE.test(full) || !isIso(at) || bodyParts.length !== 1) throw new Error("unexpected git show output");
    const parents = parentsRaw.split(" ").filter(p => SHA_RE.test(p));
    const body = bodyParts[0].replace(/\s+$/, "");
    return { sha: full, subject, body, author, at, parents, files: await this.changedFiles(sha, parents[0]) };
  }

  /** Files changed against the first parent (or the empty tree for a root commit), with line counts. */
  private async changedFiles(sha: FullSha, parent?: FullSha): Promise<CommitDetail["files"]> {
    const base = parent ? [parent, sha] : ["--root", sha];
    const common = ["diff-tree", "-r", "-z", "-M", "--no-commit-id"];
    const [names, nums] = await Promise.all([
      this.run([...common, "--name-status", ...base, "--"]),
      this.run([...common, "--numstat", ...base, "--"]),
    ]);
    const counts = new Map<string, { additions: number; deletions: number }>();
    const n = nums.stdout.split("\0");
    for (let i = 0; i < n.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(n[i]);
      if (!m) continue;
      let file = m[3];
      if (file === "") { file = n[i + 2] ?? ""; i += 2; }   // rename: "add\tdel\t\0old\0new"
      counts.set(file, { additions: m[1] === "-" ? 0 : Number(m[1]), deletions: m[2] === "-" ? 0 : Number(m[2]) });
    }
    const files: CommitDetail["files"] = [];
    const s = names.stdout.split("\0");
    for (let i = 0; i < s.length; i++) {
      const code = s[i];
      if (!code) continue;
      const letter = code[0];
      const isTwoPath = letter === "R" || letter === "C";
      const file = isTwoPath ? s[i + 2] : s[i + 1];
      i += isTwoPath ? 2 : 1;
      if (file === undefined) break;
      const status = letter === "A" || letter === "C" ? "A" : letter === "D" ? "D" : letter === "R" ? "R" : "M";
      if (files.length >= MAX_FILES) {
        this.options.logger?.warn(`git show ${sha} truncated to ${MAX_FILES} files: the file list is partial`);
        break;
      }
      files.push({ path: file, status, ...(counts.get(file) ?? { additions: 0, deletions: 0 }) });
    }
    return files;
  }

  async branches(): Promise<BranchInfo[]> {
    const { stdout } = await this.run(["for-each-ref", `--format=%(refname)${US}%(objectname)${US}%(HEAD)`, "refs/heads"]);
    const out: BranchInfo[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const [ref, head, cur] = line.split(US);
      if (!SHA_RE.test(head)) continue;
      const name = ref.replace(/^refs\/heads\//, "");
      out.push({ name, head, isCurrent: cur === "*", isAgent: name.startsWith("nexus/agent-") });
    }
    return out;
  }

  async refs(): Promise<RefInfo[]> {
    const { stdout } = await this.run(["for-each-ref",
      `--format=%(refname)${US}%(objectname)${US}%(objecttype)${US}%(*objectname)${US}%(*objecttype)`, "refs/heads", "refs/tags", "refs/remotes"]);
    const out: RefInfo[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const [ref, obj, type, peeled, peeledType] = line.split(US);
      let kind: RefInfo["kind"], name: string;
      if (ref.startsWith("refs/heads/")) { kind = "branch"; name = ref.slice("refs/heads/".length); }
      else if (ref.startsWith("refs/tags/")) { kind = "tag"; name = ref.slice("refs/tags/".length); }
      else if (ref.startsWith("refs/remotes/")) { kind = "remote"; name = ref.slice("refs/remotes/".length); if (name.endsWith("/HEAD")) continue; }
      else continue;
      const sha = type === "tag" ? peeled : obj;
      const targetType = type === "tag" ? peeledType : type;
      if (targetType !== "commit" || !SHA_RE.test(sha)) continue;   // a tag on a tree or blob is not a point in history
      out.push({ name, kind, sha });
    }
    return out;
  }

  async branchesContaining(sha: FullSha): Promise<string[]> {
    assertSha(sha);
    if (!await this.resolves(sha)) return [];
    const { stdout } = await this.run(["for-each-ref", `--contains=${sha}`, "--format=%(refname)", "refs/heads"]);
    return stdout.split("\n").filter(Boolean).map(r => r.replace(/^refs\/heads\//, ""));
  }

  async headOf(ref = "HEAD"): Promise<FullSha> {
    assertRef(ref);
    const { stdout } = await this.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { allowExit: [1] });
    const sha = stdout.trim();
    if (!SHA_RE.test(sha)) throw new Error(`unknown ref ${ref}`);
    return sha;
  }

  async contains(sha: FullSha, ref = "HEAD"): Promise<boolean> {
    assertSha(sha);
    const target = await this.headOf(ref);
    if (!await this.resolves(sha)) return false;
    const { code } = await this.run(["merge-base", "--is-ancestor", sha, target], { allowExit: [1] });
    return code === 0;
  }

  async fileAt(commit: FullSha, file: string): Promise<string | undefined> {
    assertSha(commit);
    assertRelativePath(file);
    const { stdout } = await this.run(["ls-tree", "-z", commit, "--", file]);
    // Require the entry's path to be exactly the requested one: never a directory listing or a pathspec expansion.
    const entry = /^(\d+) (\w+) ([0-9a-f]{40})\t([^\0]*)$/s.exec(stdout.split(NUL)[0] ?? "");
    if (!entry || entry[4] !== file || entry[2] !== "blob") return undefined;
    const blob = await this.run(["cat-file", "blob", entry[3]]);
    return blob.stdout;
  }

  async isDirty(file: string): Promise<boolean> {
    // Trust model: this runs `git status` in the user's checkout, so a clean/smudge filter configured by the repo can still
    // run, exactly as with the built-in git extension. fsmonitor and hooks are disabled for every call; filters are not.
    assertRelativePath(file);
    const { stdout } = await this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", file]);
    return stdout.length > 0;
  }

  // ---- write half: worktrees.ts and merge.ts ----
  private context(): wt.GitContext {
    return { repoRoot: this.repoRoot, sessionsDir: this.options.sessionsDir, run: (cwd, args, o) => this.runIn(cwd, args, o) };
  }
  createSessionWorktree(input: { sessionId: string; workspaceId: string }): Promise<SessionWorktree> { return wt.createSessionWorktree(this.context(), input); }
  removeSessionWorktree(sessionId: string): Promise<void> { return wt.removeSessionWorktree(this.context(), sessionId); }
  diff(worktreePath: string, baseCommit: FullSha, paths?: string[]): Promise<string> { return wt.diff(this.context(), worktreePath, baseCommit, paths); }
  commitIn(worktreePath: string, message: string, sessionId: string, approvedDiff: string): Promise<FullSha> { return wt.commitIn(this.context(), worktreePath, message, sessionId, approvedDiff); }
  mergeAgentBranch(sessionId: string): Promise<MergeResult> { return mergeAgentBranch(this.context(), sessionId); }
}
