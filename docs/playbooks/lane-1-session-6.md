# Lane 1, session 6: handoff

Written 2026-11-07 (T+0 was 22:15 ET Fri 2026-11-06). Read `CLAUDE.md`, then `progress/lane-1.md` (Done, Blocked, Decisions, Session 4 and 5 notes), then this file. Claims carry how they were checked; `{unverified}` means they were not. The repo moves every few minutes: re-verify anything that matters.

## Where things stand (checked 2026-11-07, afternoon ET)

- `main` = `a93cad20`; `lane-1` = `06f3d128`, nothing ahead of `main`; `lane-2` = `4f6e8b19`; `lane-3` = `d6d6eaf6`, 13 commits ahead of `main`. No open PRs. [proof: `git rev-list --count origin/main..origin/<branch>`, `gh pr list --repo Bomoga/Nexus`]
- Lane 2 is wired. `registerLane2` (`src/register/lane-2.ts`) now returns the real router, store, Slack service, git service, gate, approval hooks and `setSlackApprovalResolver`; `buildLane2` in `src/register/lane-2-services.ts` builds all of it without `vscode`, so it can be used in unit tests. [proof: read both files]
- Lane 1 shipped since the last playbook: CIBA phone hook registered, inert unless `nexus.ciba.serviceUrl` is set (PR 20); approvals hang-path fixes (PR 28); `extension.ts` passes Lane 2's services into `registerLane1` (PR 19); Slack approve/reject buttons reach the approvals controller through `connectSlackApprovals` in `src/register/slack-approvals.ts` (PR 26). PR 25 also merged the Prune native adapters and the swarm review redesign, which the session 5 playbook listed as Held; whether Adrian approved that is {unverified}. [proof: `git log --merges origin/main`, `gh pr view`]
- The only full-slice test, `src/features/compose.test.ts`, uses `FakeGit` and `FakeSlack` (line 40). No test runs the agent against the real git service, real gate and real `LocalStore`. [proof: grep of test files]
- On this Windows machine 4 tests in `src/services/gate/gate.test.ts` and the whole `src/services/git/git-cli.test.ts` file fail, and they fail the same without Lane 1's changes. The GitHub `extension` check is green on the same code (Linux). [proof: stashed run, `gh pr checks`]
- `nexus.openReceipt` is owned by Lane 3 (`src/contracts/commands.ts:27`) and no code registers it; `nexus.openSession` is registered (`src/features/views/lane3-views.ts:68`). Lane 3 can call `OptimizerService.openReceipt(receiptId, sessionId?)`. [proof: grep]
- `src/register/lane-2.ts` has a header comment saying session worktrees fail with "not implemented" until L2-06; `GitCli.createSessionWorktree` and `worktrees.ts` exist, so the comment looks stale. {unverified: the write half has not been exercised by a real test}
- Another interactive session, "Nexus Lane 1 session 5", pushed to `lane-1` in parallel and could not be reached by `SendMessage`. Two sessions can push `lane-1`: always fetch and merge `origin/lane-1` before you push, never force.

## Facts that surprised us (do not rediscover)

1. All `nexus://` routes must be `nexus://nexus.nexus/<route>` (`extensionUrlHandler.ts:155`); `UriRouter` normalizes it.
2. GitHub logins: Adrian `Bomoga`, Brandon `brandondelgadoo`, Elkin `aerr0c` (CODEOWNERS now says so).
3. `gh pr ...` needs `--repo Bomoga/Nexus` or it targets upstream `microsoft/vscode`.
4. Only the `extension` check matters. Copilot posts a quota notice; CodeQL, Playwright, Screenshots and Detect Changes are upstream workflows that stay pending.
5. Files are CRLF. Use Edit, or normalise newlines in Python and restore them.
6. Unit tests cannot import any file that imports `vscode`; put testable logic in a `vscode`-free module (see `src/register/slack-approvals.ts`).
7. `package.json` in the fork checkout changes on each build; revert it with `git checkout` if it shows modified.

## Held: do NOT do these, and do not ask Adrian about them

- Live API spend above a few cents: no live CouncilAsAJudge runs (about $0.17 each), no Prune live runs.
- Deploying the CIBA service or any Auth0 dashboard change (needs `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_AUDIENCE`; Adrian said "Not now").
- The checkpoint tags `cp-1`, `cp-2`, `cp-3`.
- Anything in Lane 2's or Lane 3's paths (`src/services`, `src/bridge`, `src/register/lane-2*.ts`, `src/register/lane-3.ts`, `webviews/`, `src/features/views`), and contracts changes.
- Adrian dropped the launch check: a Lane 1 PR merges on a green `extension` check alone.

