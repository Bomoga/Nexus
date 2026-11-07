import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./task.css";
import { App } from "./App";
import { resolveTaskId } from "./taskId";

createRoot(document.getElementById("root") as HTMLElement).render(<App taskId={resolveTaskId()} />);
