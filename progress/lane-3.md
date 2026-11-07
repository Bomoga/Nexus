## Done
- H0-N1 webview skeleton smoke (in C:\dev\nexus-hello, outside the repo)
- H0-N3 theme.css + style test drafted; theme.css and Button seeded into webviews/shared/
- L3-02 globe core (attempt 2 confirmed by review; merged T+3:40)
- L3-08 Slack view part 1 (confirmed on first review; merged T+3:45)
- L3-01 first drop (component stubs + fakeBridge) merged early at T+3:25 so L3-02/L3-08 could start
- L3-01 shared kit (attempt 2 confirmed by review; merged T+4:00). Integration fixes at merge: chat tests import createFakeTransport from shared/fakeBridge; globe/chat local env.d.ts replaced by shared/env.d.ts; globe loads fixtures lazily so production bundles carry no demo data (checked: 0 demo strings in chat/globe main bundles).
- Wave 1 verified in a browser on ?fake=1: globe renders 159 scripted events with no console errors; Slack view shows channels, history and the status line.
- Lead: Slack and Approvals sidebar views declared in contributes/lane-3.json; package.json regenerated (contributes:check clean).
- L3-03 globe arcs, activity rings, live inserts (attempt 2 disputed only for literal NUL bytes in model/arcs.ts; Elkin approved a lead fix: separators now "\n"; merged T+5).
- L3-13 task editor (attempt 2 disputed only for §14 labels while the optimizer state is unknown; Elkin approved a lead fix: unknown optimizer ⇒ "data use unknown" + LEAVES MACHINE, fields locked during START, regression test proven to fail without the fix; merged T+5).
- After both merges: 134 tests / 11 files, typechecks, lint, build of chat/globe/task, contributes:check all green; 0 fixture strings in production bundles; 0 NUL bytes. Browser check on ?fake=1: task editor renders; globe live count rises with cubes/diamonds on the activity rings.

- Morning run (scheduled, Elkin asleep): merged origin/main into lane-3 (35 lane-2 commits: bridge router + webview host, slack web client, local event store) — clean, 291 tests green, pushed.

## Blocked — DECISION FOR ELKIN: L3-09 (Slack threads + composer)
- Not merged. Branch lane-3-wt/L3-09, worktree C:\dev\nexus-wt\L3-09. Commits: 085b63ed (attempt 1), dd52edc0 (attempt 2), 7a988ac1 (approved fix round: app-owned outbox store, MAKE TASK keyed by thread). All 129 tests pass; the four bugs from last night are fixed for their tested scenarios (their regression tests fail on dd52edc0).
- The fix round was DISPUTED (Opus reviewer, reproduced with probes in a scratch copy):
  1. NEW silent loss (regression vs dd52edc0): dropConfirmed (live.ts:157-167) matches identity + text with no ts bound, so an OLDER message of ours with the same text ("ok", "thanks") deletes a genuinely failed send and its RETRY — on return to the channel, or even with no navigation when the page loads after the failure. Fix: only our own copy with ts ≥ the echo's send time (minus skew) confirms it, one copy confirms at most one echo.
  2. Bug (b) still open for restored PENDING echoes: Slack delivers while away, user returns, pending echo shown beside the real message; the 30 s timeout then turns it into RETRY → double post.
  3. Post results reach only the view that sent them: close/reopen the thread pane while a reply is in flight → the row stays pending forever (failure) or a stale pending row stays beside the reply (success). Fix: the store notifies subscribed views per target; settlement must not go through the sender's closure.
- Root cause: without a clientId on ChatMessage, the view has to guess which Slack copy is "ours". The robust fix is cross-lane: an optional `clientId` on ChatMessage echoed by the host (contract change, Lane 1) and/or slack.post idempotent by clientId (Lane 2) — then every match is exact and RETRY after a timeout is safe.
- Options: (A) merge dd52edc0 (attempt 2) as the cp-1 version — its known issues are edge cases around switching channels/threads mid-send — and do the store work after the clientId contract lands; (B) one more focused fix round on 7a988ac1 for items 1-3 with probe-based tests; (C) hold until the contract change. Lead recommendation: (A) for cp-1 + push the clientId ask to Adrian/Brandon today; never merge 7a988ac1 as-is (item 1 is a regression).

