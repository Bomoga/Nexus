import { describe, expect, it } from "vitest";
import { Lane3Views, escapeAttr, withBodyData, type Lane3Deps, type PanelLike } from "./lane3-views";

const PAGE = '<!doctype html>\n<html lang="en">\n<head></head>\n<body>\n<div id="root"></div>\n</body>\n</html>';

function setup() {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const registered: string[] = [];
  const opened: { viewId: string; entry: string; title: string; panel: PanelLike & { reveals: number; dispose(): void } }[] = [];
  const executed: string[] = [];
  const errors: string[] = [];
  const deps: Lane3Deps = {
    makeHost: (viewId, entry) => ({
      register: () => {
        registered.push(`${viewId}:${entry}`);
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
    executeCommand: async (id) => {
      executed.push(id);
    },
    showError: (m) => errors.push(m),
  };
  const views = new Lane3Views(deps).register();
  const run = (id: string, ...args: unknown[]) => commands.get(id)!(...args);
  return { views, commands, registered, opened, executed, errors, run };
}

describe("Lane3Views", () => {
  it("registers the sidebar views and every lane 3 command it serves", () => {
    const { registered, commands } = setup();
    expect({ registered, commands: [...commands.keys()].sort() }).toEqual({
      registered: ["nexus.chat:chat", "nexus.approvals:approvals"],
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

  it("opens one session panel per session id with the id on <body>", () => {
    const { run, opened } = setup();
    run("nexus.openSession", "ses_01");
    run("nexus.openSession", "ses_01");
    run("nexus.openSession", "ses_02");
    expect(opened.map((o) => [o.viewId, o.entry])).toEqual([["nexus.session", "session"], ["nexus.session", "session"]]);
    expect(opened[0].panel.webview.html).toContain('<body data-session-id="ses_01">');
    expect(opened[0].panel.reveals).toBe(1);
  });

  it("refuses to open a session without an id", () => {
    const { run, opened, errors } = setup();
    run("nexus.openSession");
    run("nexus.openSession", 42);
    expect(opened.length).toBe(0);
    expect(errors.length).toBe(2);
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

describe("withBodyData", () => {
  it("escapes the value so an id can't break out of the attribute", () => {
    expect(withBodyData("<body>", "session-id", '"><script>x</script>')).toBe('<body data-session-id="&quot;&gt;&lt;script&gt;x&lt;/script&gt;">');
    expect(escapeAttr("a&b")).toBe("a&amp;b");
  });
});
