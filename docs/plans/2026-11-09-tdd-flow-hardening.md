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

## Findings from the first live run (symple-crm #34, 09.11.2026, fixed in 0.17.1)

- **Shell loop around runs-wait.** The autopilot wrapped `runs-wait` in a shell loop that ignored `progressed` and passed the same stale `progress` every time. After the first ticked task it restarted about once a second, and the table after each task never showed. Fix: `runs-wait` returns the current `progress` and remembers what it reported, so a stale map waits for the next tick; the skill forbids a shell loop.
- **Specs had no title.** The spec template had no `# ` heading, so `specs` returned `title: ""` and the PR title rule pointed at a heading that did not exist. Fix: the template has a title line; specs without one fall back to the first sentence of `## Goal`, and PRs to the issue title.
- **board listed other worktrees.** A worktree of other work (`fix/...`) showed as `stalled`. Fix: only worktrees on `feature/<slug>`.
- **cleanup kept worktrees for old sessions** waiting for input. It now says to close them with `claude stop <name>`.
- **Bare `cd` in agents.** The agents' shell text said a `cd` carries into the next command. In workflow subagents every Bash call starts at the worktree root (seen in the transcripts), so the agents ignored the rule, and that did no harm. Fix: the agents' text describes the real behaviour; the no-bare-`cd` rule stays in the skills that run in a main session (implement-spec, autopilot, ship-feature), where a `cd` does carry.
- **sync-base on #34 (0.17.0) worked as designed**: a conflict in `testreport.md`, not a generated file, aborted the merge and blocked the spec with nothing pushed. The cause was in symple-crm: `testreport.md` was tracked although `.gitignore` lists it, so every PR rewrote it (untracked in symple-crm #95).
- **Worktrees started from a stale local base.** The next autopilot run branched spec 69 from local `main`, 2 commits behind `origin/main`. Fix (0.18.0): the pre-flight check `base` fetches and fails when the local base is behind or diverged; the user pulls. Rejected: branching from `origin/<base>` (silent, the base-suite check would test other code, local-only specs would be missing).

## Findings from pojistneudalosti v1-3 (10.11.2026, fixed in 0.19.0)

- **Two decisions during implementation (Q-15, Q-16).** The spec removed the `⚠` glyph (AC-8, AC-15) and said existing tests stay unchanged (AC-19), while three existing tests asserted `⚠`. The analysis ran on the right base (v1-2 merged); no critic compared the criteria with existing test assertions. Fix: a third critic `existing-tests`; revise names the test to update in the AC and task, or adds an Open question when a criterion forbids test edits. The test-writer updates exactly the named assertion in RED. The hits are returned as `existingTestsChanged` for the approval gate.
- **An answer left a Verify command stale.** The AC-19 allow-list of changed tests did not get the Q-15/Q-16 files, so T-17 failed. Fix: resolve-questions and the autopilot's Decisions step update Verify commands too.
- **The full suite was only the backend.** `test command (all)` skipped the frontend (`-Dskip.npm`), with the frontend command on a separate line nothing reads, so T-13 committed a red frontend test. Fixed in pojistneudalosti #8; the stack-detector and the implementer's SETUP step now put every suite into `test command (all)`.

## Reviewing runs (0.20.0)

The findings above came from reading session transcripts by hand twice. `/tdd-flow:review-run` does that: `skills/review-run/scripts/transcript.cjs` locates a transcript by session id, job name or slug (job `state.json`, `claude agents`, the run file, `~/.claude/projects/*/<uuid>.jsonl`), prints a summary of the key events and filtered views, and lists the workflow transcripts; the skill cross-checks the run file, PR, commits, spec and stack.md and reports findings as plugin / repo / one-off. Report only in chat (user decision).

## Next wave: findings of the first two review-run passes (10.11.2026, open)

From `/tdd-flow:review-run` on pojistneudalosti v1-3 (session 235ddbe7) and symple-crm #34 (job gdpr-person-anonymisation). Each is a plugin change unless marked.

