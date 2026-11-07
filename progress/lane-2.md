## Done
- L2-W1 Windows fixes merged to lane-2 (disputed once): isolated git config uses a real empty file instead of os.devNull; the gate awaits taskkill (3 s cap) before reporting a killed run, and finishes a timed-out run even when the kill leaves the child running; gate tests are platform-neutral (node -e), poll instead of fixed 20 ms waits, and skip on win32 only for POSIX process groups and the POSIX PATH-shadow script. Verified on macOS only.
- PR #33 merged to main: code refs, nexus:// coderef links, ui.openTarget, notification-text sanitizing. Launch check passed.
- L2-14 code refs (disputed once) and L2-16 ui.openTarget merged to lane-2 and wired: coderef.create/open, the nexus:// coderef route (failures shown to the user), nexus.openCodeRef, a read-only nexus-git: view of a file at a commit with "Open Current Version". A decoded vscode.Uri path is re-encoded so links decode once. Launch check pending.
- Wave 3 merged to lane-2 and wired: L2-06 session worktrees + commits bound to the approved diff + merge agent branch, L2-07 git watcher (globe events), L2-04 Slack cache. Launch check: on the Nexus repo the watcher wrote 313 events (lane-1 109, lane-2 76, lane-3 91, main 28), no extension host errors.
- Wiring: register/lane-2.ts now provides the Slack service, git service and gate to Lane 1, and serves app.ping, store.*, events.query/search/subscribe, slack.*, git.commit.show, git.branches and ui.openExternal. Launch check: nexus.nexus activates, no extension host errors.
- Wave 2 merged to lane-2: L2-13 gate, L2-05 git read side, L2-03 live Slack (each disputed twice; lead applied the last fixes, each pinned by a mutant)
- L2-08 LocalStore + search merged to lane-2 (three disputes; lead applied the last fix). Adrian's controllers shadowed into it: 1,069 writes, 0 refused
- L2-01 router + host merged to lane-2 (lead applied the final fixes; panels retained, reused ids replace)
- Wave 1 launch check on lane-2: nexus.nexus activated, no extension host errors
- L2-02 Slack web client merged to lane-2 (lead applied the last two fixes after a third dispute; not run against live Slack)
- Interface drops merged to lane-2: gate types, L2-02 slack interface + fake, L2-08 store interface + fake, L2-01 bridge interface + fake

