// Lane 3's views, panels and the commands that open them, with VS Code injected so they can be unit-tested.
// src/register/lane-3.ts supplies the real pieces. Lane 1 runs the design pass on these under Elkin's handoff
// (progress/lane-3.md "HANDOFF TO ADRIAN"); the layout follows docs/playbooks/design-night.md §4.
import type { WebviewHost } from "../../bridge/host";

/** Webview ids. "nexus.home" is the id Lane 1's core change hides the tab and title for (editor.ts). */
export const HOME_PANEL = "nexus.home";
export const TIMELINE_PANEL = "nexus.timeline";
export const SESSION_PANEL = "nexus.session";
export const TASK_PANEL = "nexus.task";
export const PLAN_PANEL = "nexus.plan";
export const CHAT_VIEW = "nexus.chat";
export const GIT_VIEW = "nexus.git";
export const APPROVALS_VIEW = "nexus.approvals";
/** The agent view in the secondary side bar (container `nexus-agent`); it hosts the `session` entry as a view. */
export const AGENT_VIEW = "nexus.agent";

export interface PanelLike {
  readonly webview: { html: string };
  reveal(): void;
  onDidDispose(cb: () => void): { dispose(): void };
}

/** The slice of a resolved vscode.WebviewView this file uses. */
export interface ViewLike {
  readonly webview: { html: string };
  show?(preserveFocus?: boolean): void;
  onDidDispose(cb: () => void): { dispose(): void };
}

export interface Lane3Deps {
  /** Host one webview entry (media/<entry>/) under a view or panel id. `onResolveView` fires once per resolved view. */
  makeHost(viewId: string, entry: string, onResolveView?: (view: ViewLike) => void): Pick<WebviewHost, "register"> & { openPanel(title: string): PanelLike };
  registerCommand(id: string, fn: (...args: unknown[]) => unknown): { dispose(): void };
  executeCommand(id: string, ...args: unknown[]): Thenable<unknown>;
  showError(message: string): void;
  /** Per-workspace memory (vscode workspaceState) for one-time behaviour such as the first reveal of the agent view. */
  workspaceState?: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> };
}

/** workspaceState key: the agent view was revealed once in this workspace (after that the user's layout choice stands). */
export const AGENT_REVEALED_KEY = "nexus.agentViewRevealed";

/** Session and task ids arrive from URIs and notifications: short, plain characters only (they end up in tab titles and HTML). */
export function isPanelId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** Escape a value for a double-quoted HTML attribute. */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Put `data-<name>="<value>"` on the page's <body> so the webview can read its id (webviews/session/sessionId.ts and
 * webviews/task/taskId.ts read it first). The host builds a plain <body>; this rewrites it, replacing an earlier value of
 * the same attribute, so a view can be pointed at another id (the page reloads and replays from seq 0).
 */
export function withBodyData(html: string, name: string, value: string): string {
  const attr = `data-${name}`;
  return html.replace(/<body\b([^>]*)>/, (_m, attrs: string) => {
    const kept = attrs.replace(new RegExp(`\\s*${attr}="[^"]*"`), "");
    return `<body${kept} ${attr}="${escapeAttr(value)}">`;
  });
}

/** A Slack thread target as `ui.openTarget` routes it to `nexus.openSlack` (src/services/coderef/open-target.ts). */
export interface SlackTarget { channelId: string; threadTs: string }
const CHANNEL_ID = /^[A-Z][A-Z0-9_]{0,31}$/;
const SLACK_TS = /^\d{1,12}\.\d{1,9}$/;

/** Only a plain {channelId, threadTs} in Slack's own formats is a target; anything else just focuses the view. */
export function asSlackTarget(arg: unknown): SlackTarget | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  const { channelId, threadTs } = arg as Record<string, unknown>;
  if (typeof channelId !== "string" || !CHANNEL_ID.test(channelId)) return undefined;
  if (typeof threadTs !== "string" || !SLACK_TS.test(threadTs)) return undefined;
  return { channelId, threadTs };
}