## Tasks (do each; at a stop rule, record it in `progress/lane-1.md` and continue)

### S6-T1. Fresh state (lead, no worker)
`git fetch --all`; print per-branch ahead/behind against `origin/main`; `gh pr list --repo Bomoga/Nexus`; `ListAgents` to see whether another Lane 1 session is busy. Merge `origin/main` and `origin/lane-1` into your local `lane-1`. Under `In flight` in `progress/lane-1.md` write the tasks you own (S6-T2, S6-T3) so a parallel session does not duplicate them.

### S6-T2. Real-services end-to-end test (worker A, reviewer Opus)
Goal: one test file that runs the Lane 1 slice against the real Lane 2 pieces in a temp git repo, proving the cp-1 wiring without a launch.
- File: `extensions/nexus/src/features/compose.real.test.ts` (and helpers beside it); owns only that path glob `src/features/compose.real*`.
- Build: `buildLane2` (`src/register/lane-2-services.ts`) with a real `GitCli` (`src/services/git/git-cli.ts`) over a temp repo made by `git init` plus two commits, a real `LocalStore` (`src/services/events/local-store.ts`) in a temp dir, a fake Slack via `slackSeams` or `FakeSlack`, then `composeLane1` with a scripted `FakeProvider` agent: write one file via the gate, ask to commit, a human approves through `approvals.resolve`.
- Assert: the session worktree exists on branch `nexus/agent-<id>`; its commit contains the edit; the user's checkout `HEAD` and working tree are unchanged; `AgentEvent`s replay from `seq` 0 with no gaps; `ApprovalRequest.decidedBy` is the human; a second `resolve` loses (first answer wins) and returns the winner; a Slack-sourced resolve through `connectSlackApprovals` reaches the controller; a secret-looking string in a tool result is redacted in the store.
- Skip a single case with a stated reason only if `git` is missing; do not weaken or skip assertions to get green. Avoid `cmd.run` in the main path, because the gate's `cmd.run` tests fail on this Windows machine (see above); add one `cmd.run` case only if it passes here, otherwise report it.
- Acceptance: `cd extensions/nexus && npx vitest run src/features/compose.real.test.ts` exits 0, plus `npx tsc --noEmit -p .` and `npx eslint src/features` clean.
- If the test exposes a bug in Lane 2's files: do not fix it. The worker reports file, line, repro; the lead writes it in `progress/lane-1.md` with a short message for Adrian to relay to Brandon.

### S6-T3. Reproduce the Windows gate and git-cli failures (worker B, read-only)
Goal: a precise report Brandon can act on. Owns nothing; edits nothing.
- Run `npx vitest run src/services/gate/gate.test.ts src/services/git/git-cli.test.ts` in `extensions/nexus`. For each failure record the test name, the assertion or error, and the likely cause (Windows path or PATH handling, process groups, `git` config, line endings, a missing binary). Check whether the same tests pass in a Linux-like setting if available (WSL) and say so, or say it was not tried.
- Report only; no fixes. The lead copies the finding into `progress/lane-1.md` and drafts the message for Brandon.

### S6-T4. Relay the two cross-lane gaps (lead, no worker)
Write into `progress/lane-1.md` Blocked, as messages for Adrian to relay (never post to Slack yourself):
- To Elkin: "`nexus.openReceipt` is owned by Lane 3 and nothing registers it; register it and call `OptimizerService.openReceipt(receiptId, sessionId?)` (src/features/accounts/optimizer.ts)."
- To Brandon: "The header comment in `src/register/lane-2.ts` says session worktrees fail until L2-06, which looks stale; and the Windows gate/git-cli test failures in S6-T3's report."

### S6-T5. cp-1 readiness table (lead)
From `docs/PLAN.md` section "cp-1" (about line 1696), write a table into `progress/lane-1.md`: each of the 7 cp-1 steps, and for each one `proven offline` (cite the test), `needs a launch plus a human` (say which), or `blocked on <person>`. Do not tag `cp-1`.

