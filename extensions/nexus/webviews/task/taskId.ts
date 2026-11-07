import { isFakeMode } from "../shared";

// How the panel learns its task, in one place. The host renders <body data-task-id="...">; ?taskId= is a dev
// convenience only (VS Code owns the webview's query string). The demo fallback exists only in ?fake=1.
export function resolveTaskId(): string | undefined {
  const fromBody = document.body.dataset.taskId;
  if (fromBody) return fromBody;
  const fromQuery = new URLSearchParams(location.search).get("taskId");
  if (fromQuery) return fromQuery;
  return isFakeMode() ? "fake-task" : undefined;
}
