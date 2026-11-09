---
name: autopilot
description: This skill should be used when the user runs /tdd-flow:autopilot, or asks to "implement all approved specs", "run the specs in parallel", "work through the open specs" or "implement every spec that is not implemented yet". It starts one background Claude session per approved tdd-flow spec, each in its own git worktree (tasks through tdd-implement, superpowers code review, pull request), runs several at once and reports the pull requests.
argument-hint: "[slug ...] [--parallel N]"
---

# Autopilot: implement every approved spec in parallel

Input: $ARGUMENTS - optional feature slugs (default: every spec), optional `--parallel N` (default 3).

Each spec runs in its own background session (`claude --bg`) in `.claude/worktrees/<slug>` on branch `feature/<slug>`. That session runs `/tdd-flow:implement-spec`, which implements the tasks, simplifies the whole PR, reviews, fixes once and opens a PR. This skill selects the specs, starts the sessions, keeps at most N running and reports. It never merges.

`tdd-flow` is the plugin CLI (on the Bash `PATH`); it takes JSON on stdin and prints `{"ok": ..., "result": ...}`. Run it from the main checkout's root.

## 0. Clean up merged specs

```bash
tdd-flow cleanup <<'TDD_FLOW_JSON'
{}
TDD_FLOW_JSON
```

It removes the worktree, background session, run file and (with `git branch -d`) branch of every spec whose PR is merged with nothing after it. It never forces. A worktree is kept, with the reason, while:
- a PR is open or the branch has newer commits;
- a session there is still open;
- it has uncommitted or untracked changes;
- it has ignored files other than build output, dependencies and IDE metadata (a `.env`, a local database).

Show one line per removed spec (slug, PR, MB freed), one per kept one (slug - why), and the `notes`. On `skipped`, show it as a warning and go on. An error here does not stop the autopilot.

## 1. Select specs

```bash
tdd-flow specs <<'TDD_FLOW_JSON'
{"slugs": []}
TDD_FLOW_JSON
```

Pass the slugs from the input in `slugs` (naming a spec also restarts it after a `blocked` run). On `ok: false` show the error and stop; it says what to fix: `.tdd-flow/` git-ignored, `state.json` tracked, not the main checkout.

Show `runnable` and `skipped` (one line each: slug - reason), and every entry of `warnings` (for example a git identity made up from the hostname) with its fix command. An error that there is no git identity stops the autopilot: show the fix command. Specs are runnable when their status on `feature/<slug>`, or on the base branch if that branch does not exist yet, is `approved`. They must also be committed on the base branch without local changes. The exception is a spec that exists only on `feature/<slug>`, which `/tdd-flow:simplify-codebase --implement` creates: it runs when it is named in the slugs. If nothing is runnable, stop.

Before starting, check `gh auth status`; if it fails, tell the user to run `! gh auth login` and stop.

## 2. Start sessions (at most N at a time)

For each spec to start:

1. ```bash
   tdd-flow worktree <<'TDD_FLOW_JSON'
   {"slug": "<slug>"}
   TDD_FLOW_JSON
   ```
   → `path`, `branch`. On error, record the spec as blocked with the message and go on with the next one.
2. Pick the session name, which is also what the user types in `claude attach <name>`: a 3-word kebab-case summary of what the spec builds, from its `title` (and the goal in `spec.md` if the title is missing or vague), e.g. `invitation-password-reset` or `customer-address-management`. Lowercase letters, digits and hyphens only. If a session in `claude agents --json --all` already has that name, add the spec number (e.g. `customer-address-management-23`).
3. Start the session in a subshell, so this session's directory does not change:
   ```bash
   (cd "<path>" && claude --bg -n <name> "/tdd-flow:implement-spec <slug> <base>")
   ```
   `<base>` is `base` from step 1. The output contains `backgrounded · <id> · <name>`; take the id.
4. ```bash
   tdd-flow run-report <<'TDD_FLOW_JSON'
   {"slug": "<slug>", "status": "running", "session": "<id>"}
   TDD_FLOW_JSON
   ```
   This also replaces the result of an earlier run.

Tell the user, per started spec: slug, worktree and `claude attach <name>` to watch it. Then show the board:

```bash
tdd-flow board <<'TDD_FLOW_JSON'
{"slugs": ["<every spec of this run, in order>"], "queued": ["<the ones not started yet>"]}
TDD_FLOW_JSON
```

Print its `table` exactly as returned (one row per spec: status, ticked/total tasks and the open task, PR or reason). Keep its `progress` for the next `runs-wait`.

## 3. Wait, refill, repeat

Run with the Bash tool and `run_in_background: true` (it blocks until a run finishes, up to 4 hours):

```bash
tdd-flow runs-wait <<'TDD_FLOW_JSON'
{"slugs": ["<every running slug>"], "progress": <progress from the last board>}
TDD_FLOW_JSON
```

It returns when a run finishes or when a running spec ticks a task (`progressed`). Every time it exits, run `board` again (same slugs, `queued` updated) and print its `table`. Then read `finished`:

- `done` → note the `prUrl`.
- `blocked` → note `details`.
- `stalled` → the session went idle or disappeared without a report (it asked something or stopped early). Note its `attach` command (`runs-wait` gives the name, or the id when the name is ambiguous); do not restart it.

Then start the next queued specs (step 2) until N are running again, and start `runs-wait` again for the running slugs with the latest `progress`. Repeat until nothing runs and nothing is queued. If `runs-wait` reports `timedOut`, list the running sessions with their `attach` commands and ask the user whether to keep waiting.

## 4. Summary

The final `board` table (it has the PR URL, or the reason and `claude attach <name>` for blocked and stalled specs), followed by the skipped specs (slug - reason) and the worktree of each blocked or stalled spec. Then:

- A blocked spec: fix the cause (in its worktree), then run `/tdd-flow:autopilot <slug>`; it resumes from `tasks.md` on the same branch.
- A stalled spec: `claude attach <name>` and answer the session.
- Worktrees stay until the PR is merged (fixes after PR review go there). The next autopilot start then removes them (step 0). A worktree with uncommitted changes, or with ignored files that are not build output (`.env`, a local database), stays: deal with them first. `/tdd-flow:deploy {feature, mode: "merge", approved: true}` sets the spec to `done` if you want that.

## Notes

- Background sessions stop at permission prompts until someone attaches. For unattended runs, allow in your settings what the sessions need: the Workflow tool for tdd-flow workflows, `Bash(tdd-flow:*)`, your test/build commands, `Bash(git:*)`, `Bash(gh pr:*)`, Edit and Write (or run in auto mode).
- N sessions use the rolling rate-limit window N times faster. Tests of parallel sessions can collide on shared resources (ports, one local database, docker compose): use `--parallel 1` for such repos.
- PRs of parallel specs can conflict with each other; that is resolved at merge.
