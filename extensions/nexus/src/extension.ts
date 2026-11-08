import * as vscode from "vscode";
import type { Lane2Services } from "./register/lane-1-features";
import type { NexusBridgeRouter } from "./bridge/router";
import { registerLane1 } from "./register/lane-1";
import { registerLane2 } from "./register/lane-2";
import type { Lane3Views } from "./features/views/lane3-views";
import { registerLane3 } from "./register/lane-3";

export function activate(context: vscode.ExtensionContext): void {
  // Lane 2 goes first so whatever it constructs (router, store, slack, git, makeGate, approvalHooks) reaches Lane 1.
  // While registerLane2 is still a stub that returns nothing, Lane 1 falls back to its stand-ins.
  const lane2: Partial<Lane2Services> = registerLane2(context);
  // Lane 1 runs first but "Make task" must open Lane 3's task editor, so hand it a late-bound opener.
  const lane3: { views?: Lane3Views } = {};
  const lane1 = registerLane1(context, lane2, taskId => lane3.views?.openTaskEditor(taskId));
  lane3.views = registerLane3(context, lane2.router as NexusBridgeRouter, { receipts: lane1.receipts });
}

export function deactivate(): void {}
