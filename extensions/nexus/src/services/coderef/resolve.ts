// Opens a code reference (coderef.open). vscode-free: the editor pieces are injected seams.
import type { CodeRef } from "../../contracts";
import type { GitService } from "../git/types";
import { checkRelativePath, CodeRefError, linesOf } from "./create";

export interface ResolveDeps {
  git: Pick<GitService, "workspaceId" | "contains" | "fileAt" | "isDirty" | "headOf">;
  /** Opens the working-copy file and selects the lines. */
  openLive(path: string, startLine: number, endLine: number): Promise<void> | void;
  /** Opens the file at the commit read-only (a virtual document over fileAt) and selects the lines. */
  openAtCommit(commit: string, path: string, startLine: number, endLine: number): Promise<void> | void;
  /** Called after a stale open: the lead turns it into an "Open current version" action. */
  offerCurrent(): void;
}

export async function openCodeRef(deps: ResolveDeps, ref: CodeRef): Promise<{ opened: "at_commit" | "current"; stale: boolean }> {
  const { git } = deps;
  checkRelativePath(ref.path);
  if (ref.workspaceId !== await git.workspaceId()) throw new CodeRefError("foreign_workspace", "this reference belongs to a different repository");
  let atCommit: string | undefined;
  try {
    atCommit = await git.fileAt(ref.commit, ref.path);
  } catch {
    throw new CodeRefError("not_found", `commit ${ref.commit.slice(0, 8)} is not in this repository`);
  }
  if (atCommit === undefined) throw new CodeRefError("not_found", `${ref.path} does not exist at ${ref.commit.slice(0, 8)}`);
  if (ref.endLine > linesOf(atCommit).length) throw new CodeRefError("not_found", `lines ${ref.startLine}-${ref.endLine} do not exist in ${ref.path} at ${ref.commit.slice(0, 8)}`);

  let fresh: boolean;
  try {
    fresh = await git.contains(ref.commit) && await git.fileAt(await git.headOf(), ref.path) === atCommit && !await git.isDirty(ref.path);
  } catch {
    fresh = false;
  }
  if (fresh) {
    await deps.openLive(ref.path, ref.startLine, ref.endLine);
    return { opened: "current", stale: false };
  }
  await deps.openAtCommit(ref.commit, ref.path, ref.startLine, ref.endLine);
  deps.offerCurrent();
  return { opened: "at_commit", stale: true };
}
