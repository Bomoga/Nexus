import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./session.css";
import { ErrorBoundary } from "../shared";
import { App } from "./App";
import { resolveComposeSeq, resolveSessionId } from "./sessionId";

const root = createRoot(document.getElementById("root") as HTMLElement);
void resolveSessionId().then((sessionId) => root.render(
    <ErrorBoundary>
      <App sessionId={sessionId} composeSeq={resolveComposeSeq()} />
    </ErrorBoundary>,
  ));
