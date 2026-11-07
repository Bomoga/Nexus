# Lane 1 playbook — Adrian (agents, models, fork, Swarms, Prune, Auth0 sign-in/CIBA, integration)

Branch `lane-1`. Machine: 8 GB → **max 2 workers**, one Nexus window, browsers closed during launch checks (`CLAUDE.md` §11). The lead does every core (VS Code `src/`, `build/`, `product.json`) task itself in the main checkout; workers only ever touch `extensions/nexus` (`PLAN §3`). Lane 1 is also the integrator: checkpoints (`PLAN §8`), CODEOWNERS/CI (`PLAN §3.3`), demo (`PLAN §10`).

Load factor: 26 tasks / 42.75 wh against ~31 nominal worker-hours (`PLAN §1 Q1`). Nothing is cut; the plan rebalances with Q1(a)–(d). Watch the "borrowable" column below: those tasks are the ones a Lane 2/3 lead may take after cp-1.

## 0. Hour 0 (T+0:00–T+2:00) — lead only, no workers yet

Follow `PLAN §4.3` column **A** row by row: H0-A1 repo import → H0-A2 remote switch help → H0-A3 skeleton → H0-A4 contracts review + commit → H0-A5 cp-0 tag, protection, lane branches, Routine → H0-A6 launch check + Auth0 Native app + CIBA plan check. The contracts you paste in are `PLAN §2.1–§2.12` verbatim (rename/typo fixes only; semantics frozen). cp-0 contents are exactly `PLAN §4.2`. What you deliberately leave for wave 1 is `PLAN §4.4`.

Gate to leave hour 0: `npx vitest run src/contracts` green, `cp-0` tagged, `lane-1/2/3` pushed, the skeleton activates in the fork on all three machines.

## 1. Wave 1 — T+2 → T+5 (2 workers + lead)

| Slot | Task | PLAN ref | Owns (summary) | Done when | Next in slot |
|---|---|---|---|---|---|
| Worker A | **L1-03** provider interface + fake provider + listing cache | §5.1 L1-03 | `src/models/provider.ts`, `fake-provider.ts`, `listing-cache.ts` | `npx vitest run src/models/provider.test.ts` | L1-23 → L1-24 |
| Worker A (then) | **L1-23** redact() · **L1-24** prompt framing | §5.1 L1-23, L1-24 | `src/shared/redact.ts`, `src/agent/prompt-framing.ts` | their vitest files | — |
| Worker B | **L1-08** agent process host | §5.1 L1-08 | `src/agent/process-host.ts`, `src/agent-process/main.ts` | `npx vitest run src/agent/process-host.test.ts` | L1-26 |
| Worker B (then) | **L1-26** demo repo seed + planted bug | §5.1 L1-26 | `demo/**` | `node demo/seed.mjs --out /tmp/nexus-demo && npm test` exits 1 | — |
| Lead | **L1-S1** register `extensions/nexus` with the fork build, prove built-in bundling | §5.1 L1-S1 | `build/gulpfile.extensions.*`, ext tsconfig/.vscodeignore | launch check without `--extensionDevelopmentPath` | L1-02 prototype |

Disjointness check before dispatch: A owns `src/models/*` + `src/shared/*` + `src/agent/prompt-framing.ts`; B owns `src/agent/process-host.ts` + `src/agent-process/*` + `demo/**`. No overlap. `src/register/lane-1.ts` is **lead-only** until wave 3 (several tasks list "registration lines" — the lead adds those at merge time to avoid two workers editing one file).

Cross-lane inputs this wave: none needed. Everything runs on contracts + fixtures (`PLAN §2.12`). Lane 2's interface drops (`src/bridge/types.ts`, `services/slack/types.ts`, `services/events/store.ts`, `services/gate/types.ts`) land by T+2:30 (`PLAN §3`, §5.2 "Interface drop") — merge `main` once they are on `main`, or cherry-pick nothing: wait for the PR.

