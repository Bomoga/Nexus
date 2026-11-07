// Lane 3's views, panels and the commands that open them, with VS Code injected so they can be unit-tested.
// src/register/lane-3.ts supplies the real pieces.
import type { WebviewHost } from "../../bridge/host";

/** Webview ids. "nexus.home" is the id Lane 1's core change hides the tab and title for (editor.ts). */
export const HOME_PANEL = "nexus.home";
export const TIMELINE_PANEL = "nexus.timeline";
export const SESSION_PANEL = "nexus.session";
export const TASK_PANEL = "nexus.task";
export const CHAT_VIEW = "nexus.chat";
export const APPROVALS_VIEW = "nexus.approvals";

export interface PanelLike {
  readonly webview: { html: string };
  reveal(): void;
  onDidDispose(cb: () => void): { dispose(): void };
}

export interface Lane3Deps {
  /** Host one webview entry (media/<entry>/) under a view or panel id. */
  makeHost(viewId: string, entry: string): Pick<WebviewHost, "register"> & { openPanel(title: string): PanelLike };
  registerCommand(id: string, fn: (...args: unknown[]) => unknown): { dispose(): void };
  executeCommand(id: string): Thenable<unknown>;
  showError(message: string): void;
}

/** Escape a value for a double-quoted HTML attribute. */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Put `data-<name>="<value>"` on the page's <body> so the webview can read its id (webviews/session/sessionId.ts and
 * webviews/task/taskId.ts read it first). The host builds a plain <body>; this rewrites it once, before the page runs.
 */
export function withBodyData(html: string, name: string, value: string): string {
  return html.replace("<body>", `<body data-${name}="${escapeAttr(value)}">`);
}

/** Lane 3's views, panels and commands, built on injected VS Code pieces so they can be unit-tested. */
export class Lane3Views {
  private readonly disposables: { dispose(): void }[] = [];
  private home: PanelLike | undefined;
  private timeline: PanelLike | undefined;
  private readonly sessions = new Map<string, PanelLike>();
  private readonly tasks = new Map<string, PanelLike>();

  constructor(private readonly deps: Lane3Deps) {}

  register(): this {
    const d = this.deps;
    this.disposables.push(
      d.makeHost(CHAT_VIEW, "chat").register(),
      d.makeHost(APPROVALS_VIEW, "approvals").register(),
      d.registerCommand("nexus.openHome", () => this.openHome()),
      d.registerCommand("nexus.searchEvents", () => this.openHome()),
      d.registerCommand("nexus.openTimeline", () => this.openTimeline()),
      d.registerCommand("nexus.openSlack", () => d.executeCommand(`${CHAT_VIEW}.focus`)),
      d.registerCommand("nexus.openApprovals", () => d.executeCommand(`${APPROVALS_VIEW}.focus`)),
      // Declared in the editor menu; the real flow (share-selection.ts) needs Lane 2's code-ref and Slack services wired in.
      d.registerCommand("nexus.shareSelectionToSlack", () => d.showError("Share to Slack isn't connected yet: the Slack service still has to be wired in.")),
      d.registerCommand("nexus.openSession", (sessionId?: unknown) => {
        if (typeof sessionId !== "string" || sessionId === "") {
          d.showError("Open session needs a session id (open it from a thread, the globe or a notification).");
          return;
        }
        this.openSession(sessionId);
      }),
    );
    return this;
  }

  /** The globe home: at most one, revealed if already open. */
  openHome(): void {
    this.home = this.single(this.home, HOME_PANEL, "globe", "Nexus", (p) => (this.home = p));
  }

  openTimeline(): void {
    this.timeline = this.single(this.timeline, TIMELINE_PANEL, "timeline", "Nexus Timeline", (p) => (this.timeline = p));
  }

  /** One session panel per session id. */
  openSession(sessionId: string): void {
    this.keyed(this.sessions, sessionId, SESSION_PANEL, "session", `Session ${sessionId}`, "session-id");
  }

  /** The task editor for a draft task (for Lane 1's "Make task" flow). One panel per task id. */
  openTaskEditor(taskId: string): void {
    this.keyed(this.tasks, taskId, TASK_PANEL, "task", "Task", "task-id");
  }

  dispose(): void {
    this.disposables.splice(0).forEach((x) => x.dispose());
  }

  private single(current: PanelLike | undefined, viewId: string, entry: string, title: string, forget: (p: undefined) => void): PanelLike {
    if (current) {
      current.reveal();
      return current;
    }
    const panel = this.deps.makeHost(viewId, entry).openPanel(title);
    this.disposables.push(panel.onDidDispose(() => forget(undefined)));
    return panel;
  }

  private keyed(map: Map<string, PanelLike>, id: string, viewId: string, entry: string, title: string, attr: string): void {
    const open = map.get(id);
    if (open) {
      open.reveal();
      return;
    }
    const panel = this.deps.makeHost(viewId, entry).openPanel(title);
    panel.webview.html = withBodyData(panel.webview.html, attr, id);
    map.set(id, panel);
    this.disposables.push(panel.onDidDispose(() => map.delete(id)));
  }
}
