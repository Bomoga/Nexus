# Lane playbooks

One file per lane lead session. Each playbook is the lead's running order for the whole event: what to dispatch, in which wave, to how many workers, what to merge and when to launch-check. It **does not restate** task briefs, contracts or acceptance commands: those live in `docs/PLAN.md` and are referenced by section and task ID (`PLAN §5.1 L1-09` = the L1-09 block in PLAN.md section 5.1). `CLAUDE.md` remains the source of truth for rules; the playbook only sequences them.

| Playbook | Getting started (read at 9:45 PM) | Lead | Branch | Workers |
|---|---|---|---|---|
| `lane-1.md` | `start-lane-1.md` | Adrian | `lane-1` | 2 (8 GB) |
| `lane-2.md` | `start-lane-2.md` | Brandon | `lane-2` | 3 (2 on 8 GB) |
| `lane-3.md` | `start-lane-3.md` | Elkin | `lane-3` | 3 (2 on 8 GB) |

The `start-lane-N.md` pages cover 9:45 PM → T+2:00 only: pre-flight checklist, the hour-0 rows you do by hand, the exact first three messages to paste into your Claude Code lead session, and what to watch in the first hour of wave 1. From T+2 the playbook takes over.

Shared mechanics every playbook assumes (from `CLAUDE.md` §10–§12 and `PLAN §3`):

```
# new worker (sparse worktree) — CLAUDE.md §11
git worktree add --no-checkout ../nexus-wt/<id> -b lane-N/<id> lane-N
cd ../nexus-wt/<id> && git sparse-checkout set extensions/nexus docs progress CLAUDE.md && git checkout
cd extensions/nexus && npm install

# per-task merge — CLAUDE.md §11 "lead's merge procedure"
(cd ../nexus-wt/<id>/extensions/nexus && <acceptance cmd> && npm test)
# reviewer gets: brief + `git diff lane-N...lane-N/<id>` + test output → confirmed|disputed
git merge --no-ff lane-N/<id> && (cd extensions/nexus && npm test) && git push origin lane-N
git worktree remove ../nexus-wt/<id> && git branch -d lane-N/<id>

# sync — every 3 h and after any PR to main
git merge main     # never rebase; conflicts outside owned paths → stop, tell the human

# launch check (before every PR to main) — CLAUDE.md §10
.\scripts\code.bat --extensionDevelopmentPath=<repo>\extensions\nexus   # dev loop
.\scripts\code.bat                                                       # built-in bundle, checkpoints only
```

Reviewer model class: Opus for anything touching the bridge, the gate, contracts or a §14 rail; Sonnet otherwise (`CLAUDE.md` §11). Two attempts per task, then the human.

Progress file (`progress/lane-N.md`, lead only, fixed headings): **Done · In flight · Blocked · Decisions · Next**. Update at every merge into the lane branch, before every PR to `main`, and before sleeping.