1. **Empty review findings still start a fix round.** symple-crm #34 T-5: the suite failed on a foreign test (`SessionSharingIT`, port 8080 held by another project), the reviewer approved with no findings, and `tdd-implement.js` (~l. 605-651) still ran fix → retry → ESCALATED on the strong model, 27 minutes with no change, before `blocked`. Fix: with no non-minor findings and a failing test outside the task's files and the branch diff, run that test once alone and go straight to `blocked` ("suite fails outside this task: <test>"); never dispatch a fix agent on an empty list.
2. **A foreign failing test climbs the whole GREEN ladder before a decision.** v1-3 T-6 and T-14: GREEN → retry → ESCALATED, each failing on "the full suite is failing" for an existing test the implementer may not edit, then `record-block`. `greenProblems` (`tdd-implement.js` ~l. 331-336) does not tell the task's tests from others, and `testDefects` covers only the task's tests. Fix: accept a report that a failing test is an existing one that contradicts an AC (`testDefects` for tests outside the task, or `conflictingTests`) and stop the ladder after the first attempt with `blocked` plus a decision.
3. **A technical block with uncommitted work cannot be restarted the documented way.** #34 T-5: `run-report blocked` said "run `/tdd-flow:autopilot <slug>`", but `specs` refuses a worktree with uncommitted changes, so the main session resumed the old session by message instead. implement-spec sets work aside only for a decision. Fix: `set-aside` (label `blocked-T-<n>`, patch path in `details`) on every blocked report from a task, or let `specs` accept a spec whose run file says `blocked` and resume over the uncommitted changes; the autopilot skill names the message-to-a-live-session path as legitimate.
4. **The implementer does not see the decisions a task refers to.** #34 T-4 ("Q-5" in the task notes): GREEN got only the AC text, wrote a different dry-run message, two per-task reviews rated the deviation `minor` (dropped by `must`), and the final review raised it as Important, costing a fix round. Fix: pass the text of the `Q-n` entries a task names into the GREEN/SETUP prompt; in `code-reviewer`, a deviation from `## Resolved questions` is at least `major`.
5. **The analysis does not verify claims about existing code.** #34 AC-6 said a wrong `--confirm` "exits 2"; `CliRunner` returns 1 at the analysis base, the implementation was right, the spec wrong. The `existing-tests` critic (0.19.0) covers tests only. Fix: the critics (or revise) check every Context/AC statement about existing code against the file with a line number.
6. **An explicit slug in the requirement text is ignored.** v1-3: "Feature slug: v1-3-ui-design. …" became `feature-slug-v1-3-ui-design-vizualni-pru…` (`analyze-requirements.js` ~l. 169, fetch-requirement prompt), renamed by hand. Fix: "if the text names a slug (`Feature slug: x`, `slug: x`), use it verbatim"; or a `slug` parameter of the skill.
7. **push-gate could not replace a monorepo's own gate** (done in 0.21.0). symple-crm kept `.claude/hooks/pre-push-check.cjs`, without a HEAD cache, so `git push` + `gh pr create` ran the backend suite twice (8.5 min). push-gate already took `test command (all)` from `stack.md`, but not `type check command`, and its 280 s budget was below the ~4 min backend `verify`. Fix: `type check command` from the profile runs first; budget 540 s under a 600 s hook timeout (Claude Code lets a timed-out PreToolUse hook through, so the budget must stay under it). Lint stays out (the profile's line is often prose, and a formatter would rewrite files). Repo change: remove the symple-crm hook after updating the plugin.

## Later: move global rules into the plugin

So users don't need your `~/.claude/rules`: Shell (no bare `cd`), Questions (in chat, one at a time), Git state reporting (commit check, block check, PR only after `gh pr create` returned a URL). How a plugin ships rules is to be checked in the Claude Code docs first.

## Not done (decided)

- Generic Stop/PostToolUse hooks for a dirty tree: the commit CLI checks it, and a hook would fire in every repo.
- Headless mode: the autopilot already runs `claude --bg`.
- Converting Testcontainers to singletons: symple-crm already has static containers (`TestContainersConfig`).

## Open questions

- Phase 1: none (Q1 split, Q2 release as one PR, F2 option a, Q3 option a).
- Phase 2 and 3 questions come when those phases start.
