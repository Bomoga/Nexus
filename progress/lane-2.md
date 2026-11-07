## Done
- L2-02 Slack web client merged to lane-2 (lead applied the last two fixes after a third dispute; not run against live Slack)
- Interface drops merged to lane-2: gate types, L2-02 slack interface + fake, L2-08 store interface + fake, L2-01 bridge interface + fake

## In flight
- L2-08 LocalStore + search: built, in review
- L2-01 router + host: phase 2 starting

## Blocked

## Decisions
T+0 = 22:00 ET, 2026-11-06
- 2026-11-06 RAM: 24 GB, max 3 workers. Lead shell Node v24.22.1 (login shell, fnm); non-login shells get /usr/local/bin/node v22.23.3.
- 2026-11-07 H0-B2 Socket Mode: OK from plain Node. @slack/bolt 5.1.0, socket-mode 3.1.1, web-api 8.3.0. Event `message`, no subtype, received in #nexus-build (bot is member). A user-token post was received.
- 2026-11-07 H0-B3 git API: OK, getAPI(1) is the only version (git ext 10.0.0, tag 1.145.2). Ref = {type: 0 Head | 1 RemoteHead | 2 Tag, name?, commit?, commitDetails?, remote?}; state.HEAD adds upstream, ahead, behind. state.refs was EMPTY at activation: use await repo.getRefs({}) / getBranches({remote:true}). Remote ref names already include the remote (origin/main). Repository also exposes createWorktree, deleteWorktree, diffBetween, merge (check before shelling out in L2-05/L2-06).
- 2026-11-07 H0-B3 child process: OK. child_process.fork JSON lines over stdin/stdout from the extension host, 55 ms. Child runs Electron's Node v24.22.0 (electron 43.8.3) with ELECTRON_RUN_AS_NODE=1, not v24.22.1. Pass a minimal env so tokens are not inherited.
- H0-B4 schema: 001/002 pass offline on PGlite with Timescale calls stubbed (run twice, one row per table, duplicate event dropped, first answer wins). PENDING apply on Tiger.
- H0-B4 NOTIFY ok?: PENDING. L2-11 reads this; if no, stays on 2 s polling.
- 2026-11-07 H0-B3 trust: in Restricted Mode an extension that declares extensionDependencies on vscode.git does not activate ("not supported in Restricted Mode"). An untrusted folder would stop Nexus the same way if it depends on vscode.git. To raise with Lane 1: startup defaults should turn workspace trust off (verified flag: --disable-workspace-trust; setting to confirm in L1-22).
- 2026-11-07 Worker branches are `lane-2-wt/<id>`, not `lane-2/<id>`: git cannot create `lane-2/x` while branch `lane-2` exists, so the naming in CLAUDE.md sections 10 and 11 cannot work. Needs a CLAUDE.md fix (Lane 1 owns that file). Sparse worktrees work: 2.1 MB plus 375 MB node_modules; max 3 workers.
- 2026-11-07 EventStore, SlackService and Gate use the method names in Lane 1's `src/features/ports.ts` (decideApproval, agentEvents, getThread, request) where PLAN 5.2 differs, so Lane 1 needs no adapters.
- 2026-11-07 `src/shared/redact.ts` is on lane-1, not on main. Until it lands, LocalStore and the bridge take the redactor as a required injected argument with no pass-through default.
- 2026-11-07 Slack: an xoxp post made through the Nexus app stores user + bot_id + app_id + bot_profile and no client_msg_id (checked on a real message in #nexus-build). bot_id does NOT mean bot. Trust users.info is_bot; use bot_id only if the lookup failed. L2-03 needs the same rule.
- 2026-11-07 Launch check before the interface-drop PR: fork activated nexus.nexus, no extension host errors (isolated profile, --disable-workspace-trust).
- 2026-11-07 decodeCodeRef in contracts can throw URIError on a malformed escape. Callers guard for now; a contracts PR is Adrian's and the team's call.

## Next
- Finish L2-01, L2-02, L2-08, then wave 2
