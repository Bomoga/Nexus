# Lane 1 overnight watch: poll for other lanes' pushes and act on unblockings

How to use: open a Claude Code session in the Nexus repo on branch `lane-1` (after, or alongside, `lane-1-session-2.md`), then run `/loop` with no interval and paste everything below the line as the loop prompt. The session paces itself (20 to 30 minutes between quiet checks, shorter right after something changed). Say "stop the loop" to end it.

---

You are the Lane 1 lead for Nexus, on an unattended overnight watch. Read `CLAUDE.md` (especially sections 10 to 12 and 14) and `progress/lane-1.md` once, then run one tick of the procedure below per wake-up. Tag factual claims with `[proof: ...]` or `{unverified}`. Commits are `lane-1: <what changed>` with the trailer the session's attribution reminder gives. Never rebase, never force push, never push `main`, never edit `src/contracts`, VS Code core (`src/`, `build/`, `product.json`), or another lane's files. Push only `lane-1`. Never print, log or commit anything from `extensions/nexus/.env`.

## One tick

1. **Fetch.** `git fetch origin` (no merge yet). Read the heads of `origin/main`, `origin/lane-2`, `origin/lane-3`.
2. **Compare with the last seen heads**, kept in `.git/nexus-poll-state` (a plain text file inside `.git`, so it is never committed; create it on the first tick with the current heads and treat that tick as "nothing new").
3. **Nothing moved on `origin/main`:** if `origin/lane-2` or `origin/lane-3` moved, read only their new `progress/lane-N.md` (`git show origin/lane-N:progress/lane-N.md`) for Blocked and Decisions lines that mention Lane 1, and note any request. Then update the state file and go to step 8 as a quiet tick.
4. **`origin/main` moved:** list what changed (`git diff --stat <old>..origin/main`) and classify it:
   - **Unblocks Lane 1:** a real `LocalStore` or event store implementation, the bridge router and host, the Slack service, the gate, `src/shared/redact.ts` reaching `main`, the git service (worktrees, merge), or anything in `progress/lane-2.md` or `lane-3.md` that says a Lane 1 request was answered. Also a Lane 3 webview or message-shape change that touches a Lane 1 protocol message.
   - **Contracts changed** (`src/contracts/**`): stop automating. Record it in `progress/lane-1.md` under Blocked and do nothing else until Adrian reads it.
   - **Other:** note it and continue.
5. **Merge `origin/main` into `lane-1`** (`git merge`, no rebase) only when the change is relevant. On a conflict inside Lane 1's own paths, resolve it, re-run the checks, and commit the merge. On a conflict outside Lane 1's paths, run `git merge --abort`, write the conflicting paths and owning lane under Blocked in `progress/lane-1.md`, push that note, and stop acting on this change.
6. **Check and unblock.** From `extensions/nexus` run, with the working directory verified first: `npm run contributes:check`, `npm run typecheck`, `npm run lint`, `npm test`. If anything is red because of the merge, fix it inside Lane 1's paths; if the cause is another lane's code, record it under Blocked and do not patch their files. If green, do the Lane 1 work the change unblocks, from `lane-1-session-2.md` tasks 2 to 5 first (adapters test, `register/lane-1.ts` wiring, commands, leftovers), swapping fakes for the real service when it is on `main` and keeping the fake-based test too. Keep every commit green.
7. **Record and push.** Update `progress/lane-1.md` (Done, In flight, Blocked, Decisions, Next) with what arrived and what you did, run the checks again, then `git push origin lane-1`. Update `.git/nexus-poll-state` with the new heads.
8. **Schedule the next tick** with `ScheduleWakeup`, passing this same prompt: 1200 to 1800 seconds when nothing changed, 300 to 600 seconds for one follow-up tick right after you merged something (to catch a second push), and set `noop` true for a tick that only checked.

## Overnight limits (CLAUDE.md section 12)

- Work only on tasks already briefed in `lane-1-session-2.md` or `progress/lane-1.md`. Start no new, unbriefed feature work and open no PR to `main`.
- Do not tag checkpoints. Do not merge `lane-2` or `lane-3` into anything; only `main` comes into `lane-1`.
- Anything that needs Adrian goes in `progress/lane-1.md` under Blocked with one clear line each: the fork launch check and any PR of `redact.ts` to `main`, core changes (L1-S1, L1-02, L1-22 core), branding, the CIBA yes or no, the Auth0 round trip through the fork, a Swarms council run (costs money), the Prune tool-calling check, and any contracts change.
- No live API calls beyond what a unit test needs. No spending: the integration tests (`npm run test:int`) are not part of this loop.
- If the 5-hour usage limit stops you, resume with the next tick once it resets; read `.git/nexus-poll-state` and `progress/lane-1.md` first so nothing is repeated.
- If three ticks in a row fail the same way, stop looping, write the failure and the last command output summary under Blocked, push the note, and wait for Adrian.

## Morning handoff

When Adrian returns (or the loop is stopped), the last tick writes a short summary at the top of `progress/lane-1.md` Next: what arrived from other lanes overnight, what Lane 1 merged and built, what is still blocked on whom, and the exact commands to run the launch check.
