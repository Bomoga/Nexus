# Lane 2 playbook — Brandon (extension backend: bridge, Slack, git, events/TigerData, gate, code refs, Token Vault)

Branch `lane-2`. Workers: **3** if the machine has 16 GB, **2** if 8 GB (write RAM in `progress/lane-2.md` at H0-B5; `PLAN §1 Q4`). No webview UI in this lane (`CLAUDE.md` §9). Load: 16 tasks / 32.25 wh against ~47 nominal → ~14 wh of slack that `PLAN §1 Q1(c)` earmarks for borrowing Lane 1 extension-side tasks after cp-1.

Lane 2 is upstream of both other lanes in wave 1: your **interface drops** at T+2:30 are what let Lane 1 and Lane 3 build against fakes instead of waiting (`PLAN §3` "Disjointness rule applied").

## 0. Hour 0 — column **B** of `PLAN §4.3`

H0-B1 Slack workspace + app from the manifest in `PLAN §4.5` (scopes are **(verify)** — fix at install time and note what Slack accepted) → H0-B2 switch checkout + plain-Node Socket Mode check → H0-B3 built-in git API (`getAPI(1)` **(verify)**) and child-process round trip from a scratch extension → H0-B4 Tiger Cloud service, `sql/001_schema.sql` + `002_aggregates.sql` first cut, `LISTEN/NOTIFY` check (`PLAN §1 Q6`) → H0-B5 first sparse worktree → H0-B6 dispatch wave 1.

Write into `progress/lane-2.md` → Decisions, before dispatching: Socket Mode ok?/git API version/NOTIFY ok?/RAM. L2-11 reads the NOTIFY answer (`PLAN §5.2 L2-11`).

## 1. Wave 1 — T+2 → T+5 (interface drops first)

Each wave-1 worker's **first commit, within 30 minutes**, is the interface + fake named in its PLAN block; the lead merges those three commits into `lane-2` immediately and opens a tiny PR to `main` titled `lane-2: interface drops for bridge, slack, store` so Lanes 1 and 3 can `git merge main` by T+3.

| Slot | Task | PLAN ref | Interface drop (T+2:30) | Done when | Next |
|---|---|---|---|---|---|
| Worker A | **L2-01** bridge (L) | §5.2 L2-01 | `src/bridge/types.ts` (`BridgeRouter.handle/publish`) + `fake-bridge-server.ts` | `npx vitest run src/bridge/router.test.ts src/bridge/host.test.ts` | L2-13 |
| Worker B | **L2-02** Slack Web API, user token (L) | §5.2 L2-02 | `src/services/slack/types.ts` (`SlackService`) + `fake-slack.ts` from fixtures | `npx vitest run src/services/slack/web-client.test.ts` | L2-03 |
| Worker C (16 GB) | **L2-08** store interface + local JSONL + outbox + search (L) | §5.2 L2-08 | `src/services/events/store.ts` + `fake-store.ts` seeded with `scriptedNexusEvents()` | `npx vitest run src/services/events/local-store.test.ts src/services/events/search.test.ts` | L2-05 |
| (8 GB) | lead writes the L2-08 interface + fake by hand at T+2:30; Worker C's L2-08 starts in wave 2 | §5.2 L2-08 | same | — | — |
| Lead | gate interface drop `src/services/gate/types.ts` (`Gate.handle`, `ApprovalsHook`) by T+2:45 — Lane 1's L1-09 FakeGate mirrors it | §5.2 L2-13 | — | typecheck | — |

Disjointness: A `src/bridge/**`; B `src/services/slack/**`; C `src/services/events/**`; lead `src/services/gate/types.ts` only. `src/register/lane-2.ts` is **lead-only** (registration lines added at merge).

## 2. Wave 2 — T+5 → T+8

