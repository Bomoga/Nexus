# Nexus demo script

The acceptance test for the product (`CLAUDE.md` §8, sponsor beats from `docs/PLAN.md` §10). Target: **under 8 minutes**, narrated as a task, never as architecture. Button labels below come from the plan; fix any that differ after the first rehearsal and commit the correction.

## Roles (D-3)

| Role | Person | Where |
|---|---|---|
| Presenter | Adrian | demo laptop, Nexus open on the demo repo |
| Phone teammate | Brandon | phone: Slack signed in as himself, Auth0 Guardian installed and enrolled |
| Second session (step 7b) | Elkin | second laptop, same team repo, starts an agent session ~5 minutes before step 7b |

## Before you start (once, ~10 minutes)

1. Seed the repo **shortly before the demo** with `node demo/seed.mjs --out <folder> --force --t0 <now, ISO>` (the **Nexus (dev): Re-seed demo repo** command does exactly this). The history ends at `--t0`, so seeding at hour 0 leaves it 70 hours old and outside the globe's default 36 h window. Open `<folder>` in Nexus. Check: the globe shows ~36 hours of history over six orbits, and `npm test` fails on exactly one test, "applies discount per unit".
2. `#nexus-demo`: pin the starting message. The presenter posts it as themselves:
   > cart total ignores the discount when qty > 1 (this is what the code-ref in step 3 attaches to)
3. The Nexus bot is in `#nexus-demo` and `#nexus-build`. Brandon's phone shows `#nexus-demo`.
4. `accounts.list` shows Anthropic, Google Gemini, Swarms and Prune connected with the right data-use labels (D-5). Optimize with Prune is **off**.
5. Close everything that is not Nexus and the phone. One Nexus window.

## Script

| # | Presenter does | Brandon (phone) | What the audience sees |
|---|---|---|---|
| 0 | Click **Sign in**. Auth0 Universal Login opens in the browser; click through; return to Nexus. | — | Back in Nexus, signed in. The Slack panel's status line reads "posting as Adrian via manual" (Slack tokens were pasted once beforehand with **Nexus: Connect Slack**; Token Vault is roadmap). |
| 1 | Nexus is already on the globe. Type `cart module` in the event search, press Enter (the bug arrives in the commit "add cart module"; no commit subject contains "discount"). The globe tracks the event. Click it. | — | The commit opens in a diff view. Merges arc into `main`. |
| 2 | Click the status bar model item. Show models from Anthropic and Google Gemini with their data-use labels. Pick the Anthropic model. Say once: "keys connect providers today; account linking is roadmap." Flip **Optimize with Prune** on. | — | Label changes to "unknown · leaves machine". |
| 3 | Open `src/cart.ts`, select lines **42–48**, right-click **Share to Slack**. | Sees the snippet and the `nexus://` link in `#nexus-demo`, replies in the thread: **"can an agent take this?"** | The message posts as Adrian in the Slack view; Brandon's reply appears live. |
| 4 | In the Slack view, click **MAKE TASK** on the thread. Edit one line of the brief (add "run the tests"). Click **START**. | — | A draft task becomes a running session. *(Optional 4b, if Tier 3 is solid: on the long thread click **Break into subtasks**, review the 3-subtask plan, **ACCEPT**; two cubes start orbiting.)* |
| 5 | Open the session view. | Watches the single progress message in the thread edit itself in place. | Tool calls stream, the diff grows, the thread's progress message updates. |
| 6 | Wait for the approval card. Point at the council verdict. | Phone buzzes: Guardian request "NX apr_… commit", and the Slack message with the same verdict. He taps **Approve**. | Card shows "Council review · looks_good (model-written)", then flips to "decided by Brandon via auth0 push". The agent continues; tests pass. |
| 7 | Back on the globe: the new session and commit are at the now line. Click the commit, review the diff. Run **Nexus: Merge agent branch**. | — | The agent's work merges with no conflicts. Status bar reads "PRUNE $… · saved $…". Open the session's RECEIPTS tab, click **OPEN** on one receipt: Prune's page verifies it. |
| 7b | Point at the cube orbiting `lane-2` (Elkin's session). Click it. Click the busiest bar of the activity strip. | — | A teammate's session from another laptop, live, replayed from the start. "Now" jumps to the busiest hour. |
| 8 | Switch the globe to the Nexus repo itself. | — | The 36 hours that built Nexus orbiting the planet. |

## If something breaks on stage

- Sign-in fails: say so, continue; Slack still works with the manual token fallback.
- Swarm review slow or missing: the card says "review unavailable"; the human decides anyway. That is the designed behavior.
- Anything else: stop and switch to the fallback recording (`progress/lane-1.md` names the file).

## Reset between rehearsals

`node demo/seed.mjs --out <folder> --force --t0 <now, ISO>` rebuilds the repo with its history ending now (the same `--t0` gives identical hashes). Delete the thread replies in `#nexus-demo`, keep the pinned message.