### S6-T6. Ship and keep the notes current
After S6-T2 is `confirmed`: merge the worker branch into `lane-1` (`--no-ff`), run the full extension suite, commit, push `lane-1`, open a title-only PR, wait for the `extension` check, merge it. Append the results of S6-T2 to S6-T5 to `progress/lane-1.md` in the same or a following small PR.

### S6-T7. The loop (never end idle)
Arm the Monitor script below and keep it armed. On each event, fetch and act:
- A PR or push touching Lane 1 paths (`src/features/{accounts,tasks,sessions,approvals,swarms,auth}`, `src/models`, `src/agent`, `src/agent-process`, `src/register/lane-1*`, `contributes/lane-1.json`, `contracts`, core) -> read the diff; comment on the PR only if it breaks a Lane 1 contract. A contracts PR is never merged without written approval from both Brandon and Elkin.
- `main` moves -> merge it into `lane-1`; run the extension checks; fix red that is in Lane 1 paths; log red in other lanes' paths for that lane and leave their files alone.
- Lane 2 or Lane 3 reports a request of Lane 1 in their progress file -> do it if it is Lane 1's, with a worker, and say so.
- Nothing changes for 30 minutes -> re-arm the monitor and ship one small, tested improvement from `progress/lane-1.md` "Next" or a review leftover, with a worker and a reviewer.

Monitor script (re-arm every 30 minutes; it expires):

```bash
cd "C:/Users/atmor/OneDrive/Desktop/Repositories/Nexus"; prev=""; while true; do git fetch -q --all 2>/dev/null || true; cur=$( { for b in main lane-1 lane-2 lane-3; do echo "branch $b $(git rev-parse --short origin/$b 2>/dev/null)"; done; gh pr list --repo Bomoga/Nexus --state open --json number,title -q '.[]|"openPR \(.number) \(.title)"' 2>/dev/null; } | sort); if [ -n "$cur" ] && [ "$cur" != "$prev" ]; then if [ -z "$prev" ]; then echo "$cur"; else comm -13 <(echo "$prev") <(echo "$cur"); fi; prev="$cur"; fi; sleep 60; done
```

## Subagent specification (mandatory)

You are the lead: you plan, brief, merge, push and write the progress file. Workers implement or investigate; reviewers judge. Follow CLAUDE.md section 11 (sparse worktrees on `lane-1-wt/<task-id>`, disjoint OWNS, workers never push, fresh reviewer per task, two attempts then record in Blocked).

| Role | Tasks | Model class | How many at once | Tools and scope |
|---|---|---|---|---|
| Worker A | S6-T2 | Sonnet-class | 1 | Agent tool with Write/Edit/Bash; its own sparse worktree `../nexus-wt/S6-T2` on branch `lane-1-wt/S6-T2`; edits only `src/features/compose.real*` |
| Worker B | S6-T3 | Sonnet-class | 1 | Read/Bash only; runs tests in the main checkout's `extensions/nexus`, edits nothing; returns a report |
| Reviewer | S6-T2 | Opus-class (touches the gate, approvals, the store) | 1, after Worker A reports | Sees only: the brief, `git diff lane-1...lane-1-wt/S6-T2`, the test output. Answers `confirmed` or `disputed` with notes |
| Explorer (optional) | any lookup | Haiku or Sonnet | 1 | Read-only: "where is X", "what does this return" |

- Dispatch Worker A and Worker B in a single message so they run at the same time. That is 2 workers, the limit on this 8 GB machine (3 only if `Get-CimInstance Win32_ComputerSystem` shows 16 GB or more); open one Nexus window, never a second `npm run watch`. Workers and reviewers never spawn subagents.
- Do S6-T1, S6-T4, S6-T5 yourself while the workers run. Dispatch the reviewer the moment Worker A reports; do not wait on anything else first.
- Two attempts: a `disputed` verdict sends the notes back to a new worker once; after the second dispute, record under Blocked in `progress/lane-1.md` and move on.
- Every brief uses the CLAUDE.md section 11 template: TASK, LANE/BRANCH/WORKTREE, GOAL, OWNS, READ FIRST, CONTRACTS, ACCEPTANCE (a command that exits 0), CONSTRAINTS, STOP WHEN, REPORT (Changed / Commits / Acceptance / Open questions). A worker starts with no memory of this session: name the files and put no secrets in a brief.
- Record each task's worker, reviewer verdict and merge commit in `progress/lane-1.md`.

Brief for Worker A (fill the paths; send as is):

