---
name: autopilot
description: This skill should be used when the user runs /tdd-flow:autopilot, or asks to "implement all approved specs", "run the specs in parallel", "work through the open specs" or "implement every spec that is not implemented yet". It starts one background Claude session per approved tdd-flow spec, each in its own git worktree (tasks through tdd-implement, superpowers code review, pull request), runs several at once and reports the pull requests.
argument-hint: "[slug ...] [--parallel N]"
---

# Autopilot: implement every approved spec in parallel

Input: $ARGUMENTS - optional feature slugs (default: every spec), optional `--parallel N` (default 3, or 1 when the tests need Docker or a database; step 1b decides).

Each spec runs in its own background session (`claude --bg`) in `.claude/worktrees/<slug>` on branch `feature/<slug>`. That session runs `/tdd-flow:implement-spec`, which implements the tasks, simplifies the whole PR, reviews, fixes once and opens a PR. This skill selects the specs, starts the sessions, keeps at most N running and reports. It never merges.

`tdd-flow` is the plugin CLI (on the Bash `PATH`); it takes JSON on stdin and prints `{"ok": ..., "result": ...}`. Run it from the main checkout's root.

**Shell:** this session's shell keeps a `cd` for every later command, and the paths below are relative to the main checkout's root. Never use a bare `cd` into a subdirectory. Use a subshell `(cd apps/web && npm ci)` or a tool flag (`npm --prefix`, `mvn -f`, `git -C`).

## 0. Clean up merged specs

```bash
tdd-flow cleanup <<'TDD_FLOW_JSON'
{}
TDD_FLOW_JSON
```

It removes the worktree, background session, run file and local branch of every spec whose PR is merged with nothing after it (ignored files such as a `.env` go with the worktree; the branch is deleted even after a squash merge, because the PR was merged at its tip). It never forces the worktree. A worktree is kept, with the reason, while:
- a PR is open or the branch has newer commits;
- a session there is still open;
- it has uncommitted or untracked changes;

Show one line per removed spec (slug, PR, MB freed), one per kept one (slug - why), and the `notes`. On `skipped`, show it as a warning and go on. An error here does not stop the autopilot.

## 1. Select specs

```bash
tdd-flow specs <<'TDD_FLOW_JSON'
{"slugs": []}
TDD_FLOW_JSON
```

Pass the slugs from the input in `slugs` (naming a spec also restarts it after a `blocked` run). On `ok: false` show the error and stop; it says what to fix: `.tdd-flow/` git-ignored, `state.json` tracked, not the main checkout.

Show `runnable` and `skipped` (one line each: slug - reason), and every entry of `warnings` (for example a git identity made up from the hostname) with its fix command. An error that there is no git identity stops the autopilot: show the fix command. Specs are runnable when their status on `feature/<slug>`, or on the base branch if that branch does not exist yet, is `approved`. They must also be committed on the base branch without local changes. The exception is a spec that exists only on `feature/<slug>`, which `/tdd-flow:simplify-codebase --implement` creates: it runs when it is named in the slugs. If nothing is runnable, stop.

## 1b. Pre-flight

Once, in the main checkout, before any worktree exists. Run it with the Bash tool and `timeout: 600000`: it may run the test suite. While the printed JSON has `"again": true` (the base suite still runs), run the identical command again; it waits for the same run.

```bash
tdd-flow autopilot-check <<'TDD_FLOW_JSON'
{"runnable": <number of runnable specs>, "parallel": <N from --parallel, or leave the key out>}
TDD_FLOW_JSON
```

Print one line per entry of `checks`: `<status> <name> - <details>`, plus its `fix` when there is one. It checks:
- `gh` is logged in;
- Docker is running, when `.tdd-flow/stack.md` says the tests need it (`tests need:`);
- the rules background sessions need are allowed, unless they run in `auto` mode. Otherwise they stop at a permission prompt until someone attaches;
- the local base branch has what `origin` has (`base`): every worktree branches from it. Behind or diverged fails; the fix is a pull the user runs, never you without their OK;
- the base suite passes, once for all specs (only with 2 or more specs, a clean main checkout on the base branch and a base in line with origin).

If `ok` is false, stop: a failed check would stop every session. Warnings do not stop the run. Use the returned `parallel` as N from here on.

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

**With the status pane open** (`board` returned `paneOpen: true`; the pane shows every spec beside the chat, `/tdd-status`): print the board `table` once after step 2 and once in the summary, not after every return. Add `"ticks": false` to every `runs-wait` input, so it returns only when a run finishes, not on a ticked task. After each return, write one line per finished or blocked spec (`<slug>: done <prUrl>`, `<slug>: blocked - <first line of details>`, `<slug>: decision Q-<n>`, `<slug>: stalled - <attach>`) instead of the table. Without `paneOpen`, everything below stays as written.

Run with the Bash tool and `run_in_background: true` (it blocks until a run finishes, up to 4 hours):

```bash
tdd-flow runs-wait <<'TDD_FLOW_JSON'
{"slugs": ["<every running slug>"], "progress": <progress from the last board>}
TDD_FLOW_JSON
```

It returns when a run finishes or when a running spec ticks a task (`progressed`), with the current `progress`. Pass that `progress` to the next `runs-wait`. Run `runs-wait` itself as the background command: never wrap it in a shell loop or filter its result in the shell. Every return, `progressed` included, must come back to you, so the table is printed after each ticked task. Every time it exits, run `board` again (same slugs, `queued` updated) and print its `table`. Then read `finished`:

