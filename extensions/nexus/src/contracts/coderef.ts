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

// nexus://nexus.nexus/coderef/<workspaceId>/<commit>/<startLine>-<endLine>/<url-encoded path>
// The authority is the extension id: VS Code core drops any nexus:// URI whose authority is not "publisher.name".
export const CODEREF_SCHEME = "nexus";
export const NEXUS_URI_AUTHORITY = "nexus.nexus";
export function encodeCodeRef(r: CodeRef): string {
  return `${CODEREF_SCHEME}://${NEXUS_URI_AUTHORITY}/coderef/${encodeURIComponent(r.workspaceId)}/${r.commit}/${r.startLine}-${r.endLine}/${encodeURIComponent(r.path)}`;
}
/** Also reads the legacy authority-less form nexus://coderef/... (links already posted). Returns null (never throws, not even URIError on a bad percent escape) for anything that is not a valid link; the text is untrusted. */
export function decodeCodeRef(uri: string): CodeRef | null {
  const m = /^nexus:\/\/(?:nexus\.nexus\/)?coderef\/([^/]+)\/([0-9a-f]{40})\/(\d+)-(\d+)\/(.+)$/.exec(uri);
  if (!m) return null;
  let workspaceId: string, path: string;
  try { workspaceId = decodeURIComponent(m[1]); path = decodeURIComponent(m[5]); } catch { return null; }
  const parsed = CodeRef.safeParse({ workspaceId, commit: m[2],
    startLine: Number(m[3]), endLine: Number(m[4]), path });
  return parsed.success ? parsed.data : null;
}
// Other nexus:// routes (frozen), all with the extension id as authority:
//   nexus://nexus.nexus/auth/callback?code=&state=   nexus://nexus.nexus/session/<sessionId>   nexus://nexus.nexus/approval/<approvalId>
