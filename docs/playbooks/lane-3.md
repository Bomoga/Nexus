# Lane 3 playbook — Elkin (every webview UI)

Branch `lane-3`. Workers: **3** if 16 GB, **2** if 8 GB (record at H0-N5; `PLAN §1 Q4`). Everything in this lane lives under `extensions/nexus/webviews/**` plus three small extension-side files named in PLAN (`src/features/share/share-selection.ts`, `src/features/gitviews/open-commit.ts`, `contributes/lane-3.json`). Load: 16 tasks / 33 wh against ~47 nominal → ~14 wh of slack that `PLAN §1 Q1(c)` earmarks for borrowing Lane 1 UI-adjacent work after cp-1.

Every view runs standalone against the **fixture bridge** (`webviews/shared/fakeBridge.ts`, `PLAN §5.3 L3-01`) with `vite` and `?fake=1`, so no Lane 3 task ever waits for Lane 1 or Lane 2 code — only for the contracts (`PLAN §2.9` request/subscription names). The UI rules from `CLAUDE.md` §6 are enforced mechanically by `webviews/shared/style.test.tsx` (`PLAN §5.3` intro): every acceptance runs it.

## 0. Hour 0 — column **N** of `PLAN §4.3`

H0-N1 webview skeleton + globe prototype in a **webview view** (WebGL smoke) → H0-N2 switch checkout → H0-N3 your `xoxp` token + "posts as me" smoke, then `theme.css` geometry tokens → H0-N4 contracts review with Adrian (10 min), then Anthropic/Gemini dev-key smoke from a Node script (note working model IDs) → H0-N5 sparse worktree + RAM + launch the skeleton → H0-N6 dispatch.

Write into `progress/lane-3.md` → Decisions: WebGL in a webview view ok?/RAM/model IDs seen.

## 1. Wave 1 — T+2 → T+5 (kit first, two views start on stubs at T+2:30)

| Slot | Task | PLAN ref | Owns | Done when | Next |
|---|---|---|---|---|---|
| Worker A | **L3-01** shared kit: Vite build, theme tokens, components, `bridgeClient`, `fakeBridge` (L) | §5.3 L3-01 | `webviews/shared/**`, `scripts/build-webviews.mjs`, `webviews/tsconfig.json`, `vite.config.ts` (initial) | `npx vitest run webviews/shared && npm run build:webviews` | L3-03 |
| Worker B (from T+2:30) | **L3-02** globe core: planet, orbits, angle = time, window (L) | §5.3 L3-02 | `webviews/globe/scene/**`, `webviews/globe/model/**`, globe entry files | `npx vitest run webviews/globe/model && npm run build:webviews` | — |
| Worker C (16 GB, from T+2:30) | **L3-08** Slack view part 1: channels + history (L) | §5.3 L3-08 | `webviews/chat/{ChannelList,History,MessageRow,StatusBar,App}.tsx` + entry | `npx vitest run webviews/chat/ChannelList.test.tsx webviews/chat/History.test.tsx && npm run build:webviews` | L3-09 |