Hand-run by the lead this wave (needs your keys, no worker): the **L1-S5 Swarms** and **L1-S4 Prune** int tests are written in L1-17/L1-20 later; for now do the raw `curl` checks from `PLAN §1 Q2/Q5` and write results into `progress/lane-1.md` → Decisions. These results set `OptimizerSetting.scope` and whether `CouncilAsAJudge` is real or emulated (`PLAN §9` Swarms row).

## 2. Wave 2 — T+5 → T+8

| Slot | Task | PLAN ref | Depends on | Done when | Borrowable (Q1c)? |
|---|---|---|---|---|---|
| Worker A | **L1-09** agent runtime tool loop (L) | §5.1 L1-09 | L1-03, L1-08, L1-24 | `npx vitest run src/agent-process/runtime.test.ts` | no (core of the lane) |
| Worker B | **L1-04** Anthropic provider → **L1-06** accounts service | §5.1 L1-04, L1-06 | L1-03 | their vitest files; L1-04 int test with your key, run by the lead | L1-06 yes |
| Lead | **L1-02** tab-less home core change (L) | §5.1 L1-02 | L1-S1 | launch check per the task block | never (core) |
| Lead, 15 min | **L1-S6** `nexus://` callback smoke (inside L1-14) | §5.1 L1-14 | Lane 2's `uri-handler.ts` route table (L2-14 first commit) | a `nexus://auth/callback?x=1` URL opened from the browser reaches the handler | — |

If L1-02 is not working by T+8: stop, record "closable home tab for cp-1" in Decisions (`PLAN §9` Globe row), and come back to it in wave 5.

## 3. Wave 3 — T+8 → T+10 (into cp-1)

| Slot | Task | PLAN ref | Depends on | Done when |
|---|---|---|---|---|
| Worker A | **L1-10** sessions controller → **L1-11** tasks controller + brief builder | §5.1 L1-10, L1-11 | L1-08, store interface (fake until cp-1) | their vitest files |
| Worker B | **L1-05** Gemini provider (= smoke L1-S3) → **L1-07** model picker | §5.1 L1-05, L1-07 | L1-03, L1-06 | vitest; Gemini int test run by the lead with your key |
| Lead | **L1-22** startup defaults (core half) + merge `main` + wire real Lane 2 store/gate/slack into `src/register/lane-1.ts` | §5.1 L1-22, §3 | L1-02 | fresh user-data dir opens on the home; no Chat view |

**cp-1 (T+10–12)** — you run `PLAN §8 cp-1` steps 1–7 on a fresh build and tag. Allowed degradations are listed per step there. If the real provider loop is not stable, cp-1 step 6 runs with `FakeProvider`'s scripted turn against the **real** gate and demo repo (`PLAN §7` note) — that still produces a real worktree and commit.

PR to `main` from `lane-1` after the launch check; title only (`CLAUDE.md` §10).

## 4. Wave 4 — T+12 → T+16

| Slot | Task | PLAN ref | Depends on | Done when | Borrowable? |
|---|---|---|---|---|---|
| Worker A | **L1-12** approvals controller → **L1-13** progress message (**or** hand L1-13 to Lane 2 as L2-17 per Q1a) | §5.1 L1-12, L1-13 | L1-10, store conditional update (L2-10 interface) | vitest; two concurrent resolves → one winner | L1-13 yes |
| Worker B | **L1-17** Swarms client + provider (= smoke L1-S5) → **L1-18** swarm review | §5.1 L1-17, L1-18 | L1-03, L1-23, L1-12 | vitest; int test run by the lead | L1-18 after L1-17 lands, yes |
| Lead | **L1-14** Auth0 sign-in (PKCE, refresh token in SecretStorage) | §5.1 L1-14 | L1-S6 | vitest + the real browser round trip once | — |

Cross-lane: L1-12's Slack surface is Lane 2's `interactivity.ts` (L2-03) calling your `approvals.resolve`; L1-18's verdict is rendered by L3-12 and L2-03. Agree the `ApprovalsHook`/`resolve` signature by message in `#nexus-build` the moment L1-12's first commit lands — it is already in `PLAN §2.9` (`approvals.resolve`, `conflict` error code), so this is a confirmation, not a design.

