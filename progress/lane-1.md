## Done
Lead session, no workers: everything below was written, tested and independently reviewed on the local `lane-1` branch. Nothing is pushed (no `cp-0` tag yet). `npm run ci` in extensions/nexus is green: 28+ test files, ~500 unit tests, typecheck, lint, contribution merge.
- L1-23 redact (bounded patterns, fails closed over 2 MB, catches `.env` lines inside diffs)
- L1-24 prompt framing (random fence token; rules cover fences, quoted `> ` brief lines and the task title)
- L1-03 provider interface, FakeProvider (key fingerprints only), ListingCache
- L1-04 Anthropic provider (retries off, cut-off streams detected) and L1-05 Gemini provider (plain function declarations only; generateContent path, not Interactions)
- L1-06 accounts service + `Nexus: Connect provider`; L1-07 model picker (status bar + quick pick, data-use labels, Swarms never offered for the agent)
- L1-08 agent process host + child channel (env allowlist, 8 Mi line cap, 64 concurrent requests, replies only to the asking process, one restart per session)
- L1-09 agent runtime tool loop (8 tools over the gate, redacted and bounded events, tool results fenced, cancel frees the runtime even if the provider ignores abort, Prune routing per call)
- L1-10 sessions controller (gap-free seq, replay-then-live, start guard, best-effort finalize), L1-11 tasks controller + thread brief builder (everything from Slack is quoted), L1-12 approvals controller (first answer wins, no timeout, races closed, ended sessions refuse decisions)
- L1-14 Auth0 sign-in (PKCE, state + nonce + id_token checks, only the refresh token stored); settings `nexus.auth0.*`, commands `nexus.signIn` / `nexus.signOut`, `handleAuthUri` for Lane 2's URI handler
- L1-17 Swarms client + text-role provider, L1-18 advisory swarm review, L1-19 task breakdown + scheduler (max 2, 1 under 10 GB, dependency order)
- L1-20 Prune adapter + receipts, L1-21 optimizer (toggle, spend totals, receipts to the store)
- L1-22 extension half (home keeper); L1-26 demo repo seed + `demo/demo-script.md` + `nexus.dev.reseedDemoRepo`
- Independent reviews: four rounds with fresh Opus/Sonnet reviewers; every blocking finding fixed and covered by a test (one fix was mutation-checked). Round four's fixes: early approval decision read after the await, session ending claimed synchronously and shared by concurrent callers, event sanitiser bounded by total nodes with cycle and getter handling, undecidable approvals of ended sessions hidden from "waiting", swarm subtask briefs quoted and parent referenced by id, scheduler marks tasks failed only while still draft.
- Composition root `composeLane1` (src/features/compose.ts) with an offline end-to-end test: thread, task, agent, human approvals, swarm review, commit.

## In flight
- none

## Blocked
- cp-0 is not tagged, so `lane-1` exists only locally (CLAUDE.md §10: no lane branch before cp-0). Needs Adrian: branding in product.json, branch protection, the T+0 minute, GitHub handles in CODEOWNERS, then the tag.
- Core work stays with Adrian: L1-S1 (register extensions/nexus with the fork build), L1-02 (tab-less home), L1-22 core half (startup defaults, Nexus Dark, chat/Copilot off).
- Live checks need Adrian's keys and accounts: `npm run test:int -- anthropic|gemini|swarms` (ANTHROPIC_API_KEY, GEMINI_API_KEY, SWARMS_API_KEY); Prune live check (L1-S4: tool-calling passthrough decides `all_roles`); Auth0 tenant + Native app for L1-S6.
- Wiring needs Lane 2: the sessions, approvals, tasks, swarm review, decompose, optimizer and Auth0 services are built and tested but NOT constructed in `src/register/lane-1.ts`, because they need Lane 2's event store, git service, gate and Slack service (interface drops not on main yet). Adapters to the Lane-1-owned ports in `src/features/ports.ts` are the integration step; `src/features/testing/memory-ports.ts` shows the expected behaviour (conditional approval update, worktree per session, gate asking approvals).

