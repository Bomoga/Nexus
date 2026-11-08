# Design night: the Nexus frontend redesign (unattended, until 06:00)

*The playbook for one lead session that redesigns every Nexus webview and the globe overnight, with no human available. The paste-in prompt is `docs/playbooks/design-night-prompt.md`; it points here. `CLAUDE.md` still rules; this file only adds the design spec and the running order. Written 2026-11-08 at about 01:35 EST from the state of `origin/main` at `c9347f18` and `origin/lane-3` at `5f116540`.*

## Contents

1. [Situation](#1-situation)
2. [Research, and what we take from it](#2-research-and-what-we-take-from-it)
3. [Design system v2](#3-design-system-v2)
4. [Target layout](#4-target-layout)
5. [Per-surface specs](#5-per-surface-specs)
6. [Tasks](#6-tasks)
7. [Schedule to 06:00](#7-schedule-to-0600)
8. [The verification loop](#8-the-verification-loop)
9. [Rules, held items, stop conditions](#9-rules-held-items-stop-conditions)
10. [The morning report](#10-the-morning-report)

---

## 1. Situation

- **Who you are.** The Lane 1 lead (Adrian's session) on branch `lane-1`. Lane 3 (Elkin) handed every webview to Adrian at about T+20: "Lane 3 is yours if anything needs doing" (`progress/lane-3.md` on `origin/lane-3`, heading "HANDOFF TO ADRIAN"). All 17 planned Lane 3 tasks are on `main`. So Lane 1 may edit `extensions/nexus/webviews/**`, `src/features/views/**`, `src/register/lane-3.ts` and `contributes/lane-3.json` tonight, and records that it did so in `progress/lane-1.md`.
- **What exists.** Seven Vite entries under `extensions/nexus/webviews/`: `globe`, `chat`, `session`, `approvals`, `task`, `plan`, `timeline`, plus the shared kit in `webviews/shared/` (`theme.css`, `Button`, `Input`, `Select`, `Tabs`, `Table`, `StatusLine`, `KeyValueRow`, `Chip`, `Toolbar`, `EmptyState`, `StoreStatusLine`, `ErrorBoundary`, `waiting`, `bridgeClient`, `fakeBridge`). The style test `webviews/shared/style.test.tsx` mechanically enforces CLAUDE.md §6 (radius 0, 22/20 px controls, no shadow, purple accent) by resolving the `--nx-*` tokens from `theme.css` itself, because jsdom does not substitute custom properties.
- **Where the views live today.** Activity bar container `nexus` with two webview views, `nexus.chat` ("Slack") and `nexus.approvals` ("Approvals") (`contributes/lane-3.json`). The globe is the custom editor `nexus.home`, tab-less through the core change in `src/vs/workbench/browser/parts/editor/editorGroupView.ts` (`nexusHomeActive`). Session, task and plan open as webview **panels** in the editor area (`src/features/views/lane3-views.ts`, `openPanel` + `withBodyData` for the id). The timeline is a panel too.
- **Three purples disagree.** Kit accent `#8b5cf6`/`#a78bfa` (`webviews/shared/theme.css`), theme accent `#9d6bff`/`#b794ff` (`themes/nexus-dark.json`), globe `0x7f77dd`/`0xafa9ec`/`0xcecbf6` (`webviews/globe/scene/colors.ts`). `progress/lane-3.md` left this as "Open: accent color … until Adrian picks." Tonight picks (section 3).
- **Contrast problems measured tonight** (WCAG relative-luminance formula, computed from the hex values in the repo): white on the kit accent `#8b5cf6` is **4.23:1** and white on the theme accent `#9d6bff` is **3.51:1**; both fail the 4.5:1 that 11 px uppercase button labels need. Dark `#0b0b0e` on `#9d6bff` is **5.60:1** and passes. Everything else in the palette passes: body `#d4d4d8` 13.0:1, muted `#8b8b96` 5.7:1, `#b794ff` 8.0:1, status greens/ambers/reds 5.7 to 7.6:1. The editor line-number color `#4a4a55` is 2.2:1 and the inactive activity-bar icon `#6b6b78` is 3.7:1 (icons need 3:1, fine; line numbers are VS Code's own convention, leave them).
- **Machine.** Adrian's laptop: i7-1165G7, 8 GB RAM (`CLAUDE.md` §3). Low-memory rules apply: at most 2 workers, one Nexus window, no second `npm run watch`.
- **Tooling state found at 01:30.** `extensions/nexus/node_modules/` exists but `node_modules/.bin/` was empty, so `npx vitest` and `npx vite` failed with "not recognized". `npm ci` was run at 01:40 and restored them; `npx vitest run webviews` then passed **37 files, 371 tests** (your baseline: anything lower is a regression). Step one of D-00 is still `npm ci`, in case the tree changed. There is no `.claude/launch.json`. Chrome is installed at `C:\Program Files\Google\Chrome\Application\chrome.exe` (used for file screenshots, section 8).
- **Fork facts you rely on.** The fork's `viewsContainers` contribution point accepts `secondarySidebar` (`src/vs/workbench/api/browser/viewsExtensionPoint.ts:74`). Nexus's startup defaults live in `src/vs/workbench/browser/workbench.contribution.ts` around line 1031 (`registry.registerDefaultConfigurations`), where `workbench.secondarySideBar.defaultVisibility` is currently `'hidden'` and `workbench.colorTheme` is `'Nexus Dark'`. The webview host CSP allows `font-src ${cspSource}` and `img-src ${cspSource} data:` (`src/bridge/host.ts:43-46`), `localResourceRoots` is `media/` only. `@react-three/drei` 10.x is already a dependency (`package.json`), so thick lines via drei's `Line` need no new package.
- **Protocol you may call from webviews** (all already in `src/contracts/protocol.ts` and all handled by `webviews/shared/fakeBridge.ts`): `sessions.list`, `sessions.get`, `agent.subscribe`, `approvals.list/resolve/subscribe`, `receipts.list/subscribe`, `tasks.*`, `git.branches`, `git.commit.show`, `git.mergeAgentBranch`, `events.query/search/subscribe/activity`, `slack.*`, `swarms.review.*`, `ui.openTarget`, `ui.openExternal`, `ui.setTimeWindow`, `store.status/subscribe`, `models.list`, `accounts.list`, `optimizer.get/set`, `auth.status`, `app.ping`. **Contracts are frozen**: nothing tonight adds or changes a message, type or command name.

## 2. Research, and what we take from it

What was read tonight, and the decision each item drives. Secondary sources are marked; verify before quoting them to a judge.

| Topic | What the sources say | Decision for Nexus |
|---|---|---|
| **Bloomberg Terminal typography and density** | Bloomberg commissioned Matthew Carter to design proportional and monospaced typefaces for the Terminal; its UX team's stated job is presenting data "so users aren't overwhelmed" and "hiding complexity" across thousands of functions; even "a font change or the relocation of a button can be disruptive" ([Bloomberg, "How Bloomberg Terminal UX designers conceal complexity"](https://www.bloomberg.com/company/stories/how-bloomberg-terminal-ux-designers-conceal-complexity)). Secondary writeups add that dense trading UIs stay scannable through color coding, bold weight, borders and spatial grouping, and that "without those hierarchy tools, density becomes chaos" ([openskillindex, secondary](https://openskillindex.com/skills/intense-visions-harness-engineering-design-content-density-d2ab35)); critics note users take pride in mastering the complexity ([UX Magazine](https://uxmag.com/articles/the-impossible-bloomberg-makeover)). | Density comes from **structure, not smallness**: every surface is a grid of 1 px-bordered regions with an uppercase 11 px header, rows of fixed height, and numerals in one mono column. Hierarchy by weight, border and position, never by size jumps. Nothing moves between iterations without reason: a control keeps its place once placed. |
| **UI font for dense screens** | Guides converge on Inter or IBM Plex Sans at 400/500 for dense dashboards, tabular numerals in every numeric column, no serifs in chrome ([madegooddesigns, secondary](https://madegooddesigns.com/bloomberg-font/); [ui-craft dense dashboard skill, secondary](https://www.skills.sh/educlopez/ui-craft/ui-craft-dense-dashboard)). Inter's own notes describe a prominent x-height and short extenders "calibrated to maximize letter recognition within compact UI elements" ([rsms.me/inter](https://rsms.me/inter/lab)). Inter exposes `tnum` (tabular), `zero` (slashed zero), `ss01` (open digits), `cv11` (single-storey a) ([rsms.me/inter](https://rsms.me/inter/lab); [lexingtonthemes, secondary](https://lexingtonthemes-com.pages.dev/blog/inter-stylistic-sets-css-tailwind)). | **Inherit the host font** (`var(--vscode-font-family)`, Segoe UI on Windows) for UI text, with Inter, IBM Plex Sans and system-ui as the fallback stack. Bundling a font file is allowed only if its OFL `LICENSE` ships beside it under `media/` and the CSP's `font-src ${cspSource}` loads it; tonight do **not** bundle (license and CSP checks cost time the demo doesn't need). Turn on `font-feature-settings: "tnum" 1, "zero" 1` everywhere numbers appear. |
| **Monospace for data** | Reviews rate IBM Plex Mono the "strongest free option for a product UI", JetBrains Mono the developer-tool favorite whose taller x-height "helps below 12px", Geist Mono best for non-code data display, Berkeley Mono the paid pick; one notes you "don't need a monospace font to get aligned figures" if the sans has tabular numerals ([sitepoint](https://www.sitepoint.com/best-monospace-fonts-for-developers/); [fontalternatives, secondary](https://fontalternatives.com/blog/best-free-monospace-fonts-2026/); [artofstyleframe, secondary](https://artofstyleframe.com/blog/monospace-fonts-in-product-ui/)). JetBrains Mono and IBM Plex Mono are SIL OFL 1.1; redistribution must keep the copyright notice and the OFL text ([JetBrains Mono LICENSE](https://maxibestof.one/fonts/coding/jetbrains-mono-LICENSE.txt); [IBM Plex, Wikipedia](https://wiki.krisyotam.com/content/wikipedia_en_all_nopic_2026-03/IBM_Plex)). | Data (SHAs, times, counts, model IDs, T+, code, diffs) uses `var(--vscode-editor-font-family)` so it matches the user's editor, falling back to `"Cascadia Mono", "JetBrains Mono", "IBM Plex Mono", Consolas, ui-monospace, monospace`. Mono is for **identifiers and code**; counts and money in tables may stay in the UI sans with `tnum`. |
| **Reference dark systems (Linear)** | Community extractions describe a near-black base (`#08090a`) with stepped surfaces (`#0f1011`, `#141516`, `#1a1b1d`), an achromatic palette with one indigo-violet accent, a 4 px grid, 12 to 13 px body, Inter for UI and Berkeley Mono for code, semantic green/yellow/red only for status ([webdesignhot, secondary](https://www.webdesignhot.com/design.md/linear/); [buildmvpfast, secondary](https://www.buildmvpfast.com/blog/linear-aesthetic-tokens-density-keyboard-first-ux-2026)). | Nexus Dark already does this: `#0b0b0e` chrome, `#0e0e11` editor, `#14141a` widgets, `#17171c` hover, `#2e2e36` borders, one purple. Keep the ladder, name it in tokens (section 3), and make every webview use the ladder instead of ad-hoc values. |
| **VS Code webview guidance** | Official: use webviews sparingly, make every element themeable, follow accessibility guidance (contrast, ARIA, keyboard); the same rules apply to webview views in any container ([VS Code UX guidelines, webviews](https://code.visualstudio.com/api/ux-guidelines/webviews)). Theme colors are exposed as `--vscode-*` CSS variables; `contrastBorder` and friends are set only in high-contrast themes; always use the fallback form `var(--vscode-x, fallback)` ([Theme Color reference](https://code.visualstudio.com/api/references/theme-color)). | Colors stay theme-mapped with Nexus Dark fallbacks. Add a high-contrast path: when `--vscode-contrastBorder` is set, borders use it. Keyboard reachability and ARIA labels are acceptance items, not polish. |
| **WCAG 2.2** | Normal text needs 4.5:1 (11 px is normal text; "large" starts at 18 pt). New in 2.2: 2.4.11 Focus Not Obscured (Minimum, AA), 2.5.8 Target Size (Minimum, AA: 24×24 CSS px **or** enough spacing, with inline and user-agent exceptions), 2.4.13 Focus Appearance at AAA ([W3C, What's New in WCAG 2.2](https://w3.org/WAI/standards-guidelines/wcag/new-in-22/); [hidde.blog](https://hidde.blog/new-in-wcag22/); [tetralogical](https://tetralogical.com/blog/2023/10/05/whats-new-wcag-2.2)). | Primary buttons become **dark text on purple** (`#0b0b0e` on `#9d6bff`, 5.6:1), the Bloomberg dark-on-amber move in our hue. 22 px controls stay (VS Code's own rows are 22 px) and satisfy 2.5.8 through the spacing rule: a 24 px circle centered on each control must not hit a neighbor's, so vertical pitch is at least 24 px (22 px control + 2 px) and horizontal gaps at least 4 px. Focus ring: 1 px solid `--nx-focus` plus `outline-offset: 1px`, never clipped by `overflow: hidden` parents (2.4.11). |
| **Three.js lines** | `LineBasicMaterial.linewidth` is ignored by the WebGL renderer on most platforms (ANGLE on Windows caps lines at 1 px); the fix is `Line2`/`LineMaterial`/`LineGeometry` from the addons, which need `material.resolution` set to the canvas size or widths come out wrong ([three.js LineMaterial docs](https://threejs.org/docs/pages/LineMaterial.html); [three.js discourse](https://discourse.threejs.org/t/how-to-use-linesegments2-to-render-fat-lines/33981.md)). drei wraps this as `<Line lineWidth>` (unverified tonight; check `node_modules/@react-three/drei` before using). | Orbits, arcs and the now line get real width (1.5 to 2 px) through drei `Line` or `Line2`; the planet wire stays 1 px (fine detail reads better thin). Cap `dpr` at `[1, 1.5]`, keep `antialias: true`, no post-processing (would need a new dependency). |

## 3. Design system v2

All of CLAUDE.md §6 stands. This section tightens it into tokens the code can enforce. Tokens live in `webviews/shared/theme.css` `:root`; the style test resolves them, so **every new token must be declared in that `:root` block** or the test's resolver throws.

### 3.1 Color

One purple ramp, used by the kit, the theme and the globe. Values come from Nexus Dark so webviews match the chrome around them.

| Token | Value | Use |
|---|---|---|
| `--nx-accent` | `#9d6bff` | primary action fill, selection, active tab underline, tracked event, selected channel rule |
| `--nx-accent-hi` | `#b794ff` | accent **text** on dark (8.0:1), links, active tab label, kind labels |
| `--nx-accent-lo` | `#7f77dd` | globe orbit lines, inactive accent marks |
| `--nx-accent-deep` | `#5b3fb3` | pressed state, planet wireframe |
| `--nx-accent-glow` | `#d9caff` | now line, tracking ring, "LIVE" dot |
| `--nx-accent-tint` | `#9d6bff22` | selected row background (matches `list.inactiveSelectionBackground` in the theme) |
| `--nx-accent-fg` | `#0b0b0e` | **text on accent fill** (5.6:1). Never white on purple. |
| `--nx-bg` | `var(--vscode-editor-background, #0e0e11)` | page |
| `--nx-surface` | `var(--vscode-sideBar-background, #0b0b0e)` | side regions, headers |
| `--nx-surface-2` | `var(--vscode-editorWidget-background, #14141a)` | inputs, dropdowns, inset blocks |
| `--nx-hover-bg` | `var(--vscode-list-hoverBackground, #17171c)` | row hover |
| `--nx-border` | `var(--vscode-contrastBorder, var(--vscode-panel-border, #2e2e36))` | every 1 px line |
| `--nx-border-strong` | `#3a3a46` | focused container, table header rule |
| `--nx-fg` | `var(--vscode-foreground, #d4d4d8)` | text |
| `--nx-muted` | `var(--vscode-descriptionForeground, #8b8b96)` | labels, secondary (5.7:1, the floor; nothing dimmer carries meaning) |
| `--nx-ok` / `--nx-pending` / `--nx-error` | `#3fb950` / `#d29922` / `#f85149` | status only: confirmed/passing, awaiting approval, rejected/failed |

Rules: status colors never decorate (no green "connected" headers; a status word or dot carries it). The globe keeps the purple ramp regardless of theme; its markers differ by **shape and brightness**, not hue (commit sphere `accent-hi`, agent cube `accent-glow`, Slack diamond `accent`), so purple stays the one accent.

### 3.2 Type

| Token | Value |
|---|---|
| `--nx-font-ui-family` | `var(--vscode-font-family, Inter, "IBM Plex Sans", "Segoe UI", system-ui, sans-serif)` |
| `--nx-font-data` | `var(--vscode-editor-font-family, "Cascadia Mono", "JetBrains Mono", "IBM Plex Mono", Consolas, ui-monospace, monospace)` |
| `--nx-font-ui` / `--nx-lh-ui` | `12px` / `16px` body |
| `--nx-font-ui-sm` / `--nx-lh-sm` | `11px` / `14px` labels, table cells, headers |
| `--nx-font-data` sizes | `11px/14px` in tables and strips, `12px/16px` in diffs and briefs |
| `--nx-font-xs` | `10px` **only** for SVG axis ticks and the kbd hint; never for a word a user must read |
| Headers | 11 px, 600, uppercase, `letter-spacing: 0.06em`, `--nx-muted` |
| Buttons | 11 px, 600, uppercase, `letter-spacing: 0.04em` |
| Numerals | `font-variant-numeric: tabular-nums slashed-zero; font-feature-settings: "tnum" 1, "zero" 1` on `.nx-data`, every `td`, every count |
| Truncation | single-line cells truncate with ellipsis and carry a `title`; text blocks (messages, briefs, diffs) wrap; nothing clips mid-glyph |

### 3.3 Geometry and density

`--nx-radius: 0` everywhere (the style test checks it). Controls 22 px, toolbar controls 20 px, rows 22 px in lists (20 px allowed only in dropdown results and the channel list), gaps 4 or 8, horizontal padding 8 (6 in table cells). A **region** is a bordered box with a 22 px header strip: `PanelHeader` (uppercase title, optional count in mono, actions right-aligned at 20 px). Regions touch, sharing borders, so the screen reads as one grid with no gutters wider than 1 px. Vertical pitch between stacked controls is at least 24 px.

### 3.4 Surfaces, states, motion

- Borders 1 px, no shadows, no gradients, no blur, no radius; hover brightens the fill (`--nx-hover-bg`) or inverts (buttons); pressed uses `--nx-accent-deep`; disabled `opacity: .5` plus `cursor: default`.
- Focus: `outline: 1px solid var(--nx-focus); outline-offset: 1px` on every interactive element, visible against both `--nx-bg` and `--nx-surface`; containers that scroll give their children room so the ring is never cut.
- Motion: none in the DOM except state changes under 100 ms; the globe is the only animated thing. Respect `prefers-reduced-motion` by slowing the planet's rotation to zero and skipping the live-insert glide.
- Empty state: one line of text plus one action, left-aligned in the region, 22 px tall. Loading: a one-line `… loading` status in `--nx-muted`, no spinner. Error: a `StatusLine tone="error"` with RETRY.
- Scrollbars: thin (8 px), square thumb `--nx-border-strong` on transparent track, via `::-webkit-scrollbar` in `theme.css`.
- High contrast: when `--vscode-contrastBorder` resolves, borders take it and hover adds a 1 px dashed outline.

### 3.5 Components (kit v2)

Existing: `Button` (add `variant: "primary" | "default" | "ghost" | "danger"`, `size: "md" | "sm"`, `kbd`), `Input` (add `prefix` label slot), `Select`, `Tabs` (add `count` per tab), `Table` (sticky header, `align: "right"` for numerics, `mono` columns, row `onClick`, `selected`), `StatusLine`, `KeyValueRow`, `Chip` (add `kind` variants: default, accent, ok, pending, error, stale-dashed), `Toolbar` (left and right groups), `EmptyState`.

New: `PanelHeader`, `Region` (bordered box with optional header and footer status line), `SegmentedControl` (for the time window: 24H 36H 7D 30D), `Badge` (status word with dot: LIVE, RUNNING, AWAITING, DONE, FAILED), `ListRow` (22 px grid row with named slots: leading, title, meta, trailing), `MonoBlock` (pre with wrap, select-all on double click of the header), `Confirm` (inline two-step: MERGE → CONFIRM MERGE / CANCEL, 5 s auto-revert). Every component is exported from `webviews/shared/index.ts` and has a render test; the style test gains assertions for the new tokens and for `--nx-accent-fg` on primary buttons.

## 4. Target layout

Three regions, as Adrian asked: **Slack and git on the left, the globe in the center, the agent on the right.**

```
┌──────────┬────────────────────────────────────────────┬──────────────────┐
│ ACTIVITY │                                            │ AGENT            │
│  BAR     │             NEXUS HOME (globe)             │ ─ session switch │
│ ┌──────┐ │   tab-less editor area, nexus.home         │ ─ status strip   │
│ │SLACK │ │   search · window · live/pinned · counts   │ ─ LOG  DIFF      │
│ ├──────┤ │                                            │   TESTS RECEIPTS │
│ │GIT   │ │                                            │ ─ approval card  │
│ ├──────┤ │   activity strip · detail strip            │                  │
│ │APPROV│ │                                            │                  │
│ └──────┘ │                                            │                  │
│ primary  │                                            │ secondary        │
│ side bar │                                            │ side bar         │
└──────────┴────────────────────────────────────────────┴──────────────────┘
```

- **Left (primary side bar, container `nexus`):** views in this order: `nexus.chat` "Slack", `nexus.git` "Git" (new), `nexus.approvals` "Approvals". "GitHub" in Adrian's words means the repo side: branches, agent branches, recent commits, merge; GitHub.com has no integration in Nexus and none is added. The built-in Source Control view stays where it is.
- **Center:** the globe home, unchanged in mechanism (custom editor `nexus.home`, tab-less core change already on `main`), redesigned in chrome and scene (section 5.1).
- **Right (secondary side bar, new container `nexus-agent`, contributed under `viewsContainers.secondarySidebar` in `contributes/lane-3.json`):** one webview view `nexus.agent` "Agent" that hosts the `session` entry as a **view** instead of a panel. Startup default `workbench.secondarySideBar.defaultVisibility` changes from `'hidden'` to `'visible'` in `src/vs/workbench/browser/workbench.contribution.ts` (a Lane 1 startup-defaults core change; heads-up goes in `progress/lane-1.md` and the PR title says "core:").
- **Session selection without a contract change.** The agent view has no `data-session-id` at creation. It calls `sessions.list` (newest first, running before done), shows the newest as the current one, and offers a switcher. `nexus.openSession <id>` focuses `nexus.agent` and selects that session by **re-setting the resolved view's HTML with `withBodyData(html, "session-id", id)`** (the host keeps a reference to the resolved `WebviewView`; a reload replays from `seq 0`, which the contracts guarantee). If the view is not resolved yet, focus it and pass the id the same way once `resolveWebviewView` runs. Keep `openSession` as a panel fallback only when the secondary side bar is unavailable. Task and plan editors stay panels tonight.
- **`.claude/launch.json`** (new, repo root, Lane 1's) declares the Vite dev server so the built-in browser can open any view at `http://localhost:5173/<entry>/?fake=1`:

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "nexus-webviews", "runtimeExecutable": "npx", "runtimeArgs": ["vite", "--port", "5173", "--strictPort"], "cwd": "extensions/nexus", "port": 5173 }
  ]
}
```

(If `cwd` is not honored by the preview tool, start it with `run_in_background` from `extensions/nexus` and `navigate` to the URL instead.)

## 5. Per-surface specs

Every surface: regions with `PanelHeader`s, the token set above, keyboard reachable, `?fake=1` renders without console errors, empty/loading/error states styled. Specific requirements follow; where a spec and CLAUDE.md §6 or §7 disagree, CLAUDE.md wins.

### 5.1 Globe home (`webviews/globe`, `webviews/timeline`)

Chrome:
- Top bar is one 22 px `PanelHeader` row: left, `SegmentedControl` 24H · 36H · 7D · 30D; center, the search input (`prefix` "SEARCH", placeholder "events: title, sha, orbit, kind", max width 480); right, `Badge` LIVE (glow dot) or VIEWING T+hh:mm with a BACK TO LIVE button, then `N EVENTS` in mono. STOP TRACKING (kbd ESC) appears right of the search while tracking.
- Search dropdown rows 20 px: title (truncating) · kind (accent-hi, uppercase) · orbit · T+ · short SHA, all data in mono; active row `--nx-accent-tint` plus 1 px accent outline; Enter picks the top, Escape closes (already implemented; restyle only).
- Under the stage: the **activity strip** (32 px) with a 4-px left gutter legend "15M" and hover tooltip "T+hh:mm · N"; then the **detail strip** (22 px): kind · title · orbit · T+ · sha · actor, OPEN on the right; the `StoreStatusLine` at the very bottom (offline, outbox count).
- A **legend** of 4 glyphs (sphere commit, arc merge, cube agent, diamond Slack) sits in the stage's top-left corner as an HTML overlay in 11 px mono, `--nx-muted`.
- Stage background is `--nx-bg`; no vignette, no stars.

Scene (`webviews/globe/scene/**`, colors from `colors.ts` which now mirrors section 3.1 as hex numbers):
- Planet: latitude rings and meridians in `accent-deep` at 1 px, 0.9 opacity, rotation unchanged (0.05 rad/s), zero when `prefers-reduced-motion`.
- Orbits: drei `Line` or `Line2` at 1.5 px in `accent-lo`, 0.55 opacity; the activity ring per family at 1 px, 0.3 opacity, dashed if drei supports it, otherwise solid.
- Now line: 2 px `accent-glow` from the planet surface to just past the outermost ring, with a 3 px dot at each orbit crossing.
- Markers: commit spheres `accent-hi`; merge arcs 1.5 px `accent`, 0.85 opacity; agent cubes `accent-glow`; Slack diamonds `accent`. Hover: marker scales 1.3× and the detail strip previews it; selected: 1 px ring in `accent-glow`; tracked: ring plus camera follow (existing).
- Depth fade: markers behind the planet are hidden (the depth-only sphere already does this); markers on the far side of an orbit drop to 0.5 opacity so the near side reads as foreground.
- `Canvas` props: `dpr={[1, 1.5]}`, `gl={{ antialias: true, powerPreference: "low-power" }}`; instancing threshold unchanged (about 2,000).
- Timeline fallback (`webviews/timeline`) reuses the same bar, strips and tokens; lanes 22 px; marks in the same ramp.

### 5.2 Slack view (`webviews/chat`)

- Left column 180 px: `PanelHeader` CHANNELS with the count; rows 20 px: `#` in mono, name, unread count right-aligned in mono (bold when > 0), a `--nx-pending` dot only when the bot is not a member (tooltip and `aria-label` "bot not in channel: no live updates"); selected row has a 2 px accent left rule and `--nx-accent-tint`.
- History: header 22 px with the channel name in mono, member/bot badges, and a LIVE badge when subscribed; rows are a 3-column grid `time (mono, muted, 44 px) · name (600) · text`, 2 px vertical padding, hover `--nx-hover-bg`; day separators as 20 px rows with a 1 px rule and the date in mono; reply counts as `Chip` (accent-hi) "3 REPLIES"; pending rows at 0.6 opacity, failed rows with a red 2 px left rule and RETRY/DISMISS.
- Bot messages: 2 px accent left rule, uppercase NEXUS label, body in `--nx-fg`, approval buttons APPROVE (primary) · REJECT (danger) inline; the "model-written" label where the contracts require it.
- Code-ref chips: `Chip kind="accent"` with `path:start-end` in mono and the short SHA; stale refs dashed.
- Composer: 22 px `Input` growing to 88 px, SEND (primary, kbd ENTER) and a 20 px identity line "posting as @name" (or "no user token: posts go as the app" in `--nx-pending`).
- Thread pane 300 px: header THREAD · reply count · CLOSE (kbd ESC); same rows; MAKE TASK (primary) in its footer.

### 5.3 Agent view (`webviews/session`, hosted as the `nexus.agent` view)

- Header region (two 22 px rows): row 1, session switcher (`Select` listing sessions newest first as "status · task title · model"), `Badge` with the status; row 2, mono strip `branch · model · T+start · elapsed · $cost (saved)`, truncating from the left with a `title`.
- `Tabs` LOG · DIFF · TESTS · RECEIPTS with counts.
- LOG as a transcript: `message` events as full-width text rows; `tool_call`/`tool_result` as 22 px grid rows `seq · T+ · TOOL · summary` in mono with ok/fail glyphs (`✓`/`✗` in status colors); `status`, `commit`, `error` as `StatusLine`s; `approval_request` renders the approval card inline (below); `receipt` rows show `requested → served · $` in mono. Auto-scroll pinned to the bottom until the user scrolls up; a `↓ N NEW` ghost button returns.
- DIFF: one `Region` per file with header `path · +a −d · COLLAPSE`; lines in mono 12/16 with `+`/`−` in `--nx-ok`/`--nx-error` (text color only, no fills), hunk headers muted.
- TESTS: command in mono, exit code badge, tail block.
- RECEIPTS: `Table` with right-aligned numerics and a footer total; OPEN stays disabled until Lane 1 wires a bridge command (unchanged tonight).
- Approval card: `Region` header APPROVAL · kind; action in mono; "reason" with the model-written label; swarm verdict `Badge` (LOOKS GOOD ok, CONCERNS pending, DO NOT MERGE error, REVIEW UNAVAILABLE muted) plus a judges `Table`; APPROVE (primary) REJECT (danger); decided state shows "approved by slack U… at T+" in a status line.
- Empty: "no agent session yet · START ONE FROM A SLACK THREAD" with a button that runs… nothing from a webview; show the text and make it a hint, not a button, unless `ui.openTarget` can reach the Slack view (it cannot). Keep it honest.

### 5.4 Approvals view (`webviews/approvals`)

Dense list, one `Region` per approval: header `kind · session short id · T+ requested`, action in mono, reason with the label, swarm `Badge` and a compact judges table (name · verdict · one-line note), APPROVE/REJECT, decided line. Pending ones first, then decided, with a 20 px "DECIDED" separator.

### 5.5 Git view (`webviews/git`, new entry)

Three regions: **BRANCHES** (`Table`: name, head short SHA mono, CURRENT badge, AGENT chip, `git.branches`), **AGENT BRANCHES** (same rows plus MERGE → `Confirm` → `git.mergeAgentBranch`, result as a `StatusLine`: "merged as <sha>", "already merged", or the clean-abort message), **RECENT COMMITS** (`events.query` last 24 h, kind commit/merge, rows `T+ · sha · title · actor`, click → `ui.openTarget`). `fakeBridge` already serves all three requests.

### 5.6 Task editor and plan review (`webviews/task`, `webviews/plan`)

Restyle only: `Region`s TASK · SOURCE (quoted block with the UNTRUSTED/QUOTED tag) · BRIEF (mono textarea) · MODEL (select with data-use chips LEAVES MACHINE / NOT USED FOR TRAINING / UNKNOWN) · actions START (primary) · BREAK INTO SUBTASKS. Plan review: subtasks as a `Table` (n · title · depends on) with ACCEPT (primary) and REJECT.

## 6. Tasks

Sizes: S under 1 h, M 1 to 2 h. `OWNS` are disjoint between tasks that run at once. Every acceptance runs from `extensions/nexus`, offline, no keys. The lead does D-00 to D-04 itself (shared files); workers take the view tasks.

| ID | Title | Pri | Size | Depends | Owns | Acceptance |
|---|---|---|---|---|---|---|
| **D-00** | Prep: fetch, merge, `npm ci`, baseline checks and screenshots | 1 | S | – | `.claude/launch.json`, `docs/design/**` | `npm ci && npm run typecheck && npm run lint && npx vitest run webviews && npm run build:webviews && npm run contributes:check` green; seven baseline PNGs in `docs/design/screens/before/` |
| **D-01** | Tokens v2 in `theme.css` + style test extensions | 1 | M | D-00 | `webviews/shared/theme.css`, `webviews/shared/style.test.tsx` | `npx vitest run webviews/shared/style.test.tsx`; new tests: primary button text resolves to `--nx-accent-fg`; every `--nx-*` color pair listed in a `CONTRAST` table in the test passes 4.5:1 (text) or 3:1 (UI) computed from the fallback hex values; `font-feature-settings` includes `tnum` on `.nx-data` |
| **D-02** | Kit v2 components | 1 | M | D-01 | `webviews/shared/*.tsx` (not `fakeBridge.ts`, `bridgeClient.ts`), `webviews/shared/index.ts` | `npx vitest run webviews/shared`; each new component has a render test; `npm run typecheck` |
| **D-03** | Nexus Dark theme alignment | 2 | S | D-01 | `themes/nexus-dark.json` | JSON parses; `button.background` `#9d6bff` with `button.foreground` `#0b0b0e`; `badge`, `activityBarBadge`, `focusBorder`, `list.*`, `sideBarSectionHeader.*`, new `secondarySideBar*` keys set; `npm run contributes:check` |
| **D-04** | Layout: `nexus-agent` secondary-side-bar container + `nexus.agent` view, `nexus.git` view, startup default visible, `openSession` selects in the view | 1 | M | D-00 | `contributes/lane-3.json`, `src/features/views/lane3-views.ts` (+test), `src/register/lane-3.ts`, `src/bridge/host.ts` **only if** a view reference accessor is needed (then the Opus reviewer must confirm; Lane 2's file), `src/vs/workbench/browser/workbench.contribution.ts` (one line) | `npx vitest run src/features/views`; `npm run contributes && npm run contributes:check`; launch check: secondary side bar visible at startup with AGENT; `Nexus: Open session` focuses it |
| **D-05** | Agent view redesign | 1 | M | D-02 | `webviews/session/**` | `npx vitest run webviews/session && npm run build:webviews`; screenshot `after/session.png` |
| **D-06** | Slack view redesign | 1 | M | D-02 | `webviews/chat/**` | `npx vitest run webviews/chat && npm run build:webviews`; `after/chat.png` |
| **D-07** | Globe chrome + scene redesign, timeline fallback | 1 | M | D-02 | `webviews/globe/**`, `webviews/timeline/**` | `npx vitest run webviews/globe webviews/timeline && npm run build:webviews`; `after/globe.png`, `after/timeline.png`; frame time under 16 ms with the 36 h fixture in Chrome (DevTools performance or `requestAnimationFrame` delta logged for 5 s) |
| **D-08** | Approvals view redesign | 1 | S | D-02 | `webviews/approvals/**` | `npx vitest run webviews/approvals && npm run build:webviews`; `after/approvals.png` |
| **D-09** | Task editor + plan review restyle | 2 | S | D-02 | `webviews/task/**`, `webviews/plan/**` | `npx vitest run webviews/task webviews/plan && npm run build:webviews`; `after/task.png`, `after/plan.png` |
| **D-10** | Git view (new entry) | 2 | M | D-02, D-04 | `webviews/git/**` | `npx vitest run webviews/git && npm run build:webviews`; `after/git.png`; `fakeBridge` serves it without changes |
| **D-11** | Polish pass: focus rings, truncation, ARIA, scrollbars, high contrast, console clean | 1 | S | D-05..D-08 | any `webviews/**` (lead only, sequential) | `npx vitest run webviews`; zero console errors on all entries at `?fake=1`; Tab reaches every control in each view |
| **D-12** | Morning report, progress file, PR to `main` | 1 | S | all | `docs/design/REPORT.md`, `progress/lane-1.md` | PR merged after the `extension` check passes; report lists every change with before/after images |

Worker brief fields follow `CLAUDE.md` §11 exactly (TASK, LANE, BRANCH `lane-1-wt/D-xx`, WORKTREE `../nexus-wt/D-xx` sparse, GOAL, OWNS, READ FIRST = this file's §3 and the surface's §5 block plus `CLAUDE.md` §6, §14, CONTRACTS, ACCEPTANCE, CONSTRAINTS, STOP WHEN, REPORT). Add to every CONSTRAINTS: "no new npm dependency; no contract change; webview code never imports `vscode` or Node; colors only through `--nx-*` tokens, no hex literals outside `theme.css` and `scene/colors.ts`; keep every existing test green or explain which assertion changed and why in REPORT".

Reviewer checklist adds to §11: tokens only; 22/20 px; dark text on accent; focus ring present and unclipped; contrast table respected; no hue other than purple used for non-status meaning; every label uppercase 11 px; data in mono with `tnum`; empty/loading/error states present; `?fake=1` screenshot attached and matches §5.

## 7. Schedule to 06:00

Times are **America/New_York on 2026-11-08**. Read the clock at start (`date`) and shift the plan if you start later than 01:45; never move the 05:15 freeze or the 06:00 stop.

| Window | Lead | Workers (max 2) |
|---|---|---|
| start → 02:30 | D-00, D-01 (tokens + tests), start D-02 | – |
| 02:30 → 03:00 | finish D-02, D-03 | – |
| 03:00 → 04:15 | D-04 (layout + core default), merge procedure for finished workers | **D-07 globe**, **D-05 agent view** |
| 04:15 → 05:15 | merges, D-10 git view if a slot frees after D-06/D-08 | **D-06 Slack**, **D-08 approvals**; then D-09 if time |
| 05:15 | **freeze**: no new tasks start; unfinished worker tasks are merged only if the reviewer confirms, otherwise abandoned (worktree removed, noted in REPORT) | – |
| 05:15 → 05:40 | D-11 polish on what landed, full checks, launch check | – |
| 05:40 → 05:55 | D-12: PR `lane-1 → main`, wait for `extension`, merge, REPORT and progress file | – |
| 06:00 | stop. End the turn with `wrap_up`. | – |

Priority if time runs short: D-07 (demo step 1 and 7), D-05 (step 5 and 6), D-06 (steps 3 and 4), D-08 (step 6), then D-04's visible-by-default right bar, then D-09, D-10. A dropped task is recorded in REPORT under "Not done", with the reason.

## 8. The verification loop

Run after every task, before every merge:

```bash
cd extensions/nexus && npm run typecheck && npm run lint && npx vitest run webviews src/features/views && npm run build:webviews && npm run contributes:check
```

Timing measured at 01:45 on this machine: `npx vitest run webviews` alone takes about 3 minutes (vitest reported 186 s, mostly worker startup), so during a task run only the surface's folder (`npx vitest run webviews/globe`) and save the full command for merges and PRs. `npm ci` took under a minute once the cache was warm.

Visual check, per entry (`globe`, `chat`, `session`, `approvals`, `task`, `plan`, `timeline`, `git`):

1. Dev server: `preview_start` with `nexus-webviews`, or `npx vite --port 5173 --strictPort` in the background from `extensions/nexus`. Fake mode is `?fake=1` (the fixture bridge; `vite.config.ts` documents it).
2. Interactive look: built-in browser `navigate` to `http://localhost:5173/<entry>/?fake=1`, `screenshot`, `read_console_messages` (must be empty of errors), `find` a few controls and Tab through them. The session view reads `<body data-session-id>` first and `?sessionId=<id>` as the dev fallback (`webviews/session/sessionId.ts:7-9`), so `?fake=1&sessionId=<fixture session id>` works; the task editor's `taskId.ts` follows the same pattern.
3. File screenshot for the report, from the repo root, 1280×800 and a narrow 360×800 for side-bar views:

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,800 --screenshot="docs/design/screens/after/globe.png" "http://localhost:5173/globe/?fake=1"
```

   If WebGL renders black under `--disable-gpu`, drop that flag or add `--use-angle=swiftshader --enable-unsafe-swiftshader`; if the scene still fails headless, take the stage screenshot through the built-in browser and note it. Keep each PNG under 300 KB (`--window-size` only; no retina scaling).
4. Critique each screenshot against §3 and §5 with the Read tool before accepting it: alignment to the 22 px grid, one accent, mono numerals aligned, headers uppercase, no rounded corner, no white-on-purple, focus visible, nothing clipped. Write the critique as a checklist in REPORT.
5. Launch check (lead, once before each PR, and once after D-04): `.\scripts\code.bat --extensionDevelopmentPath=<repo>\extensions\nexus` from the repo root with the fork's `npm run watch` output present in `out/` (the core one-liner in D-04 needs a core compile: if `npm run watch` is not running, start it once in a background terminal and wait for "Finished compilation"; incremental is about 32 s on this machine). Confirm: Nexus activates, the home opens tab-less, the secondary side bar shows AGENT, the left container shows SLACK · GIT · APPROVALS, no error notifications, then close the window. Never leave two Nexus windows open on 8 GB.

## 9. Rules, held items, stop conditions

Standing (from `CLAUDE.md` §10, §11, §14 and the Lane 1 session prompts):

- Branch `lane-1`; worker branches `lane-1-wt/D-xx` in sparse worktrees; `git fetch --all` then `git merge origin/main` and `git merge origin/lane-1` before any push; never rebase, never force push, never push `main`; PRs title-only (`lane-1: redesign the nexus webviews (design night)`; a second PR for the core default if you split it: `lane-1: core: show the secondary side bar by default`); merge only after the `extension` check passes on the pushed commit; `gh … --repo Bomoga/Nexus` on every call.
- Commits `lane-1: <what changed>`, tests green at every commit, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never edit: `src/contracts/**`, Lane 2's paths (`src/services/**`, `src/bridge/**` except the one accessor D-04 may need, `src/register/lane-2*.ts`), `CLAUDE.md`, `docs/PLAN.md`, `package.json` dependencies, the lockfile, `.env*`. No new npm packages. No secrets in code, logs, screenshots or the report.
- Webviews never import `vscode` or Node; every color through tokens; Slack and repo text stay untrusted (render as text, never as HTML).
- At most 2 workers at once; workers and reviewers never spawn agents, push, merge or edit outside OWNS; two attempts per task, then it is abandoned with notes (no human tonight).
- Record every decision you make for Adrian (accent pick, layout mechanics, anything dropped) under **Decisions** in `progress/lane-1.md`, and the Lane 3 ownership note: "Lane 1 ran the design pass on webviews under Elkin's handoff".

Held, do not do, do not ask: live API spend; Slack posts; Auth0 or CIBA changes; `cp-*` tags; dependency upgrades; bundling font files; changing any message, type or command name; editing VS Code core beyond the one default in D-04; deleting or weakening tests; touching the demo repo seed.

Stop conditions: the clock reaches 06:00 (finish the current commit, write REPORT and the progress file, `wrap_up`); or the repo is in a state you cannot make green within 30 minutes (revert to the last green commit on `lane-1`, write what happened, stop); or a push is rejected twice after fetch-and-merge (stop, record).

## 10. The morning report

`docs/design/REPORT.md`, written by the lead, in this order:

1. **Status line**: what is on `main`, what is on `lane-1` only, what was abandoned.
2. **Before/after** for each surface: two images side by side (markdown table), three bullets of what changed.
3. **Decisions made for Adrian**: accent ramp, dark-on-purple buttons, layout mechanics, anything that deviated from §5 and why.
4. **Checks**: the last full verification output (test counts, typecheck, lint, build), launch-check result, console-error status per entry, frame time for the globe.
5. **Not done / known issues**: with file and line, and the smallest next step for each.
6. **Demo notes**: anything the presenter should know (for example, "the secondary side bar opens by default; drag it narrower than 320 px and the status strip truncates from the left").

No prose about architecture; the report is for a reader who will open the app at 08:00 and demo it.
