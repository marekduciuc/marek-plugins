# tdd-flow hardening plan (from /insights, 09.11.2026)

Source: the "Where Things Go Wrong" to "On the Horizon" sections of the Claude Code insights report of 09.11.2026, checked against tdd-flow 0.12.1 and the symple-crm run transcripts.

Goal: a user installs tdd-flow and it works without changing their whole environment. Fixes go into the plugin, not into the user's rules or repo CLAUDE.md.

Status: phase 1 implemented in tdd-flow 0.13.0. Phase 2: autopilot pre-flight and external test state (F6) implemented in tdd-flow 0.14.0; migrations (F7), meta-tests (F8), questions in chat (F4) and `/tdd-flow:resolve-questions` in tdd-flow 0.15.0. Phase 3: before-push sync implemented in tdd-flow 0.16.0, as a merge of the base (no rebase, so no force-push); the cleanup skill in 0.16.1; the decision queue in 0.17.0. Migration collisions and the dependency graph not started.

Phase 2 (0.14.0) as built: a separate `tdd-flow autopilot-check` command. The base suite runs only for 2 or more specs and only in a clean main checkout on the base. Permissions come from managed settings, the user settings, the main checkout's `settings.local.json` (worktree sessions use it) and the base's `settings.json`. No rules are needed in `auto` mode, which is the default since Claude Code 2.1.283. `tests need:` in stack.md is inferred from the test lines only for older profiles. It sets parallel to 1. The test cache stays on (user decision after the architecture review: Testcontainers start fresh, and one session at a time already avoids shared state); `TDD_FLOW_TEST_CACHE=off` covers a shared local database.

Phase 1 as built, after the architecture review: the relay returns `relayFailed` and the task commit retries on that flag only; `block` keeps the tick when HEAD already is the task commit; `stageChanged` is opt-in and set only on task commits (not CHARACTERIZE, docs, mark-implemented or skipped-task commits); `tdd-flow test -- <cmd>` keeps the caller's directory; the type check comes from a new `type check command` field in `stack.md`; the identity check uses `git var GIT_COMMITTER_IDENT` and stops the autopilot when git has no identity.

## Already done outside the plugin

| Where | Change |
|---|---|
| `~/.claude/rules/communication.md` | Confirm the visible result before data moves, merges or deletes. Shell: no bare `cd`. After each commit, check `git status --porcelain`. Before reporting a block, check the real state. |
| symple-crm `CLAUDE.md` | Test commands as subshells. `protects=`/`fails_when=`/`no_claim=` rule. Shared IT database. A migration keeps existing ITs green. |
| symple-crm `.tdd-flow/stack.md` | All commands as subshells from the repo root. |
| `git config --global` | `user.name` and `user.email` set (3 of the last 5 symple-crm commits had `marek@Mareks-MacBook-Pro.local`). |

## Phase 1: stability (tdd-flow 0.13.0)

One PR, one commit per item, each with a regression test in `tests/cli.test.cjs` (fixture git repo), written test-first.

### P1.1 False "blocked at COMMIT" (F1)
Seen: users-list/role-change run (T-2, T-6, T-7, T-9), T-16 in another run.
- First read the run logs (`<git common dir>/tdd-flow/runs/*.json`, `tdd-log.md`, the transcripts) to confirm the cause. Suspected cause: `tdd-implement.js:662` blocks on any `ok:false` from `cli('commit')`, including a failed relay of a commit that went through.
- `tdd-flow commit` becomes idempotent: if HEAD is already `<type>(<slug>): T-n` and the task is ticked, return `committed: true` with that sha.
- Before blocking at COMMIT, the workflow checks the real state through the CLI (deterministic), not the relayed result.

### P1.2 Commits leave out changed files (F2, decision: option a)
Seen in 13+ runs (list in the 09.11.2026 session): bookkeeping files, schema-pinning ITs (`FlywayMigrationIT`, `RlsCatalogIT`, `OpenApiDocIT`, `openapi.json`), fixtures and test helpers, production code, an untracked `application-jobs.yml`.
- Bug fix: new untracked files under `.tdd-flow/features/<slug>/` (`review.md`, `tdd-log.md`, `testreport.md`) are staged when the repo tracks `.tdd-flow/`. Today the CLI never stages an untracked `.tdd-flow/` path, so they always end up in `unexpected`.
- Stage every changed tracked file, plus new untracked files in directories the task touched. New files elsewhere (e.g. a loose note in the repo root) are not staged and are listed in the result (`unstaged`).
- Tracked files that test runs rewrite (e.g. `vitest.config.mts` thresholds via coverage autoUpdate, a root `testreport.md`) are staged into the task commit too (Q3, decision: option a), so ratcheted thresholds ship with the code that raised them. The commit result lists them.

