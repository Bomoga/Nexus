// Creates a code reference from a selection (coderef.create). vscode-free: the lead feeds it the selection's repo-relative
// path and line range. The ref always points at HEAD's full SHA and the snippet comes from that commit, never the working copy.
import { encodeCodeRef, type CodeRef } from "../../contracts";
import type { GitService } from "../git/types";

/** A refusal with a stable code and a message fit to show the user. */
export class CodeRefError extends Error {
  constructor(readonly code: "invalid_path" | "invalid_range" | "dirty" | "not_found" | "foreign_workspace", message: string) {
    super(message);
    this.name = "CodeRefError";
  }
}

export interface CreateDeps { git: Pick<GitService, "workspaceId" | "headOf" | "isDirty" | "fileAt"> }
export interface CreatedCodeRef { ref: CodeRef; link: string; snippet: string }

/** The most lines a snippet carries. */
export const MAX_SNIPPET_LINES = 12;

/** Throws unless `p` is a repo-relative path with no `..` and no absolute or drive prefix. */
export function checkRelativePath(p: string): void {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) throw new CodeRefError("invalid_path", "invalid path");
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).some(s => s === "" || s === "." || s === "..")) {
    throw new CodeRefError("invalid_path", "the path must be relative to the repository root, without '..'");
  }
}

/** A file's lines without the empty tail a trailing newline leaves. */
export function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export async function createCodeRef(deps: CreateDeps, path: string, startLine: number, endLine: number): Promise<CreatedCodeRef> {
  checkRelativePath(path);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new CodeRefError("invalid_range", "invalid line range");
  }
  const { git } = deps;
  if (await git.isDirty(path)) throw new CodeRefError("dirty", `${path} has uncommitted changes: commit first, so the reference points at lines that exist in history`);
  const commit = await git.headOf();
  const text = await git.fileAt(commit, path);
  if (text === undefined) throw new CodeRefError("not_found", `${path} is not in the latest commit: commit first`);
  const lines = linesOf(text);
  if (endLine > lines.length) throw new CodeRefError("invalid_range", `lines ${startLine}-${endLine} are out of range: ${path} has ${lines.length}`);
  const ref: CodeRef = { workspaceId: await git.workspaceId(), commit, path, startLine, endLine };
  const snippet = lines.slice(startLine - 1, Math.min(endLine, startLine - 1 + MAX_SNIPPET_LINES)).join("\n");
  return { ref, link: encodeCodeRef(ref), snippet };
}
