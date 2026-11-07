import { describe, expect, it, vi } from "vitest";
import { discoverRepositoryRoot, getGitApi, listRefNames, pickRepository, type GitApiLike, type VscodeLike } from "./git-api";

const repo = (fsPath: string, refs: { type: number; name?: string }[] = []) => ({ rootUri: { fsPath }, getRefs: vi.fn(async () => refs) });
const vscodeWith = (api: GitApiLike | undefined, folder?: string, active = true): VscodeLike => ({
  extensions: { getExtension: () => api === undefined ? undefined : { isActive: active, exports: { getAPI: () => api }, activate: async () => undefined } },
  workspace: { workspaceFolders: folder ? [{ uri: { fsPath: folder } }] : undefined },
});

describe("git-api", () => {
  it("returns undefined when the git extension is missing or disabled", async () => {
    expect(await getGitApi(vscodeWith(undefined))).toBeUndefined();
    const disabled: VscodeLike = { ...vscodeWith({ repositories: [] }), extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => { throw new Error("disabled"); } }, activate: async () => undefined }) } };
    expect(await getGitApi(disabled)).toBeUndefined();
  });

  it("activates the extension when needed", async () => {
    const activate = vi.fn(async () => undefined);
    const vs: VscodeLike = { ...vscodeWith({ repositories: [] }), extensions: { getExtension: () => ({ isActive: false, exports: { getAPI: () => ({ repositories: [] }) }, activate }) } };
    expect(await getGitApi(vs)).toEqual({ repositories: [] });
    expect(activate).toHaveBeenCalledOnce();
  });

  it("picks the deepest repository containing the workspace folder", async () => {
    const api = { repositories: [repo("/w"), repo("/w/sub"), repo("/other")] };
    expect(pickRepository(api, vscodeWith(api, "/w/sub/pkg"))?.rootUri.fsPath).toBe("/w/sub");
    expect(pickRepository(api, vscodeWith(api, "/w"))?.rootUri.fsPath).toBe("/w");
    expect(pickRepository(api, vscodeWith(api, "/elsewhere"))?.rootUri.fsPath).toBe("/w");
    expect(pickRepository({ repositories: [] }, vscodeWith(api))).toBeUndefined();
    expect(await discoverRepositoryRoot(vscodeWith(api, "/other"))).toBe("/other");
  });

  it("lists ref names through getRefs, not state.refs", async () => {
    const r = repo("/w", [{ type: 0, name: "main" }, { type: 1, name: "origin/main" }, { type: 2, name: "v1" }, { type: 0 }]);
    expect(await listRefNames(r)).toEqual({ branches: ["main"], remotes: ["origin/main"], tags: ["v1"] });
    expect(r.getRefs).toHaveBeenCalledWith({});
  });
});
