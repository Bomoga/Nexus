// "Nexus: Open commit": a quick pick of the commit's files; picking one opens VS Code's built-in diff editor.
// Extension-host code against injected dependencies (no vscode import); src/register/lane-3.ts supplies the real ones.
import type { Req, RequestName, Res } from "../../contracts";

export type Request = <N extends RequestName>(name: N, body: Req<N>) => Promise<Res<N>>;

/** One side of a diff: the file at a git ref (rendered through the built-in git extension), or nothing. */
export type DiffSide = { kind: "git"; ref: string } | { kind: "empty" };

export interface CommitPickItem {
  label: string;
  description: string;
  path: string;
  status: "A" | "M" | "D" | "R";
}

export interface OpenCommitDeps {
  request: Request;
  showQuickPick(items: CommitPickItem[], options: { title: string; placeHolder: string }): Promise<CommitPickItem | undefined>;
  showInputBox(options: { prompt: string; placeHolder?: string }): Promise<string | undefined>;
  showError(message: string): void;
  /** vscode.diff with the built-in diff editor. */
  openDiff(left: DiffSide, right: DiffSide, path: string, title: string): Promise<void>;
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const short = (sha: string): string => sha.slice(0, 7);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** "2026-11-07T01:02:03Z" -> "2026-11-07 01:02". */
function formatTime(at: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(at);
  return m ? `${m[1]} ${m[2]}` : at;
}

export async function openCommit(deps: OpenCommitDeps, shaArg?: string): Promise<void> {
  let input = shaArg;
  if (input === undefined) {
    input = await deps.showInputBox({ prompt: "Commit SHA (7 to 40 hex characters)", placeHolder: "0123abc" });
    if (input === undefined) return;
  }
  const sha = input.trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    deps.showError("Nexus: that is not a commit SHA (7 to 40 hex characters).");
    return;
  }
  let commit: Res<"git.commit.show">;
  try {
    commit = await deps.request("git.commit.show", { sha });
  } catch (e) {
    deps.showError(`Nexus: could not open commit: ${messageOf(e)}`);
    return;
  }
  const parent = commit.parents[0];   // a merge commit diffs against its first parent
  const parents = commit.parents.length ? commit.parents.map(short).join(" ") : "none";
  const title = `${commit.subject} · ${commit.author} · ${formatTime(commit.at)} · parents ${parents}`;
  const items: CommitPickItem[] = commit.files.map(f => ({
    label: f.path, description: `${f.status} +${f.additions} -${f.deletions}`, path: f.path, status: f.status,
  }));
  const picked = await deps.showQuickPick(items, { title, placeHolder: "Pick a file to open its diff" });
  if (!picked) return;
  const left: DiffSide = picked.status === "A" || !parent ? { kind: "empty" } : { kind: "git", ref: parent };
  const right: DiffSide = picked.status === "D" ? { kind: "empty" } : { kind: "git", ref: commit.sha };
  try {
    await deps.openDiff(left, right, picked.path, `${picked.path} @${short(commit.sha)}`);
  } catch (e) {
    deps.showError(`Nexus: could not open the diff: ${messageOf(e)}`);
  }
}
