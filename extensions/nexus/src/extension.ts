import * as vscode from "vscode";
import { registerLane1 } from "./register/lane-1";
import { registerLane2 } from "./register/lane-2";
import { registerLane3 } from "./register/lane-3";

export function activate(context: vscode.ExtensionContext): void {
  registerLane1(context);
  registerLane2(context);
  registerLane3(context);
}

export function deactivate(): void {}
