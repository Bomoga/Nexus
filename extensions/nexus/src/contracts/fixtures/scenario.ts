// The demo-thread scenario: one world every lane's fakes load (PLAN §2.12).
import { fx } from "./index";
import { scriptedAgentEvents, scriptedNexusEvents, scriptedReceipts } from "./stream";

export const demoScenario = {
  channel: fx.channels[0],
  channels: fx.channels,
  users: fx.slackUsers,
  thread: fx.thread,
  task: fx.task,
  session: fx.session,
  agentEvents: scriptedAgentEvents,
  approvals: [fx.approval, fx.approvalDecided],
  review: fx.review,
  plan: fx.plan,
  receipts: scriptedReceipts,
  events: scriptedNexusEvents(),
  accounts: fx.providerAccounts,
  models: fx.models,
  slackStatus: fx.slackStatus,
};
export type DemoScenario = typeof demoScenario;
