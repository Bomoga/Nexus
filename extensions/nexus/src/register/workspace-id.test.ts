import { describe, expect, it } from "vitest";
import { folderSlugId, resolveWorkspaceId } from "./workspace-id";

const SHA = "a".repeat(40);

describe("resolveWorkspaceId", () => {
  it("prefers the git service's root-commit id", async () => {
    expect(await resolveWorkspaceId({ workspaceId: async () => SHA }, "My Repo")).toBe(SHA);
  });
  it("falls back to the folder slug when the repository has no commits", async () => {
    const git = { workspaceId: async () => { throw new Error("repository has no commits"); } };
    expect(await resolveWorkspaceId(git, "My Repo")).toBe("ws_my_repo");
  });
  it("falls back when the service returns an empty or non-string id", async () => {
    expect(await resolveWorkspaceId({ workspaceId: async () => "" }, "demo")).toBe("ws_demo");
    expect(await resolveWorkspaceId({ workspaceId: (async () => 7) as unknown as () => Promise<string> }, "demo")).toBe("ws_demo");
  });
  it("falls back when the git service has no workspaceId at all, or is missing", async () => {
    expect(await resolveWorkspaceId({}, "demo")).toBe("ws_demo");
    expect(await resolveWorkspaceId(undefined, undefined)).toBe("ws_default");
  });
});

describe("folderSlugId", () => {
  it("matches the slug Lane 1 used before", () => {
    expect(folderSlugId("Nexus-Demo.App")).toBe("ws_nexus_demo_app");
  });
});
