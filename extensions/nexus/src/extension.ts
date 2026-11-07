import * as vscode from "vscode";
import type { Lane2Services } from "./register/lane-1-features";
import { registerLane1 } from "./register/lane-1";
import { registerLane2 } from "./register/lane-2";
import { registerLane3 } from "./register/lane-3";

export function activate(context: vscode.ExtensionContext): void {
  // Lane 2 goes first so whatever it constructs (router, store, slack, git, makeGate, approvalHooks) reaches Lane 1.
  // While registerLane2 is still a stub that returns nothing, Lane 1 falls back to its stand-ins.
  const lane2 = (registerLane2(context) as Partial<Lane2Services> | undefined) ?? {};
  registerLane1(context, lane2);
  registerLane3(context);
}

export function deactivate(): void {}
