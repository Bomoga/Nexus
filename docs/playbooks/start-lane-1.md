# Getting started — Lane 1 (Adrian)

Read in this order tonight: this page (5 min) → `docs/playbooks/lane-1.md` §0–§1 (5 min) → `PLAN §4.3` column A (keep it open). Everything else you look up when its row comes.

## 9:45–10:00 PM — pre-flight (before the official start; nothing Nexus-specific is written)

Tick every box; if one fails, fix it now, not at T+0.

- [ ] `C:\dev\nexus` is the upstream clone at tag `1.145.2`; `npm run watch` is running in **Terminal 1** and says compilation finished (`CLAUDE.md` §3 build test).
- [ ] `node -v` → `v24.22.1`; `git config user.name` / `user.email` are your real identity; `claude doctor` is green; `gh auth status` is green (`PLAN §4.1` PE-1, PE-8).
- [ ] Logged in, in a browser tab each: GitHub (team org), Slack (nothing created yet unless PE-6 said it may be), Anthropic Console, Google AI Studio + the billing-enabled GCP project, Auth0, Cloudflare, Prune, Swarms, Tiger Cloud (`PLAN §4.1` PE-9). Guardian app on your phone.
- [ ] `docs/PLAN.md`, `docs/playbooks/lane-1.md`, `CLAUDE.md` and `docs/reference/globe-prototype.html` are in a folder **outside** the checkout, ready to copy in at H0-A2 (they must not exist in the repo before the import commit).
- [ ] Brandon's and Elkin's build-test results are in `CLAUDE.md` §3's table and the fork/Electron decision was made by 9:15 PM (`CLAUDE.md` §19 open items). If Electron: stop, this plan does not apply.
- [ ] PE-6 answers written down: fork of open source allowed? Slack workspace allowed pre-start? Elkin's GitHub handle (for CODEOWNERS).
- [ ] Browsers you don't need are closed; only one VS Code/Nexus window will be open (8 GB rules, `CLAUDE.md` §11).
- [ ] **Terminal 2** is open at `C:\dev\nexus` for git/repo work; **Terminal 3** will be the Claude Code lead session (started at T+0:25, after the import, so it reads the tracked `CLAUDE.md`).

## 10:00–10:15 PM — waiting for the gun

Three-person huddle (the "All" row of `PLAN §4.3` 0:00–0:10 starts at the official minute). Read `CLAUDE.md` §8 together once; decide only names (channel names, who is on the phone). Write the exact T+0 minute on a sticky note; it goes into `progress/lane-1.md` at H0-A2.

## T+0:00 → T+0:25 — you alone, no Claude Code yet

Do H0-A1 by hand from `CLAUDE.md` §3 "Creating the team repo" (orphan `main`, import commit, remote rename, push, LFS retry). Then H0-A2: copy `CLAUDE.md`, `docs/`, `.gitignore` entries, `progress/lane-{1,2,3}.md` (five headings each) into the checkout; commit `lane-1: add CLAUDE.md, plan, playbooks, progress files`; push. Send Brandon and Elkin the remote-switch block (`CLAUDE.md` §3 step 5) and `gh repo set-default <team>/nexus`.

## T+0:25 — start the lead session

In Terminal 3, at `C:\dev\nexus`, start Claude Code and paste this as the first message (edit the two placeholders):

```
You are the Lane 1 lead session for Nexus. Read CLAUDE.md fully, then docs/PLAN.md sections 1–4 and 5.1,
then docs/playbooks/lane-1.md. T+0 was <HH:MM ET>; Elkin is <name>.
Rules you follow without being asked: CLAUDE.md §10 (commits "lane-1: …", merge main never rebase, only I push),
§11 (sparse worktrees, max 2 workers, two attempts), §12 (progress/lane-1.md is yours alone), §14 (rails).
Right now we are in hour 0. Do H0-A3 from PLAN §4.3: build the extensions/nexus skeleton exactly as PLAN §3 and §4.2
describe (package.json with the dependency list in PLAN §3.2, tsconfig, vitest + vite config, scripts/merge-contributes.mjs
per PLAN §3.1, contributes/base.json + three empty lane fragments, src/extension.ts calling three empty register functions,
src/register/lane-{1,2,3}.ts stubs, webviews/shared placeholder entry, .github/workflows/ci.yml running `npm run ci`
inside extensions/nexus, .github/CODEOWNERS per PLAN §3.3). Then run `npm install` inside extensions/nexus and
`npm run ci`; it must be green with zero tests before contracts land. Do not write any contracts, features or UI yet.
Report with the headings Changed / Commits / Acceptance / Open questions, then stop and wait for me.
```

