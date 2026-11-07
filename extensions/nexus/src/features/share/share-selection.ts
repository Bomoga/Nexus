// "Nexus: Share to Slack" (editor context menu). Extension-host code, written against injected dependencies so it
// is testable without the real vscode module; src/register/lane-3.ts supplies the real ones.
import type * as vscode from "vscode";
import type { Channel, ChatMessage, CodeRef } from "../../contracts";

export interface EditorSelection {
  /** Workspace-relative path. */
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

export interface PickItem {
  label: string;
  description?: string;
  channelId?: string;
}

export interface PostArgs {
  channelId: string;
  text: string;
  threadTs?: string;
  clientId: string;
}

export interface ShareDeps {
  getSelection(): EditorSelection | undefined;
  /** coderef.create semantics. */
  createRef(path: string, startLine: number, endLine: number): Promise<{ ref: CodeRef; link: string; snippet: string }>;
  listChannels(): Promise<Channel[]>;
  showQuickPick(items: PickItem[], options: { placeHolder: string }): Promise<PickItem | undefined>;
  showInputBox(options: { prompt: string; placeHolder?: string }): Promise<string | undefined>;
  /** slack.post semantics: posts as the signed-in USER. */
  post(args: PostArgs): Promise<ChatMessage>;
  showInfo(message: string): void;
  showError(message: string): void;
  /** Shows the posted message in the Slack view. */
  revealChat(channelId: string, threadTs?: string): void;
}

const FENCE = "`".repeat(3);
const THREAD_PICK = "Reply in a thread…";
let counter = 0;

/** Breaks any run of three backticks so the snippet cannot close our fence (zero-width space inserted). */
function neutraliseFences(snippet: string): string {
  return snippet.replace(/`{3,}/g, (m) => m.split("").join("​"));
}

function newClientId(): string {
  counter += 1;
  return `share-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Text exactly: "<link>\n```\n<snippet>\n```". */
export function formatShareText(link: string, snippet: string): string {
  return `${link}\n${FENCE}\n${neutraliseFences(snippet)}\n${FENCE}`;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function shareSelection(deps: ShareDeps): Promise<void> {
  const sel = deps.getSelection();
  if (!sel) {
    deps.showError("Nexus: select some code in an editor first.");
    return;
  }
  try {
    const { link, snippet } = await deps.createRef(sel.path, sel.startLine, sel.endLine);
    const channels = (await deps.listChannels()).filter((c) => c.isMember);
    if (channels.length === 0) {
      deps.showError("Nexus: you are not a member of any Slack channel Nexus can see.");
      return;
    }
    const channel = await deps.showQuickPick(
      channels.map((c) => ({ label: `${c.isPrivate ? "🔒" : "#"}${c.name}`, channelId: c.id })),
      { placeHolder: "Share to which channel?" },
    );
    if (!channel?.channelId) return;
    const mode = await deps.showQuickPick([{ label: "Post to channel" }, { label: THREAD_PICK }], { placeHolder: "Where in the channel?" });
    if (!mode) return;
    let threadTs: string | undefined;
    if (mode.label === THREAD_PICK) {
      const ts = (await deps.showInputBox({ prompt: "Thread timestamp (the thread parent's ts)", placeHolder: "1762485300.000100" }))?.trim();
      if (!ts) return;
      threadTs = ts;
    }
    await deps.post({ channelId: channel.channelId, text: formatShareText(link, snippet), threadTs, clientId: newClientId() });
    deps.revealChat(channel.channelId, threadTs);
    deps.showInfo(`Shared ${sel.path}:${sel.startLine}-${sel.endLine} to ${channel.label}.`);
  } catch (e) {
    deps.showError(`Nexus: could not share to Slack: ${messageOf(e)}`);
  }
}

export interface RegisterShareDeps extends ShareDeps {
  registerCommand(command: string, callback: () => unknown): vscode.Disposable;
}

export function registerShareSelection(context: Pick<vscode.ExtensionContext, "subscriptions">, deps: RegisterShareDeps): void {
  context.subscriptions.push(deps.registerCommand("nexus.shareSelectionToSlack", () => shareSelection(deps)));
}
