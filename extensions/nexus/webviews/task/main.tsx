import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./task.css";
import { App } from "./App";

// How the panel learns its task: a ?taskId= query param set by the host when it builds the webview URL.
// Kept in one function so the host side can switch to an initial message without touching the App.
export function readTaskId(): string {
  const fromQuery = new URLSearchParams(location.search).get("taskId");
  return fromQuery ?? "task_01";
}

createRoot(document.getElementById("root") as HTMLElement).render(<App taskId={readTaskId()} />);
