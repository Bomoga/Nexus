# Getting started — Lane 3 (Elkin)

Read tonight, in order: this page (5 min) → `docs/playbooks/lane-3.md` §0–§1 (5 min) → `CLAUDE.md` §6 UI style and §7 the globe (10 min; these two sections are your acceptance criteria for the whole event) → `PLAN §4.3` column N. You own every webview. Nothing you build waits on another lane: every view runs against the fixture bridge from minute one (`lane-3.md` header).

## 9:45–10:00 PM — pre-flight

- [ ] Your upstream clone at `1.145.2` builds; `npm run watch` running in **Terminal 1** and finished; your build times and RAM are in `CLAUDE.md` §3's table.
- [ ] `node -v` → `v24.22.1`; git identity set; `claude doctor` green; `gh auth status` green.
- [ ] The hello-world extension from the pre-event test (`C:\dev\nexus-hello`) still opens the globe prototype in the fork — this is the base for H0-N1.
- [ ] Logged in: GitHub, Slack (you'll authorize the app at ~T+0:40), Anthropic Console and Google AI Studio with **your own** dev keys (for H0-N4's smoke script), Auth0 (sign-in at ~T+8), Guardian app on your phone.
- [ ] Chrome with WebGL working (`chrome://gpu` shows hardware acceleration) — the webview uses the same Chromium; if your laptop runs on an integrated GPU, note it: `PLAN §5.3 L3-02` targets 60 fps on one.
- [ ] **Terminal 2** for git; **Terminal 3** for the Claude Code lead session (started after switching remotes).
- [ ] Know your RAM: 8 GB → 2 workers; 16 GB → 3 (`PLAN §1 Q4`).

## 10:00–10:15 PM — huddle

`PLAN §4.3` 0:00–0:10 "All" row. Give Adrian your name for `CLAUDE.md` §9 and CODEOWNERS. You run the second laptop in the demo (step 7b, `PLAN §10` D-3).

## T+0:10 → T+0:25 — H0-N1, by hand in `C:\dev\nexus-hello` (not the repo)

Turn the hello-world into the webview skeleton: a **webview view** (sidebar, `WebviewViewProvider`) — not only a panel — that loads a Vite-built React bundle, applies `--vscode-*` theme variables, answers a hand-rolled `app.ping` over `postMessage`, and renders the globe prototype with Three.js. The one question this answers: **does WebGL work inside a webview *view* on your machine?** (`CLAUDE.md` §2 "front-load the risky things"). Yes/no goes into your Decisions draft.

## T+0:25 → T+0:40 — H0-N2 switch remotes, start the lead

Run `CLAUDE.md` §3 step 5 in your checkout, then `gh repo set-default <team>/nexus`. Start Claude Code in Terminal 3 and paste:

```
You are the Lane 3 lead session for Nexus. Read CLAUDE.md fully (sections 6 and 7 twice), then docs/PLAN.md sections
1–4 and 5.3, then docs/playbooks/lane-3.md. T+0 was <HH:MM ET>. My machine has <8|16> GB, so max <2|3> workers.
Rules you follow without being asked: CLAUDE.md §10, §11, §12, §14, and §6's UI style in every acceptance. Webview
code never imports vscode or Node.
We are in hour 0; cp-0 does not exist yet, so no branches or worktrees. Help me finish the webview skeleton in
C:\dev\nexus-hello (outside the repo): a WebviewViewProvider that loads a Vite React bundle from media/, a CSP with a
nonce and localResourceRoots = media/, theme variables applied to a sample button that is 22 px tall with
border-radius 0, an app.ping round trip, and the globe prototype from docs/reference/globe-prototype.html rendering
inside the view. Nothing here is Nexus code; it is a smoke test. Tell me the exact frame rate you observe and whether
WebGL context creation logged any warning. Stop and report.
```

## T+0:40 → T+1:05 — H0-N3: your Slack user token, then theme tokens

Open the app install link Brandon posted in `#nexus-build`, authorize, copy your `xoxp-` token into your env/keychain only (`CLAUDE.md` §14). Smoke: `chat.postMessage` to `#nexus-build` with that token — it must appear **as you**, not as the app. Then second message to the lead:

