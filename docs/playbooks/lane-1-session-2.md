# Lane 1 lead, session 2: wire the controllers to Lane 2's interfaces

Paste everything below the line into a new Claude Code session opened in the Nexus repo (`C:\Users\atmor\OneDrive\Desktop\Repositories\Nexus`, branch `lane-1`).

---

You are the Lane 1 lead for Nexus (Adrian's lane). Read `CLAUDE.md` first (conduct, contracts, safety rails), then `progress/lane-1.md` (what is done and decided) and `progress/lane-2.md` on `origin/lane-2`. Work autonomously until everything below that does not need Adrian is done. Commit as `lane-1: <what changed>` (lowercase, imperative, no period) with the trailer the session's attribution reminder gives. Never rebase, never force push, never push `main`, never edit `src/contracts`, never touch VS Code core (`src/`, `build/`, `product.json`). Push only `lane-1`. Tag factual claims with `[proof: ...]` or `{unverified}`.

## State (2026-11-07)

- `lane-1` is pushed and green: `npm run ci` in `extensions/nexus` (typecheck, lint, 506 unit tests, contributes check, build). Live smoke checks passed for Anthropic, Gemini (`gemini-3.5-flash`), one Swarms call, and Prune (needs a system message). Auth0 tenant and Native app are set up; defaults are in `contributes/lane-1.json`. Keys live in the gitignored `extensions/nexus/.env`; never print, log or commit them.
- Lane 1's features are built against ports in `src/features/ports.ts` and wired by `composeLane1` (`src/features/compose.ts`), proven by an offline end-to-end test (`compose.test.ts`). They are NOT yet constructed in `src/register/lane-1.ts`, because Lane 2's services were missing.
- Lane 2 has now put interface drops on `main` (`a678c8bd`): `src/bridge/types.ts` (`BridgeRouter`, `BridgeError`, `matchesSubscription`), `src/services/events/store.ts` (`EventStore` + `fake-store.ts`), `src/services/slack/types.ts` (`SlackService` + `fake-slack.ts`), `src/services/gate/types.ts` (`Gate`, `ApprovalsHook`). A test merge of `origin/main` into `lane-1` is conflict-free. Lane 2 chose method names to match our ports (`decideApproval`, `agentEvents`, `getThread`, `request`). The real `LocalStore`, router and gate are still in review on `lane-2`; use the fakes until they land.

## Tasks, in order

1. **Merge `origin/main` into `lane-1`** (`git merge`, no rebase). Run the full CI steps; fix anything the merge breaks inside Lane 1's paths only.
2. **Prove the ports fit.** Add a type-level test (`src/features/adapters.test.ts` or similar) that `EventStore` satisfies `StorePort`, `SlackService` satisfies `SlackPort`, and `Gate.request` satisfies `GatePort`. Where they differ (the gate's `ApprovalsHook.create({session, action, reason, diffPreview})` returning `{approvalId, decision}` vs our `ApprovalRequester.request`), write a thin adapter in `src/features/adapters/` and test it. Do not change Lane 2's files; report mismatches in `progress/lane-1.md` instead.
3. **Wire `src/register/lane-1.ts`** to construct `composeLane1` with the real pieces available and fakes where a Lane 2 implementation is not on `main`. Register every handler in `lane.handlers` with `router.handle(name, fn)` and every subscription in `lane.subscriptions` with `router.onSubscribe(...)`, mapping thrown `ApprovalConflict` to `BridgeError("conflict")`. Use the real `forkAgentProcess` for `createHost`. Respect the router's replay-then-live ordering rules in `bridge/types.ts`.
4. **Register commands** from the frozen list that are Lane 1's: `nexus.approve`, `nexus.reject`, `nexus.makeTaskFromThread`, `nexus.decomposeTask`, `nexus.rerunSwarmReview`, `nexus.toggleOptimizer`, `nexus.openReceipt`, `nexus.openSession`. Add the entries to `contributes/lane-1.json` only. Add a VS Code `NotifyPort` adapter for approvals (`showWarningMessage` with APPROVE and REJECT; an approval needs a human click, never a timeout). Run `npm run contributes` so `package.json` stays in sync.
5. **Small leftovers** from the last review: validate a Prune receipt before recording it; cancel the child when `startSession` times out; guard `removeSessionWorktree` against a synchronous throw or non-promise.
6. **Housekeeping Lane 1 owns:** fix `CLAUDE.md` sections 10 and 11 worker branch naming to `lane-N-wt/<task-id>` (git cannot create `lane-1/x` while `lane-1` exists; Lane 2 verified this). This is a docs-only commit.
7. **Update `progress/lane-1.md`** (Done, In flight, Blocked, Decisions, Next) and push `lane-1`.

## Do not do; tell Adrian instead

- **Core work is Adrian's by hand:** L1-S1 (register `extensions/nexus` with the fork build), L1-02 (tab-less home), L1-22 core half (startup defaults, Nexus Dark, built-in chat and Copilot off), and branding in `product.json`. Lane 2 reports that an untrusted folder stops Nexus from activating if it depends on `vscode.git`, so startup defaults should disable workspace trust; the setting name is still to be confirmed (L1-22).
- **`src/shared/redact.ts` is only on `lane-1`, not `main`.** Lane 2 injects a redactor as a required argument until it lands. Getting it to `main` needs a lane PR with the launch check (full fork build and launch, run by Adrian on a machine where the fork is built). Do not open that PR yourself; remind Adrian.
- **Open checks that need Adrian:** the CIBA plan yes/no (decides L1-15 and L1-16), the Auth0 round trip through the fork (L1-S6; fallback is a loopback redirect), refresh tokens enabled on the Auth0 app, the Swarms CouncilAsAJudge live run (costs money), Prune tool-calling passthrough (L1-S4).
- `decodeCodeRef` in contracts can throw on a malformed escape; fixing it is a contracts PR that needs the whole team. Mention it, do not change it.

## Definition of done for this session

`npm run ci` green on `lane-1`; the adapters test and an offline wiring test pass; `register/lane-1.ts` registers all Lane 1 handlers, subscriptions and commands against the `BridgeRouter` interface using fakes; `progress/lane-1.md` current; `lane-1` pushed. Report with: Changed, Commits, Acceptance, Open questions. Then stop.