## In flight

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
- 2026-11-07 LocalStore refuses anything the contract schemas reject, and rejects the put. Callers must supply ISO times (L2-07: use %cI), integer exitCode (L2-13: map a killed process to an integer), 40-char lowercase SHAs, nexus/agent-<id> branches, no extra keys. Real Clock and GitPort adapters: ids matching [A-Za-z0-9_-]+, non-empty baseBranch.
- 2026-11-07 For L2-10: after a crash between the two appends, a ghost outbox line identical to an older journal line is not dropped (waived by Brandon's lead-fix call). The fix is writing the outbox id into journal lines.
- 2026-11-07 Bridge wiring still to do in src/register/lane-2.ts: one shared NexusBridgeRouter with a real containsSecret, log and redact (needs src/shared/redact.ts on main), declare nexus.t0 in contributes/lane-2.json, key the store directory by folder path.
- 2026-11-07 Elkin: host loads media/<entry>.js as a classic script; the planned Vite output may differ. A reloaded page must resubscribe with fromSeq.
- 2026-11-07 Adrian: lane-1 hang paths on store I/O failure: approvals-controller.ts:218-223, sessions-controller.ts:159-160 and 166-167.
- 2026-11-07 URLs: the fork hands an extension only nexus://<extension-id>/..., so the frozen nexus://auth/callback and nexus://coderef/... never reach Nexus (extensionUrlHandler.ts:155). Also product.json urlProtocol is still code-oss, and trustedExtensionProtocolHandlers should list nexus.nexus. Needs Lane 1: a core change or a contracts PR. Lane 2's UriRouter accepts both spellings and a decoded vscode.Uri.
- 2026-11-07 Webview host loads Vite's media/<entry>/index.html (proven in the fork with Lane 3's real chat and globe build). CSP: nonce plus cspSource for scripts, no strict-dynamic.
- 2026-11-07 Git interface widened for L2-07/L2-13/L2-14: refs, branchesContaining, contains, fileAt, isDirty, and a path-scoped diff against a base commit.
- 2026-11-07 Gate limits: a descendant that calls setsid() survives the timeout kill; Windows shim quoting, taskkill and bare-name refusal are unit-tested only (never run on Windows). The recheck between commit approval and commitIn leaves a window of tens of milliseconds.
- 2026-11-07 For L2-06: git.diff must include untracked files (or the human approves a diff missing whole files that commitIn then commits).
- 2026-11-07 Slack: the SDK's delayReconnectAttempt is replaced on our client (hardenReconnect) because the SDK drops a rejection and retries forever. Unpinned: no test catches createBoltApp dropping that call. The host must store ApprovalRequest.slackMessage before a card can be clicked. L2-S1 (live) not run yet.
- 2026-11-07 For Adrian: a Slack APPROVE click needs Lane 1's approvals controller. registerLane2 returns setSlackApprovalResolver; Lane 1 must call it with approvals.resolve after composing (until then a Slack click is refused, app and notification approvals work). The Slack approval card posts only for tasks whose source is a thread.
- 2026-11-07 Slack tokens: SecretStorage (Nexus: Connect Slack) first, then SLACK_USER_TOKEN / SLACK_BOT_TOKEN / SLACK_APP_TOKEN from the environment in development.
- 2026-11-07 Slack cache known limit: re-paging the same channel past the cache cap a second time skips some middle history (SlackService.history has no "older than" parameter). The first walk is complete.
- 2026-11-07 Commits are bound to the approved diff (temporary index, --full-index --binary, submodules always shown); a merge refuses to overwrite ignored files, compared case-folded. The agent's commit message may not contain a scissors line.
- 2026-11-07 L2-09 (Tiger schema) is waiting on the Tiger connection string; wave 3 ran L2-07 in its place.
- 2026-11-07 For Elkin: ui.openTarget calls Lane 3's commands: nexus.openCommit(sha: string), nexus.openSession(sessionId: string), nexus.openSlack({ channelId, threadTs }). nexus.openCommit is not registered yet, so a commit click on the globe shows "not found" until it is. Share to Slack can use the coderef.create bridge handler (refuses a dirty file with code "conflict") and formatCodeRefForSlack (services/coderef/slack-format.ts, capped at 3000 characters) in place of its own formatter; nexus.openCodeRef takes a CodeRef or a nexus:// link.
- 2026-11-07 For Adrian (Windows): the gate's symlink tests need symlink privilege (Developer Mode or admin) and fail with EPERM without it; `node` must be on PATH. On win32 a timed-out command reports exit code 1 (taskkill /F), indistinguishable from a normal failure.
- 2026-11-07 Code refs known limit: a committed symlink opens whatever it points to (local files only).
- 2026-11-07 Security: VS Code turns [label](command:...) in an extension's notification text into a clickable link that runs the command. All untrusted text in a notification goes through plainNotificationText (src/shared/plain-text.ts). Lane 2 uses it for code-ref paths and Slack names; Lane 1 fixed the approval notification and commands.ts in 344eb5ec. Still open, for Elkin: share-selection.ts:93 and :95 show file paths and raw errors, once it is wired.

## Next
- Adrian: rerun `npx vitest run src/services/git src/services/gate src/services/coderef` on Windows; L2-S1 live Slack check (Brandon); L2-09 Tiger schema once the connection string is in; then L2-10 Tiger store, L2-11 sync, L2-12 aggregates; L2-15 Token Vault