- `done` → note the `prUrl`.
- `blocked` → note `details`. With a `decision`, the spec waits for the user's answer: see **Decisions** below.
- `stalled` → the session went idle or disappeared without a report (it asked something or stopped early). Note its `attach` command (`runs-wait` gives the name, or the id when the name is ambiguous); do not restart it.

Then start the next queued specs (step 2) until N are running again, and start `runs-wait` again for the running slugs with the latest `progress`. Leave finished slugs out: `runs-wait` returns at once for them. Repeat until nothing runs and nothing is queued. If `runs-wait` reports `timedOut`, list the running sessions with their `attach` commands and ask the user whether to keep waiting.

### Decisions

A blocked run with `decision` added an open question (`decision.id`) to `spec.md` in its worktree and stopped before the tasks it blocks.
1. If other specs are still running, start `runs-wait` again in the background for them first, so they keep being watched while you ask. Skip this when nothing else runs.
2. Ask the open decisions in chat, one at a time, in plain text: slug, question, options, recommendation and the blocked tasks. Next to the recommendation, show the precedent: run `tdd-flow decisions` with `{"slug": "<slug>"}` (from the main checkout) and name the closest earlier answer on the same subject (`<other-slug> Q-<m>: <answer> (<date>)`), or "no earlier decision". Wait for each answer. Do not put two questions in one message.
3. Edit what the answer changes in the worktree (`.claude/worktrees/<slug>/.tdd-flow/features/<slug>/`), as the `resolve-questions` skill does: the criteria, edge cases, tasks, `tasks.md` and the **Verify** commands it changes (an allow-list of test edits, protected paths). If the spec says `Status: implemented` (the decision came from the simplify or review step, after every task was ticked), add a task for the answer to the task table and `tasks.md` (`- [ ] T-<next> <what the answer changes> (<AC ids>)`). Otherwise the restart would find nothing to do. Do not move the question, change `Status` or commit: step 4 does that. The user's answer in this conversation approves the change.
4. When N specs are already running, wait for a slot first (the edits wait in the worktree). Then record the answer and start the spec again:
   ```bash
   tdd-flow answer-decision <<'TDD_FLOW_JSON'
   {"slug": "<slug>", "id": "Q-<n>", "answer": "<answer>", "where": "<the ids step 3 changed; leave the key out for no change>"}
   TDD_FLOW_JSON
   ```
   It checks that the run still waits on `Q-<n>`, moves the question to `## Resolved questions` with the answer and today's date, sets an `implemented` spec back to `approved` (it refuses while `tasks.md` has no open task), commits `docs(<slug>): answer Q-<n>` in the worktree, removes the old session unless `claude agents` lists it as `working`, starts the spec again with `claude --bg` in its worktree (the old session's name when it is free) and records the run as `running`. The new session resumes from the first open task. Print one line: `<slug>: Q-<n> answered, running again as <name>`, its `attach` command and its `notes`. An error names the step that failed and keeps the steps before it: fix the cause and run the same command again.
5. Stop the background `runs-wait` (TaskStop) and start a new one that includes the restarted slug.

A decision the user does not answer stays open; list it in the summary.

A decision answered through `/tdd-flow:answer-decision` (for example from the status pane) counts as answered: before you ask one, check the spec's row in the latest `board`. When it no longer shows that decision, do not ask it again; once the spec runs, add it back to the `runs-wait` slugs.

## 4. Summary

The final `board` table (it has the PR URL, or the reason and `claude attach <name>` for blocked and stalled specs, or `decision Q-<n>: ...`), then the open decisions: slug, question, recommendation. To answer one later:
- run `/tdd-flow:resolve-questions <slug>` in the worktree;
- set `Status: approved` again (for an implemented spec, add a task for the answer as in **Decisions** step 3);
- commit in the worktree;
- run `/tdd-flow:autopilot <slug>`.

Then list the skipped specs (slug - reason) and the worktree of each blocked or stalled spec. Then:

- A blocked spec: fix the cause (in its worktree), then run `/tdd-flow:autopilot <slug>`; it resumes from `tasks.md` on the same branch.
- A stalled spec: `claude attach <name>` and answer the session.
- Worktrees stay until the PR is merged (fixes after PR review go there). The next autopilot start then removes them (step 0). A worktree with uncommitted changes stays: deal with them first. Ignored files (`.env`, a local database) do not keep it; they are deleted with it. `/tdd-flow:deploy {feature, mode: "merge", approved: true}` sets the spec to `done` if you want that.

## Notes

- Background sessions stop at permission prompts until someone attaches. Step 1b lists the rules they need when they do not run in `auto` mode: `Workflow`, `Bash(tdd-flow *)`, `Bash(git *)`, `Bash(gh pr *)`, `Bash(gh issue view *)`, `Edit`, `Write`, and the frozen install of each tracked lockfile (`Bash(npm ci)`, `Bash(pnpm install *)`, `Bash(yarn install *)`, `Bash(bun install *)`). Allow them in `~/.claude/settings.json` or the main checkout's `.claude/settings.local.json` (worktree sessions use that file too).
- N sessions use the rolling rate-limit window N times faster. Tests of parallel sessions can collide on shared resources (ports, one local database, docker compose). With `tests need:` in `stack.md` the autopilot runs one spec at a time unless you pass `--parallel N`.
- PRs of parallel specs can conflict with each other; that is resolved at merge.
