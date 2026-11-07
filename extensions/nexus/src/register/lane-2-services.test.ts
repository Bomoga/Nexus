import { describe, expect, it, vi } from "vitest";
import { ApprovalRequest } from "../contracts";
import { fx } from "../contracts/fixtures";
import { FakeBridgeServer } from "../bridge/fake-bridge-server";
import { FakeEventStore } from "../services/events/fake-store";
import { FakeGit } from "../services/git/fake-git";
import type { BotApi } from "../services/slack/bot";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildLane2, SLACK_SECRET_KEYS, userAllowlist, type Lane2Inputs } from "./lane-2-services";

function bot() {
  const api = {
    auth: { test: vi.fn(async () => ({ user_id: "U_BOT", user: "nexus", bot_id: "B1", team_id: "T1" })) },
    chat: {
      postMessage: vi.fn(async (a: { channel: string }) => ({ ts: "50.000100", message: { ts: "50.000100", text: "card", bot_id: "B1", user: "U_BOT", type: "message", channel: a.channel } })),
      update: vi.fn(async () => ({ ts: "50.000100", message: { ts: "50.000100", text: "decided", bot_id: "B1", user: "U_BOT", type: "message" } })),
    },
  };
  return api;
}

function setup(over: Partial<Lane2Inputs> = {}, secrets: Record<string, string> = {}) {
  const router = new FakeBridgeServer();
  const store = new FakeEventStore();
  const api = bot();
  const opened: string[] = [];
  const commands: unknown[][] = [];
  const built = buildLane2({
    router, store, redact: t => t.replaceAll("SECRET", "[R]"),
    secret: async k => secrets[k], env: {}, allowlist: () => [],
    openExternal: async u => { opened.push(u); return true; }, log: () => {},
    executeCommand: async (id, ...args) => { commands.push([id, ...args]); },
    slackSeams: { makeBotApi: () => api as unknown as BotApi, socketOptions: { makeApp: () => { throw new Error("no socket in unit tests"); }, sleep: () => new Promise(() => undefined) } },
    ...over,
  });
  return { router, store, built, api, opened, commands };
}

