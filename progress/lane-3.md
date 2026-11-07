## Done
- H0-N1 webview skeleton smoke (in C:\dev\nexus-hello, outside the repo)
- H0-N3 theme.css + style test drafted; theme.css and Button seeded into webviews/shared/
- L3-02 globe core (attempt 2 confirmed by review; merged T+3:40)
- L3-08 Slack view part 1 (confirmed on first review; merged T+3:45)
- L3-01 first drop (component stubs + fakeBridge) merged early at T+3:25 so L3-02/L3-08 could start

## In flight
- L3-01 shared kit: attempt 2 (bridge timeouts, validate-before-subscribe, lazy fake, shared ambient types) in re-review

## Follow-ups (from reviews, not yet scheduled)
- Fake bridge live streams don't echo the fake's own writes (approvals.resolve, slack.post, tasks.*); slack.subscribe ignores channelIds.
- Chat (for L3-09): older-page load errors are silent; paging stalls if the first page doesn't overflow; Slack mrkdwn (`<url|label>`, `<@U…>`, `&amp;`) shown raw — who normalizes, Lane 2 or the view?; not-a-member dot uses amber (reserved for pending approval) and its tooltip isn't keyboard-reachable; no error boundary in main.tsx.
- Globe: rename model `useInstancing` (not a hook) to `shouldInstance`; tilts repeat after 5 families; InstancedMesh remounts when the count changes.
- After L3-01 merges: delete webviews/globe/env.d.ts and webviews/chat/env.d.ts in favour of the kit's shared webviews/shared/env.d.ts.

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
