import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./session.css";
import { App } from "./App";
import { resolveSessionId } from "./sessionId";

const root = createRoot(document.getElementById("root") as HTMLElement);
void resolveSessionId().then((sessionId) => root.render(<App sessionId={sessionId} />));