```
TASK S6-T2: add a real-services end-to-end test for the Lane 1 slice
LANE: lane-1    BRANCH: lane-1-wt/S6-T2    WORKTREE: ../nexus-wt/S6-T2 (sparse: extensions/nexus docs progress CLAUDE.md)
GOAL: One test file, src/features/compose.real.test.ts, runs composeLane1 against the REAL Lane 2 pieces in a temp git repo: buildLane2 (src/register/lane-2-services.ts), a real GitCli (src/services/git/git-cli.ts), a real LocalStore (src/services/events/local-store.ts), a fake Slack, and a scripted FakeProvider agent that writes one file through the gate and asks to commit, with a human approving through approvals.resolve. It proves the cp-1 wiring without launching the fork.
OWNS (may edit only these): extensions/nexus/src/features/compose.real*
READ FIRST: CLAUDE.md sections 5 and 14; src/features/compose.ts and compose.test.ts (the fake-based version to mirror); src/register/lane-2-services.ts; src/register/slack-approvals.ts; src/services/git/worktrees.ts and git-cli.ts; src/services/gate/gate.ts; src/services/events/local-store.ts.
CONTRACTS: AgentSession, AgentEvent, ApprovalRequest (decidedBy, first answer wins), Task, NexusEvent.
ACCEPTANCE: cd extensions/nexus && npx vitest run src/features/compose.real.test.ts && npx tsc --noEmit -p . && npx eslint src/features  (all exit 0). Write the test file first, see it fail, then make it pass.
  Assert: session worktree exists on branch nexus/agent-<id>; its commit contains the edit; the user's checkout HEAD and working tree are unchanged; AgentEvents replay from seq 0 with no gaps; decidedBy is the human; a second resolve loses and returns the winner; a Slack-sourced resolve through connectSlackApprovals reaches the controller; a secret-looking string in a tool result is redacted in the store.
CONSTRAINTS: no network, no real API keys, no vscode import (use the vscode-free builders). Do not weaken, skip or mock away the thing under test. Do not use cmd.run in the main path: the gate's cmd.run tests fail on this Windows machine; add a cmd.run case only if it passes here. Never edit files outside OWNS; if the test exposes a bug in Lane 2's files (src/services, src/bridge, src/register/lane-2*), do not fix it: report file, line and a repro.
STOP WHEN: acceptance passes and the report is written, OR 90 minutes without progress, OR you need something outside OWNS. Then stop and report; do not work around it.
REPORT (exactly these headings): Changed / Commits / Acceptance / Open questions / blocked on
```

Brief for Worker B:

```
TASK S6-T3: reproduce and explain the Windows failures in the gate and git-cli tests (read-only)
LANE: lane-1    OWNS: nothing (edit no file, create no branch)
GOAL: A precise report Brandon can act on. In extensions/nexus run: npx vitest run src/services/gate/gate.test.ts src/services/git/git-cli.test.ts. For each failing test give the test name, the assertion or error text, and the likely cause (Windows path or PATH handling, process groups, git config, line endings, a missing binary). Say whether it passes under WSL/Linux or that you did not try. 
ACCEPTANCE: the report lists every failure. 
CONSTRAINTS: do not fix anything, do not touch any file, print no secrets. 
STOP WHEN: all failures are explained, OR 30 minutes.
REPORT: Failures (one line each) / Likely cause / Linux result / Suggested fix for Lane 2 (one line, not applied)
```

## Standing rules (from CLAUDE.md and Adrian)

- Never rebase or force push; never push `main`; push only `lane-1` (fetch and merge `origin/lane-1` first: another session may have pushed). Never edit another lane's paths. Never print, log or commit anything from `extensions/nexus/.env`.
- Commit as `lane-1: <change>` (lowercase, imperative, no period) with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. PR titles only; the only body is `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Always pass `--repo Bomoga/Nexus` to `gh`.
- Merge your own PR once the `extension` check passes (no launch check, no waiting for other checks). Never enable auto-merge. Never merge a contracts PR without written approval from both Brandon and Elkin.
- Tag every factual claim `[proof: ...]` or `{unverified}`; report red tests and skipped steps plainly.
- Ask Adrian only for the Auth0 values, an Auth0 dashboard change, more than a few cents of live API spend, or relaying a teammate's approval. Everything else: decide, record in `progress/lane-1.md`, continue.

## Finish (only if Adrian says stop)

Short report: what is done, what is blocked and on whom, what to send Brandon and Elkin.
