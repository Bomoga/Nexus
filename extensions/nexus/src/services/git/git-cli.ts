// The read half of GitService, over the git CLI (PLAN 5.2 L2-05). git is always run with execFile and an argv array,
// never a shell string. Everything that comes from a repository (names, paths, messages) is untrusted: SHAs are
// validated, paths are checked and follow `--`, and output is bounded. The write half belongs to L2-06.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { BranchInfo, CommitDetail, FullSha, GitService, LogEntry, MergeResult, RefInfo, SessionWorktree } from "./types";

const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_LOG_ENTRIES = 20000;
const MAX_FILES = 2000;
const SHA_RE = /^[0-9a-f]{40}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const US = "\x1f";

/** Throws unless `sha` is a full 40-char lowercase hex SHA. */
export function assertSha(sha: string): void {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new Error("invalid commit sha: expected 40 lowercase hex characters");
}

/** Throws unless `p` is a non-empty repo-relative path with no `..` segment, no NUL and no drive or root prefix. */
export function assertRelativePath(p: string): void {
  if (typeof p !== "string" || p.length === 0) throw new Error("invalid path: empty");
  if (p.includes("\0")) throw new Error("invalid path: contains NUL");
  if (path.posix.isAbsolute(p) || path.win32.isAbsolute(p) || /^[A-Za-z]:/.test(p)) throw new Error("invalid path: must be relative to the repository root");
  if (p.split(/[\\/]/).includes("..")) throw new Error("invalid path: must not contain '..'");
}

function assertRef(ref: string): void {
  if (typeof ref !== "string" || ref.length === 0 || ref.startsWith("-") || [...ref].some(c => c <= " " || c === "\x7f" || "~^:?*[\\".includes(c)) || ref.includes("..")) throw new Error("invalid ref name");
}

function assertIso(value: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error("invalid time: expected an ISO 8601 date");
}

interface RunResult { stdout: string; code: number }

export class GitCli implements GitService {
  constructor(private readonly repoRoot: string) {}

  private run(args: string[], options: { allowExit?: number[] } = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      execFile("git", ["-c", "core.quotepath=off", ...args], {
        cwd: this.repoRoot,
        maxBuffer: MAX_OUTPUT,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" },
      }, (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, code: 0 });
        const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
        if (options.allowExit?.includes(code)) return resolve({ stdout, code });
        const detail = String(stderr || error.message).trim().split("\n")[0].slice(0, 300);
        reject(new Error(`git ${args[0]} failed: ${detail}`));
      });
    });
  }

  async workspaceId(): Promise<string> {
    const { stdout } = await this.run(["rev-list", "--max-parents=0", "HEAD"]);
    const roots = stdout.split("\n").filter(l => SHA_RE.test(l)).sort();
    if (!roots.length) throw new Error("repository has no commits");
    return createHash("sha1").update(roots[0]).digest("hex");
  }

  async log(options: { since?: string } = {}): Promise<LogEntry[]> {
    const args = ["log", "--branches", "--tags", "--remotes", `--max-count=${MAX_LOG_ENTRIES}`, "-z",
      `--format=%H${US}%P${US}%an${US}%cI${US}%s${US}%(trailers:key=Nexus-Agent,valueonly,unfold,separator=%x1e)`];
    let sinceMs = -Infinity;
    if (options.since !== undefined) {
      assertIso(options.since);
      sinceMs = Date.parse(options.since);
      args.push(`--since=${options.since}`);
    }
    args.push("--");
    const { stdout } = await this.run(args);
    const entries: LogEntry[] = [];
    for (const record of stdout.split("\0")) {
      if (!record.trim()) continue;
      const [sha, parents, authorName, committedAt, subject, trailer = ""] = record.replace(/^\n/, "").split(US);
      if (!SHA_RE.test(sha) || Number.isNaN(Date.parse(committedAt))) continue;
      if (Date.parse(committedAt) < sinceMs) continue;
      const entry: LogEntry = { sha, parents: parents.split(" ").filter(p => SHA_RE.test(p)), authorName, committedAt, subject };
      const session = trailer.split("\x1e").map(s => s.trim()).find(s => SESSION_ID_RE.test(s));
      if (session) entry.agentSessionId = session;
      entries.push(entry);
    }
    return entries.sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt));
  }

  async show(sha: FullSha): Promise<CommitDetail> {
    assertSha(sha);
    const { stdout } = await this.run(["show", "--no-patch", "--no-show-signature", `--format=%H${US}%P${US}%an${US}%cI${US}%s${US}%b`, sha, "--"]);
    const [full, parentsRaw, author, at, subject, ...bodyParts] = stdout.split(US);
    if (!SHA_RE.test(full)) throw new Error("unexpected git show output");
    const parents = parentsRaw.split(" ").filter(p => SHA_RE.test(p));
    const body = bodyParts.join(US).replace(/\s+$/, "");
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
    for (let i = 0; i < s.length && files.length < MAX_FILES; i++) {
      const code = s[i];
      if (!code) continue;
      const letter = code[0];
      const isTwoPath = letter === "R" || letter === "C";
      const file = isTwoPath ? s[i + 2] : s[i + 1];
      i += isTwoPath ? 2 : 1;
      if (file === undefined) break;
      const status = letter === "A" || letter === "C" ? "A" : letter === "D" ? "D" : letter === "R" ? "R" : "M";
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
    const { code } = await this.run(["merge-base", "--is-ancestor", sha, target], { allowExit: [1] });
    return code === 0;
  }

  async fileAt(commit: FullSha, file: string): Promise<string | undefined> {
    assertSha(commit);
    assertRelativePath(file);
    const normalized = file.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    const { stdout } = await this.run(["ls-tree", "-z", commit, "--", normalized]);
    const m = /^(\d+) (\w+) ([0-9a-f]{40})\t/.exec(stdout.split("\0")[0] ?? "");
    if (!m || m[2] !== "blob") return undefined;
    const blob = await this.run(["cat-file", "blob", m[3]]);
    return blob.stdout;
  }

  async isDirty(file: string): Promise<boolean> {
    assertRelativePath(file);
    const { stdout } = await this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", file]);
    return stdout.length > 0;
  }

  // ---- write half: L2-06 ----
  async createSessionWorktree(_input: { sessionId: string; workspaceId: string }): Promise<SessionWorktree> { return notYet(); }
  async removeSessionWorktree(_sessionId: string): Promise<void> { return notYet(); }
  async diff(_worktreePath: string, _baseCommit: FullSha, _paths?: string[]): Promise<string> { return notYet(); }
  async commitIn(_worktreePath: string, _message: string, _sessionId: string): Promise<FullSha> { return notYet(); }
  async mergeAgentBranch(_sessionId: string): Promise<MergeResult> { return notYet(); }
}

function notYet(): never {
  throw new Error("not implemented in L2-05: the git write half lands in L2-06");
}
