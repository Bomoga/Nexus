export const COMMANDS = {
  // §5 list
  "nexus.openHome": "Nexus: Open Home",                     "nexus.connectProvider": "Nexus: Connect provider",
  "nexus.pickModel": "Nexus: Pick model",                   "nexus.shareSelectionToSlack": "Nexus: Share to Slack",
  "nexus.makeTaskFromThread": "Nexus: Make task from thread", "nexus.openSession": "Nexus: Open session",
  "nexus.approve": "Nexus: Approve",                        "nexus.reject": "Nexus: Reject",
  "nexus.openCommit": "Nexus: Open commit",                 "nexus.mergeAgentBranch": "Nexus: Merge agent branch",
  "nexus.searchEvents": "Nexus: Search events",             "nexus.decomposeTask": "Nexus: Break into subtasks",
  "nexus.rerunSwarmReview": "Nexus: Re-run swarm review",
  // completed by the planning agent
  "nexus.signIn": "Nexus: Sign in (Auth0)",                 "nexus.signOut": "Nexus: Sign out",
  "nexus.connectSlack": "Nexus: Connect Slack",             // Token Vault first, manual token fallback
  "nexus.openSlack": "Nexus: Open Slack",                   "nexus.openApprovals": "Nexus: Open approvals",
  "nexus.openTimeline": "Nexus: Open timeline (globe fallback)",
  "nexus.toggleOptimizer": "Nexus: Toggle Optimize with Prune", "nexus.openReceipt": "Nexus: Open Prune receipt",
  "nexus.cancelSession": "Nexus: Cancel agent session",     "nexus.openCodeRef": "Nexus: Open code reference",
  "nexus.setTimeWindow": "Nexus: Set globe time window",    "nexus.showIdentity": "Nexus: Show Slack posting identity",
  "nexus.dev.reseedDemoRepo": "Nexus (dev): Re-seed demo repo",
  "nexus.newTask": "Nexus: New agent task",                 // a blank composer in the agent view: no Slack thread needed
} as const;
export type CommandId = keyof typeof COMMANDS;
export const COMMAND_OWNER: Record<CommandId, "lane-1" | "lane-2" | "lane-3"> = {
  "nexus.openHome": "lane-3", "nexus.connectProvider": "lane-1", "nexus.pickModel": "lane-1", "nexus.shareSelectionToSlack": "lane-3",
  "nexus.makeTaskFromThread": "lane-1", "nexus.openSession": "lane-3", "nexus.approve": "lane-1", "nexus.reject": "lane-1",
  "nexus.openCommit": "lane-3", "nexus.mergeAgentBranch": "lane-3", "nexus.searchEvents": "lane-3", "nexus.decomposeTask": "lane-1",
  "nexus.rerunSwarmReview": "lane-1", "nexus.signIn": "lane-1", "nexus.signOut": "lane-1", "nexus.connectSlack": "lane-2",
  "nexus.openSlack": "lane-3", "nexus.openApprovals": "lane-3", "nexus.openTimeline": "lane-3", "nexus.toggleOptimizer": "lane-1",
  "nexus.openReceipt": "lane-3", "nexus.cancelSession": "lane-1", "nexus.openCodeRef": "lane-2", "nexus.setTimeWindow": "lane-3",
  "nexus.showIdentity": "lane-2", "nexus.dev.reseedDemoRepo": "lane-1", "nexus.newTask": "lane-3",
};