| Slot | Task | PLAN ref | Depends on | Done when |
|---|---|---|---|---|
| Worker A | **L2-13** the gate (L) | §5.2 L2-13 | L2-06 interface (`GitService.diff/commitIn` — drop it yourself from `PLAN §5.2 L2-05` types at T+5 if L2-05 hasn't started) | `npx vitest run src/services/gate/gate.test.ts` |
| Worker B | **L2-03** Socket Mode + bot posts + Block Kit buttons (L) | §5.2 L2-03 | L2-02 | three vitest files; **L2-S1** int run by you from the extension host, result in progress |
| Worker C | **L2-05** git service → **L2-07** watcher → events | §5.2 L2-05, L2-07 | L2-08 interface | `git-cli.test.ts`; `watcher.test.ts` (temp repos, local `git` only) |
| Lead | reviewer duty is heavy this wave (bridge + gate = Opus-class reviewers, `CLAUDE.md` §11); run L2-S1 | — | — | — |

Cross-lane: the gate's `ApprovalsHook` is implemented by Lane 1's L1-12 (wave 4 there). Until then the gate's tests use an in-process hook; nothing in L2-13 imports Lane 1 code (`PLAN §3` rule: interfaces only).

## 3. Wave 3 — T+8 → T+10 (into cp-1)

| Slot | Task | PLAN ref | Depends on | Done when |
|---|---|---|---|---|
| Worker A | **L2-06** worktrees, gated commit, merge agent branch | §5.2 L2-06 | L2-05 | `worktrees.test.ts`, `merge.test.ts` (conflict leaves `git status --porcelain` empty) |
| Worker B | **L2-09** Tiger schema finish (int, needs `TIGER_URL`) → **L2-16** `ui.openTarget` | §5.2 L2-09, L2-16 | H0-B4 | `npm run test:int -- schema`; `open-target.test.ts` |
| Worker C | **L2-04** Slack cache | §5.2 L2-04 | L2-02 | `cache.test.ts` |
| Lead | merge `main`; launch check; PR `lane-2 → main` before T+10 so Lane 1's cp-1 wiring (`lane-1` wave 3) finds real services on `main` | `CLAUDE.md` §10 | — | — |

**cp-1 support (T+10–12):** be on `#nexus-build`; cp-1 steps 4 (Slack live) and 6 (gate + worktree + commit) are yours if they fail (`PLAN §8 cp-1`).

## 4. Wave 4 — T+12 → T+16

| Slot | Task | PLAN ref | Depends on | Done when |
|---|---|---|---|---|
| Worker A | **L2-10** Tiger adapter + combined store (L) | §5.2 L2-10 | L2-08, L2-09 | `tiger-store.test.ts`, `combined-store.test.ts`; `tiger.int.test.ts` run by you |
| Worker B | **L2-14** code refs + URI handler (its `registerRoute` is what Lane 1's L1-14 needs — if L1-S6 is waiting, commit `uri-handler.ts` first) | §5.2 L2-14 | L2-05 | `resolve.test.ts`, `uri-handler.test.ts` |
| Worker C | **L2-17** progress message (if `PLAN §1 Q1(a)` accepted — brief is `PLAN §5.1 L1-13` with LANE lane-2) else **L2-15** | §5.1 L1-13 / §5.2 L2-15 | L2-03 / L1-14 refresh token | `progress-message.test.ts` / `token-vault.test.ts` |

Approval first-answer-wins across machines lives in L2-10's `resolveApproval` conditional UPDATE (`PLAN §5.2 L2-10`, semantics `PLAN §2.6`); Lane 1's L1-12 calls it. Tell Lane 1 in `#nexus-build` the moment L2-10's `resolveApproval` is on `lane-2`.

## 5. Wave 5 — T+16 → T+22

| Slot | Task | PLAN ref | Depends on | Done when |
|---|---|---|---|---|
| Worker A | **L2-11** sync (NOTIFY if H0-B4 said yes, else 2 s polling) + outbox flush | §5.2 L2-11 | L2-10 | `sync.test.ts` (machine-B events appear on machine-A with `seq` intact) |
| Worker B | **L2-15** Token Vault Slack exchange (if not done in wave 4) | §5.2 L2-15 | L1-14 on `main` | `token-vault.test.ts`; int exchange once with your Auth0 login |
| Worker C | Slack reconnect/backoff, cache edge cases, `slack.status` identity warning | §5.2 L2-03/L2-04 | — | existing suites stay green |
| Lead | **Q1(c) borrowing window opens**: if Lane 1's progress file shows L1-21 or L1-16 unstarted at T+18, offer to take one (extension-only paths) and record it in both progress files | `PLAN §1 Q1` | — | — |

## 6. cp-2 window — T+22 → T+24

No new dispatch. You are the **phone teammate** for `PLAN §8 cp-2` step 3 and the second-laptop session owner is Lane 3; step 4 (shared live within 5 s) is your sync path. If Tiger is unreachable on venue Wi-Fi, follow `PLAN §9` TigerData row (local copy; beat marked skipped) — do not debug the network during the checkpoint.

## 7. Wave 6 — T+24 → T+30

| Slot | Task | PLAN ref | Notes |
|---|---|---|---|
| Worker A | **L2-12** continuous aggregate + `events.activity` | §5.2 L2-12 | feeds Lane 3's L3-06 activity strip; **(verify)** refresh policy on the free plan |
| Worker B/C | cp-2 rough edges; `PLAN §8 cp-3` step 3 error paths that are yours: Tiger unreachable → offline line; Slack socket dropped → reconnect ≤ 30 s | §8 cp-3 | — |

## 8. cp-3 and after

T+30–33 fixes only; be available for `PLAN §8 cp-3` steps 2–3. T+33–36: `PLAN §10` D-3 role rehearsal (you on the phone, twice).

## 9. Standing checks for every Lane 2 merge

Reviewer prompt additions beyond `CLAUDE.md` §11: (1) every bridge response body is Zod-validated and never matches a `redact` pattern (`PLAN §5.2 L2-01`); (2) a bot user's button click can never resolve an approval (`PLAN §5.2 L2-03`); (3) every agent path is resolved inside the worktree, every non-allowlisted command waits with no timeout (`PLAN §5.2 L2-13`); (4) user token only for reads and the user's own posts, bot token for everything the agent says (`PLAN §2.5` semantics); (5) `git` is always `execFile` with argv, never a shell string (`PLAN §5.2 L2-05`); (6) nothing written to Tiger skipped `redact()` (`PLAN §5.2 L2-08/L2-10`).

## 10. Sleep handoff (Brandon)

Suggested slot: T+12–T+16 (after the cp-1 PR, with L2-10, L2-14 and L2-17/L2-15 briefed so the lead runs wave 4 unattended), or T+26–T+30 if Adrian takes the earlier slot. Lead opens no PR to `main` while you sleep (`CLAUDE.md` §12).