- L3-04 globe picking + detail strip (attempt 2 confirmed by review; merged in the morning run). Click picks markers (individual + instanced), merge arcs and activity cubes/diamonds; drag never selects; one-row DetailStrip with OPEN/Enter → ui.openTarget; T+ origin 2026-11-07T03:00Z (22:00 ET). After merge: 312 tests / 21 files, typechecks, lint, builds, contributes:check green; 0 fixture strings; 0 NUL bytes. Not checked in a real browser: raycasting (jsdom can't render the Canvas) — worth a manual click test on /globe/?fake=1.
- Not done for L3-04: ?debug=1 pause/speed controls (no seam in Globe.tsx; small follow-up).

## In flight
- (none) — morning run stopped as planned after L3-04.
- Next: wave 4 (L3-05 search/tracking, L3-11 session view, L3-10 code refs) — not started; the hourly poll may start it.
- Lane 2's webview host (src/bridge/host.ts) renders a plain <body>; the task editor needs <body data-task-id="…"> (ask Brandon).
- Lead merge checklist now includes a NUL-byte scan (literal NULs slipped in twice and make git treat files as binary).
- style.test.tsx is ready (13 tests, pass with css enabled) and parked at C:\dev\nexus-hello\pending\ until vitest.config.ts has `test.css: true`

## Follow-ups (from reviews, not yet scheduled)
- Fake bridge live streams don't echo the fake's own writes (approvals.resolve, slack.post, tasks.*); slack.subscribe ignores channelIds.
- Chat (for L3-09): older-page load errors are silent; paging stalls if the first page doesn't overflow; Slack mrkdwn (`<url|label>`, `<@U…>`, `&amp;`) shown raw — who normalizes, Lane 2 or the view?; not-a-member dot uses amber (reserved for pending approval) and its tooltip isn't keyboard-reachable; no error boundary in main.tsx.
- Globe: rename model `useInstancing` (not a hook) to `shouldInstance`; tilts repeat after 5 families; InstancedMesh remounts when the count changes.
- Kit: dispose() leaves pending requests unsettled and sends no unsub; the lazy fake import has no .catch; two bridge tests don't pin pending-entry deletion and timer clearing on reply; active tab line overlaps the container border.
- Globe scene rendering has no test (a broken split in Scene.tsx compiled and passed all tests during the merge; caught by hand).

## Blocked
- Opening links from webviews: no contract request for external URLs (ui.openTarget only takes commit/session/thread). Asked Lane 1 for e.g. ui.openExternal; chat links render as buttons that do nothing until then.
- Slack avatars: remote images are blocked by the webview CSP; initials are shown. Asked Lane 2 to hand avatars over as data: URIs.
- @types/react-dom is not a dependency; webviews use a local ambient declaration until Lane 1 adds it.
- style.test.tsx (L3-01 acceptance) needs `test.css: true` in extensions/nexus/vitest.config.ts — Vitest replaces every .css import (including ?raw) with an empty string otherwise, so the test would run against nothing. That file is Lane 1's; asked Adrian.

## Decisions
T+0 = 22:00 ET, 2026-11-06 (as recorded by lane-2; team chat showed 22:02)
- RAM 32 GB, AMD Radeon RX 7900 XT (discrete GPU), Windows 11 → max 3 workers. Lead shell: Node v24.22.1 via fnm.
- Fork build test: npm install 6.7 min, first build ~1 min, incremental rebuild ~4.5 s, globe test pass.
- H0-N1 WebGL in a webview VIEW: yes. WebGL 2 (ANGLE/D3D11) with no warnings in a sidebar view and in a panel, under a strict CSP (nonce script, localResourceRoots = media/, Three.js 0.187 bundled by Vite 8, React 19). View 279x279: 360 fps (display refresh cap); panel 528x520: 229-245 fps. app.ping round trip 0.6 ms warm, 53 ms during extension-host startup.
- For L3-02: resizing the renderer inside a ResizeObserver callback while the canvas drives page height loops forever. Resize on the next frame, only when the width changes.
- Style test: jsdom does not substitute CSS custom properties, so the test resolves var(--nx-*) from theme.css :root itself. Verified it fails on a 24 px control and a rounded chip.
- H0-N4 provider smoke: skipped (no personal Anthropic credits); relying on Adrian's demo-machine smoke for model IDs.
- Worker branches are `lane-3-wt/<id>` (same reason as lane-2: git cannot create `lane-3/<id>` while `lane-3` exists).
- Open: accent color. PLAN L3-01 says #8b5cf6; the globe prototype uses #7F77DD. The kit seed uses #8b5cf6 until Adrian picks.

## Next
- Wave 1: Worker A on L3-01 (first commit = component stubs + fakeBridge.ts); then Worker B L3-02 and Worker C L3-08 once that commit is merged.
- Slack: authorize the Nexus app when the install link is available; set SLACK_USER_TOKEN.