## Decisions
T+0 = <HH:MM ET>, 2026-11-06
- The agent reports "session finished" with a child-to-host `evt` named `session.finished` (src/agent-process/session-events.ts). The frozen agent protocol has no such message and it is internal to Lane 1's two processes, so no contract changed.
- Ports, not Lane 2 imports: controllers talk to `StorePort`, `GitPort`, `GatePort`, `SlackPort` (src/features/ports.ts). Lane 2 should satisfy them or Lane 1 writes adapters when their interfaces land. Notable requirements: `decideApproval` must be a conditional update returning `{approval, won}`; `GitPort.removeSessionWorktree` is optional cleanup; the gate's `cmd.run` / `git.commit` must call `ApprovalsController.request` and wait.
- Live smoke results (2026-11-07, Adrian's keys): Anthropic `claude-sonnet-5-5` tool round trip passes; Gemini passes on `gemini-3.5-flash` (`gemini-3.8-flash` returned 503 "high demand"); Swarms single-agent call passes after a $1 purchased top-up (free credits do not count; the CouncilAsAJudge run is NOT yet run). Model lists came from each account's own list call.
- Prune live (2026-11-07): `POST /v1/chat/completions` (Bearer) and the native `/v1/proxy/anthropic/messages` (`X-Prune-Key`) both answer 200 with `prune_metadata` once the request has a system message; a request with NO system message gets a 400 from Anthropic via Prune. Every Nexus role call sends a system prompt. Each Prune call now sends `X-Prune-Template-Id: nexus-<role>`; `nexus-summary` appears under Dashboard -> Templates. Tool-calling passthrough (L1-S4) is still untested, so the agent stays on `text_roles`. The note below that the proxy routes are undocumented is out of date: they exist.
- Prune: the plan's per-provider `/v1/proxy/<provider>/…` routes with a `user_api_key` field are NOT in Prune's docs. Documented (withprune.com/docs, read 2026-11-06): OpenAI-compatible `POST https://api.withprune.com/v1/chat/completions`, Bearer Prune key, provider keys in Prune's vault, receipt as `prune_metadata` (routed_model, cost_with_prune_usd, receipt_signature, …). The adapter follows the docs. Whether Anthropic/Gemini tool calls pass through is undocumented, so the agent stays on its provider (`text_roles`) until L1-S4 passes. The model is pinned by discarding any answer from a different model.
- Swarms: REST confirmed from the API reference (`POST /v1/swarm/completions`, `/v1/agent/completions`, `GET /v1/models/available`, `x-api-key`). The docs state no way to switch off default tools, so the client simply never sends tool/MCP fields; CouncilAsAJudge's final text is read from the last output turn. Both calls are unverified against a live key (smoke L1-S5).
- Gemini uses generateContent with function declarations; Gemini 3 thought signatures are passed through as `providerMeta` (unverified live, smoke L1-S3).
- Anthropic: `dataUse: not_used_for_training` is sourced to privacy.claude.com (src/models/data-use.ts). Gemini is "may be used" unless the user says the project is billing-enabled.
- Untrusted text: the whole Slack thread, author names and code-ref paths are on `> ` quoted brief lines; the task title is fenced when given to the model; SYSTEM_RULES say so. A task title is still shown to people as plain text.
- Cancelling a session records any waiting approval as the cancelling human's rejection; any other ending releases the waiting gate as rejected WITHOUT writing a decision and refuses later decisions.
- `nexus.approve` / `nexus.reject` without an id act only when exactly one approval is waiting.
- Commit 46d2d305 was committed with one failing approvals test (a real ordering bug, fixed by the next commit 3236ec0d). The branch is green at every other commit.
- The demo history must be seeded close to demo time (`--t0 now`, which the re-seed command does).
- eslint.config.mjs got an `.mjs` globals block for the child-process test fixture (integrator-owned file).

## Next
- Adrian: tag cp-0 (see Blocked), then push `lane-1` and merge `main` into it.
- Run the live smoke checks with real keys (anthropic, gemini, swarms, prune, auth0) and write the results here.
- With Lane 2's interfaces on main: write the adapters, construct the services in `register/lane-1.ts`, register `nexus.approve`, `nexus.reject`, `nexus.makeTaskFromThread`, `nexus.decomposeTask`, `nexus.rerunSwarmReview`, `nexus.toggleOptimizer`, `nexus.openReceipt`, and add the VS Code notification adapter for approvals.
- L1-15 / L1-16 (Cloudflare Worker + CIBA push) only if the Auth0 plan includes CIBA (decided at H0-A6); L1-13 (Slack progress message) is proposed to move to Lane 2 as L2-17.
