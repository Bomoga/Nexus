# Getting started — Lane 2 (Brandon)

Read tonight, in order: this page (5 min) → `docs/playbooks/lane-2.md` §0–§1 (5 min) → `PLAN §4.3` column B and `PLAN §4.5` (the Slack manifest). You own the Slack app and the Tiger Cloud service during hour 0, and your lane's T+2:30 **interface drops** unblock the other two lanes, so your first hour is the most time-sensitive of the three.

## 9:45–10:00 PM — pre-flight

- [ ] Your upstream clone at `1.145.2` builds; `npm run watch` is running in **Terminal 1** and finished (`CLAUDE.md` §3). Your first-build and incremental times and RAM are in `CLAUDE.md` §3's table.
- [ ] `node -v` → `v24.22.1`; git identity set; `claude doctor` green; `gh auth status` green.
- [ ] Logged in: GitHub, Slack (workspace creation only after the gun unless PE-6 said otherwise), Tiger Cloud console, Anthropic Console, Google AI Studio (your dev keys), Auth0 (for the sign-in at ~T+8), Guardian app on your phone.
- [ ] `psql` or any Postgres client installed for H0-B4 (`PLAN §4.3`) — `npx pg` scripts are fine too.
- [ ] A scratch folder outside the checkout (e.g. `C:\dev\nexus-scratch`) with an empty extension skeleton for the H0-B3 checks (git API, child process) — nothing Nexus-specific in it.
- [ ] **Terminal 2** for git; **Terminal 3** for the Claude Code lead session, started after you've switched remotes (so it reads the team `CLAUDE.md`).
- [ ] Know your RAM: 8 GB → 2 workers; 16 GB → 3 (`PLAN §1 Q4`, `lane-2.md` header).

## 10:00–10:15 PM — huddle

`PLAN §4.3` 0:00–0:10 "All" row. You are the phone teammate in the demo (`PLAN §10` D-3); confirm that.

## T+0:10 → T+0:25 — H0-B1 Slack app, by hand