### P1.3 Working directory drift (F3)
Seen: `npm ci` left the shell in `apps/web`, T-1 started from the wrong directory.
- The CLI switches to `git rev-parse --show-toplevel` at start; all relative paths resolve from the repo root.
- `stack-detector` writes every command as a subshell from the root: `(cd apps/web && npm test)`, never a bare `cd` chain.
- `implement-spec` installs dependencies with a subshell or `--prefix`.
- Agent prompts (test-writer, implementer, code-reviewer, release-engineer): never a bare `cd`.

### P1.4 Type check before RED (F9)
"Buggy code" was the top friction type (57); type errors in new tests counted as RED.
- test-writer runs the type check or compile step on the new tests before reporting RED. A type error in the test is a wrong-reason failure.

### P1.5 Git identity check
- autopilot start and `deploy` preflight warn when `user.email` is not set (commits would get a hostname address).

## Phase 2: fewer stalls

- **Autopilot pre-flight**, once in the main checkout before any worktree: base suite green, `gh` auth, Docker if the stack needs it, the permissions background sessions need (they pause at prompts until you attach), git identity.
- **External test state (F6):** stack-detector records "tests need a database or Docker". The autopilot then warns and defaults to `--parallel 1` (the test cache stays on, decided 09.11.2026).
- **Migrations (F7):** implementer rule: a schema or migration change updates the dependent tests and fixtures in the same task. Then remove the migration line from the symple-crm CLAUDE.md.
- **Meta-tests (F8):** test-writer and implementer follow repo tests that check other tests (comment metadata, naming), e.g. `TestClaimCommentsTest`.
- **Questions in chat (F4):** the `ship-feature` Gate 1 and the `analyze-requirements` handoff print open questions numbered in chat and ask them one at a time.
- **New skill `/tdd-flow:resolve-questions <slug>`:** walks the spec's Open questions one at a time in chat and updates `spec.md` after each answer (spec question resolution was the top goal, 40 sessions).

## Phase 3: parallel runs and decisions

- **Before push:** rebase onto the base and run the generate commands (new `stack.md` field, e.g. `openapi.json`), then rerun the suite (PR #83/#84 conflicts).
- **Migration collisions:** the autopilot warns when two specs running at the same time add migrations.
- **Decision queue:** a blocked run writes a structured decision (context, options, recommendation, blocked tasks) to `run-report`; `board` and the autopilot summary show it in chat; optionally a draft PR with the decisions at the top. No polling, no skipping ahead to later tasks.

  Design (decided 09.11.2026):
  - **When.** implement-spec raises a decision only when a step is blocked on a choice that is the user's to make: the spec contradicts itself or the code, an AC allows two behaviours, or a finding needs a product call. Technical failures (a red test, the environment, a merge conflict) stay plain `blocked`.
  - **Where.** In the worktree, the session adds the question to `## Open questions` in `spec.md`, in the usual format. The assumption is its recommendation, followed by the options and the tasks it blocks. It commits the file (`docs(<slug>): open question Q-<n>`), then runs `run-report` with `status: blocked` and `decision: {id, question, options, recommendation, tasks}`. Later tasks are not started.
  - **Shown.**
    - `board` puts `decision Q-<n>: <question>` in the reason column.
    - `runs-wait` returns the decision with the finished run.
    - The autopilot starts `runs-wait` again in the background, then asks the open decisions in chat, one at a time, as `resolve-questions` does. The other specs keep running meanwhile.
  - **Answer.**
    - The autopilot writes the answer into the worktree's `spec.md` (`## Resolved questions`, plus the ACs and tasks it changes) and commits it.
    - It then restarts the spec as in step 2: `specs` with the slug, `worktree`, a new `claude --bg` session. The old session is removed with `claude rm` first.
    - The restarted spec continues from the first open task. It waits in the queue when N specs are already running.
    - When the autopilot has already ended, the user answers with `/tdd-flow:resolve-questions <slug>` in the worktree, then runs `/tdd-flow:autopilot <slug>`.
  - **No draft PR.** The PR still opens at the end, so there is no early push and no early CI.
- **`/tdd-flow:cleanup` skill:** exposes `tdd-flow cleanup` outside the autopilot.
- **Dependency graph between specs** and merge order. Related to the deferred task-level parallel worktrees idea (01.11.2026).

## Later: move global rules into the plugin

So users don't need your `~/.claude/rules`: Shell (no bare `cd`), Questions (in chat, one at a time), Git state reporting (commit check, block check, PR only after `gh pr create` returned a URL). How a plugin ships rules is to be checked in the Claude Code docs first.

## Not done (decided)

- Generic Stop/PostToolUse hooks for a dirty tree: the commit CLI checks it, and a hook would fire in every repo.
- Headless mode: the autopilot already runs `claude --bg`.
- Converting Testcontainers to singletons: symple-crm already has static containers (`TestContainersConfig`).

## Open questions

- Phase 1: none (Q1 split, Q2 release as one PR, F2 option a, Q3 option a).
- Phase 2 and 3 questions come when those phases start.
