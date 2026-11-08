import { describe, expect, it } from "vitest";
import { Lane3Views, escapeAttr, readBodyData, withBodyData, type Lane3Deps, type PanelLike, type ViewLike } from "./lane3-views";

const PAGE = '<!doctype html>\n<html lang="en">\n<head></head>\n<body>\n<div id="root"></div>\n</body>\n</html>';

function setup(opts: { focusFails?: boolean; state?: Map<string, unknown> } = {}) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const registered: string[] = [];
  const opened: { viewId: string; entry: string; title: string; panel: PanelLike & { reveals: number; dispose(): void } }[] = [];
  const executed: string[] = [];
  const executedArgs: unknown[][] = [];
  const errors: string[] = [];
  const resolvers = new Map<string, (view: ViewLike) => void>();
  /** Simulate VS Code resolving a contributed view: returns the fake view. */
  const resolveView = (viewId: string) => {
    const listeners: (() => void)[] = [];
    const view = {
      webview: { html: PAGE },
      shows: 0,
      show() {
        view.shows++;
      },
      onDidDispose(cb: () => void) {
        listeners.push(cb);
        return { dispose: () => undefined };
      },
      dispose: () => listeners.forEach((l) => l()),
    };
    resolvers.get(viewId)?.(view);
    return view;
  };
  const deps: Lane3Deps = {
    makeHost: (viewId, entry, onResolveView) => ({
      register: () => {
        registered.push(`${viewId}:${entry}`);
        if (onResolveView) resolvers.set(viewId, onResolveView);
        return { dispose: () => undefined };
      },
      openPanel: (title) => {
        const listeners: (() => void)[] = [];
        const panel = {
          webview: { html: PAGE },
          reveals: 0,
          reveal() {
            panel.reveals++;
          },
          onDidDispose(cb: () => void) {
            listeners.push(cb);
            return { dispose: () => undefined };
          },
          dispose: () => listeners.forEach((l) => l()),
        };
        opened.push({ viewId, entry, title, panel });
        return panel;
      },
    }),
    registerCommand: (id, fn) => {
      commands.set(id, fn);
      return { dispose: () => commands.delete(id) };
    },
    executeCommand: async (id, ...args) => {
      executed.push(id);
      executedArgs.push(args);
      if (opts.focusFails && id.endsWith(".focus")) throw new Error(`no such view: ${id}`);
    },
    showError: (m) => errors.push(m),
    workspaceState: opts.state
      ? {
          get: <T,>(key: string) => opts.state!.get(key) as T | undefined,
          update: async (key: string, value: unknown) => {
            opts.state!.set(key, value);
          },
        }
      : undefined,
  };
  const views = new Lane3Views(deps).register();
  const run = (id: string, ...args: unknown[]) => commands.get(id)!(...args);
  return { views, commands, registered, opened, executed, executedArgs, errors, run, resolveView };
}

