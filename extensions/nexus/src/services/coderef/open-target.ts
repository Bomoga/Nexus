// ui.openTarget: a webview (globe, search, detail strip) asks the host to open an event's target. Routing only: the
// commands themselves belong to Lane 3. The target can originate from Slack or remote teammates, so every field is
// validated again here and nothing but the validated fields is ever passed to a command.
import { Id, Sha } from "../../contracts";
import type { EventTarget, Req } from "../../contracts";
import { BridgeError } from "../../bridge/types";
import type { BridgeRouter, Disposable } from "../../bridge/types";

export interface OpenTargetDeps {
  /** vscode.commands.executeCommand, injected. Rejects with "command '<id>' not found" when nothing is registered. */
  executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
}

// Slack channel ids are upper-case alphanumerics (C0123ABCD); the bound is loose enough for fixtures like "C_DEMO".
const CHANNEL_ID = /^[A-Z][A-Z0-9_]{0,31}$/;
const SLACK_TS = /^\d{1,12}\.\d{1,9}$/;

interface Route { command: string; arg: unknown; what: string }

function route(target: EventTarget): Route {
  const t = target as { type?: unknown; sha?: unknown; sessionId?: unknown; channelId?: unknown; threadTs?: unknown };
  switch (t.type) {
    case "commit": {
      const sha = Sha.safeParse(t.sha);
      if (!sha.success) throw new BridgeError("invalid_request", "the commit id is not a full 40-character SHA");
      return { command: "nexus.openCommit", arg: sha.data, what: "the commit view" };
    }
    case "session": {
      const id = Id.safeParse(t.sessionId);
      if (!id.success) throw new BridgeError("invalid_request", "the session id is not valid");
      return { command: "nexus.openSession", arg: id.data, what: "the session view" };
    }
    case "thread": {
      if (typeof t.channelId !== "string" || !CHANNEL_ID.test(t.channelId)) throw new BridgeError("invalid_request", "the Slack channel id is not valid");
      if (typeof t.threadTs !== "string" || !SLACK_TS.test(t.threadTs)) throw new BridgeError("invalid_request", "the Slack thread timestamp is not valid");
      return { command: "nexus.openSlack", arg: { channelId: t.channelId, threadTs: t.threadTs }, what: "the Slack view" };
    }
    default: throw new BridgeError("invalid_request", "unknown target type");
  }
}

function isCommandNotFound(e: unknown): boolean {
  return e instanceof Error && /command '[^']*' not found/i.test(e.message);
}

/** Registers the ui.openTarget handler. */
export function registerOpenTarget(router: BridgeRouter, deps: OpenTargetDeps): Disposable {
  return router.handle("ui.openTarget", async (req: Req<"ui.openTarget">) => {
    const r = route(req);
    try { await deps.executeCommand(r.command, r.arg); }
    catch (e) {
      if (isCommandNotFound(e)) throw new BridgeError("not_found", `${r.what} is not available (${r.command} is not registered)`);
      throw new BridgeError("internal", `could not open ${r.what}`);
    }
    return {};
  });
}