While it works (≈20 min), you do H0-A4's first half by hand: `product.json` name/`applicationName`/`dataFolderName`/`urlProtocol` **(verify field names in the file)**, and pull Brandon and Elkin for the 10-minute contracts read of `PLAN §2`.

## T+1:05 — contracts

Second message to the lead:

```
Create extensions/nexus/src/contracts exactly as PLAN.md §2.1–§2.12: one file per subsection, Zod schemas with inferred
types, protocol.ts, agent-protocol.ts, commands.ts, fixtures/index.ts, fixtures/stream.ts (scriptedNexusEvents with the
seeded generator described), fixtures/scenario.ts, and src/contracts/contracts.test.ts that parses every fixture with
its schema and checks seq contiguity in scriptedAgentEvents. Apply only these review edits from the team: <paste or "none">.
Do not change any semantics note. Acceptance: `npx vitest run src/contracts` green and `npm run typecheck` green.
Commit as "lane-1: add contracts and fixtures". Stop and report.
```

Then H0-A5 by hand: commit the rest of cp-0 (`PLAN §4.2`), branch protection + auto-merge, `git tag cp-0 && git push --tags`, `git branch lane-1 lane-2 lane-3 && git push origin lane-1 lane-2 lane-3`, Routine (`CLAUDE.md` §12). Announce `cp-0` in `#nexus-build`.

## T+1:45 → T+2:00 — H0-A6, then first dispatch

Launch check on your machine, then the Auth0 Native app + Slack connection (Token Vault only) + the 3-minute CIBA plan check; write yes/no into `progress/lane-1.md` → Decisions. Then:

```
cp-0 is tagged; switch to branch lane-1. Begin wave 1 from docs/playbooks/lane-1.md §1: create sparse worktrees and
dispatch Worker A on L1-03 and Worker B on L1-08 using the briefs in PLAN §5.1 verbatim (fill WORKTREE paths). Queue
L1-23 → L1-24 after L1-03 and L1-26 after L1-08. Never more than 2 workers. For each finished task run the merge
procedure in CLAUDE.md §11 with a reviewer, then update progress/lane-1.md and push lane-1. Ask me before anything
touching VS Code core; I am doing L1-S1 myself in this checkout.
```

You start L1-S1 (`PLAN §5.1 L1-S1`) in the main checkout in parallel.

## First hour of wave 1 — what to watch

- T+2:30: Lane 2's interface-drop PR on `main` (`lane-2.md` §1). Have the lead `git merge main` as soon as it lands.
- T+3:00: both workers' first commits exist and are red tests (brief rule: test first). If a worker asks for a dependency or a file outside OWNS, answer in the brief, never by hand-editing its worktree.
- T+4:00: L1-S1 result in Decisions. If the built-in bundle fails, the fallback is `--extensionDevelopmentPath` for cp-1 (`PLAN §5.1 L1-S1` STOP WHEN) — write it down and move to L1-02.
- Hand-run the Swarms and Prune curl checks from `PLAN §1 Q2/Q5` with your keys (10 min each) and write what came back into Decisions; L1-17 and L1-20 briefs depend on it.

## If something is off at 10 PM

| Symptom | Do |
|---|---|
| Push of the import commit fails on LFS | `git lfs push --all origin main` then push again (`CLAUDE.md` §3 step 2) |
| A teammate's machine can't switch remotes cleanly | they re-clone the team repo shallow and reuse nothing; their first `npm install` costs ~8 min (`CLAUDE.md` §3 build numbers) |
| Slack app creation is slower than 15 min | Brandon continues; your H0-A3 does not depend on it; tokens are needed first at H0-N3 (~T+0:40) |
| Branch protection blocks your own cp-0 push | protect `main` **after** the cp-0 tag (that is the order in H0-A5) |