describe("Lane3Views", () => {
  it("registers the sidebar views and every lane 3 command it serves", () => {
    const { registered, commands } = setup();
    expect({ registered, commands: [...commands.keys()].sort() }).toEqual({
      registered: ["nexus.chat:chat", "nexus.git:git", "nexus.approvals:approvals", "nexus.agent:session"],
      commands: ["nexus.openApprovals", "nexus.openHome", "nexus.openSession", "nexus.openSlack", "nexus.openTimeline", "nexus.searchEvents", "nexus.shareSelectionToSlack"],
    });
  });

  it("opens the globe as the nexus.home panel once, and reveals it after that", () => {
    const { run, opened } = setup();
    run("nexus.openHome");
    run("nexus.searchEvents");
    expect(opened.map((o) => [o.viewId, o.entry, o.title])).toEqual([["nexus.home", "globe", "Nexus"]]);
    expect(opened[0].panel.reveals).toBe(1);
  });

  it("opens a new home after the old one was closed", () => {
    const { run, opened } = setup();
    run("nexus.openHome");
    opened[0].panel.dispose();
    run("nexus.openHome");
    expect(opened.length).toBe(2);
  });

  it("opens the timeline as its own panel", () => {
    const { run, opened } = setup();
    run("nexus.openTimeline");
    expect(opened.map((o) => [o.viewId, o.entry])).toEqual([["nexus.timeline", "timeline"]]);
  });

  it("shows a session in the resolved agent view (body data re-set, page reloads) and focuses it; no panel opens", async () => {
    const { run, opened, executed, resolveView } = setup();
    const view = resolveView("nexus.agent");
    await run("nexus.openSession", "ses_01");
    expect(view.webview.html).toContain('<body data-session-id="ses_01">');
    expect(executed).toEqual(["nexus.agent.focus"]);
    expect(opened).toEqual([]);
    const before = view.webview.html;
    await run("nexus.openSession", "ses_01");
    expect(view.webview.html).toBe(before); // same session: no reload
    await run("nexus.openSession", "ses_02");
    expect(view.webview.html).toContain('<body data-session-id="ses_02">');
    expect(view.webview.html).not.toContain("ses_01");
  });

  it("points the agent view at the pending session when it resolves later, and forgets a disposed view", async () => {
    const { run, resolveView, executed } = setup();
    await run("nexus.openSession", "ses_07");
    expect(executed).toEqual(["nexus.agent.focus"]);
    const view = resolveView("nexus.agent");
    expect(view.webview.html).toContain('<body data-session-id="ses_07">');
    view.dispose();
    await run("nexus.openSession", "ses_08");
    expect(view.webview.html).toContain("ses_07"); // the disposed view is no longer written to
    const again = resolveView("nexus.agent");
    expect(again.webview.html).toContain('<body data-session-id="ses_08">');
  });

  it("falls back to one session panel per id when the agent view cannot be focused", async () => {
    const { run, opened } = setup({ focusFails: true });
    await run("nexus.openSession", "ses_01");
    await run("nexus.openSession", "ses_01");
    await run("nexus.openSession", "ses_02");
    expect(opened.map((o) => [o.viewId, o.entry])).toEqual([["nexus.session", "session"], ["nexus.session", "session"]]);
    expect(opened[0].panel.webview.html).toContain('<body data-session-id="ses_01">');
    expect(opened[0].panel.reveals).toBe(1);
  });

  it("refuses to open a session without an id", async () => {
    const { run, opened, errors, executed } = setup();
    await run("nexus.openSession");
    await run("nexus.openSession", 42);
    await run("nexus.openSession", "ses 01\n<x>");
    await run("nexus.openSession", "a".repeat(129));
    expect(opened.length).toBe(0);
    expect(executed).toEqual([]);
    expect(errors.length).toBe(4);
  });

  it("forgets a closed panel's listener (no growth across open/close cycles)", async () => {
    const { views, run, opened, commands } = setup({ focusFails: true });
    for (let i = 0; i < 5; i++) {
      await run("nexus.openSession", `ses_${i}`);
      opened[i].panel.dispose();
    }
    await run("nexus.openSession", "ses_0");
    expect(opened.length).toBe(6);
    views.dispose();
    expect(commands.size).toBe(0);
  });

  it("opens one plan panel per plan id with the id on <body>, and refuses an invalid id", () => {
    const { views, opened, errors } = setup();
    views.openPlan("plan_01");
    views.openPlan("plan_01");
    expect(opened).toHaveLength(1);
    expect(opened[0].viewId).toBe("nexus.plan");
    expect(opened[0].panel.webview.html).toContain('<body data-plan-id="plan_01">');
    views.openPlan('x"><script>');
    expect(opened).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("opens the task editor with the task id on <body>", () => {
    const { views, opened } = setup();
    views.openTaskEditor("task_01");
    expect(opened[0].viewId).toBe("nexus.task");
    expect(opened[0].panel.webview.html).toContain('<body data-task-id="task_01">');
  });

  it("focuses the Slack and Approvals views", async () => {
    const { run, executed } = setup();
    await run("nexus.openSlack");
    await run("nexus.openApprovals");
    expect(executed).toEqual(["nexus.chat.focus", "nexus.approvals.focus"]);
  });

  it("disposes every command it registered", () => {
    const { views, commands } = setup();
    views.dispose();
    expect(commands.size).toBe(0);
  });
});

describe("revealAgentViewOnce", () => {
  it("reveals the agent view without stealing focus, once per workspace", async () => {
    const state = new Map<string, unknown>();
    const { views, executed, executedArgs } = setup({ state });
    await views.revealAgentViewOnce();
    await views.revealAgentViewOnce();
    expect(executed).toEqual(["nexus.agent.focus"]);
    expect(executedArgs[0]).toEqual([{ preserveFocus: true }]);
    expect(state.get("nexus.agentViewRevealed")).toBe(true);
    const again = setup({ state });
    await again.views.revealAgentViewOnce();
    expect(again.executed).toEqual([]);
  });

  it("does nothing without workspace state, and keeps retrying while the view cannot be focused", async () => {
    const none = setup();
    await none.views.revealAgentViewOnce();
    expect(none.executed).toEqual([]);
    const state = new Map<string, unknown>();
    const failing = setup({ state, focusFails: true });
    await failing.views.revealAgentViewOnce();
    expect(failing.executed).toEqual(["nexus.agent.focus"]);
    expect(state.has("nexus.agentViewRevealed")).toBe(false);
  });
});

describe("withBodyData", () => {
  it("escapes the value so an id can't break out of the attribute", () => {
    expect(withBodyData("<body>", "session-id", '"><script>x</script>')).toBe('<body data-session-id="&quot;&gt;&lt;script&gt;x&lt;/script&gt;">');
    expect(escapeAttr("a&b")).toBe("a&amp;b");
  });

  it("replaces an earlier value of the same attribute and keeps other attributes", () => {
    const once = withBodyData('<body class="x">', "session-id", "ses_01");
    expect(once).toBe('<body class="x" data-session-id="ses_01">');
    const twice = withBodyData(once, "session-id", "ses_02");
    expect(twice).toBe('<body class="x" data-session-id="ses_02">');
    expect(readBodyData(twice, "session-id")).toBe("ses_02");
    expect(readBodyData("<body>", "session-id")).toBeUndefined();
  });
});
