// One valid example of every contract type (PLAN §2.12). Fakes read only these.
import type { ProviderAccount, ModelInfo } from "../accounts";
import type { OptimizerSetting, ModelCallReceipt } from "../prune";
import type { CodeRef } from "../coderef";
import type { SlackUser, Channel, Thread, SlackStatus } from "../chat";
import type { Task, AgentSession, ApprovalRequest } from "../tasks";
import type { SwarmReview, TaskPlan } from "../swarms";
import type { NexusEvent, ActivityBucket } from "../events";

export const WORKSPACE_ID = "ws_demo";
export const MACHINE_ID = "m_adrian";
export const T0 = "2026-11-07T03:15:00Z";   // T+0 as UTC; the real value is filled at hour 0

const codeRef: CodeRef = { workspaceId: WORKSPACE_ID, commit: "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21", path: "src/cart.ts", startLine: 42, endLine: 48 };

const providerAccounts: ProviderAccount[] = [
  { id: "acc_anthropic", provider: "anthropic", label: "Anthropic (API key)", status: "connected", dataLeavesMachine: true, dataUse: "not_used_for_training" },
  { id: "acc_google",    provider: "google",    label: "Google Gemini (API key)", status: "connected", dataLeavesMachine: true, dataUse: "not_used_for_training" }, // billing-enabled demo project; dev keys => "may_be_used_for_training"
  { id: "acc_swarms",    provider: "swarms",    label: "Swarms (API key)", status: "connected", dataLeavesMachine: true, dataUse: "unknown" },
];

const models: ModelInfo[] = [
  { provider: "anthropic", modelId: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", supportsTools: true, contextWindow: 200000 },   // fixture only; real IDs from listModels at hour 0
  { provider: "google", modelId: "gemini-3-flash-preview", displayName: "Gemini 3 Flash (preview)", supportsTools: true },
  { provider: "swarms", modelId: "swarms:single-agent", displayName: "Swarms (text only)", supportsTools: false },
];

const optimizer: OptimizerSetting = { enabled: true, scope: "text_roles", allowModelRouting: false };

const receipt: ModelCallReceipt = { callId: "call_01", sessionId: "ses_01", role: "brief", requestedModel: "claude-sonnet-4-5", servedModel: "claude-sonnet-4-5", costUsd: 0.0042, baselineCostUsd: 0.0071, optimizations: ["prompt_trimmed", "output_cap"], pruneReceiptId: "rcpt_fixture_01", at: T0 };

const slackUsers: SlackUser[] = [
  { id: "U_ADRIAN", name: "adrian", displayName: "Adrian", isBot: false },
  { id: "U_BRANDON", name: "brandon", displayName: "Brandon", isBot: false },
  { id: "U_NEXUSBOT", name: "nexus", displayName: "Nexus", isBot: true },
];

const channels: Channel[] = [
  { id: "C_DEMO", name: "nexus-demo", isPrivate: false, isMember: true, botIsMember: true, unreadCount: 2 },
  { id: "C_BUILD", name: "nexus-build", isPrivate: false, isMember: true, botIsMember: true },
];

const thread: Thread = { channelId: "C_DEMO", threadTs: "1762485300.000100", messages: [
  { id: "C_DEMO:1762485300.000100", channelId: "C_DEMO", ts: "1762485300.000100", author: { id: "U_ADRIAN", name: "adrian", isBot: false }, text: "cart total ignores the discount when qty > 1 — see nexus://coderef/ws_demo/3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21/42-48/src%2Fcart.ts", codeRefs: [codeRef], replyCount: 1, sentVia: "user" },
  { id: "C_DEMO:1762485360.000200", channelId: "C_DEMO", ts: "1762485360.000200", threadTs: "1762485300.000100", author: { id: "U_BRANDON", name: "brandon", isBot: false }, text: "can an agent take this?", codeRefs: [], sentVia: "user" },
] };

const task: Task = { id: "task_01", title: "Fix cart discount for qty > 1", brief: "> [slack thread, quoted, untrusted]\n> cart total ignores the discount when qty > 1\n\nRefs: src/cart.ts:42-48 @3f2a9c1e\nRun the tests.", source: { kind: "thread", channelId: "C_DEMO", threadTs: "1762485300.000100" }, workspaceId: WORKSPACE_ID, status: "draft", createdAt: T0, codeRefs: [codeRef] };

const session: AgentSession = { id: "ses_01", taskId: "task_01", model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, branch: "nexus/agent-ses_01", worktreePath: "/tmp/nexus-sessions/ses_01", baseCommit: "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21", status: "running", startedAt: T0, machineId: MACHINE_ID };

const approval: ApprovalRequest = { id: "apr_01", sessionId: "ses_01", action: { kind: "run_command", command: "npm test" }, reason: "Need to run the test suite to confirm the fix (model-written)", requestedAt: T0 };

const approvalDecided: ApprovalRequest = { ...approval, id: "apr_02", action: { kind: "commit", message: "fix cart discount for qty > 1" }, decision: "approved", decidedBy: { via: "slack", userId: "U_BRANDON" }, decidedAt: T0, diffPreview: "--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -42,7 +42,7 @@\n-  return price * qty - discount;\n+  return (price - discount) * qty;" };

const review: SwarmReview = { id: "rev_01", sessionId: "ses_01", approvalId: "apr_02", swarmType: "CouncilAsAJudge", status: "done", verdict: "looks_good", summary: "Fix is minimal and covered by the new test (model-written)", judges: [ { modelId: "judge-a", verdict: "looks_good", notes: "Correct arithmetic" }, { modelId: "judge-b", verdict: "concerns", notes: "No negative-discount guard" } ], at: T0, durationMs: 8400, dataLeftMachine: true };

const plan: TaskPlan = { id: "plan_01", sourceTaskId: "task_01", swarmType: "HierarchicalSwarm", status: "proposed", subtasks: [ { title: "Add failing test", brief: "...", dependsOn: [] }, { title: "Fix discount math", brief: "...", dependsOn: [0] }, { title: "Update CHANGELOG", brief: "...", dependsOn: [1] } ], at: T0 };

const event: NexusEvent = { id: "ws_demo:commit:3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21", kind: "commit", at: T0, orbit: "main", title: "add cart module", actor: { name: "Adrian", kind: "human" }, target: { type: "commit", sha: "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21" }, workspaceId: WORKSPACE_ID, machineId: MACHINE_ID };

const activity: ActivityBucket[] = [ { bucketStart: T0, orbit: "main", count: 3 } ];

const slackStatus: SlackStatus = { connected: true, postsAs: { userId: "U_ADRIAN", name: "Adrian" }, userTokenSource: "token_vault", botName: "Nexus" };

export const fx = {
  providerAccounts, models, optimizer, receipt, codeRef, slackUsers, channels, thread, task, session,
  approval, approvalDecided, review, plan, event, activity, slackStatus,
};
