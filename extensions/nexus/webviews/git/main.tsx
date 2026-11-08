import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./git.css";
import { ErrorBoundary } from "../shared";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
