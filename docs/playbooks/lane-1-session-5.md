# Lane 1, session 5: handoff

Written 2026-11-07 (T+0 was 22:15 ET Fri 2026-11-06). Read `CLAUDE.md`, then `progress/lane-1.md` (Done, Blocked, Decisions, Session 4 notes), then this file. Claims carry how they were checked; `{unverified}` means they were not. Re-verify anything that matters, because the repo moves every few minutes.

## Where things stand (checked 2026-11-07, afternoon ET)

- `main` = `1c6019b0` (PR 16, Lane 3's webviews, merged). Every Lane 1 code and contracts change is on `main`: PR 9 contracts (Brandon and Elkin approved in writing), PR 10 and 13 (auth callback form, theme, CIBA client and service, hardening), PR 14 (CODEOWNERS login fix, test lint), PR 15 (`src/features/approvals/ciba-hook.ts`). No open PRs. [proof: `git log origin/main`, `gh pr list --repo Bomoga/Nexus`]
- `lane-2` = `e4440cb9`, 0 commits ahead of `main` and about 110 behind: Brandon has not merged `main` since PR 9 landed. [proof: `git rev-list --count`]
- **`registerLane2` is an empty stub on `main` and on `origin/lane-2`** (`src/register/lane-2.ts`, 4 lines: `export function registerLane2(_context): void {}`). Lane 2's services exist as code under `src/services` and `src/bridge` but nothing constructs them, so nothing is live end to end. This is the single gate for cp-1. [proof: `git show origin/main:extensions/nexus/src/register/lane-2.ts`, `git show origin/lane-2:...` (4 lines)]
- `extension.ts` on `main` calls `registerLane1(context)`, `registerLane2(context)`, `registerLane3(context)` independently: Lane 1 gets no Lane 2 services, so `withFallbacks` supplies stand-ins. [proof: `git show origin/main:extensions/nexus/src/extension.ts`]
- Lane 3 registers `nexus.openHome` (`src/features/views/lane3-views.ts:60`), so `registerHomeKeeper` has its target. [proof: grep]
- Workspace trust is already off by default in core: `security.workspace.trust.enabled: false` at `src/vs/workbench/browser/workbench.contribution.ts:1038`. (An earlier note in the session 4 transcript said this looked undone; that was wrong, it only searched `product.json` and the contributes file.)
- Adrian's instructions this session: **skip the launch check from now on (maximum velocity)**. A Lane 1 PR merges on a green `extension` check alone. Adrian also said "Not now" to deploying the CIBA service: do not ask for the Auth0 values again.

## Facts that surprised us (do not rediscover)

1. All `nexus://` routes must be `nexus://nexus.nexus/<route>`; core `extensionUrlHandler.ts:155` drops any other authority. Lane 2's `UriRouter` normalizes to `nexus://<route>/...`; `handleCallback` accepts both forms.
2. Elkin's GitHub login is `aerr0c` (CODEOWNERS now says so). Brandon is `brandondelgadoo`. Adrian is `Bomoga`.
3. CouncilAsAJudge returned HTTP 503 from about 14:10 UTC 2026-11-07 and a council run costs about $0.17: do not run live council calls (see Held).
4. A launched `Nexus.exe` sits beside the user's own VS Code: pick windows by process name `Nexus`.
5. `gh pr ...` needs `--repo Bomoga/Nexus`; without it gh targets upstream `microsoft/vscode`.
6. The Copilot reviewer only posts a quota notice, and the CodeQL, Playwright, Screenshots and Detect Changes checks are upstream VS Code workflows that stay pending. The only check that matters is `extension`.
7. Writes on Windows: files are CRLF; use Edit, or normalise newlines in Python and restore them.

## Held: do NOT do these, and do not ask Adrian about them again

- Prune native adapters (branch `lane-1-wt/L1-S4b`, head `3fb2bc35`): disputed twice by reviewers; the two-attempts rule sends it to Adrian. Leave it.
- Swarm review prompt redesign: needs live council runs (about $0.35 per validation round). Leave it.
- CIBA service deployment and any Auth0 dashboard change: needs `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_AUDIENCE` from Adrian. Adrian said "Not now".
- Checkpoint tags `cp-1`, `cp-2`, `cp-3`: their acceptance steps need a launch, Slack, a phone and a human. Do not tag. Record in `progress/lane-1.md` what is still missing.
- Anything in Lane 2's or Lane 3's paths (`src/services`, `src/bridge`, `src/register/lane-2.ts`, `src/register/lane-3.ts`, `webviews/`, `src/features/views/`, `src/features/coderef`), and contracts changes.

## Tasks, in order (do each; at a stop rule, record in `progress/lane-1.md` and continue to the next)

### T1. Fresh state, sync
`git fetch --all`; print per-branch ahead/behind against `origin/main`; `gh pr list --repo Bomoga/Nexus`. Merge `origin/main` into `lane-1` (never rebase). If `lane-2` now has a real `register/lane-2.ts`, go to T2 first.

### T2. Lane 1's side of the Lane 2 wiring (the cp-1 gate)
- Read `src/register/lane-1.ts` (`registerLane1(context, lane2: Partial<Lane2Services>)`), `src/register/lane-1-features.ts` (`Lane2Services`, `withFallbacks`) and `src/register/lane-2.ts` on the freshest of `origin/main` and `origin/lane-2`.
- If `registerLane2` is still the stub: write nothing in Lane 2's paths. Prepare Lane 1's half so it is a one-line change later: make `registerLane2` allowed to return `Partial<Lane2Services>` in `extension.ts` (Lane 1's file) as `const lane2 = registerLane2(context) ?? {}; registerLane1(context, lane2);` only if that type-checks against the current stub (`void` return); if it needs a change in `register/lane-2.ts`, do not make it. Add a test that `extension.ts` passes whatever `registerLane2` returns into `registerLane1`. Then write the message for Adrian to relay to Brandon (below) into `progress/lane-1.md` Blocked.
- If it is real: wire it, add one test that the real objects satisfy the ports, run the full checks, PR, merge.
- Message to relay to Brandon (put it in the progress file, never post to Slack yourself): "`registerLane2` is still a 4-line stub on `main`. cp-1 needs it to construct and return `{ router, store, slack, git, makeGate, approvalHooks }` (see `Lane2Services` in `src/register/lane-1-features.ts`) and to register `nexus://` via `vscode.window.registerUriHandler`. Please also `git merge origin/main` into `lane-2` first (contracts: `clientId` echo and `ui.openExternal`)."

### T3. Register the CIBA phone hook, inert until configured
- New setting `nexus.ciba.serviceUrl` (string, default empty) in `contributes/lane-1.json`, then `npm run contributes`. In `lane-1-features.ts`, when the setting is non-empty and the user is signed in, build `CibaClient({ baseUrl, getAccessToken: () => auth.accessToken(), isStillPending: async id => !(await controller.get(id))?.decision })` and add `makeCibaHook({ client, approverAuth0UserId: () => auth.status().auth0UserId, resolve: (id, d, by) => controller.resolve(id, d, by), log })` to the approvals controller's `hooks`. Check `Auth0Session`'s real method names before using them.
- Hook must be inert (never constructed) when the setting is empty or nobody is signed in. Add tests for both. Call the hook's `cancel` when the approval is decided elsewhere (the controller's `subscribe`).
- Acceptance: `npx vitest run`, `npx tsc --noEmit -p .`, `npx eslint src`, `npm run contributes:check` in `extensions/nexus` all exit 0.

### T4. Hang-path audit
Lane 2 reported hang paths on a store I/O failure at `sessions-controller.ts:159-160` and `:166-167` (and `approvals-controller.ts:218-223`, which now wraps its emit in `try/finally` and always wakes the waiter). For each, write a test where the store throws and assert that the agent's waiter or the session is released and nothing hangs. Fix only what the tests show. Mutation-check any fix (revert it, see the test fail).

### T5. cp-1 pre-checks that need no launch
In `extensions/nexus`: run `npm run ci` (cp-1 step 1). Run `npm run test:int` only for providers whose keys exist in `extensions/nexus/.env` and only the Anthropic and Gemini listing tests (a few cents); never print `.env`. Record exit codes and test counts in `progress/lane-1.md`.

### T6. Progress notes
Append to `progress/lane-1.md`: PRs 14 and 15, the CODEOWNERS correction, the finding that `registerLane2` is a stub, the trust-default correction, and the Held list. Title-only PR, merge on green `extension`.

### T7. Keep going (this is the loop; never end idle)
After T1 to T6, arm a Monitor on `main`, `lane-1`, `lane-2`, `lane-3` and open PRs (script below) and keep it armed. On each event: fetch, decide, act.
- `lane-2` gains a real `registerLane2` or merges `main` -> redo T2.
- `main` moves -> merge it into `lane-1`; run the extension checks; if red because of Lane 1 paths, fix; if red in another lane's paths, log it for that lane, leave their files alone.
- A PR opens that touches `src/features/{accounts,tasks,sessions,approvals,swarms,auth}`, `src/models`, `src/agent`, `src/agent-process`, `contracts` or core -> read the diff and comment on the PR only if it breaks a Lane 1 contract. Contracts PRs: never merge without both other engineers' written approval.
- Nothing changes for 30 minutes -> re-arm the monitor and do one useful Lane 1 improvement from `progress/lane-1.md` "Next" or the review leftovers (small, tested, behind existing tests), then PR and merge on green.

Monitor script (re-arm every 30 minutes; it expires):

```bash
cd "C:/Users/atmor/OneDrive/Desktop/Repositories/Nexus"; prev=""; while true; do git fetch -q --all 2>/dev/null || true; cur=$( { for b in main lane-1 lane-2 lane-3; do echo "branch $b $(git rev-parse --short origin/$b 2>/dev/null)"; done; gh pr list --repo Bomoga/Nexus --state open --json number,title -q '.[]|"openPR \(.number) \(.title)"' 2>/dev/null; } | sort); if [ -n "$cur" ] && [ "$cur" != "$prev" ]; then if [ -z "$prev" ]; then echo "$cur"; else comm -13 <(echo "$prev") <(echo "$cur"); fi; prev="$cur"; fi; sleep 60; done
```

## How to run it: parallel subagents (mandatory)

You are the lead: you plan, brief, merge, push and talk to the human. Workers implement; reviewers check. Follow CLAUDE.md section 11 (sparse worktrees on `lane-1-wt/<id>`, disjoint OWNS, workers never push, fresh reviewer per task, two attempts then record in Blocked).

- **Fan out.** T3 (CIBA hook registration), T4 (hang-path tests), T5 (`npm run ci` plus provider listing tests) and T6 (progress notes, drafted by you) own disjoint paths. Launch T3, T4 and T5 as worker subagents in one message so they run at the same time; start T2's prep yourself while they run. Do T1 and the merge steps yourself.
- **Limits.** At most 2 workers at once on this 8 GB machine (3 if `Get-CimInstance Win32_ComputerSystem` shows 16 GB or more), one Nexus window, never a second `npm run watch`. Workers do not spawn subagents and never push.
- **Briefs.** Use the brief template in CLAUDE.md section 11, filled in per task: GOAL, OWNS (exact paths), READ FIRST, CONTRACTS, ACCEPTANCE (a command that exits 0), CONSTRAINTS, STOP WHEN, REPORT headings. A worker starts with no memory of this session, so name the files and the spec; put no secrets in a brief.
- **Review.** Send a fresh reviewer (Opus-class for approvals, the gate, auth or contracts-adjacent code) only the brief, the diff and the test output. `confirmed` -> merge with `git merge --no-ff`, re-run the suite, push, remove the worktree. `disputed` -> back to a worker once; after the second dispute, record it under Blocked and move on.
- **T7 loop.** For each incoming change or improvement, brief a worker and a reviewer instead of editing in your own checkout, unless it is a one-line fix. Dispatch the next worker before you wait on the previous reviewer.
- **Model classes.** Workers: Sonnet-class. Reviewers: Sonnet-class, Opus-class for security rails. Explorers (read-only lookups): Haiku or Sonnet.
- Record each task's worker, reviewer verdict and merge commit in `progress/lane-1.md` In flight / Done.

## Standing rules (from CLAUDE.md and Adrian)

- Never rebase or force push; never push `main`; push only `lane-1`. Never edit another lane's paths. Never print, log or commit anything from `extensions/nexus/.env`.
- Commit as `lane-1: <change>` (lowercase, imperative, no period) with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. PR titles only, no body except the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Always pass `--repo Bomoga/Nexus` to `gh`.
- Merge your own PR into `main` once the `extension` check passes (no launch check, no wait for the other checks). Never enable auto-merge. Contracts PRs need written approval from both Brandon and Elkin.
- Subagents are required, not optional (see "How to run it: parallel subagents" below). Do not do implementation yourself that a worker could do.
- Tag every factual claim `[proof: ...]` or `{unverified}`; report red tests and skipped steps plainly.
- 8 GB machine rules: at most 2 workers, one Nexus window.
- Ask the user only for: the Auth0 values, a dashboard change, more than a few cents of live API spend, or relaying a teammate's approval. Everything else: decide, record in `progress/lane-1.md`, continue.

## Finish (only if Adrian says stop)

Short report: what is done, what is blocked and on whom, what to send Brandon and Elkin.
