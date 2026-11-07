// Creates a code reference from a selection (coderef.create). vscode-free: the lead feeds it the selection's repo-relative
// path and line range. The ref always points at HEAD's full SHA and the snippet comes from that commit, never the working copy.
import { CodeRef, encodeCodeRef } from "../../contracts";
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

/** The most characters a snippet carries, so a minified file cannot send a huge one. */
export const MAX_SNIPPET_CHARS = 2000;

/** The longest encoded path a link may carry, so a shared link always fits in one Slack message with its snippet. */
export const MAX_LINK_PATH_CHARS = 900;

/** Throws unless `p` is a plain repo-relative path: not empty, no NUL, no leading slash or backslash, no drive prefix, and no empty, '.' or '..' segment (either separator). */
export function checkRelativePath(p: string): void {
  const bad = typeof p !== "string" || p.length === 0 || p.includes("\0") || p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)
    || p.split(/[\\/]/).some(s => s === "" || s === "." || s === "..");
  if (bad) throw new CodeRefError("invalid_path", "invalid path: it must be relative to the repository root, with no empty, '.' or '..' segments, no drive prefix and no NUL");
}

/** A file's lines (\r\n, \n and a lone \r all break lines) without the empty tail a trailing line break leaves. */
export function linesOf(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export async function createCodeRef(deps: CreateDeps, path: string, startLine: number, endLine: number): Promise<CreatedCodeRef> {
  checkRelativePath(path);
  if (encodeURIComponent(path).length > MAX_LINK_PATH_CHARS) throw new CodeRefError("invalid_path", "this file's path is too long to share as a link");
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
  const parsed = CodeRef.safeParse(ref);
  if (!parsed.success) throw new CodeRefError("invalid_path", `${path} cannot be shared as a code reference`);
  let snippet = lines.slice(startLine - 1, Math.min(endLine, startLine - 1 + MAX_SNIPPET_LINES)).join("\n");
  const points = Array.from(snippet);   // cut on code points, never inside a surrogate pair
  if (points.length > MAX_SNIPPET_CHARS) snippet = `${points.slice(0, MAX_SNIPPET_CHARS).join("")}\n…`;
  return { ref: parsed.data, link: encodeCodeRef(parsed.data), snippet };
}
