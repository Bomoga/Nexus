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

  it("serves the activity strip from the store's events, in 15-minute buckets per orbit", async () => {
    const { router, store } = setup();
    await store.putNexusEvent({ ...fx.event, id: "evt_act_1", at: "2026-11-07T10:05:00.000Z", orbit: "act-test" });
    await store.putNexusEvent({ ...fx.event, id: "evt_act_2", at: "2026-11-07T10:14:59.000Z", orbit: "act-test" });
    const buckets = await router.call("events.activity", { from: "2026-11-07T10:00:00Z", to: "2026-11-07T10:15:00Z" });
    expect(buckets.filter(b => b.orbit === "act-test")).toEqual([{ bucketStart: "2026-11-07T10:00:00.000Z", orbit: "act-test", count: 2 }]);
    await expect(router.call("events.activity", { from: "now", to: "later" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("asks the activity query for the current workspace, and falls back to the local copy when it throws (no shared store yet)", async () => {
    const calls: unknown[][] = [];
    const answering = setup({ workspaceId: async () => "ws_here", activityQuery: { query: async (_t, p) => { calls.push(p); return { rows: [{ bucket: new Date("2026-11-07T10:00:00Z"), orbit: "remote", count: 4 }] }; } } });
    expect(await answering.router.call("events.activity", { from: "2026-11-07T10:00:00Z", to: "2026-11-07T10:15:00Z" })).toEqual([{ bucketStart: "2026-11-07T10:00:00.000Z", orbit: "remote", count: 4 }]);
    expect(calls).toEqual([["2026-11-07T10:00:00.000Z", "2026-11-07T10:15:00.000Z", "ws_here"]]);

    const notConnected = setup({ workspaceId: async () => "ws_here", activityQuery: { query: async () => { throw new Error("shared store not connected"); } } });
    await notConnected.store.putNexusEvent({ ...fx.event, id: "evt_act_3", at: "2026-11-07T10:05:00.000Z", orbit: "act-local" });
    const buckets = await notConnected.router.call("events.activity", { from: "2026-11-07T10:00:00Z", to: "2026-11-07T10:15:00Z" });
    expect(buckets.filter(b => b.orbit === "act-local")).toEqual([{ bucketStart: "2026-11-07T10:00:00.000Z", orbit: "act-local", count: 1 }]);
  });

  it("reads Slack as the user with the Token Vault token first, and falls back to the pasted one", async () => {
    const used: string[] = [];
    // record which token each Slack call was built with; every call then fails, which is fine for this check
    const webOptions = { makeApi: (token: string) => { used.push(token); return new Proxy({}, { get: () => new Proxy({}, { get: () => async () => { throw new Error("offline"); } }) }); } };
    const vault = { getUserToken: vi.fn(async () => ({ token: "xoxp-vault", source: "token_vault" as const })) };
    await setup({ tokenVault: vault, slackSeams: { webOptions } as never }, { [SLACK_SECRET_KEYS.user]: "xoxp-pasted" }).built.served.status();
    expect(used.length).toBeGreaterThan(0);
    expect(new Set(used)).toEqual(new Set(["xoxp-vault"]));
    used.length = 0;
    await setup({ tokenVault: { getUserToken: async () => { throw new Error("vault down"); } }, slackSeams: { webOptions } as never }, { [SLACK_SECRET_KEYS.user]: "xoxp-pasted" }).built.served.status();
    expect(new Set(used)).toEqual(new Set(["xoxp-pasted"]));
  });

  it("starts one Slack progress message when a thread task's session runs, and closes it when the session ends", async () => {
    const { store, built, api } = setup({ git: new FakeGit() }, { [SLACK_SECRET_KEYS.bot]: "xoxb-1", [SLACK_SECRET_KEYS.app]: "xapp-1" });
    const task = { ...fx.task, source: { kind: "thread" as const, channelId: "C9", threadTs: "40.000100" } };
    await store.putTask(task);
    const session = { ...fx.session, taskId: task.id, status: "running" as const, slackProgress: undefined };
    await built.observedStore.putSession(session);
    await vi.waitFor(() => expect(api.chat.postMessage).toHaveBeenCalledTimes(1));
    expect(api.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C9", thread_ts: "40.000100" }));
    await vi.waitFor(async () => expect((await store.getSession(session.id))?.slackProgress).toMatchObject({ channelId: "C9", threadTs: "40.000100" }));
    expect(await built.progress!.update(session, "running the tests")).toBe(true);
    await built.observedStore.putSession({ ...session, status: "done" });
    await vi.waitFor(() => expect(api.chat.update).toHaveBeenCalled());
    expect(api.chat.postMessage).toHaveBeenCalledTimes(1);   // one message per session, edited in place
  });

  it("never lets the progress message's write put back an older session status, and still closes the message", async () => {
    const { store, built, api } = setup({ git: new FakeGit() }, { [SLACK_SECRET_KEYS.bot]: "xoxb-1", [SLACK_SECRET_KEYS.app]: "xapp-1" });
    const task = { ...fx.task, source: { kind: "thread" as const, channelId: "C9", threadTs: "40.000100" } };
    await store.putTask(task);
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    api.chat.postMessage.mockImplementationOnce(async (a: { channel: string }) => { await held; return { ts: "51.000100", message: { ts: "51.000100", text: "card", bot_id: "B1", user: "U_BOT", type: "message", channel: a.channel } }; });
    const session = { ...fx.session, taskId: task.id, status: "running" as const, slackProgress: undefined, endedAt: undefined };
    await built.observedStore.putSession(session);   // resolves while Slack is still posting
    const failed = { ...session, status: "failed" as const, endedAt: "2026-11-07T05:00:00.000Z" };
    await built.observedStore.putSession(failed);    // the agent failed to start meanwhile
    release();
    await vi.waitFor(async () => expect((await store.getSession(session.id))?.slackProgress?.messageTs).toBe("51.000100"));
    expect(await store.getSession(session.id)).toMatchObject({ status: "failed", endedAt: failed.endedAt });
    await vi.waitFor(() => expect(api.chat.update).toHaveBeenCalled());   // the message is closed, not left at "started"
  });

  it("keeps the progress message reference when Lane 1 writes its own copy of the session", async () => {
    const { store, built, api } = setup({ git: new FakeGit() }, { [SLACK_SECRET_KEYS.bot]: "xoxb-1", [SLACK_SECRET_KEYS.app]: "xapp-1" });
    const task = { ...fx.task, source: { kind: "thread" as const, channelId: "C9", threadTs: "40.000100" } };
    await store.putTask(task);
    const session = { ...fx.session, taskId: task.id, status: "running" as const, slackProgress: undefined };
    await built.observedStore.putSession(session);
    await vi.waitFor(async () => expect((await store.getSession(session.id))?.slackProgress).toBeDefined());
    await built.observedStore.putSession({ ...session, status: "awaiting_approval" });   // Lane 1's copy has no reference
    expect(await store.getSession(session.id)).toMatchObject({ status: "awaiting_approval", slackProgress: { channelId: "C9" } });
    expect(api.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("remembers a Token Vault miss for a minute instead of asking Auth0 on every Slack call", async () => {
    let t = 1_000_000;
    const vault = { getUserToken: vi.fn(async () => null) };
    const webOptions = { makeApi: () => new Proxy({}, { get: () => new Proxy({}, { get: () => async () => { throw new Error("offline"); } }) }) };
    const { built } = setup({ tokenVault: vault, now: () => t, slackSeams: { webOptions } as never }, { [SLACK_SECRET_KEYS.user]: "xoxp-pasted" });
    await built.served.status();
    await built.served.status();
    expect(vault.getUserToken).toHaveBeenCalledTimes(1);
    t += 61_000;
    await built.served.status();
    expect(vault.getUserToken).toHaveBeenCalledTimes(2);
  });

  it("asks Token Vault again right after a sign-in, instead of waiting out its quiet minute", async () => {
    let signedIn = false;
    const vault = { getUserToken: vi.fn(async () => (signedIn ? { token: "xoxp-vault", source: "token_vault" as const } : null)) };
    const webOptions = { makeApi: () => new Proxy({}, { get: () => new Proxy({}, { get: () => async () => { throw new Error("offline"); } }) }) };
    const { built } = setup({ tokenVault: vault, now: () => 1_000_000, slackSeams: { webOptions } as never }, { [SLACK_SECRET_KEYS.user]: "xoxp-pasted" });
    await built.served.status();   // before sign-in: a miss, remembered
    signedIn = true;
    built.authChanged();
    await built.served.status();
    expect(vault.getUserToken).toHaveBeenCalledTimes(2);
  });

  it("keeps a session's newest status and its message reference when writes race on a slow store", async () => {
    for (let round = 0; round < 25; round++) {
      const base = new FakeEventStore();
      const pause = () => new Promise(r => setTimeout(r, Math.floor(Math.random() * 5)));
      // a store whose session reads and writes each take 0-5 ms, like real I/O
      const slow = new Proxy(base, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown;
          if (key === "getSession" || key === "putSession") return async (...a: unknown[]) => { await pause(); return (value as (...x: unknown[]) => unknown).apply(target, a); };
          return typeof value === "function" ? (value as (...x: unknown[]) => unknown).bind(target) : value;
        },
      }) as unknown as FakeEventStore;
      const { built, api } = setup({ store: slow, git: new FakeGit() }, { [SLACK_SECRET_KEYS.bot]: "xoxb-1", [SLACK_SECRET_KEYS.app]: "xapp-1" });
      const task = { ...fx.task, source: { kind: "thread" as const, channelId: "C9", threadTs: "40.000100" } };
      await base.putTask(task);
      const session = { ...fx.session, taskId: task.id, status: "running" as const, slackProgress: undefined, endedAt: undefined };
      const failed = { ...session, status: "failed" as const, endedAt: "2026-11-07T05:00:00.000Z" };
      await built.observedStore.putSession(session);
      await pause();
      await Promise.all([built.observedStore.putSession(session), built.observedStore.putSession(failed)]);
      await vi.waitFor(async () => expect((await base.getSession(session.id))?.slackProgress).toBeDefined());
      await vi.waitFor(() => expect(api.chat.update).toHaveBeenCalled());
      expect(await base.getSession(session.id), `round ${round}`).toMatchObject({ status: "failed", endedAt: failed.endedAt });
      expect(api.chat.postMessage).toHaveBeenCalledTimes(1);
    }
  }, 20_000);

  it("drops a Token Vault token Slack refuses and uses the pasted one, instead of failing until it expires", async () => {
    const used: string[] = [];
    const makeApi = (token: string) => new Proxy({}, { get: () => new Proxy({}, { get: (_g, name) => async () => {
      used.push(`${token}:${String(name)}`);
      if (token === "xoxp-vault") throw Object.assign(new Error("An API error occurred: invalid_auth"), { data: { error: "invalid_auth" } });
      if (name === "test") return { user_id: "U_ME", user: "brandon" };
      throw new Error("offline");
    } }) });
    const vault = { getUserToken: vi.fn(async () => ({ token: "xoxp-vault", source: "token_vault" as const })), invalidate: vi.fn() };
    const { built } = setup({ tokenVault: vault, now: () => 1_000_000, slackSeams: { webOptions: { makeApi } } as never }, { [SLACK_SECRET_KEYS.user]: "xoxp-pasted" });
    expect((await built.served.status()).postsAs).toBeNull();   // the vault token is refused
    expect(vault.invalidate).toHaveBeenCalledTimes(1);
    const after = await built.served.status();
    expect([after.postsAs?.name, after.userTokenSource]).toEqual(["brandon", "manual"]);
    expect(vault.getUserToken).toHaveBeenCalledTimes(1);   // not asked again during the quiet minute
    expect(used.filter(u => u.startsWith("xoxp-pasted")).length).toBeGreaterThan(0);
  });

  it("leaves Token Vault alone when Slack refuses a pasted token", async () => {
    const makeApi = () => new Proxy({}, { get: () => new Proxy({}, { get: () => async () => { throw Object.assign(new Error("invalid_auth"), { data: { error: "invalid_auth" } }); } }) });
    const vault = { getUserToken: vi.fn(async () => null), invalidate: vi.fn() };
    let t = 1_000_000;
    const { built } = setup({ tokenVault: vault, now: () => t, slackSeams: { webOptions: { makeApi } } as never }, { [SLACK_SECRET_KEYS.user]: "xoxp-pasted" });
    await built.served.status();
    expect(vault.invalidate).not.toHaveBeenCalled();
    t += 61_000;   // the vault's own miss window ends; a refused pasted token must not have extended it
    await built.served.status();
    expect(vault.getUserToken).toHaveBeenCalledTimes(2);
  });

  it("puts Lane 1's final summary in the closed progress message when it calls finish before storing the end", async () => {
    const { store, built, api } = setup({ git: new FakeGit() }, { [SLACK_SECRET_KEYS.bot]: "xoxb-1", [SLACK_SECRET_KEYS.app]: "xapp-1" });
    const task = { ...fx.task, source: { kind: "thread" as const, channelId: "C9", threadTs: "40.000100" } };
    await store.putTask(task);
    const session = { ...fx.session, taskId: task.id, status: "running" as const, slackProgress: undefined };
    await built.observedStore.putSession(session);
    await vi.waitFor(async () => expect((await store.getSession(session.id))?.slackProgress).toBeDefined());
    const done = { ...session, status: "done" as const };
    await built.progress!.finish(done, "Fixed the discount for qty > 1 and added a test.");
    await built.observedStore.putSession(done);
    await vi.waitFor(() => expect(api.chat.update).toHaveBeenCalled());
    const updates = () => api.chat.update.mock.calls as unknown as unknown[][];
    const texts = updates().map(c => JSON.stringify(c[0]));
    expect(texts.some(t => t.includes("Fixed the discount for qty"))).toBe(true);
    await new Promise(r => setTimeout(r, 20));
    expect(JSON.stringify(updates().at(-1)?.[0])).toContain("Fixed the discount for qty");   // the later store write does not edit it away
  });
});
