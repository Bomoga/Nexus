import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./approvals.css";
import { ErrorBoundary } from "../shared";
import { App } from "./App";

createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