**Drop at T+2:30 (Worker A's first commit):** component stubs with the final prop types + `fakeBridge.ts` answering `events.query/subscribe` from `scriptedNexusEvents()` and `slack.*` from `demoScenario` (`PLAN §2.12`). The lead merges that commit into `lane-3` immediately so B and C's worktrees can `git merge lane-3`.

Disjointness: A `webviews/shared/**` + build scripts; B `webviews/globe/**`; C `webviews/chat/**`. `contributes/lane-3.json` and `src/register/lane-3.ts` are **lead-only** until wave 4 (views/containers for globe, chat, approvals, session, plan, git, timeline are declared by the lead in one commit at T+4 from `PLAN §2.11 COMMAND_OWNER` and `PLAN §3` folder list).

## 2. Wave 2 — T+5 → T+8

| Slot | Task | PLAN ref | Depends on | Done when |
|---|---|---|---|---|
| Worker A | **L3-03** arcs, activity rings, live insert → **L3-04** picking, detail strip, drag | §5.3 L3-03, L3-04 | L3-02 model | `arcs.test.ts`; `DetailStrip.test.tsx` |
| Worker B | **L3-02** finish (instancing past 2,000 events; 60 fps on an integrated GPU against the 36 h scripted stream) | §5.3 L3-02 | — | as above |
| Worker C | **L3-09** Slack view part 2: threads, composer as you, pending echo, live (L) | §5.3 L3-09 | L3-08 | `ThreadPane.test.tsx`, `Composer.test.tsx` |
| Lead | `git merge main` once Lane 2's interface-drop PR lands (T+3); launch the fork with `--extensionDevelopmentPath` and open the globe view on the fixture bridge to eyeball §6 style | — | — | — |

L3-03 and L3-04 both touch `webviews/globe/scene/` — they run **sequentially in one slot** (A), never in parallel (`CLAUDE.md` §11 disjointness).

## 3. Wave 3 — T+8 → T+10 (into cp-1)

| Slot | Task | PLAN ref | Depends on | Done when |
|---|---|---|---|---|
| Worker A | **L3-13** task editor (brief edit, model select, START) | §5.3 L3-13 | L3-01 | `npx vitest run webviews/task && npm run build:webviews` |
| Worker B | **L3-17** "Nexus Dark" theme JSON (if `PLAN §1 Q1(b)` accepted; else idle → start L3-11 early) | §5.3 L3-17 | — | JSON parses; purple accent visible in the launch check |
| Worker C | **L3-09** finish | §5.3 L3-09 | — | as above |
| Lead | merge `main`; switch the globe and chat views from `fakeBridge` to the real bridge (one flag in `bridgeClient.ts`); launch check; PR `lane-3 → main` before T+10 | `CLAUDE.md` §10 | — | — |

**cp-1 (T+10–12):** `PLAN §8 cp-1` steps 3 (globe on real events), 4 (Slack view live), 6 (task editor → session view opens — a minimal session view is acceptable at cp-1; L3-11 lands in wave 4) are yours to watch.

## 4. Wave 4 — T+12 → T+16

| Slot | Task | PLAN ref | Depends on | Done when |
|---|---|---|---|---|
| Worker A | **L3-05** event search + tracking (L) | §5.3 L3-05 | L3-02, L3-04 | `Search.test.tsx`, `tracking.test.ts` |
| Worker B | **L3-11** session view: replay from `seq` 0, log/diff/tests/receipts tabs (L) | §5.3 L3-11 | L3-01 | `npx vitest run webviews/session && npm run build:webviews` (15 scripted rows in order) |
| Worker C | **L3-10** code-ref chips, bot-message styling + approval buttons, **Share to Slack** editor command | §5.3 L3-10 | L3-08 | `CodeRefChip.test.tsx`, `share-selection.test.ts` |

Cross-lane: `coderef.create/open` are Lane 2's L2-14 (their wave 4) — L3-10 builds on `fakeBridge` and flips to real when L2-14 is on `main`. Receipts in L3-11 come from Lane 1's L1-20/L1-21 (their wave 5); the RECEIPTS tab renders `scriptedReceipts` until then.

## 5. Wave 5 — T+16 → T+22

| Slot | Task | PLAN ref | Depends on | Done when |
|---|---|---|---|---|
| Worker A | **L3-12** approvals view with the swarm verdict card | §5.3 L3-12 | L3-01 | `npx vitest run webviews/approvals && npm run build:webviews` |
| Worker B | **L3-07** timeline fallback (same data, search, click) | §5.3 L3-07 | L3-01, L3-05 model | `npx vitest run webviews/timeline && npm run build:webviews` |
| Worker C | **L3-11** finish → **L3-15** git views (`nexus.openCommit` file list → built-in diff editor; merge-agent-branch quick pick) | §5.3 L3-11, L3-15 | L3-01 | `npx vitest run webviews/git src/features/gitviews` |
| Lead | **Q1(c) borrowing window:** if Lane 1's progress shows L1-21 (optimizer status bar/totals) unstarted at T+18, offer to take it — it is extension-side but UI-adjacent; record in both progress files | `PLAN §1 Q1` | — | — |

The timeline (L3-07) must be real by cp-2 because `PLAN §8 cp-2` step 5 may make it the home (`PLAN §9` Globe row). The globe keeps being improved in wave 6 either way.

## 6. cp-2 window — T+22 → T+24

No new dispatch. You run the **second laptop** for `PLAN §8 cp-2` step 4 (start an agent session on your machine so it orbits on Adrian's globe via Tiger). Be ready to flip the home to timeline (`nexus.openTimeline` default) if step 5 says so — that is a one-line change in `src/register/lane-3.ts`.

## 7. Wave 6 — T+24 → T+30

| Slot | Task | PLAN ref | Notes |
|---|---|---|---|
| Worker A | **L3-06** activity strip (per orbit, 15-min buckets, click moves "now") | §5.3 L3-06 | data from Lane 2's L2-12 (same wave); build on fixture `activity` until then |
| Worker B | **L3-14** task-plan review (accept/reject a `TaskPlan`) | §5.3 L3-14 | pairs with Lane 1's L1-19 (same wave); fixture `plan` until then |
| Worker C | **L3-16** empty/error states, offline status line, approval "still pending" UI, keyboard hints — one commit per view, sequential | §5.3 L3-16 | runs after each view's owner task is merged (same files) |

## 8. cp-3 and after

T+30–33 fixes only; `PLAN §8 cp-3` step 3's visible error states (offline line, `unavailable` card, "Prune: off (error)") are rendered by your views. T+33–36: `PLAN §10` D-3/D-6 rehearsals; you drive the step 7b laptop.

## 9. Standing checks for every Lane 3 merge

Reviewer prompt additions beyond `CLAUDE.md` §11: (1) `style.test.tsx` passes on the view root — radius 0, 22/20 px controls, no shadow, purple as the only accent (`CLAUDE.md` §6); (2) no import of `vscode` or Node modules under `webviews/**` (`PLAN §5.3` constraints); (3) every bridge call goes through `bridgeClient` with Zod-validated responses, never raw `postMessage`; (4) Slack text rendered as text, never HTML (`PLAN §5.3 L3-08`); (5) model-written text (agent messages, approval reasons, swarm summaries) carries the "model-written" label (`CLAUDE.md` §14); (6) components come from `webviews/shared`, no third-party UI kit (`CLAUDE.md` §16).

## 10. Sleep handoff (Elkin)

Suggested slot: T+20–T+24 (after L3-12 and L3-07 land, with L3-06/L3-14/L3-16 briefed) — but Adrian needs your laptop awake for cp-2 step 4 at ~T+23, so either brief a teammate to start the session on it, or take T+26–T+30 instead. Lead opens no PR to `main` while you sleep (`CLAUDE.md` §12).
