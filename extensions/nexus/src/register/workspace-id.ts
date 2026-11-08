/**
 * The id Lane 1 stamps on tasks, sessions and the events they produce. Lane 2 scopes shared events by the open repo's
 * root-commit id (what the git service returns) and also accepts the folder slug, so the root-commit id is preferred: two
 * machines that have a same-named folder holding different repos must not share one id.
 */
export interface WorkspaceIdSource {
  workspaceId?(): Promise<string>;
}

/** The folder slug, used only when there is no repository with commits to take a root-commit id from. */
export function folderSlugId(folderName: string | undefined): string {
  return `ws_${(folderName ?? "default").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

export async function resolveWorkspaceId(git: WorkspaceIdSource | undefined, folderName: string | undefined): Promise<string> {
  try {
    const id = await git?.workspaceId?.();
    if (typeof id === "string" && id.length > 0) return id;
  } catch {
    // no repository, or one without commits: fall through to the folder slug
  }
  return folderSlugId(folderName);
}