Create the workspace and the app from the manifest in `PLAN §4.5` (paste it in the app config's manifest editor; if Slack rejects a scope, note the one it accepted — scopes are **(verify)**). Enable Socket Mode, generate the `xapp-` token (`connections:write`), install to the workspace, create `#nexus-demo` and `#nexus-build`, invite the app to both. Post the app's install link in `#nexus-build` so each person can authorize and get their own `xoxp-` at H0-N3. Tokens go in your env/keychain only (`CLAUDE.md` §14).

## T+0:25 → T+0:40 — H0-B2 switch remotes, start the lead

Run `CLAUDE.md` §3 step 5 in your checkout, then `gh repo set-default <team>/nexus`; confirm `npm run watch` is still incremental. Start Claude Code in Terminal 3 and paste:

```
You are the Lane 2 lead session for Nexus. Read CLAUDE.md fully, then docs/PLAN.md sections 1–4 and 5.2, then
docs/playbooks/lane-2.md. T+0 was <HH:MM ET>. My machine has <8|16> GB, so max <2|3> workers.
Rules you follow without being asked: CLAUDE.md §10, §11, §12, §14. You never write webview UI.
We are in hour 0 and cp-0 does not exist yet, so do not create branches or worktrees. Do H0-B2's smoke test now:
from a scratch Node script outside the repo (C:\dev\nexus-scratch), using @slack/bolt in Socket Mode with the
SLACK_APP_TOKEN and SLACK_BOT_TOKEN from my environment, receive one message posted in #nexus-build and print its
text. Then write what worked (package versions, event name, anything surprising) under Decisions in a draft I will
paste into progress/lane-2.md. Do not store or print the tokens. Stop and report.
```

## T+0:40 → T+1:05 — H0-B3 by hand with the lead

Second message:

```
In C:\dev\nexus-scratch create a throwaway extension (not Nexus code) that on activate (1) gets the built-in git API
via vscode.extensions.getExtension('vscode.git').exports.getAPI(1) and logs the repo's branch names, and (2) forks a
child Node process with child_process.fork, sends {ping:1} over JSON lines on stdio and logs the reply. I will launch
the fork with --extensionDevelopmentPath pointing at it. Tell me the exact getAPI version that worked and the shape
of the Repository/Ref objects you saw; that goes into PLAN §5.2 L2-05's "(verify)" note. Stop and report.
```

You launch, read the Output panel, and write results into your Decisions draft.

## T+1:05 → T+1:30 — H0-B4 Tiger Cloud, by hand

Create the free service; keep the connection string in your env only. Run `sql/001_schema.sql` as drafted in `PLAN §5.2 L2-09` (ask the lead to write the file from that block — it is lane-2 code and allowed now that the skeleton exists on `main` after Adrian's H0-A3 push; commit it later on `lane-2`). Then the NOTIFY check: `LISTEN nexus;` in one `psql`, `NOTIFY nexus, 'x';` in another; did the first session print it? Write yes/no — `PLAN §5.2 L2-11` reads it. Hand the connection string to Adrian and Elkin **in person**.

## T+1:30 → T+2:00 — H0-B5 first worktree, H0-B6 dispatch

After Adrian announces `cp-0`: `git fetch && git switch lane-2`. Run the sparse-worktree sequence from `CLAUDE.md` §11 once by hand with a throwaway id; if `git sparse-checkout` misbehaves, write "full worktrees, 2 workers" into Decisions (`CLAUDE.md` §11). Then:

```
cp-0 is tagged and I am on lane-2 (sparse worktrees <work|do not work>; max <2|3> workers). Paste this into
progress/lane-2.md under Decisions: <your draft>. Begin wave 1 from docs/playbooks/lane-2.md §1: dispatch Worker A
on L2-01, Worker B on L2-02<, Worker C on L2-08> with the PLAN §5.2 briefs verbatim. Each worker's FIRST commit, within
30 minutes, is the interface + fake named in its PLAN block; the moment all three (or two, plus the store interface I
will write with you by hand) are in, merge them to lane-2 and open a PR to main titled
"lane-2: interface drops for bridge, slack, store". Then write src/services/gate/types.ts yourself per PLAN §5.2 L2-13
and include it. Use the merge procedure in CLAUDE.md §11 for every task; update progress/lane-2.md and push lane-2
after each merge.
```

On 8 GB, you and the lead write `src/services/events/store.ts` + `fake-store.ts` by hand at T+2:30 (`lane-2.md` §1) while two workers run.

## First hour of wave 1 — what to watch

- T+2:30: the interface-drop PR is open; ping `#nexus-build` when it merges. Lanes 1 and 3 are waiting on it.
- T+3:00: three red-test first commits. L2-01's reviewer must be **Opus-class** (bridge; `CLAUDE.md` §11).
- T+4:00: `web-client.test.ts` uses recorded JSON, no network — if a worker reaches for a real token in a unit test, dispute it.
- Keep Socket Mode's scratch script running in the background so you notice if the venue Wi-Fi drops the socket (`CLAUDE.md` §17).

## If something is off at 10 PM

| Symptom | Do |
|---|---|
| Slack won't accept a manifest scope | remove it, install, note it in Decisions; the user-token scopes that matter first are `channels:history`, `channels:read`, `chat:write`, `users:read` {unverified against Slack's reference} |
| Socket Mode receives nothing | the app must be **in** the channel and subscribed to `message.channels` (`PLAN §4.5`); check the app-level token has `connections:write` |
| Tiger service creation is slow | continue to H0-B5; L2-09/L2-10 need it only from wave 3/4 (`lane-2.md` §3–§4) |
| `getAPI(1)` is undefined | try the version the fork's `extensions/git/src/api/api1.ts` exports and record it; it is a `(verify)` item in `PLAN §5.2 L2-05` |