```
Draft webviews/shared/theme.css for Nexus per CLAUDE.md §6 and PLAN §5.3 L3-01: kit tokens mapped from --vscode-*
variables, --nx-radius:0, --nx-control-h:22px, --nx-toolbar-h:20px, 11/12 px UI text, data in the editor monospace
font with tabular numerals, purple accent, no shadows/gradients/animation. Also draft webviews/shared/style.test.tsx
that asserts computed border-radius 0, control height 22/20 px, no box-shadow and the accent var on a rendered Button.
Keep both files in C:\dev\nexus-hello for now; I will move them into the repo after cp-0. Stop and report.
```

## T+1:05 → T+1:30 — H0-N4: contracts read, then provider smoke

Spend 10 minutes with Adrian and Brandon on `PLAN §2` (you care most about §2.5 chat, §2.8 events, §2.9 protocol names — those are what your views call). Then a plain Node script with your dev keys: Anthropic `listModels` + one tool-calling turn, Gemini the same via `@google/genai` `interactions.create` **(verify SDK ≥ 2.0.0 and that the method exists)**; write the model IDs that worked into your Decisions draft — Lane 1's L1-05 and the fixtures' `models` entries use them (`PLAN §2.12`).

## T+1:30 → T+2:00 — H0-N5 worktree + RAM, H0-N6 dispatch

After Adrian announces `cp-0`: `git fetch && git switch lane-3`. Sparse-worktree check from `CLAUDE.md` §11 with a throwaway id; launch the fork with `--extensionDevelopmentPath=<repo>\extensions\nexus` and confirm the skeleton's `app.ping` works. Then:

```
cp-0 is tagged and I am on lane-3 (sparse worktrees <work|do not work>; max <2|3> workers). Paste this into
progress/lane-3.md under Decisions: <your draft>. Move theme.css and style.test.tsx from C:\dev\nexus-hello into
webviews/shared/ as the seed of L3-01. Begin wave 1 from docs/playbooks/lane-3.md §1: dispatch Worker A on L3-01 with
the PLAN §5.3 brief verbatim; its FIRST commit within 30 minutes is the component stubs + fakeBridge.ts answering
events.* and slack.* from the fixtures. As soon as that commit is merged to lane-3, dispatch Worker B on L3-02<, and
Worker C on L3-08>. Declare the Nexus views/containers for all webviews in contributes/lane-3.json yourself in one commit
at T+4 (PLAN §2.11 COMMAND_OWNER, PLAN §3). Use the merge procedure in CLAUDE.md §11 for every task; update
progress/lane-3.md and push lane-3 after each merge.
```

## First hour of wave 1 — what to watch

- T+2:30: Worker A's stub + `fakeBridge` commit is merged; Workers B and C `git merge lane-3` in their worktrees before starting.
- T+3:00: Lane 2's interface-drop PR lands on `main` — have the lead `git merge main`; your `bridgeClient.ts` types against `src/bridge/types.ts` from it.
- T+4:00: open the globe view in the fork on the fixture stream (`?fake=1` in the dev server, or the real view with `fakeBridge` flag) and eyeball `CLAUDE.md` §6: square corners, 22 px controls, purple only. Dispute anything rounded on sight.
- Every merge runs `npm run build:webviews`; if `media/` is not picked up by the fork launch, that is Lane 1's L1-S1 — tell Adrian, don't work around it.

## If something is off at 10 PM

| Symptom | Do |
|---|---|
| WebGL fails inside the webview **view** but works in a panel | record it; the globe home is a webview **editor** (`CLAUDE.md` §7), so L3-02 proceeds; sidebar views use no WebGL |
| Frame rate < 30 fps on the prototype | note it in Decisions; L3-02's instancing threshold (`PLAN §5.3 L3-02`) and the timeline fallback (`PLAN §9` Globe row) exist for exactly this |
| Your Slack post appears as the app, not you | you used the bot token; the user token starts `xoxp-` (`CLAUDE.md` §3 hour-0 table) |
| The lead wants to add a UI library | no: `CLAUDE.md` §16 forbids third-party component kits; the shared kit is L3-01 |
