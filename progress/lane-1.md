## Done
Lead session, no workers (everything below was written and reviewed on the local `lane-1` branch; nothing pushed yet).
- L1-23 redact (bounded patterns, fails closed over 2 MB, env lines inside diffs)
- L1-24 prompt framing (random fence token, matching-token rule in SYSTEM_RULES)
- L1-03 provider interface, FakeProvider (key fingerprints only), ListingCache
- L1-08 agent process host + child channel (env allowlist, 8 Mi line cap, 64 concurrent requests, replies only to the asking process, one restart per session)
- L1-09 agent runtime tool loop (8 tools over the gate, redacted/clipped events, 32 KB tool results fenced as untrusted, cancel within one turn); `run()` entry and `NEXUS_FAKE_PROVIDER=1` verified across a real child process
- L1-04 Anthropic provider (unit tests with an injected client; live int test written, not run)
- L1-26 demo repo seed + `demo/demo-script.md` + `nexus.dev.reseedDemoRepo`
- Independent reviews: L1-23, L1-24, L1-08 (disputed, all blocking findings fixed and re-tested); L1-03, L1-26, reseed command (confirmed, findings fixed)

## In flight
- none

## Blocked
- cp-0 is not tagged, so `lane-1` exists only locally and is not pushed (CLAUDE.md §10: no lane branch before cp-0). Needs Adrian: branding in product.json, branch protection, the T+0 minute, GitHub handles in CODEOWNERS, then the tag.
- Core work stays with Adrian: L1-S1 (register extensions/nexus with the fork build), L1-02 (tab-less home), L1-22 core half (startup defaults, Nexus Dark, chat/Copilot off).
- Live checks need Adrian's keys: `npm run test:int -- anthropic` (ANTHROPIC_API_KEY); later Gemini, Swarms, Prune smoke tests.
- Lane 2 interface drops (events store, slack types, gate types) have not reached main; Lane 1 controllers are coded against Lane-1-owned ports until they do.

## Decisions
T+0 = <HH:MM ET>, 2026-11-06
- The agent reports "session finished" with a child-to-host `evt` named `session.finished` (schema in src/agent-process/session-events.ts). The frozen agent protocol has no such message and it is internal to Lane 1's two processes, so no contract changed. Lane 2's gate never sees it.
- `credentials.get` is answered by a host handler the sessions controller (L1-10) must provide; it must tie `callId` to the active session. The process host only routes.
- Anthropic: SDK retries are off (a resent turn double-bills). `dataUse: not_used_for_training` comes from src/models/data-use.ts, sourced to privacy.claude.com (checked 2026-11-07). Gemini is "may be used" unless the user says the project is billing-enabled.
- Prune and Swarms key formats are undocumented; redact() only matches long alphanumeric runs with a digit after `prune_` / `swarms_` (verify in L1-S4 / L1-S5).
- The demo history must be seeded close to demo time (`--t0 now`, which the re-seed command does); seeded at hour 0 it is outside the globe's 36 h window by T+34.
- eslint.config.mjs got an `.mjs` globals block for the child-process test fixture (integrator-owned file).

## Next
- Gemini provider (L1-05), accounts service (L1-06), model picker (L1-07).
- Controllers against ports: sessions (L1-10), tasks + brief builder (L1-11), approvals (L1-12).
- Swarms client + provider (L1-17), Prune adapter (L1-20), optimizer (L1-21), Auth0 sign-in (L1-14), extension half of startup defaults (L1-22).
- When Adrian tags cp-0: push `lane-1`, merge `main`, reconcile ports with Lane 2's interface drops.