/** The value of `data-<name>` on the page's <body>, if any. */
export function readBodyData(html: string, name: string): string | undefined {
  return new RegExp(`<body\\b[^>]*\\sdata-${name}="([^"]*)"`).exec(html)?.[1];
}

/** Lane 3's views, panels and commands, built on injected VS Code pieces so they can be unit-tested. */
export class Lane3Views {
  private readonly disposables: { dispose(): void }[] = [];
  private home: PanelLike | undefined;
  private timeline: PanelLike | undefined;
  private agentView: ViewLike | undefined;
  /** The session the agent view should show once it resolves (or re-show after a reload). */
  private agentSessionId: string | undefined;
  private chatView: ViewLike | undefined;
  /** The thread the Slack view should open once it resolves. */
  private chatTarget: SlackTarget | undefined;
  private chatOpenSeq = 0;
  private readonly sessions = new Map<string, PanelLike>();
  private readonly tasks = new Map<string, PanelLike>();
  private readonly plans = new Map<string, PanelLike>();

  constructor(private readonly deps: Lane3Deps) {}

  register(): this {
    const d = this.deps;
    this.disposables.push(
      d.makeHost(CHAT_VIEW, "chat", (view) => this.onChatViewResolved(view)).register(),
      d.makeHost(GIT_VIEW, "git").register(),
      d.makeHost(APPROVALS_VIEW, "approvals").register(),
      d.makeHost(AGENT_VIEW, "session", (view) => this.onAgentViewResolved(view)).register(),
      d.registerCommand("nexus.openHome", () => this.openHome()),
      d.registerCommand("nexus.searchEvents", () => this.openHome()),
      d.registerCommand("nexus.openTimeline", () => this.openTimeline()),
      d.registerCommand("nexus.openSlack", (target?: unknown) => this.openSlack(target)),
      d.registerCommand("nexus.openApprovals", () => d.executeCommand(`${APPROVALS_VIEW}.focus`)),
      // nexus.shareSelectionToSlack is registered by src/register/lane-3.ts (registerShareSelection over the shared router).
      d.registerCommand("nexus.openSession", (sessionId?: unknown) => {
        if (!isPanelId(sessionId)) {
          d.showError("Open session needs a valid session id (open it from a thread, the globe or a notification).");
          return;
        }
        return this.openSession(sessionId);
      }),
    );
    return this;
  }

  /**
   * Show the secondary side bar with the Agent view the first time a workspace opens. The workbench computes the bar's
   * startup visibility before this extension activates (onStartupFinished), finds no view container in it (the built-in
   * Chat is disabled), records it as empty and hides it; the core default `workbench.secondarySideBar.defaultVisibility:
   * visible` is not enough on its own. Done once per workspace (workspaceState), so a user who hides the bar is not
   * fought on the next start. Focus stays where it was.
   */
  async revealAgentViewOnce(): Promise<void> {
    const state = this.deps.workspaceState;
    if (!state || state.get<boolean>(AGENT_REVEALED_KEY)) return;
    try {
      await this.deps.executeCommand(`${AGENT_VIEW}.focus`, { preserveFocus: true });
      await state.update(AGENT_REVEALED_KEY, true);
    } catch {
      // no secondary side bar (or the view is not registered): nothing to reveal, try again next start
    }
  }

  /** The globe home: at most one, revealed if already open. */
  openHome(): void {
    this.home = this.single(this.home, HOME_PANEL, "globe", "Nexus", (p) => (this.home = p));
  }

  openTimeline(): void {
    this.timeline = this.single(this.timeline, TIMELINE_PANEL, "timeline", "Nexus Timeline", (p) => (this.timeline = p));
  }

  /**
   * Focus the Slack view and, when given a thread target, open that channel and thread in it. The webview reads
   * `<body data-channel-id data-thread-ts>` at boot (webviews/chat), so the page is re-set and reloads; `data-open-seq`
   * changes every time so the same thread can be opened again.
   */
  async openSlack(arg?: unknown): Promise<void> {
    const target = asSlackTarget(arg);
    if (target) {
      this.chatTarget = target;
      if (this.chatView) this.pointChatView(this.chatView, target);
    }
    try {
      await this.deps.executeCommand(`${CHAT_VIEW}.focus`);
    } catch {
      // no Slack view registered: nothing to focus
    }
  }