## 5. Wave 5 — T+16 → T+22

| Slot | Task | PLAN ref | Depends on | Done when | Borrowable? |
|---|---|---|---|---|---|
| Worker A | **L1-20** Prune adapter (= smoke L1-S4) (L) → **L1-21** optimizer toggle + totals + receipts to store | §5.1 L1-20, L1-21 | L1-04, L1-05, L1-23; L1-07 | vitest; int test by the lead decides `scope` | L1-21 yes |
| Worker B | **L1-18** finish → approvals/notification polish, L1-22 extension half if not done | §5.1 L1-18, L1-22 | — | vitest | — |
| Lead | hourly `git merge main`; dry-run `PLAN §8 cp-2` steps 2–4 on the demo repo with Brandon on the phone at ~T+20 | §8, §10 D-1..D-3 | — | a timed run noted in progress | — |

## 6. cp-2 window — T+22 → T+24 (sponsor work + checkpoint only)

| Slot | Task | PLAN ref | Gate |
|---|---|---|---|
| Worker A | **L1-15** auth service (Cloudflare Worker, CIBA start/poll) → **L1-16** CIBA approvals in the app | §5.1 L1-15, L1-16 | only if H0-A6 recorded "CIBA included"; else skip and note `PLAN §9` Auth0 row |
| Lead | **cp-2 acceptance** `PLAN §8 cp-2` steps 1–6, globe decision (step 5), tag | §8 | — |
| Lead | if Lane 3 is behind: take the smallest open Lane 3 task per `CLAUDE.md` §9 ("Lane 1 picks up Lane 3 work") | §5.3 | record in both progress files |

Deploying the Worker is a lead step (`wrangler deploy` with the secret binding), not a worker step (`PLAN §5.1 L1-15`).

## 7. Wave 6 — T+24 → T+30

| Slot | Task | PLAN ref | Notes |
|---|---|---|---|
| Worker A | **L1-19** swarm task breakdown: decompose + plan accept half | §5.1 L1-19 | Tier 3, kept in full (`PLAN §1 Q1`) |
| Worker B | **L1-19** scheduler half (`src/features/sessions/scheduler.ts`) — or a Lane 2/3 lead per Q1(c) — then cp-2 rough edges | §5.1 L1-19 | disjoint files: decompose.ts vs scheduler.ts |
| Lead | integration fixes, error paths from `PLAN §8 cp-3` step 3 rehearsed once | §8 | — |

## 8. cp-3 and after — T+30 → T+36

- T+30–33: fixes only. Run `PLAN §8 cp-3` steps 1–5, tag, then **L1-27** fallback recording (`PLAN §5.1 L1-27`, §10 D-4).
- T+33–36: `PLAN §10` D-5 (demo keys in SecretStorage on the demo machine), D-6 (two rehearsals under 8 minutes), opt into the four sponsor tracks. Sponsor-step script: `PLAN §10` "Sponsor demo-script steps".

## 9. Standing checks for every Lane 1 merge

Reviewer prompt additions beyond `CLAUDE.md` §11: (1) no key/token in any `ProviderAccount`, log, event or prompt (`PLAN §2.2` note, §14); (2) the agent process has no path to set an approval decision (`PLAN §5.1 L1-12` constraint); (3) Swarms/Prune outbound text passes `redact()` (`PLAN §5.1 L1-17/L1-20`); (4) `allowModelRouting` forced false for role `agent` (`PLAN §2.3`); (5) any Gemini request has no server-side tools (`PLAN §5.1 L1-05`).

## 10. Sleep handoff (Adrian)

Before sleeping, brief the next two tasks in the current wave so the lead can run them unattended (`CLAUDE.md` §12); the lead opens no PR to `main` while you sleep. Suggested sleep slot for Lane 1: T+16–T+20 (after L1-14 lands, before the cp-2 dry run), with L1-20 and L1-18-finish briefed.
