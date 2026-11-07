import { z } from "zod";
import { Sha } from "./common";

export const CodeRef = z.object({
  workspaceId: z.string().min(1),          // stable per repo: sha1 of the root commit, set by the git service
  commit: Sha,                             // full SHA, never a branch name
  path: z.string().min(1).refine(p => !p.startsWith("/") && !p.includes(".."), "relative, no .."),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
}).strict().refine(r => r.endLine >= r.startLine, "endLine >= startLine");
export type CodeRef = z.infer<typeof CodeRef>;

// nexus://coderef/<workspaceId>/<commit>/<startLine>-<endLine>/<url-encoded path>
export const CODEREF_SCHEME = "nexus";
export function encodeCodeRef(r: CodeRef): string {
  return `${CODEREF_SCHEME}://coderef/${encodeURIComponent(r.workspaceId)}/${r.commit}/${r.startLine}-${r.endLine}/${encodeURIComponent(r.path)}`;
}
export function decodeCodeRef(uri: string): CodeRef | null {
  const m = /^nexus:\/\/coderef\/([^/]+)\/([0-9a-f]{40})\/(\d+)-(\d+)\/(.+)$/.exec(uri);
  if (!m) return null;
  const parsed = CodeRef.safeParse({ workspaceId: decodeURIComponent(m[1]), commit: m[2],
    startLine: Number(m[3]), endLine: Number(m[4]), path: decodeURIComponent(m[5]) });
  return parsed.success ? parsed.data : null;
}
// Other nexus:// routes (frozen): nexus://auth/callback?code=&state=   nexus://session/<sessionId>   nexus://approval/<approvalId>
