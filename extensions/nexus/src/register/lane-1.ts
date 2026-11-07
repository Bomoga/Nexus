import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { AccountsService, secretKeyFor } from "../features/accounts/accounts-service";
import { connectProvider, type ConnectUi } from "../features/accounts/connect-provider";
import { ModelPicker, type PickerItem, type PickerUi } from "../features/accounts/model-picker";
import { reseedDemoRepo } from "../features/demo/reseed";
import { HomeKeeper } from "../features/home/open-home";
import { createProviders } from "../models/registry";

// Lane 1 wiring: accounts, models, agent, tasks, sessions, approvals, swarms, auth.
// Lead-only file until wave 3: tasks list their registration lines and the lead adds them at merge time.
export function registerLane1(context: vscode.ExtensionContext): void {
  const accounts = new AccountsService({ secrets: context.secrets, state: context.globalState, providers: createProviders() });
  const picker = registerModelPicker(context, accounts);
  registerConnectProvider(context, accounts, picker);
  registerReseedDemoRepo(context);
  registerHomeKeeper(context);
}

function registerModelPicker(context: vscode.ExtensionContext, accounts: AccountsService): ModelPicker {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  bar.command = "nexus.pickModel";
  const ui: PickerUi = {
    setStatus: (text, tooltip) => { bar.text = text; bar.tooltip = tooltip; bar.show(); },
    showPick: async items => {
      type QuickItem = vscode.QuickPickItem & { source?: PickerItem };
      const quick: QuickItem[] = items.map(i =>
        i.kind === "separator"
          ? { label: i.label, kind: vscode.QuickPickItemKind.Separator }
          : { label: i.label, description: i.description, detail: i.detail, source: i });
      const chosen = await vscode.window.showQuickPick(quick, { placeHolder: "Pick the model for the coding agent", matchOnDescription: true });
      return chosen?.source;
    },
  };
  const picker = new ModelPicker({ accounts, state: context.workspaceState, ui });
  context.subscriptions.push(
    bar,
    vscode.commands.registerCommand("nexus.pickModel", async () => {
      if ((await picker.pick()) === "empty") {
        const go = await vscode.window.showInformationMessage("No provider is connected yet.", "Connect provider");
        if (go) await vscode.commands.executeCommand("nexus.connectProvider");
      }
    }),
  );
  // Verify stored keys in the background; the status bar item appears as soon as the first answer is known.
  void picker.refreshStatus();
  void accounts.list().then(() => picker.refreshStatus());
  return picker;
}

function registerConnectProvider(context: vscode.ExtensionContext, accounts: AccountsService, picker: ModelPicker): void {
  const ui: ConnectUi = {
    pickProvider: async items => (await vscode.window.showQuickPick(items.map(i => ({ label: i.label, id: i.id })), { placeHolder: "Which provider?" }))?.id,
    promptKey: label => Promise.resolve(vscode.window.showInputBox({ prompt: `${label}: paste the key`, password: true, ignoreFocusOut: true })),
    askYesNo: async q => {
      const a = await vscode.window.showQuickPick(["Yes", "No"], { placeHolder: q, ignoreFocusOut: true });
      return a === undefined ? undefined : a === "Yes";
    },
    info: m => void vscode.window.showInformationMessage(m),
    error: m => void vscode.window.showErrorMessage(m),
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("nexus.connectProvider", async () => {
      await connectProvider({ accounts, ui, aux: { saveAuxKey: (name, key) => Promise.resolve(context.secrets.store(secretKeyFor(name), key)) } });
      await picker.refreshStatus();
    }),
  );
}

function registerReseedDemoRepo(context: vscode.ExtensionContext): void {
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

/** Opens the Nexus home at startup and whenever the last editor closes (the home itself is Lane 3's `nexus.openHome`). */
function registerHomeKeeper(context: vscode.ExtensionContext): void {
  let warned = false;
  const keeper = new HomeKeeper({
    tabCount: () => vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0),
    openHome: async () => { await vscode.commands.executeCommand("nexus.openHome"); },
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    onError: e => {
      if (warned) return;
      warned = true;                                    // e.g. nexus.openHome is not registered yet in this build
      console.warn("Nexus: could not open the home:", e instanceof Error ? e.message : e);
    },
  });
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => keeper.tabsChanged()), { dispose: () => keeper.dispose() });
  keeper.start();
}
