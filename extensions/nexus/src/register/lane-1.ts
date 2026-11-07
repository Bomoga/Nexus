import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { reseedDemoRepo } from "../features/demo/reseed";

// Lane 1 wiring: accounts, models, agent, tasks, sessions, approvals, swarms, auth.
// Lead-only file until wave 3: tasks list their registration lines and the lead adds them at merge time.
export function registerLane1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("nexus.dev.reseedDemoRepo", async () => {
      const dir = await vscode.window.showInputBox({ prompt: "Folder for the demo repo (replaced if it was seeded before)", value: join(homedir(), "nexus-demo") });
      if (dir === undefined) return;
      const res = await reseedDemoRepo(dir, {
        seedScript: join(context.extensionPath, "..", "..", "demo", "seed.mjs"),
        exists: existsSync,
        homeDir: homedir(),
        now: () => new Date().toISOString(),
        run: (script, args) => new Promise(resolve => {
          execFile(process.execPath, [script, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
            resolve({ code, output: `${stdout}\n${stderr}` });
          });
        }),
      });
      if (res.ok) void vscode.window.showInformationMessage(res.message);
      else void vscode.window.showErrorMessage(res.message);
    }),
  );
}
