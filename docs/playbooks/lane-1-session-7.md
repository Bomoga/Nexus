# Lane 1, session 7: handoff

Written 2026-11-07 (T+0 was 22:15 ET Fri 2026-11-06). Read `CLAUDE.md`, then `progress/lane-1.md` (Session 6 section and the S6-housekeeping note at the end), then this file. Claims carry how they were checked: `[proof: ...]` means checked while writing this file, `{unverified}` means not. Re-check anything you rely on.

## Where things stand

- `main` = `ba46b28d` (PR 41, Lane 2, merged). `origin/lane-1` = `aa91640a`; local `lane-1` fast-forwarded to `main` and is not pushed. [proof: `git log origin/main`, `git merge origin/main` this session]
- Open PR: 43, Lane 3 ("activity strip under the globe with pin to a past time"). Not Lane 1's; review it only if it touches Lane 1 paths or contracts. [proof: `gh pr list --repo Bomoga/Nexus`]
- Session 6 merged: PRs 31, 32, 34, 36, 37, 39 (state and relays, real-services test, command-link notification fix, adapter sanitiser, Windows note, approvals release-before-store fix) and PR 42 (`'extensions/nexus'` added to `build/npm/dirs.ts`; react, react-dom, three, @react-three/fiber, @react-three/drei moved to devDependencies). PR 42 was Opus-confirmed. [proof: `progress/lane-1.md`, `gh pr view 42`]
- Not proven: that the fork's own `npm install` / `npm run watch` picks up `extensions/nexus` after the `dirs.ts` change. Needs a build on Adrian's machine. {unverified}
- Lane 2's PR 41 added the Tiger store, live sync, Token Vault, the Slack progress message and the activity strip, but `src/register/lane-2.ts:22` still says "Not wired yet: the Tiger store (L2-10) and Token Vault (L2-15)". So the shared-store beats of the demo (7b) are not live until Lane 2 wires them. That wiring is Lane 2's file. [proof: grep of `src/register/lane-2.ts` this session]
- Windows failures on `lane-1` that also fail without any Lane 1 change, all in Lane 2's `src/services` (drafted for Brandon in `progress/lane-1.md`): `coderef.test.ts:168` (temp file named `q?#&=.ts`), `worktrees.test.ts:270` and `:277` (EPERM opening a worktree `.git` file), `worktrees.test.ts:174` (5 s timeout under load), `gate.test.ts:178` (missing binary, `CommandRefused` from `windowsPlan`, `commands.ts:141`). [proof: vitest run this session]

## Facts that surprised us (do not rediscover)

1. All `nexus://` routes must be `nexus://nexus.nexus/<route>`; `UriRouter` normalizes it.
2. GitHub logins: Adrian `Bomoga`, Brandon `brandondelgadoo`, Elkin `aerr0c`.
3. `gh` needs `--repo Bomoga/Nexus` or it targets upstream `microsoft/vscode`.
4. Only the `extension` check matters. Copilot posts a quota notice (no code feedback); CodeQL, Playwright, Screenshots and Detect Changes are upstream workflows that stay pending. Never merge while `extension` is pending (session 6 slipped once, PR 37).
5. Files are CRLF or mixed. Use Edit, or Python with `newline=''` for appends.
6. Unit tests cannot import files that import `vscode`; keep logic in vscode-free modules.
7. VS Code renders ASCII `[label](command:...)` in extension notifications as clickable command links. Everything model- or Slack-derived that reaches a notification goes through `plainNotificationText` (`src/shared/plain-text.ts`); `src/features/notify-safe.ts` wraps the adapters.
8. The full unit suite times out some git tests when run in parallel on this 8 GB machine; use `--maxWorkers=2 --testTimeout=30000` and judge by the same failures as on `lane-1`.
9. A dropped branch is kept for reference: `lane-1-wt/S6-swarm2` at `1df1a00a`.

## Held: do NOT do these, and do not ask Adrian about them

- Live API spend above a few cents (no live CouncilAsAJudge runs at about $0.17 each, no Prune live runs).
- Deploying the CIBA service or any Auth0 dashboard change.
- The checkpoint tags `cp-1`, `cp-2`, `cp-3`.
- Anything in Lane 2's paths (`src/services`, `src/bridge`, `src/register/lane-2*.ts`), Lane 3's (`webviews`, `src/features/views`, `src/register/lane-3.ts`) or `src/contracts` (needs written approval from Brandon and Elkin).
- Adrian dropped the launch check: a Lane 1 PR merges on a green `extension` check alone.

## Tasks (do each; at a stop rule, record it in `progress/lane-1.md` and continue)

