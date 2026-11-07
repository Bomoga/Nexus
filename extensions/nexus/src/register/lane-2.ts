import { join } from "node:path";
import * as vscode from "vscode";
import { NexusBridgeRouter } from "../bridge/router";
import { handleAuthUri } from "../features/auth/current";
import { redact } from "../shared/redact";
import { UriRouter } from "../services/coderef/uri-handler";
import { LocalStore } from "../services/events/local-store";
import type { Lane2Services } from "./lane-1-features";

// Lane 2 wiring: slack, git, events, coderef, gate, bridge.
// Wired here (Adrian's call, to unblock cp-1): the shared bridge router, the local event store and the nexus:// URI handler.
// Not on main yet, so not wired: the real Slack service (only the user-token web client exists), the git service, the gate.
// Those stay on Lane 1's stand-ins and refusals (`withFallbacks`); add them to the returned object when they land.
export type Lane2Wiring = Pick<Lane2Services, "router" | "store"> & { router: NexusBridgeRouter };

export function registerLane2(context: vscode.ExtensionContext): Lane2Wiring {
  const log = (message: string, detail?: unknown) => console.warn(`Nexus bridge: ${message}`, detail ?? "");

  const router = new NexusBridgeRouter({
    // A body or error that still changes under redaction contains a secret pattern, so it is never posted.
    containsSecret: value => {
      try {
        const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
        return redact(text) !== text;
      } catch {
        return true;
      }
    },
    log,
  });

  const workspaceSlug = (vscode.workspace.workspaceFolders?.[0]?.name ?? "default").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const store = new LocalStore({ dir: join(context.globalStorageUri.fsPath, "workspaces", workspaceSlug), redact });
  if (store.skippedLines() > 0) log(`local store skipped ${store.skippedLines()} unreadable line(s) on open`);

  // One handler for every nexus:// link. Core only delivers nexus://nexus.nexus/<route>; UriRouter normalizes it.
  const uris = new UriRouter();
  context.subscriptions.push(
    uris.registerRoute("auth", uri => handleAuthUri(uri)),
    vscode.window.registerUriHandler({ handleUri: uri => { void uris.handle(uri); } }),
  );

  return { router, store };
}
