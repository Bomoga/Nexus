import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./plan.css";
import { ErrorBoundary } from "../shared";
import { App } from "./App";
import { resolvePlanId } from "./planId";

const root = createRoot(document.getElementById("root") as HTMLElement);
void resolvePlanId().then((planId) => root.render(
    <ErrorBoundary>
      <App planId={planId} />
    </ErrorBoundary>,
  ));
