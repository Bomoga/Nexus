# Design night report (2026-11-08, 02:25 to 06:00 ET)

For the reader who opens Nexus at 08:00 and demos it. Written by the Lane 1 lead session; playbook: `docs/playbooks/design-night.md`. Images are in `docs/design/screens/before/` and `docs/design/screens/after/` (1280×800 headless Chrome at `?fake=1`, plus 360-wide shots for side-bar views; narrow headless shots squeeze multi-column tables, the real browser does not).

## 1. Status line

_(filled at the end)_

## 2. Before / after

### Globe home (`webviews/globe`)

| before | after |
|---|---|
| ![globe before](screens/before/globe.png) | ![globe after](screens/after/globe.png) |

- One 22 px header row: segmented 24H · 36H · 7D · 30D (active segment filled purple with dark text), prefixed SEARCH input, LIVE badge or VIEWING T+hh:mm with BACK TO LIVE, N EVENTS in mono; a four-glyph legend overlay top-left; the activity strip has a 15M gutter; StoreStatusLine moved to the bottom.
- Scene in one purple ramp: planet wire in `--nx-accent-deep`, orbits 1.5 px in `--nx-accent-lo` (drei `Line`), dashed activity rings, a 2 px glow now line with a dot at each orbit crossing, commit spheres `accent-hi`, merge arcs 1.5 px (three `Line2`), agent cubes `accent-glow`, Slack diamonds `accent`; the green and pink markers are gone; far-side markers fade to 0.5; hover scales a marker 1.3× and previews it in the detail strip; selected events get a 1 px glow ring; canvas `dpr [1, 1.5]`, `powerPreference: low-power`; rotation stops under `prefers-reduced-motion`.
- Behaviour unchanged (search Enter/Escape, tracking, click → `ui.openTarget`, live inserts, window switch → `ui.setTimeWindow`); two test assertions moved from a `<select>` to the segmented control.

### Timeline fallback (`webviews/timeline`)

| before | after |
|---|---|
| ![timeline before](screens/before/timeline.png) | ![timeline after](screens/after/timeline.png) |

- Shares the globe's header row, search, detail strip and `globe.css`.
- Lanes 22 px, marks in the purple ramp, the last axis tick no longer clips.
- Still no activity strip (it never had one); it shows LIVE always.

### Git view (`webviews/git`, new)

| before | after |
|---|---|
| _(did not exist; `Nexus: Open commit` and `Merge agent branch` were quick picks only)_ | ![git after](screens/after/git.png) |

- Three touching regions in the primary side bar between Slack and Approvals: BRANCHES (name, CURRENT badge, short SHA), AGENT BRANCHES (AGENT chip, MERGE → CONFIRM MERGE / CANCEL inline, result line "merged as <sha>" or the clean-abort message in red), RECENT COMMITS (last 24 h, `T+ · sha · title · actor`, click or Enter → `ui.openTarget`).
- Served entirely by the bridge (`git.branches`, `git.mergeAgentBranch`, `events.query`); repo text rendered as text only.
- Narrow (360 px) shot: `screens/after/git-narrow.png`; headless Chrome squeezes the MERGE column there, the real browser does not.

## 3. Decisions made for Adrian

_(see also progress/lane-1.md "Decisions (design night)")_

## 4. Checks

_(last full verification output, launch check, console errors per entry, globe frame time)_

## 5. Not done / known issues

_(file, line, smallest next step)_

## 6. Demo notes

_(what the presenter should know)_
