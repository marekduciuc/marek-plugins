---
name: simplify-codebase
description: This skill should be used when the user runs /tdd-flow:simplify-codebase, or asks to "simplify the codebase", "find unnecessary code", "remove dead code and duplicates across the repo" or "propose refactorings that cut code". It scans the codebase (or the given paths) area by area for code that does not need to exist, writes the confirmed findings as draft tdd-flow specs of refactor tasks, and with --implement approves them and hands them to the autopilot (worktree, characterization tests, refactor, review, PR).
argument-hint: "[path ...] [--implement [slug ...]] [--parallel N]"
---

# Simplify the codebase

Input: $ARGUMENTS
- optional paths to narrow the scan (default: the whole repo);
- `--implement`: approve and implement the specs this scan writes;
- `--implement <slug ...>`: approve and implement existing draft specs without scanning again;
- `--parallel N`: passed to the autopilot (default 3).

Run it from the main checkout's root. `tdd-flow` is the plugin CLI (on the Bash `PATH`); it takes JSON on stdin and prints `{"ok": ..., "result": ...}`.

Each finding becomes a `[refactor]` task. tdd-implement first pins the current behaviour with characterization tests and commits them after the full suite passed on the old code. Then it applies the change: suite, lint and type check must pass, and a review checks that behaviour stayed the same. A task whose change no longer fits the code is skipped, not forced.

## 1. Scan (skip when `--implement` names slugs)

Run the workflow `tdd-flow:simplify` with the Workflow tool (`name` is that full name), args `{"mode": "codebase", "paths": [<paths>]}`, and wait for its completion notification.

- `no_test_suite` or `nothing_to_scan`: show `next` and stop.
- `lean`: say that nothing worth removing was confirmed, list `dropped` briefly, and stop.
- `specs_written`: show a table with one row per spec: slug, area, number of tasks, tags, risk. Below it:
  - `highRisk`: findings left for a person, because they touch public contracts or names used through strings, reflection or DI. One line each.
  - `dropped`: the count, plus the reasons that repeat.
  - `notScanned`: areas over the limit. Tell the user to scan them with paths.

## 2. Without `--implement`: stop for review

The specs stay `Status: draft` in `.tdd-flow/features/simplify-*`, uncommitted. Tell the user:
- Read each `spec.md`. To drop a task, delete its line from `tasks.md` and its criterion from `spec.md`. Don't strike it through.
- Then run `/tdd-flow:simplify-codebase --implement <slug ...>` for the specs to keep. Delete the folders of the others.

Stop here.

## 3. With `--implement`: approve on a branch, then the autopilot

The slugs are the ones named after `--implement`, or every spec step 1 wrote. For each:

```bash
tdd-flow spec-branch <<'TDD_FLOW_JSON'
{"slug": "<slug>"}
TDD_FLOW_JSON
```

It creates `.claude/worktrees/<slug>` on `feature/<slug>`, moves the spec there, sets it `approved` and commits it on that branch. The base branch is never touched. On an error (no test suite, branch exists, spec already in git) show the message and leave that slug out.

Then invoke the `tdd-flow:autopilot` skill with args `<slug ...> --parallel <N>` and follow it. The autopilot finds these branch-only specs because they are named. Its summary is the end of this skill.

## Notes

- Areas are directories of tracked source files (no tests, generated, vendored or migration code), at most 12 per run. Findings of different areas never touch the same files, so their PRs do not conflict.
- Each spec has at most 8 tasks, so its PR stays reviewable. A larger area gets `-2`, `-3` specs.
- The scan costs about 2 agents per area plus one CLI call each. Implementation costs about 5 agents per task, plus the autopilot's review and PR per spec.
