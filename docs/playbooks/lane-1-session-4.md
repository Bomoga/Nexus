# Lane 1, session 4: handoff

Written 2026-11-07 (T+0 was 22:15 ET Fri 2026-11-06). Read `CLAUDE.md`, then `progress/lane-1.md` (Done, Blocked, Decisions), then this file. Claims below carry how they were checked; `{unverified}` means it was not.

## Where things stand

- `main` = `bf99225f` (PR 8 merged by Adrian's instruction). `lane-1` = `30e321d4`, 3 commits ahead of `main`, pushed. No open PRs. Lane 2's branch has nothing that is not already on `main`; Lane 3's branch is about 56 commits ahead of `main`, unmerged. [proof: `git rev-list --left-right --count` on 2026-11-07]
- PR 8 brought to `main`: Nexus branding in `product.json`; `extensions/nexus` registered in `build/gulpfile.extensions.ts`; the tab-less `nexus.home` editor (`editor.ts`, `editorGroupView.ts`, `editorCommands.ts`); startup defaults (`workbench.contribution.ts`); the controller hang fixes; the Lane 1 features. Launch check on merged `main`: branded window, no Chat/Welcome/GitHub prompt, "pick a model" status item. [proof: screenshot and logs, session 3]
- Not on `main`, on `lane-1` only: `AUTH_REDIRECT_URI` is now `nexus://nexus.nexus/auth/callback`; `product.json` has `trustedExtensionProtocolHandlers: ["nexus.nexus"]` (core change, needs a `#nexus-build` heads-up before it reaches `main`); `parseCouncil` in `src/features/swarms/review.ts`.
- Adrian's decisions this session: CIBA plan = yes; ALL contracts changes approved by Adrian (see below; Brandon and Elkin have NOT yet approved); Auth0 tenant and Native app done; Prune connected; no branch protection (Lane lead merges its own PR on green CI plus a launch check); T+0 = 22:15 ET Nov 6.

## Facts that surprised us (do not rediscover)

1. **`nexus://auth/callback` can never work.** Core `src/vs/workbench/services/extensions/browser/extensionUrlHandler.ts:155` returns false unless `uri.authority` is an extension id (regex at line 37 needs `publisher.name`). Every route must be `nexus://nexus.nexus/<route>`. [proof: read the file]
2. **No `registerUriHandler` exists in the extension.** `register/lane-2.ts` is an empty stub: `export function registerLane2(_context): void {}`. Lane 2's services (`LocalStore`, bridge `router`/`host`, `search`, Slack `web-client`) exist as code under `src/services` and `src/bridge`, but nothing constructs them; the gate and git service are not on `main` (only `services/gate/types.ts`). So `registerLane1` runs on stand-ins, which is why the launch log says "using stand-ins for Lane 2: router, store, slack, git, makeGate". [proof: `ls`, `cat` of `extension.ts` and `register/lane-2.ts`]
3. **CouncilAsAJudge returned HTTP 503 "Service Unavailable" from about 14:10 UTC on 2026-11-07**, including a bare `curl`, while `MajorityVoting` and single-agent calls returned 200. The review feature correctly degrades to `unavailable`. [proof: curl output]. Earlier the same day it ran in about 11 s for about $0.064 with an `output` list of 6 `*_judge` turns plus `aggregator_agent`.
4. When it did run, the council graded the Reviewer agent's reply to the task, not the diff itself, and the prompt's "reply with JSON" made judges mark format failures as `do_not_merge`. Whether a better prompt fixes this is **untested** (blocked by fact 3).
5. A launched `Nexus.exe` shows up beside the user's own VS Code (`Code`); pick the window by process name `Nexus`, never by title match, or you screenshot the wrong app.

## Approved contracts changes (Adrian approved; Brandon and Elkin pending, in writing)

1. `ChatMessage.clientId?: string`, echoed by the host; `slack.post` idempotent per `clientId` (Lane 3 L3-09 needs it).
2. New protocol message `ui.openExternal` (validated https URL, system browser).
3. `orbitOf`: `lane-N-wt/<id>` belongs to `lane-N`; Lane 2's git watcher also skips `lane-N-wt/*`.
4. `decodeCodeRef` never throws `URIError`; returns a failure result.
5. URI authority rule: all routes are `nexus://nexus.nexus/<route>`; update the `coderef.ts` route comment and link builders.

## Tasks, in order (do each; stop only at a stop rule)

### T1. Contracts PR (hold the merge)
- Branch from current `lane-1` as the PR head `lane-1` is not suitable; use a short-lived branch `lane-1-contracts` off `lane-1` (push is allowed for it; it is a contracts PR, not a worker branch). Implement items 1 to 5 in `extensions/nexus/src/contracts`, with fixtures and tests, and the one-line PR body "contracts: clientId, ui.openExternal, orbitOf worktree branches, non-throwing decodeCodeRef, nexus.nexus URI authority".
- Open it against `Bomoga/Nexus` `main` (`gh pr create --repo Bomoga/Nexus ...`; this checkout has no default repo set, and without `--repo` gh targets upstream `microsoft/vscode`).
- **Never merge it** until Brandon (`brandondelgadoo`) and Elkin (`aeer0c`) have each approved in writing (a PR comment or review from them, or Adrian relaying their words in chat). Quote what you rely on in the progress file. Then merge.
- Post nothing to Slack yourself; Adrian sends the heads-up.

### T2. Lane 2 wiring status, then Lane 1's side of the wiring
- Fetch `origin/lane-2` and `origin/main`. Read `register/lane-2.ts` and Lane 2's `progress/lane-2.md`.
- If Lane 2 has made `registerLane2` return or expose services (router, store, slack, git, gate), wire them into `extension.ts` (Lane 1's file) via `registerLane1(context, services)`; test with the existing fakes plus one new test that the real objects satisfy the interfaces.
- If not, do **not** write `register/lane-2.ts` or anything under `src/services`/`src/bridge` (Lane 2's). Record exactly what is missing in `progress/lane-1.md` Blocked and draft one short message for Adrian to relay to Brandon: which service, which file, which interface in `src/register/lane-1.ts` (`Lane2Services`) it must satisfy.

### T3. Auth0 round trip
- Needs the Auth0 domain and client ID in settings `nexus.auth0.domain` and `nexus.auth0.clientId` (the tenant in `progress/lane-1.md` is `dev-pun3bnu12p3pivae.us.auth0.com`; the client ID is Adrian's: ask for it or read it from his VS Code settings; do not write it into the repo).
- Preconditions: Adrian has added `nexus://nexus.nexus/auth/callback` to the Auth0 app's Allowed Callback URLs, and a `registerUriHandler` exists (Lane 2's `uri-handler.ts` route table). If either is missing, record it and move on.
- When both hold: launch the fork (see Environment), run `nexus.signIn`, complete the browser sign-in, confirm the callback reaches `handleAuthUri` (`src/features/auth/current.ts`) and the status shows signed in. Never print or log tokens or the code.
- The `nexus://` protocol is not registered with Windows for a dev build; if the browser cannot hand the URL back, test with `scripts\code.bat --open-url "nexus://nexus.nexus/auth/callback?code=x&state=y"` to prove the routing, and report that real round trip needs the packaged app or manual protocol registration.

### T4. Swarm review, second half
- First check the council: `POST /v1/swarm/completions` with `swarm_type: CouncilAsAJudge`, one agent, task "What is 2+2?" (key from `extensions/nexus/.env`, never printed). If still 503, record the time and skip to T5.
- If it answers: run `npm run test:int -- swarms`, then run the review on one GOOD diff (discount applied per unit, tests pass) and one BAD diff (the agent weakens the test), printing each judge's role and first 200 characters. Decide from evidence whether the council grades the diff. If not, redesign `SwarmReviewService.prompt` (put the evidence in the `task`, give the Reviewer agent a system prompt, drop the JSON demand from the task and derive the verdict in `parseCouncil`); keep the unit tests green; re-run live; record the numbers and cost (about $0.06 per run).

### T5. Prune tool-calling passthrough (L1-S4)
- Read `src/models/prune-adapter.ts` and `progress/lane-1.md` Prune notes (documented endpoint `POST https://api.withprune.com/v1/chat/completions`, Bearer key; a request with no system message got a 400 from Anthropic). Run one tool-calling turn through Prune for Anthropic and one for Gemini with a trivial tool; record whether tool calls and tool results survive and where the receipt appears. If both pass, document that `all_roles` scope may be enabled and leave the default as `text_roles`; Adrian decides the default.

### T6. Remaining small items
- `registerHomeKeeper` calls `nexus.openHome`, which no lane implements: check whether Lane 3's branch has it; if so, note it for the Lane 3 merge; if not, leave it and say so.
- Run the extension checks on `lane-1` (`npm run contributes:check`, `npx tsc --noEmit -p .`, lint, `npm test`) and log the result; the one known red test is Lane 2's timing test in `local-store.test.ts` (leave it).
- When `lane-1` has changes worth shipping (the auth callback, `product.json`, `parseCouncil`): run the launch check on the merged tree, post the core-change heads-up text for Adrian to send, open a PR `lane-1` into `main` with a title only, wait for the `extension` check, and merge. The Copilot, `Analyze` and Playwright checks on this repo are upstream workflows that sat queued for 10 minutes on PR 8; the `extension` check is the gate.

## Standing rules (from CLAUDE.md and Adrian)

- Check for other agents and sessions before acting (`ListAgents`, `git fetch`, `gh pr list --repo Bomoga/Nexus`); never edit another lane's paths, `.env` files, or `src/contracts` outside T1.
- Never rebase, never force push, never push `main`; push only `lane-1` (and `lane-1-contracts` for T1). Commit format `lane-1: <what changed>`, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Never print, log or commit anything from `extensions/nexus/.env` (it exists only in the OneDrive checkout). Test key strings in code must be obviously fake.
- Tag claims `[proof: ...]` or `{unverified}`. Report outcomes faithfully, including red tests.
- Ask Adrian only for: the Auth0 client ID, a CIBA or Auth0 dashboard change, money beyond a few cents of live API calls, or a contracts approval from Brandon or Elkin.

## Environment

- Two checkouts, both on `lane-1`: the OneDrive repo (`C:\Users\atmor\OneDrive\Desktop\Repositories\Nexus`, holds `.env`, use for extension work and tests) and `C:\dev\nexus` (the built fork, use for launch checks). Keep them in step: commit and push from one, `git pull --ff-only origin lane-1` in the other.
- Fork build: Node 24.22.1 via PATH: `$env:PATH = "C:\Users\atmor\AppData\Roaming\fnm\node-versions\v24.22.1\installation;" + $env:PATH`. Do not run `npm run watch` (starts `watch-copilot`); run `npm run watch-client-transpile` and `npm run watch-extensions` in `C:\dev\nexus` only when sources change; the compiled `out/` is current as of `bf99225f` plus the three newer `lane-1` commits NOT yet compiled.
- Launch: `scripts\code.bat --user-data-dir <scratch>\ud2 --extensions-dir <scratch>\ed <file>`; stop with `taskkill /F /IM Nexus.exe`. Screenshot with `PrintWindow` on the process named `Nexus`.
- `extensions/nexus` needs a manual `npm ci`; its `package.json` contributions come from `npm run contributes`; `media/` from `npm run build:webviews`.
- 8 GB machine: one Nexus window, no second watcher, close heavy apps during a launch check.