### S7-T1. Fresh state (lead, no worker)
`git fetch --all`; per-branch ahead/behind against `origin/main`; `gh pr list --repo Bomoga/Nexus`; `ListAgents`. Merge `origin/main` and `origin/lane-1` into local `lane-1`, run `contributes:check`, `tsc --noEmit`, `eslint .` and `vitest run src/features src/shared`. Push `lane-1` (fetch and merge first). Open one title-only PR carrying this handoff and the progress note; merge it on a green `extension` check.

### S7-T2. Swarm review verdict parsing, fourth design (worker, Opus reviewer)
Goal: `src/features/swarms/review.ts` derives a `SwarmReview` verdict only from structured judge turns, in linear time, so council text cannot forge or flip a verdict. Three earlier attempts were disputed (see `progress/lane-1.md` S6-swarm2): attempt 1 let the aggregator's text set the verdict and weakened a security test; attempt 2 accepted a forged first JSON object and empty judge turns; attempt 3 used a quadratic JSON scan (1,033 ms on 30 KB, 40,409 ms on 200 KB). Start from `main`, not from the dropped branch. Constraints: one pass over the output, hard input cap (truncate before scanning, mark `summary` as truncated), verdict from `*_judge` turns only, never from `aggregator_agent`; a judge with an empty or unparseable turn counts as `concerns`, not `looks_good`; the review stays advisory (it never sets an `ApprovalRequest` decision); tests must include a 200 KB adversarial input that finishes under 100 ms, a forged-JSON case, an empty-turn case, and the existing security tests unchanged. Stop rule: two attempts, then record under Blocked. No live Swarms calls.

### S7-T3. Approvals minor leftovers (worker, Opus reviewer)
From the session-6 approvals reviewer, not fixed: (a) a cancel racing a human APPROVE can store "approved" for a session that never ran; (b) `approval_resolved` can land after `status:cancelled` when the store is slower than 250 ms (`SETTLE_GRACE_MS`); (c) `request()` can leak a promise if its read-back hangs after a cancel; (d) `sessionOf` evicts at 256 so an old approval can lose its session. Fix (a), (c), (d) if each is small and tested; for (b) record the tradeoff instead of changing the grace period. Owns `src/features/approvals/**`. Stop rule: if fixing one reopens the hang paths, revert that one and record it.

### S7-T4. CIBA poll binding in `auth-service` (worker, Opus reviewer)
`/ciba/poll` does not bind an `authReqId` to the signed-in user that started it. Add that binding with an offline test (the service stays undeployed and untouched on Auth0). Owns `auth-service/**`. Stop rule: if it needs an Auth0 value or a design decision about storage, write the question in `progress/lane-1.md` and stop.

### S7-T5. Relay drafts (lead, no worker)
Rewrite the three relay messages in `progress/lane-1.md` as current: Brandon (the four Windows failures above, the stale header at `src/register/lane-2.ts` now that line 22 says the Tiger store and Token Vault are "not wired yet", and that wiring them is his), Elkin (nothing outstanding; PR 40 covered `nexus.openReceipt` and share notifications), Adrian (cp-1 launch check steps and the `dirs.ts` build proof). Only Adrian can send them.

### S7-T6. Keep running
Arm the Monitor from the prompt and never end a turn without one armed; re-arm every 30 minutes. React to events: merge `main` into `lane-1` when it moves and re-run the checks; review Lane 2 or Lane 3 PRs only when they touch Lane 1 paths, `package.json`, `src/contracts` or `build/`. After 30 quiet minutes ship one small tested improvement from `progress/lane-1.md` "Next" (worker plus reviewer).

## Subagent specification

Workers are Sonnet-class, each in a sparse worktree (`git worktree add --no-checkout C:/dev/nexus-wt/<id> -b lane-1-wt/<id> lane-1`, then `git sparse-checkout set extensions/nexus docs progress CLAUDE.md`, then `git checkout`), at most 2 at once on this machine. Reviewers are fresh Opus-class agents that see only the brief, the diff and the test output, and answer `confirmed` or `disputed` with `file:line` notes. Workers and reviewers never spawn subagents, push, merge or rebase. Two attempts per task; a third only if Adrian's latest instruction authorises it. The lead merges with `--no-ff`, re-runs the suite, pushes, removes the worktree and deletes the task branch. Use the brief template in `CLAUDE.md` section 11.

## Only a human can do these

- Send the relays (S7-T5) to Brandon and Adrian's teammates.
- The cp-1 launch check on the fork, and the `npm install` / `npm run watch` proof for the `dirs.ts` line.
- The `cp-1` / `cp-2` / `cp-3` tags, live spend above a few cents, the CIBA deploy and Auth0 changes.