describe("buildLane2", () => {
  it("serves slack.status without any token, posting as nobody", async () => {
    const { router, built } = setup();
    expect(await router.call("slack.status", {})).toMatchObject({ connected: false, postsAs: null, userTokenSource: "none" });
    expect(await built.hasBotTokens()).toBe(false);
  });

  it("reads tokens from SecretStorage first, then the dev environment, and never needs both", async () => {
    expect(await setup({}, { [SLACK_SECRET_KEYS.bot]: "xoxb-1", [SLACK_SECRET_KEYS.app]: "xapp-1" }).built.hasBotTokens()).toBe(true);
    expect(await setup({ env: { SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" } }).built.hasBotTokens()).toBe(true);
    expect(await setup({ env: { SLACK_BOT_TOKEN: "xoxb-1" } }).built.hasBotTokens()).toBe(false);
  });

  it("serves the store and events, and publishes new events and status live", async () => {
    const { router, store } = setup();
    expect(await router.call("store.status", {})).toMatchObject({ online: true });
    const window = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z", limit: 5000 };
    const all = await router.call("events.query", window);
    expect(all.length).toBeGreaterThan(0);
    const word = all[0].title.split(/\s+/)[0];
    expect((await router.call("events.search", { q: word })).map(h => h.event.title)).toContain(all[0].title);
    const live: string[] = [];
    await router.subscribe("events.subscribe", {}, e => live.push(e.id));
    const statuses: number[] = [];
    await router.subscribe("store.subscribe", {}, s => statuses.push(s.outboxDepth));
    await store.putNexusEvent({ ...fx.event, id: "ws:commit:new" });
    store.setStatus({ outboxDepth: 4 });
    expect([live, statuses]).toEqual([["ws:commit:new"], [4]]);
  });

  it("opens only plain https links", async () => {
    const { router, opened } = setup();
    await router.call("ui.openExternal", { url: "https://example.com" });
    await expect(router.call("ui.openExternal", { url: "https://u:p@example.com" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(opened).toEqual(["https://example.com/"]);
  });

  it("provides git, the gate and the git handlers only when there is a repository", async () => {
    const without = setup();
    expect([without.built.git, without.built.makeGate]).toEqual([undefined, undefined]);
    await expect(without.router.call("git.branches", {})).rejects.toMatchObject({ code: "not_found" });
    const withGit = setup({ git: new FakeGit() });
    expect((await withGit.router.call("git.branches", {}))[0].name).toBe("main");
    const gate = withGit.built.makeGate!({ create: async () => ({ approvalId: "a", decision: "rejected" }) });
    await expect(gate.request(fx.session, "fs.read", { path: "../x" })).rejects.toThrow();
  });

  it("posts the approval card in the task's thread, stores its ts, and closes it once decided", async () => {
    const { store, built, api } = setup({}, { [SLACK_SECRET_KEYS.bot]: "xoxb-1", [SLACK_SECRET_KEYS.app]: "xapp-1" });
    const task = { ...fx.task, source: { kind: "thread" as const, channelId: "C9", threadTs: "40.000100" } };
    await store.putTask(task);
    await store.putSession({ ...fx.session, taskId: task.id });
    const approval = ApprovalRequest.parse({ ...fx.approval, id: "apr_new", sessionId: fx.session.id, decision: undefined, decidedBy: undefined, decidedAt: undefined, slackMessage: undefined });
    await store.putApproval(approval);
    await built.approvalHooks[0].onCreated(approval);
    expect(api.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C9", thread_ts: "40.000100" }));
    expect((await store.getApproval("apr_new"))?.slackMessage).toEqual({ channelId: "C9", ts: "50.000100" });
    await store.decideApproval("apr_new", "approved", { via: "app", userId: "U_ADRIAN" }, "2026-11-07T05:00:00Z");
    await vi.waitFor(() => expect(api.chat.update).toHaveBeenCalledWith(expect.objectContaining({ channel: "C9", ts: "50.000100" })));
  });

  it("merges an agent branch through git.mergeAgentBranch", async () => {
    const git = new FakeGit();
    await git.createSessionWorktree({ sessionId: "s1", workspaceId: "w" });
    const { router } = setup({ git });
    expect(await router.call("git.mergeAgentBranch", { sessionId: "s1" })).toMatchObject({ ok: true });
    expect(await router.call("git.mergeAgentBranch", { sessionId: "nope" })).toMatchObject({ ok: false });
  });

  it("starts the git watcher, which writes commit events into the store", async () => {
    const git = new FakeGit();
    let fire: () => void = () => {};
    const { store, built } = setup({ git, watcher: { machineId: "m1", watch: cb => { fire = cb; return () => {}; } } });
    await built.watcherReady;
    const window = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z", limit: 5000 };
    const before = await store.queryEvents(window);
    const w = await git.createSessionWorktree({ sessionId: "s9", workspaceId: "w" });
    git.setDiff(w.worktreePath, "+x\n");
    await git.mergeAgentBranch("s9");
    fire();
    await vi.waitFor(async () => expect((await store.queryEvents(window)).length).toBeGreaterThan(before.length), { timeout: 3000 });
    built.dispose();
  });

  it("does not post a card for a task that did not come from Slack", async () => {
    const { store, built, api } = setup({}, { [SLACK_SECRET_KEYS.bot]: "xoxb-1", [SLACK_SECRET_KEYS.app]: "xapp-1" });
    await store.putTask({ ...fx.task, source: { kind: "manual" } });
    await built.approvalHooks[0].onCreated({ ...fx.approval, sessionId: fx.session.id });
    expect(api.chat.postMessage).not.toHaveBeenCalled();
  });

  it("routes ui.openTarget to Lane 3's view commands with only the validated fields", async () => {
    const { router, commands } = setup();
    await router.call("ui.openTarget", { type: "commit", sha: "c".repeat(40) });
    await router.call("ui.openTarget", { type: "thread", channelId: "C1", threadTs: "1.000100" });
    expect(commands).toEqual([["nexus.openCommit", "c".repeat(40)], ["nexus.openSlack", { channelId: "C1", threadTs: "1.000100" }]]);
  });

  it("does not serve ui.openTarget without a command executor", async () => {
    const { router } = setup({ executeCommand: undefined });
    await expect(router.call("ui.openTarget", { type: "commit", sha: "c".repeat(40) })).rejects.toMatchObject({ code: "not_found" });
  });

  it("creates code refs at HEAD, opens fresh ones live and stale ones at their commit, and maps refusals to bridge codes", async () => {
    const git = new FakeGit();
    const head = await git.headOf();
    git.setFile(head, "src/a.ts", "one\ntwo\nthree\n");
    const editor: string[] = [];
    const codeRefEditor = {
      openLive: async (p: string, s: number, e: number) => { editor.push(`live ${p} ${s}-${e}`); },
      openAtCommit: async (c: string, p: string, s: number, e: number) => { editor.push(`at ${c.slice(0, 6)} ${p} ${s}-${e}`); },
      offerCurrent: (p: string, s: number, e: number) => { editor.push(`offer ${p} ${s}-${e}`); },
    };
    const { router, built } = setup({ git, codeRefEditor });
    const created = await router.call("coderef.create", { path: "src/a.ts", startLine: 2, endLine: 3 });
    expect([created.ref.commit, created.snippet]).toEqual([head, "two\nthree"]);
    expect(await router.call("coderef.open", { ref: created.ref })).toEqual({ opened: "current", stale: false });
    git.setDirty("src/a.ts");
    await expect(router.call("coderef.create", { path: "src/a.ts", startLine: 1, endLine: 1 })).rejects.toMatchObject({ code: "conflict" });
    expect(await built.codeRefs!.openLink(created.link)).toBe(true);
    expect(await built.codeRefs!.openLink("nexus://nexus.nexus/coderef/garbage")).toBe(false);
    await expect(router.call("coderef.open", { ref: { ...created.ref, workspaceId: "ws_other" } })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(router.call("coderef.open", { ref: { ...created.ref, path: "src/none.ts" } })).rejects.toMatchObject({ code: "not_found" });
    expect(editor).toEqual(["live src/a.ts 2-3", `at ${head.slice(0, 6)} src/a.ts 2-3`, "offer src/a.ts 2-3"]);
  });

  it("serves coderef.open only with both a repository and an editor", async () => {
    const { router, built } = setup({ git: new FakeGit() });
    expect(built.codeRefs).toBeUndefined();
    await expect(router.call("coderef.open", { ref: fx.codeRef })).rejects.toMatchObject({ code: "not_found" });
  });

  it("takes the agent allowlist only from user settings, and only as a list of strings", () => {
    const contributed = JSON.parse(readFileSync(path.join(__dirname, "../../contributes/lane-2.json"), "utf8"));
    // application scope: VS Code ignores the setting in a repository's workspace settings
    expect(contributed.contributes.configuration.properties["nexus.agent.allowedCommands"].scope).toBe("application");
    expect([userAllowlist(["npm test", "", 3, " "]), userAllowlist("npm test"), userAllowlist(undefined)]).toEqual([["npm test"], [], []]);
  });
});
