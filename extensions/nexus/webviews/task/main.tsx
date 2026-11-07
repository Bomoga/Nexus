import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./task.css";
import { ErrorBoundary } from "../shared";
import { App } from "./App";
import { resolveTaskId } from "./taskId";

createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App taskId={resolveTaskId()} />
  </ErrorBoundary>,
);