  /**
   * Show a session in the agent view (secondary side bar): the view's <body data-session-id> is (re)set, which reloads the
   * page and replays from seq 0, then the view is focused. If the view cannot be focused (no secondary side bar), the
   * session opens as an editor panel instead, one per session id.
   */
  async openSession(sessionId: string): Promise<void> {
    this.agentSessionId = sessionId;
    if (this.agentView) this.pointAgentView(this.agentView, sessionId);
    try {
      await this.deps.executeCommand(`${AGENT_VIEW}.focus`);
    } catch {
      // Only when there is no agent view at all: a resolved view already shows the session, so no second surface opens.
      if (!this.agentView) this.keyed(this.sessions, sessionId, SESSION_PANEL, "session", `Session ${sessionId}`, "session-id");
    }
  }

  /** The task editor for a draft task (for Lane 1's "Make task" flow). One panel per task id. */
  openTaskEditor(taskId: string): void {
    if (!isPanelId(taskId)) {
      this.deps.showError("Can't open the task editor: invalid task id.");
      return;
    }
    this.keyed(this.tasks, taskId, TASK_PANEL, "task", "Task", "task-id");
  }

  /** A TaskPlan review panel (no command yet: Lane 1 calls this when a plan is proposed). One panel per plan id. */
  openPlan(planId: string): void {
    if (!isPanelId(planId)) {
      this.deps.showError("Can't open the plan: invalid plan id.");
      return;
    }
    this.keyed(this.plans, planId, PLAN_PANEL, "plan", "Plan", "plan-id");
  }

  dispose(): void {
    this.disposables.splice(0).forEach((x) => x.dispose());
  }

  private onAgentViewResolved(view: ViewLike): void {
    this.agentView = view;
    const listener = view.onDidDispose(() => {
      if (this.agentView === view) this.agentView = undefined;
      const i = this.disposables.indexOf(listener);
      if (i >= 0) this.disposables.splice(i, 1);
    });
    this.disposables.push(listener);
    if (this.agentSessionId) this.pointAgentView(view, this.agentSessionId);
  }

  private onChatViewResolved(view: ViewLike): void {
    this.chatView = view;
    const listener = view.onDidDispose(() => {
      if (this.chatView === view) this.chatView = undefined;
      const i = this.disposables.indexOf(listener);
      if (i >= 0) this.disposables.splice(i, 1);
    });
    this.disposables.push(listener);
    if (this.chatTarget) this.pointChatView(view, this.chatTarget);
  }

  private pointChatView(view: ViewLike, target: SlackTarget): void {
    this.chatOpenSeq += 1;
    let html = withBodyData(view.webview.html, "channel-id", target.channelId);
    html = withBodyData(html, "thread-ts", target.threadTs);
    view.webview.html = withBodyData(html, "open-seq", String(this.chatOpenSeq));
  }

  private pointAgentView(view: ViewLike, sessionId: string): void {
    if (readBodyData(view.webview.html, "session-id") === sessionId) return;
    view.webview.html = withBodyData(view.webview.html, "session-id", sessionId);
  }

  private single(current: PanelLike | undefined, viewId: string, entry: string, title: string, forget: (p: undefined) => void): PanelLike {
    if (current) {
      current.reveal();
      return current;
    }
    const panel = this.deps.makeHost(viewId, entry).openPanel(title);
    this.track(panel, () => forget(undefined));
    return panel;
  }

  /** Run `onClose` when the panel closes, and drop the listener itself then (no growth across open/close cycles). */
  private track(panel: PanelLike, onClose: () => void): void {
    const listener = panel.onDidDispose(() => {
      onClose();
      const i = this.disposables.indexOf(listener);
      if (i >= 0) this.disposables.splice(i, 1);
    });
    this.disposables.push(listener);
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
    this.track(panel, () => map.delete(id));
  }
}
