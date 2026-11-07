// A thin wrapper over the built-in git extension's API, used for repository discovery only (PLAN 5.2 L2-05).
// The vscode module is injected so tests never need the editor. Version 1 is the only API version; state.refs is
// empty at activation, so refs come from repository.getRefs({}).
import path from "node:path";

export interface GitRefLike { type: number; name?: string; commit?: string; remote?: string }
export interface GitRepositoryLike {
  rootUri: { fsPath: string };
  getRefs(query: Record<string, never>): Promise<GitRefLike[]>;
}
export interface GitApiLike {
  repositories: GitRepositoryLike[];
  onDidOpenRepository?(listener: (repository: GitRepositoryLike) => void): { dispose(): void };
}
interface GitExtensionExports { getAPI(version: 1): GitApiLike }
interface ExtensionLike {
  isActive: boolean;
  exports: GitExtensionExports;
  activate(): PromiseLike<GitExtensionExports | void>;
}
/** The slice of the `vscode` module this wrapper uses. */
export interface VscodeLike {
  extensions: { getExtension(id: string): ExtensionLike | undefined };
  workspace: { workspaceFolders?: readonly { uri: { fsPath: string } }[] };
}

/** The built-in git extension's API (version 1), or undefined if the extension is missing or disabled. */
export async function getGitApi(vscode: VscodeLike): Promise<GitApiLike | undefined> {
  const ext = vscode.extensions.getExtension("vscode.git");
  if (!ext) return undefined;
  if (!ext.isActive) await ext.activate();
  const exports = ext.exports;
  if (!exports || typeof exports.getAPI !== "function") return undefined;
  try { return exports.getAPI(1); } catch { return undefined; }   // throws when the extension is disabled
}

/** The repository for the first workspace folder (the deepest repository containing it), else the first one found. */
export function pickRepository(api: GitApiLike, vscode: VscodeLike): GitRepositoryLike | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const repos = api.repositories;
  if (folder) {
    const contains = repos
      .filter(r => { const rel = path.relative(r.rootUri.fsPath, folder); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); })
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
    if (contains[0]) return contains[0];
  }
  return repos[0];
}

/** Absolute root of the repository Nexus should watch, or undefined when there is none. */
export async function discoverRepositoryRoot(vscode: VscodeLike): Promise<string | undefined> {
  const api = await getGitApi(vscode);
  return api ? pickRepository(api, vscode)?.rootUri.fsPath : undefined;
}

/** Ref names from the built-in extension: local branches, remote branches (already prefixed with the remote) and tags. */
export async function listRefNames(repository: GitRepositoryLike): Promise<{ branches: string[]; remotes: string[]; tags: string[] }> {
  const refs = await repository.getRefs({});
  const names = (type: number) => refs.filter(r => r.type === type && r.name).map(r => r.name as string);
  return { branches: names(0), remotes: names(1), tags: names(2) };
}
