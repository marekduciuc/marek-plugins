# tdd-flow

Personal Claude Code plugin: an end-to-end dev pipeline built on **dynamic workflows** (scripted multi-agent orchestration) and specialist subagents. It works with any stack (it detects the language and test commands per repo) and delivers through your existing CI/CD.

## How it is built

- **Workflows** (`workflows/*.js`): the orchestration. Loops, retries, fan-out and verification are code, so every run follows the same process.
- **Agents** (`agents/*.md`): the specialists the workflows call (`agentType: "tdd-flow:<agent>"`). They also carry the domain knowledge: spec template, TDD rules, doc templates.
- **CLI** `bin/tdd-flow`: the deterministic steps (parsing the spec, git bookkeeping, commits, GitHub preflight, CI polling) as plain Node code. Workflow scripts cannot run commands, so they call it through the `script-runner` agent (Haiku, Bash only, a few lines of prompt) instead of a reasoning agent. See [tdd-flow CLI](#tdd-flow-cli).
- **Skill** `ship-feature`: chains the workflows and holds the human approval gates. Workflows can't ask questions mid-run, so the gates sit between runs.
- **Skills** `autopilot` + `implement-spec`: implement every approved spec in parallel, one background session per spec in its own worktree, each ending with a simplification pass, a code review and a PR. See [Autopilot](#autopilot).
- **Skill** `simplify-codebase`: finds code that does not need to exist across the repo and turns it into refactor specs. See [Simplification](#simplification).
- **Hook** `tdd-guard`: blocks production-code edits while a cycle is in RED. The state that counts is the one of the repo (or worktree) the edited file is in, and test folders are matched inside that repo.
- **Hook** `push-gate`: before Claude runs `git push` or `gh pr create` in any repo, runs the type check, lint and tests and a gitleaks secret scan; a failure blocks the command. See [push-gate](#push-gate).
- **Mod** `hooks/register.tsx` (a Claude Code hooks module, listed under `modules` in `hooks/hooks.json`, state contract in `types/index.d.ts`): the status pane beside the chat, `/tdd-status`. See [Status pane](#status-pane).

## Workflows

| Command | Shape | Agents (typical) |
|---|---|---|
| `/tdd-flow:analyze-requirements <issue \| file \| text>` | Context (stack + fetch, parallel; the other specs and their earlier decisions) → 3 analysts from different angles (behaviour / risk / minimal scope) → synthesize spec.md + tasks.md (a question an earlier decision answers goes to `## Resolved questions`, "as decided in <slug> Q-<m>") → testability, completeness, existing-tests (existing tests that assert what the spec changes) & cross-spec critics (contradictions with other specs; skipped when there are none) → revise. Returns `existingTestsChanged` and `crossSpecFindings` for the approval gate | ~8-10 |
| `/tdd-flow:tdd-implement {feature}` | Plan + baseline → per task, sequentially: RED (test-writer writes all of the task's failing tests) → GREEN (implementer makes them pass one at a time, then refactors) → CLI suite check + review with up to 2 fix rounds (behavioural findings go through RED → GREEN again) → commit (also ticks the task). `[setup]` tasks: SETUP + verify commands → review → commit. `[refactor]` tasks and `{refactors}`: CHARACTERIZE → its own commit → REFACTOR → review → commit | ~5 per task (2 more per 5 extra behaviours); ~4 per setup task; ~6 per refactor task |
| `/tdd-flow:document {feature}` | Survey diff → pipeline per target: write → adversarial fact-check → fix → commit | ~6-14 |
| `/tdd-flow:deploy {feature}` | Preflight → 3 review lenses (spec, security, quality) → dedupe → 2 skeptics per finding → PR → CI watch with test-first fix loop (max 2) → stops at `ready_to_merge` | ~8-12 |
| `/tdd-flow:deploy {feature, mode:"merge", approved:true}` | PR review status check → merge (+ optional release) → watch post-merge pipeline → close out | ~3 |
| `/tdd-flow:ship-feature <input>` (skill) | Runs everything above with Gate 1 (spec approval, after the open questions are answered one at a time in chat) and Gate 2 (merge approval) | - |
| `/tdd-flow:resolve-questions [slug]` (skill) | Lists the spec's open questions in chat, then asks them one at a time, each with the closest earlier answer from another spec (`tdd-flow decisions`). After each answer it moves the question to `## Resolved questions`, with the answer and where it went, and updates the criteria, edge cases, tasks and `tasks.md`. An approved spec whose criteria or tasks change goes back to `draft`. No commit | - |
| `/tdd-flow:simplify {mode, ...}` | `diff` (implement-spec): simplifier on the branch diff → sceptic (Opus) refutes → at most 8 proposals. `codebase`: areas → per area simplifier → sceptic → drop findings that touch another area's files → draft refactor specs | 2 (diff); ~2 per area + 1 per spec (codebase) |
| `/tdd-flow:autopilot [slug ...] [--parallel N]` (skill) | Per approved spec, up to N at once: worktree → background session running `implement-spec` (one tdd-implement run per task → simplify the PR → superpowers code review → one fix round → push + PR) → summary of PRs | per spec as tdd-implement, plus ~5 per simplification, review and fix round |
| `/tdd-flow:cleanup` (skill) | Runs `tdd-flow cleanup` outside the autopilot: removes the worktree, session, run file and branch of each spec whose PR is merged, and says why it keeps the others | - |
| `/tdd-flow:review-run [session-id \| job name \| slug]` (skill) | Read-only review of a finished tdd-flow session: locates its transcript (`scripts/transcript.cjs locate / summary / show / agents`), cross-checks the run file, PR, commits, spec and `stack.md`, and reports in chat what went wrong, why, and whether the fix belongs in the plugin, the repo or nowhere. No edits | - |
| `/tdd-flow:answer-decision <slug> Q-<n> <answer>` (skill) | What the status pane runs when you answer a decision there (you can type it too): checks with `tdd-flow status` that the spec is still blocked on that question, edits what the answer changes in its worktree (criteria, tasks, `tasks.md`, a new task for an `implemented` spec), then `tdd-flow answer-decision` does the rest: resolved-question entry, status, commit, old session, restart, run report | - |
| `/tdd-flow:board [slug ...]` (skill) | Read-only status table of the autopilot specs (every spec with a worktree or a run that is not done, or the given slugs): status, `3/7 · T-4 ...`, PR or reason with `claude attach`. Works while an autopilot started by an older version is still running | - |
| `/tdd-flow:simplify-codebase [path ...] [--implement [slug ...]]` (skill) | `simplify` in codebase mode → draft specs for you to review; with `--implement`: `spec-branch` per spec → autopilot | as `simplify`, then as autopilot |

### Spec status

**Test rules of the repo.** Before writing tests, the test-writer reads the test section of `CLAUDE.md` / `AGENTS.md` and looks for tests that check other tests, such as required comment blocks, naming or ArchUnit rules. New tests follow them, and those meta-tests run with the new tests. The implementer keeps the suite green after a schema or migration change: it updates the fixtures, seed data and schema assertions that the change breaks, in the same task, and never changes what a test asserts about behaviour. The workflow logs each updated fixture.

`spec.md` has a `Status:` line: `draft` → `approved` (you, at Gate 1) → `implemented` (tdd-implement, in the commit that closes the last open task; the CLI sets it only when `tasks.md` really has no open task left) → `done` (`deploy` merge mode, at close-out). tdd-implement also accepts an `implemented` spec, so a review-fix run (`{findings}`) works after the spec is finished. If every task is ticked but the spec still says `approved`, tdd-implement marks it `implemented` in a separate commit. Without the merge mode of `deploy`, the base branch keeps `implemented` after the PR is merged.

### Setup tasks (no TDD)

Some work cannot be test-driven: `docker-compose.yml`, `Dockerfile`, CI pipelines, `.env.example`, dependency manifests, installing the test framework when you bootstrap a project. The analyst marks such a task as `setup`. In `tasks.md` its line ends with `[setup]`, and each of its criteria in `spec.md` has a verify command:

```
- [ ] T-1 Docker compose with Postgres (AC-1, AC-2) [setup]

### AC-1 Database service starts
- **Given** ... **When** ... **Then** ...
- **Verify:** `docker compose config -q`
```

A task is `setup` only if it has no logic that a test could check. Logic always goes into a tdd task, and the spec critics and the per-task reviewer flag misclassified tasks. tdd-implement builds a setup task in one SETUP step (implementer). The step runs every verify command and must not break the test suite. The task then gets the normal review, and is committed as `chore(<slug>): ...`. A verify command that cannot run in the environment (for example, the Docker daemon is not running) is reported, not treated as a failure. Such commands are listed in `unverified` in the result, together with the manual checks.

### Refactor tasks

A `[refactor]` task changes code without changing behaviour. The simplifier's findings become such tasks. There is no failing test to start from, so tdd-implement proves the behaviour differently:

1. **CHARACTERIZE** (test-writer, phase RED, so production code is locked). It names the existing tests that pin the behaviour the change must keep. Where nothing pins it, it writes characterization tests. For a removal, it pins the callers. For a swap to a stdlib function, it pins the edge inputs. Each test must pass on today's code.
2. The CLI commits those tests as `test(<slug>): T-n characterize ...` after running the full suite on the old code. From here on, any edit to them shows up in the review diff.
3. **REFACTOR** (implementer):
   - applies the proposal; suite, lint and type check must pass;
   - an edit to a new characterization test is sent back;
   - a test that only covered removed code may go, and is listed for the reviewer;
   - deletions and renames are committed too (`includeDeletions`).
4. Review checks that behaviour stayed the same and that the pinned tests did not change. Its findings go back to REFACTOR, never to a new RED. The task is committed as `refactor(<slug>): ...`.

If the change no longer fits the code (an earlier task removed it) or cannot be made without changing behaviour, the task is skipped: ticked in a `chore(<slug>): T-n skipped - <reason>` commit and listed in `skipped`. `{refactors: [...]}` runs proposals as synthetic tasks `R-1..`. It runs only those, not open spec tasks; they are never ticked and get one commit each.

**Bootstrapping a new project.** The repo does not need a test suite yet. The baseline counts as passing. A setup task can install the test framework and update `.tdd-flow/stack.md`, and the tdd tasks after it use the new test commands. A tdd task with no test command stops with `blocked`.

Merge mode stops with `review_changes_requested` when a reviewer requested changes on the PR. Pass `requireReview: true` to also require an approving review (`review_required` otherwise). This is off by default because GitHub does not let you approve your own PR.

The feature branch (`feature/<slug>`), task and docs commits run in the tdd-flow CLI. Pushing, the PR, CI fix commits and merge/release go through the `release-engineer` agent, so pushes still pass the push-gate hook.

Each workflow returns `{status, ..., next}`. If a coding step still fails after escalating to Opus, it stops cleanly with `status: "blocked"` and resets the TDD phase, rather than guessing.

## tdd-flow CLI

`bin/tdd-flow` does the steps that need no judgement. Claude Code adds the plugin's `bin/` to the Bash `PATH`, so agents call it as `tdd-flow`. It works from the repo (or worktree) root wherever the caller's shell is, so an agent's `cd apps/web` cannot move `.tdd-flow/` or a commit's files; only a command given after `tdd-flow test --` runs in the caller's directory. The stack profile's commands must therefore work from the root (stack-detector writes subshells such as `(cd apps/web && npm test)`), and every agent prompt forbids a bare `cd`. Workflows pass JSON on stdin; it prints `{"ok": true, "result": {...}}` or `{"ok": false, "error": "...", "fallback": true?}`.

| Command | Used by | Does |
|---|---|---|
| `context` | analyze-requirements | Reads an existing `.tdd-flow/stack.md`; fetches a GitHub issue (`gh issue view`) or reads a spec file. Text input needs no fetch. Also reports the feature `state.json` names and its spec status: the new spec takes `state.json` over only from a finished or missing spec, otherwise the result says `stateKept`. Returns `otherSpecs` (slug, title, status, path, AC ids and names, out of scope) and `decisions` (as `decisions`) of every other spec, so the cross-spec critic needs no extra agent |
| `decisions` | analyze-requirements (through `context`), implement-spec, resolve-questions, autopilot | Collects the earlier decisions: every `- Q-<n> <question> - **Answer:** <answer> (<dd.MM.yyyy>) → <where>` entry under `## Resolved questions` of every spec except `{slug}` (indented lines continue an entry; lines that do not parse are counted in `skippedLines`). Returns `{decisions: [{slug, title, id, question, answer, date, where}], conflicts: [], skippedLines}`. Each spec from its newest copy: its worktree, `feature/<slug>`, the base branch, then the main checkout; specs are the folders in `.tdd-flow/features/` plus `feature/*` branches that hold a spec. Works from a worktree. It only collects; whether a decision fits is the agent's call |
| `sync-base` | implement-spec (before the push) | Merges `origin/<base>` into the feature branch, with a PR open too: no rebase, no force-push. Conflicts only in `generated files` (stack.md) are resolved by taking the base's version and running `generate command`, in the same merge commit. The generate command is a [watched run](#slow-or-hung-test-runs): while it runs the call returns `again`, and the identical call resumes the merge without a new fetch. Any other conflict, or a generate that fails or touches other files, aborts the merge and returns `conflict` / `generateFailed`. With nothing to merge it regenerates and commits stale generated files. The push-gate then reruns the checks on the merged code. A repo whose PR branches need linear history does not take the merge commit |
| `stack-fill` | analyze-requirements | After stack-detector wrote a new `stack.md`: writes the `tests need:` value the agent returned (a required field of its output) into the file when the line is missing or still holds the template hint. Leaves a filled-in value alone |
| `plan` | tdd-implement | Parses `spec.md` and `tasks.md` (tasks, behaviours, verify commands, approval) and runs the baseline suite (a [watched run](#slow-or-hung-test-runs): `again` while it still runs). Criteria text only for the tasks the run reaches (`maxTasks`, `fromTask`); returns `taskCount` and `openIds`, which the workflow checks against the relayed plan, and the profile's `type check command` as `typeCheck`: the test-writer runs it before reporting RED, so a type error in a new test is not taken for a failing test |
| `branch` | tdd-implement | Switches to or creates `feature/<slug>`. Resets a phase an earlier run left in `state.json` (a run that stopped between RED and GREEN) to `IDLE` and reports it as `phaseReset` |
| `commit` | tdd-implement, document | Optionally sets the spec status (`specStatus`), ticks the task line (`T-1` never matches `T-10`), writes `state.json`, stages the listed files (plus every tracked deletion with `includeDeletions`, for refactors; a new file under `.tdd-flow/` only where that folder already has tracked files, never `state.json`). With `stageChanged` (task commits) it also stages every changed tracked file, including files the tests rewrote (coverage thresholds, `testreport.md`), and new files in a directory the task touched, never the repo root; they are listed in `extraStaged`, other new files in `unstaged` and in the task's entry of the run result. It optionally runs the full suite before staging (`runTests`; `again` while it still runs, and the identical call continues the same run), refuses secret-looking content, secret files and files over 5 MB (plus gitleaks on the staged changes when installed), commits. Never pushes. |
| `block` | tdd-implement | Records a stop: `state.json` phase `IDLE`, an entry in `tdd-log.md`, optional untick (skipped when HEAD's subject is the given `commitMessage`) |
| `preflight` | deploy | Base and current branch, open tasks, CI, `gh` auth and `workflow` scope, secret scan (in committed workflow files only), open PR and its review status, and `warnings` when git has no identity or makes one up from the hostname (`git var GIT_COMMITTER_IDENT`) |
| `ci-watch` | deploy | Polls `gh pr checks` (or `gh run list --commit` after merge) for up to 30 minutes; on failure returns the failed-step log tail. Each call stops after about 8.5 minutes with `"again": true` and the runner repeats it. |
| `ci-rerun`, `add-secret-scan`, `close-out` | deploy | Rerun failed jobs; add the gitleaks workflow (removed again when its commit fails, so no uncommitted file looks like a scan); mark the spec done and reset `state.json` |
| `specs` | autopilot | Checks that `.tdd-flow/` is in git and `state.json` is not; lists the specs to start, with their title (status `approved` on `feature/<slug>` or, without that branch, on the base; committed, no local changes, no session running, not blocked last time unless named) and why the others are skipped. A spec that exists only on `feature/<slug>` (from `spec-branch`) is taken only when named. Stops when git has no identity (every session's commits would fail); warns in `warnings` when git makes one up from the hostname |
| `autopilot-check` | autopilot | Pre-flight before any worktree. `gh` logged in; Docker running (`docker info`) when `tests need:` names it; permission rules for background sessions from managed, user, the main checkout's local and the base's committed settings, not needed in `auto` mode; `base`: fetches `origin/<base>` (30 s, no prompts) and fails when the local base is behind or has diverged, warns when it has unpushed commits or the fetch fails; with `runnable` ≥ 2 the base suite once (`again` while it still runs), only in a clean main checkout on the base that is in line with origin. Returns `{ok, parallel, testsNeed, checks}`. `parallel` is the user's value, else 1 when the tests need something outside the repo (`tests need:`; older profiles count as Docker when a test line names Docker, Testcontainers or Podman), else 3 |
| `worktree` | autopilot | Creates or reuses `.claude/worktrees/<slug>` on `feature/<slug>`; adds `/.claude/worktrees/` and `/.tdd-flow/state.json` to `.git/info/exclude`. A new worktree gets `.tdd-flow/state.json` (`{feature, phase: "IDLE", task: <first open task>}`), so the phase (status pane, tdd-guard) is there from the first task on |
| `areas` | simplify | Splits the tracked source files (no tests, generated, vendored or migration code) into scan areas: a directory that fits (40 files, 400 KB) is one area, small siblings are packed together, larger ones are split. Deterministic |
| `simplify-spec` | simplify | Writes one area's findings as draft specs of `[refactor]` tasks, at most 8 per spec (`simplify-<area>`, `-2`, ...). A slug is taken if its folder, its spec on the base, a local or remote `feature/<slug>` or its worktree exists |
| `spec-branch` | simplify-codebase | Approves an uncommitted draft on its own branch: creates the worktree, copies the spec there, sets `approved`, commits it on `feature/<slug>`, then removes the folder from the main checkout. Never touches the base branch; refuses without a test command, for a spec already in git, or for an existing branch |
| `set-aside` | implement-spec | Saves the uncommitted changes of a failed step as a patch in `<git common dir>/tdd-flow/runs/<slug>-<label>.patch` and restores the working tree to `HEAD` (no stash: one stash list is shared by all worktrees). Only on a feature branch |
| `replay` | every workflow | Prints the saved output of an earlier call again (see the relay check below), without running the command a second time |
| `cleanup` | autopilot (at start) | Removes the worktree, background session, run file and local branch of each spec whose PR is merged at the branch tip; ignored files (`.env`, e2e output) go with the worktree, and the branch is deleted even after a squash merge. Keeps, with the reason: an open PR, later commits, an open session, uncommitted or untracked changes. Never forces the worktree |
| `run-report` | autopilot, implement-spec | Writes a run result (`running` / `done` / `blocked`, session id, PR URL, details, and for a blocked run optionally a `decision` `{id: Q-<n>, question, recommendation, options, tasks}` the user has to answer) to `<git common dir>/tdd-flow/runs/<slug>.json`, shared by all worktrees and never committed |
| `runs-wait` | autopilot | Blocks until one of the given runs is `done` or `blocked`, or its session is idle or gone without a report (`stalled`), or a running spec ticks a task in its worktree's `tasks.md` (`progressed`, compared with the board's `progress`); reads `claude agents --json --all`. Returns the current `progress` for the next call, and remembers what it reported (`<git common dir>/tdd-flow/progress.json`), so a call with a stale map waits for the next tick instead of returning at once. `ticks: false` (the autopilot sets it while the status pane is open): returns only when a run finishes, never on a ticked task. Its result has `paneOpen: true` while the pane is open |
| `board` | autopilot, board | Status of every spec (default: every spec worktree on a `feature/<slug>` branch, or a run file that is not `done`: a done run without its worktree is finished; other worktrees in `.claude/worktrees/` are not specs) of the run as rows and a ready Markdown table: `queued` / `running` / `done` / `blocked` / `stalled`, ticked/total tasks and the open task (`simplify / review / PR` once all are ticked), PR URL, `decision Q-<n>: <question>`, or the reason with `claude attach`. `paneOpen: true` while the status pane is open (its heartbeat is younger than 60 s) |
| `status` | status pane (every 10 s) | The `board` rows of every spec with a worktree or a run, plus `task` and `phase` (from the worktree's `state.json`: `RED` / `GREEN` / `REFACTOR` / `SETUP`, `review` for `REVIEW`, and for `IDLE` while the spec runs with open tasks, which is what sessions of versions before 0.25.0 leave during review; `''` when unknown), `issueUrl` (the spec's `Source:` when it is a URL), `title`, `session` and `sessionState` (`claude agents --json --all`), the full `decision` and `at` (time of the last report). Works from the main checkout and from a worktree; with nothing to show it returns `{rows: [], paneSeen}` instead of an error. `{pane: true}` writes the heartbeat `<git common dir>/tdd-flow/pane.json`; `paneSeen` says whether it is younger than 60 s. Makes no `gh` call |
| `suite` | tdd-implement | Runs the suite from `stack.md` before each task review and returns `{ran, pass, command, cached, summary}` (with `again` and `running` while the suite still runs), so the workflow does not rely on the implementer's own `suitePass`. Skipped on a red baseline (`allowRedBaseline`). Optional input `phase`: written to `state.json` first, as `phase` does; tdd-implement passes `REVIEW`, so the status pane shows the review, and the task commit sets `IDLE` again |
| `phase` | test-writer, implementer | `{phase: RED\|GREEN\|REFACTOR\|SETUP\|REVIEW\|IDLE}`: writes only the `phase` field of the checkout's `.tdd-flow/state.json`, atomically, and returns `{phase, previous}`. Any other value is an error; a missing `state.json` is not created (`{skipped: "no state.json"}`). tdd-guard blocks only `RED` |
| `answer-decision` | answer-decision, autopilot | `{slug, id: "Q-<n>", answer, where?, name?}`, from the main checkout, after the model edited what the answer changes in the worktree. In order, each step stopping with an error that names it and keeps the ones before (a rerun skips what is done): the run is `blocked` on `id`; the `- Q-<n>` entry and its indented lines move from `## Open questions` to `## Resolved questions` (created when missing) as `- Q-<n> <question> - **Answer:** <answer> (<dd.MM.yyyy>) → <where, default no change>`, and an `implemented` spec goes back to `approved` only when `tasks.md` has an open task; commit `docs(<slug>): answer Q-<n>` of the spec folder in the worktree; `claude rm` of the old session unless it is `working` (a failure goes into `notes`); `claude --bg -n <name> "/tdd-flow:implement-spec <slug> <base>"` in the worktree (name: `name`, else the old session's when free, else the first three words of the slug without its number) and the run recorded as `running` with the new id. Returns `{slug, id, answer, session, name, attach, notes}` |
| `test [-- <command>]` | test-writer, implementer, code-reviewer | Runs the suite from `stack.md` (or the given command) and prints PASS/FAIL, the exit code and only the tail of a failure. A PASS on unchanged files comes from the [test cache](#test-cache). `RUNNING` (exit 3) when the run outlasts one call: the identical command waits for the same run ([Slow or hung test runs](#slow-or-hung-test-runs)) |

### Test cache

`tdd-flow test`, `suite`, the baseline in `plan` and `commit` with `runTests` remember a passing run. The same command in the same directory is not run again while the working tree has the same content, which makes the reviewer's rerun of the suite the implementer just ran and the CLI suite check free. The key is a tree hash of the tracked and untracked (not ignored) files, written through a temporary copy of the index; `.tdd-flow/` is left out because agents write their logs there. Only PASS is cached, and only when the run did not change files itself (lint `--fix`, snapshots). The cache is `<git dir>/tdd-flow-test-cache` (per worktree, last 20 passes).

Not in the key: gitignored inputs (`node_modules`, `.env`, build output) and outside state (a database, the network). `tests need:` in `stack.md` does not turn the cache off: Testcontainers start fresh containers on every run. Set `TDD_FLOW_TEST_CACHE=off` when a pass depends on state that persists between runs (a shared local database). The cache is also off in repos with submodules, because edits inside a submodule do not change the tree hash.

### Slow or hung test runs

A test run of the CLI (`test`, `suite`, the baseline in `plan`, `commit` with `runTests`, the base suite in `autopilot-check`) and the generate command of `sync-base` are watched for hangs, not cut by a wall clock, so a slow suite on a loaded machine finishes however long it takes.

- **A detached job.** A watcher process (`tdd-flow __watch`) starts the command in its own process group, writes its output to a log and its exit code to a job file in `<git dir>/tdd-flow/test-jobs/`. It outlives the CLI call.
- **`again`.** One call waits about 8.5 minutes at most, under the Bash tool's 10-minute limit. If the run still goes on, the command returns `"again": true` with `running`, `elapsedS` and `idleS`; `tdd-flow test` prints `RUNNING` and exits 3. The identical call waits for the same run instead of starting a second one. The workflows repeat these calls (up to 9 times, enough for the cap), and the agents and skills are told to.
- **Same run.** A call joins the running job while the command, the directory and the working tree are the same; files the run itself keeps rewriting (a report) do not count. Any other edit starts a new run and stops the old one. A finished result is returned once; one nobody collects within 10 minutes is dropped. A PASS goes into the [test cache](#test-cache) as before.
- **Hung.** The watcher kills the process group when, for `TDD_FLOW_TEST_IDLE_MS` (default 10 minutes), there is no new output and the group's CPU time (`ps -A -o pgid=,cputime=`) does not grow; when `ps` cannot be read, output alone counts. A run longer than `TDD_FLOW_TEST_HARD_CAP_MS` (default 60 minutes) is killed whatever it prints. Both are milliseconds, positive integers, read from the environment Claude Code runs in; other values give the default. The result is `pass: false`, `timedOut: true` and a summary that names the rule (`no output and no CPU for 10 min`, `exceeded the 60 min cap`) and ends with the output tail.
- **Interrupted.** A run whose watcher is gone without an exit code (a reboot, a killed process) fails as interrupted.
- **Known gaps.** Work done outside the process group (a Gradle daemon, a Docker container) does not count as CPU, and a kill does not reach it. A deadlocked process that still uses a little CPU (JVM garbage collection or timer threads) is only stopped by the cap. Suites of several worktrees are not serialised.

**Fallbacks.** Where the input is outside what the code handles, the step reports `fallback` and the workflow runs the agent that did it before: a `spec.md`/`tasks.md` the parser does not recognise or a missing `stack.md` (planning agent), a tracker other than GitHub (release-engineer for preflight, CI watch, rerun and close-out; fetch agent for Azure DevOps and Jira issues), no `stack.md` yet (stack-detector). A failed CI check still gets an agent, which reads the log tail and classifies the root cause.

Self-check: `node --test plugins/tdd-flow/tests/` from the repo root; the status pane's tests: `claude plugin test plugins/tdd-flow`.

## Autopilot

`/tdd-flow:autopilot` implements every approved spec without you watching, several at once. Run it in the main checkout.

0. `tdd-flow cleanup` removes the worktrees (~1 GB each with `node_modules` and build output) of specs whose PR is merged; see the CLI table for what it keeps.
1. `tdd-flow specs` selects the specs (see the CLI table) and shows why the others are skipped. `tdd-flow autopilot-check` then checks, once and before any worktree exists:
   - `gh` is logged in;
   - Docker is running, if the tests need it;
   - background sessions have the permission rules they need, or run in `auto` mode;
   - the local base branch is not behind `origin` (the worktrees branch from it). The autopilot never pulls; it shows the command. Specs started later in a long run can still fall behind, and `sync-base` catches that before the push;
   - with 2 or more specs, the base suite passes in a clean main checkout on the base branch.

   A failed check stops the autopilot; warnings do not. The check also sets N.
2. For each spec, at most N at a time (`--parallel N`, default 3, or 1 when `tests need:` is set): `tdd-flow worktree` creates `.claude/worktrees/<slug>` on `feature/<slug>`, and `claude --bg -n <name> "/tdd-flow:implement-spec <slug> <base>"` starts a background session there. `<name>` is a 3-word kebab-case summary of the spec (e.g. `invitation-password-reset`), so you watch it with `claude attach invitation-password-reset`.
3. `implement-spec`, in that session: installs JavaScript dependencies the fresh worktree lacks (frozen install per tracked lockfile: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`/`--frozen-lockfile`, `bun install --frozen-lockfile`) → one `tdd-implement {maxTasks: 1}` run per task, in `tasks.md` order (a task that hits `agent_limit` gets one more run) → simplification of the whole PR (see [Simplification](#simplification)) → `superpowers:requesting-code-review` over the branch (falls back to the `code-reviewer` agent without superpowers) → Critical and Important findings go through one `tdd-implement {findings}` run, with no second review → `tdd-flow sync-base` merges the base (a conflict blocks the spec) → `git push` (push-gate runs the checks) → `gh pr create` with goal, ACs, tasks, review findings (Minor ones listed) and unverified checks. It ends with `tdd-flow run-report`.
4. `tdd-flow runs-wait`, in a background Bash call, waits for results and for ticked tasks (only for results while the [status pane](#status-pane) is open: then the table is printed only at the start and the end). After each return the autopilot prints the `tdd-flow board` table (status, `3/7 · T-4 ...`, PR or reason), starts the next queued spec, and ends with the same table: PR URL, or why a spec is blocked or stalled, and `claude attach <name>` for those.

**Requirements**

- `.tdd-flow/` is committed: the worktree gets the spec from git, and the status is committed with the code. `specs` stops if `.tdd-flow/` is git-ignored or `.tdd-flow/state.json` is tracked (every PR would change it). A spec must be committed on the base branch without local changes in `spec.md`/`tasks.md` (or, from `simplify-codebase --implement`, committed only on its `feature/<slug>` and named in the slugs).
- The repo folder is trusted in Claude Code (worktrees under `.claude/worktrees/` inherit it), and `gh` is logged in.
- Background sessions pause at permission prompts until you attach. In `auto` mode (the default since Claude Code 2.1.283, or `defaultMode` in `~/.claude/settings.json`) they need no rules. Otherwise allow `Workflow`, `Bash(tdd-flow *)`, `Bash(git *)`, `Bash(gh pr *)`, `Bash(gh issue view *)`, `Edit` and `Write`, plus the frozen install of each tracked lockfile (`Bash(npm ci)`, `Bash(pnpm install *)`, `Bash(yarn install *)`, `Bash(bun install *)`). Put them in `~/.claude/settings.json` or the main checkout's `.claude/settings.local.json`, which worktree sessions use too. Test and build commands run inside `tdd-flow test`. `autopilot-check` lists the missing rules.

**Things to know**

- A run that ends `blocked` keeps its worktree. Fix the cause there and run `/tdd-flow:autopilot <slug>`: it resumes from `tasks.md`. Without the slug, blocked specs are skipped.
- `stalled` means the session went idle without a report, for example because it asked a question. Answer it with `claude attach <name>`.
- **Decisions.** When a spec needs a choice only you can make (the spec contradicts itself or the code, an AC allows two behaviours), its session first runs `tdd-flow decisions`. If an earlier spec already decided the same subject and behaviour, it answers the question from that decision (`## Resolved questions`, "as decided in <slug> Q-<m>"), updates the criteria and tasks, commits `docs(<slug>): answer Q-<n> from <other-slug> Q-<m>`, runs the blocked task again and lists the reuse under **Decisions reused** in the PR body. It stops only when no decision fits, when two fit and disagree, or when a reused decision blocks the same task again. Then it does three things: it adds the question to `## Open questions` in the worktree's `spec.md` with its recommendation and commits it; it sets the unfinished work aside as a patch; it stops with `blocked` and a `decision`. Technical failures stay plain `blocked`. The board shows `decision Q-<n>: ...`. The autopilot asks the decisions in chat one at a time while the other specs keep running, each with the closest earlier answer next to the recommendation. It edits what your answer changes in the spec, and `tdd-flow answer-decision` does the bookkeeping in one step: the resolved-question entry, the commit, removing the old session and starting the spec again from its first open task (the status pane's **answer** button runs the same command through the `answer-decision` skill). A decision raised after every task was ticked (in the simplify or review step) gets a new task for the answer, and the spec goes back to `approved`. A decision left unanswered is in the summary. To answer it later, run `/tdd-flow:resolve-questions <slug>` in the worktree, set `Status: approved` again, commit there, and run `/tdd-flow:autopilot <slug>`.
- N sessions use the rolling rate-limit window N times faster. Tests running at the same time can collide on ports, a shared local database or docker compose. With `tests need:` in `stack.md`, the autopilot runs one spec at a time unless you pass `--parallel N`. PRs of parallel specs can conflict; that is resolved at merge.
- Worktrees stay until the PR is merged, so fixes after PR review can go into the same branch. The next autopilot start removes them (step 0).

## Status pane

A Claude Code mod in this plugin (`hooks/register.tsx`) shows every spec of the repo beside the chat, so the chat does not have to reprint the board table. Verified with Claude Code 2.1.322 (the mods API is early access; older builds ignore the `modules` entry and keep the classic hooks).

- **What it shows**, one block per spec, sorted decision, blocked, stalled, running, queued, done:
  ```
  ● 82-ux-fixes-68f-focus                 running
    5/10 · T-6 Settings: inline category…
    GREEN · #82 · PR · claude attach form-error-focus   [ copy ]
  ```
  Status colour and word; ticked/total tasks and the open task; TDD phase; issue and PR as links; the `claude attach` command with a button that copies it. A `blocked` or `stalled` spec shows the first line of its reason. Above the specs, **This session** lists the workflows this session started that still run (name, feature, minutes running).
- **Where it comes from:** `tdd-flow status`, every 10 s, from the main checkout's root, only in a git repo with `.tdd-flow/`. A failed call is one dim line in the pane. The pane never edits a spec and never talks to a blocked session.
- **Opening:** `/tdd-status` opens it at any width. It opens by itself when a spec is `running`, `blocked` or `stalled`, but only where it docks as a sidebar (the fullscreen layout, 110 columns or more). A pane you closed stays closed until `/tdd-status`. While it is closed and something runs, the status line says `tdd-flow: 3 running, 1 waiting`. Background sessions (the autopilot's) and `-p` runs start no pane and no timer.
- **Answering a decision:** a spec waiting for a decision shows the question, the tasks it blocks and the recommendation, one button per option (hotkeys 1-9 on the first decision), **use recommendation**, and a field for your own answer (not on mobile). The answer runs `/tdd-flow:answer-decision <slug> Q-<n> <answer>` in the current session. Where that command is not available, it goes in as your prompt asking for the skill. The spec shows "answer sent" until it runs again.
- **Autopilot:** while the pane is open, `board` and `runs-wait` say `paneOpen`. The autopilot then prints the table only at the start and at the end, waits with `runs-wait {ticks: false}`, and writes one line per finished or blocked spec.

## Simplification

The `simplifier` agent looks for code that does not need to exist. Each finding gets one tag:
- `duplicate`
- `dead-code`
- `single-use-abstraction`
- `reinvented`: the stdlib, the platform or an installed dependency already does it
- `speculative`: options or parameters no caller uses
- `pass-through`

It proves each claim from the code with `git grep` over tracked files, never `.claude/worktrees/`. It proposes only behaviour-preserving changes and rates the risk. A finding on a public contract, or on names used through strings, reflection or DI, is `high`: it is listed for you, never applied. A sceptic (the code-reviewer on Opus) then tries to refute every finding; only findings that survive go on.

**Per PR** (implement-spec step 2, every autopilot spec):
- The workflow `simplify {mode: "diff"}` checks the branch diff.
- Each of the at most 8 confirmed proposals runs as its own `tdd-implement {refactors: [one]}`, so one failure does not stop the others. A failed one is set aside with `tdd-flow set-aside` (a patch, not a stash) and listed in the PR body.
- The superpowers review then covers the simplification commits too.
- Specs from simplify-codebase skip this step.

**Across the codebase:** `/tdd-flow:simplify-codebase [path ...]`.
- It scans area by area (at most 12 per run) and drops findings whose files belong to another area's finding, so the PRs do not conflict.
- It writes draft specs (`simplify-<area>`, `Source: tdd-flow simplify-codebase`, at most 8 `[refactor]` tasks each) and stops so you can review them.
- `--implement [slug ...]` approves them with `tdd-flow spec-branch`: each gets its own branch and worktree, and nothing is committed to the base. It then starts the autopilot with those slugs. Each spec ends as a `refactor(<slug>): ...` PR.
- A repo without a test command is refused: refactor tasks are checked by the suite.

## push-gate

The plugin is enabled at user scope, so this hook runs in **every** repo, not only during tdd-flow workflows. It gates only commands Claude runs; your own `git push` from a terminal is not checked.

**Trigger.** A Bash call containing an unquoted `git push` or `gh pr create`. `--dry-run` / `--delete` pushes are let through. A plain `--force` / `-f` push is let through without checks, because the global git guard denies it anyway. The target repo comes from `git -C <dir>` or an earlier `cd <dir>` in the same command; `bash -c "..."` and `eval` are not parsed.

**Checks, in the target repo root:**

| Repo has | Runs |
|---|---|
| `package.json` | `typecheck` / `type-check` / `check-types` / `tsc` script, else `tsc --noEmit` if `tsconfig.json`; `lint` script; `test` script (npm, pnpm or yarn from the lockfile) |
| `mvnw` / `pom.xml` | `./mvnw -q -B test` |
| `gradlew` / `build.gradle(.kts)` | `./gradlew test --quiet` |
| pytest config or `tests/` | `uv run pytest -q` (with `uv.lock`), `.venv/bin/python -m pytest -q`, or `python3 -m pytest -q` |
| `go.mod` / `Cargo.toml` / `*.sln` | `go test ./...` / `cargo test --quiet` / `dotnet test` |

With a `.tdd-flow/stack.md`, its `type check command` runs first (unless `test command (all)` already contains it) and its `test command (all)` replaces the detected test command; both run from the repo root, so a monorepo profile with `(cd apps/web && npm test) && (cd apps/backend && ./mvnw verify)` needs no gate of its own. Its lint command is not used, because it may be a formatter that rewrites files. Checks run with `CI=true`, so Vitest and Jest run once instead of watching.

**Secret scan.** `gitleaks git --log-opts="HEAD --not --remotes"`: only commits that are on no remote yet. Leaks block. False positives go into `.gitleaksignore`. Without gitleaks installed (`brew install gitleaks`), or if gitleaks cannot scan, the hook shows a warning and lets the push through.

**Skips the tests (not the secret scan) when:** the repo has its own `.claude/hooks/pre-push-check.*` gate; a git `pre-push` hook exists (husky, `core.hooksPath`) and the command is a `git push`; every changed file vs the default branch is docs or images; or the same check commands already passed for this `HEAD` (cached in `.git/tdd-flow-push-gate`, so `git push` + `gh pr create` runs the suite once; a changed command in `stack.md` runs again). A run in which a check was skipped is not cached.

**Blocks when:** a check fails; tracked files are uncommitted (`.tdd-flow/` excepted), because the checks run on the working tree; a check modified tracked files (e.g. `lint --fix`); dependencies are missing (`node_modules`, for checks detected without a profile); a command from `stack.md` exits 127 (not found: dependencies not installed, or the tool is missing on the hook's PATH, which is Claude Code's environment and not your login shell); or the 540 s budget runs out (the hook's 600 s timeout would let the push through, so the budget stays under it; a slow suite runs once per commit thanks to the cache). An auto-detected check whose tool is not installed (exit 127, or no pytest module) gives a warning instead, and the next push runs the checks again; pytest exit 5 (no tests collected) passes.

**Turn it off** for a session: start Claude Code with `TDD_FLOW_PUSH_GATE=off` in its environment. Setting it inside the Bash command has no effect.

**Known gaps:** without a stack profile only the repo root is detected (monorepo sub-packages get no checks); no type check or lint for Python and Go.

**CI side.** In GitHub repos with no secret scan in `.github/workflows`, `/tdd-flow:deploy` adds `.github/workflows/secret-scan.yml` as a separate `ci: add gitleaks secret scan` commit in the PR. It scans only the PR's commits, with the gitleaks Docker image, so organisation repos need no `GITLEAKS_LICENSE`. If the `gh` token lacks the `workflow` scope (`gh auth refresh -s workflow`), deploy skips it and lists it under risks in the PR body. The result reports `secretScan`.

## Agents and model policy

Workflows set the model on each call, so each step uses the cheapest model that does it well:

| Step | Model |
|---|---|
| Analyst drafts (x3), spec critics, per-task review, doc writing + fact-check, deploy sceptics | **Sonnet** (worker) |
| Test-writer (RED, CHARACTERIZE), implementer (GREEN + REFACTOR / fixes) | **Sonnet**, auto-escalated to **Opus** if the step fails twice |
| Simplifier scan | **Sonnet** (worker); the sceptic that refutes its findings is **Opus** |
| Spec synthesis + revision, final pre-merge review (3 lenses) | **Opus** (strong) |
| CLI steps through `script-runner` (spec parsing, branch, commits, preflight, CI polling, close-out), stack detection, fetching non-GitHub issues | **Haiku** (light) |
| Classifying a failed CI check from its log | **Sonnet** (worker), low effort |

**Escalation ladder** for every coding step: Sonnet, then Sonnet again with the failure output, then Opus with the failure output. Only if all three fail does the workflow stop with `status: "blocked"`.

**Wrong tests:** if the implementer finds that a test itself is wrong (a broken helper, a wrong field), it reports `testDefects` instead of bending production code. The ladder stops, and the test-writer fixes the test or keeps it (once per batch, logged in `tdd-log.md`). A test it keeps goes to an arbiter (the code-reviewer on Opus, read-only), with the behaviour text as the authority. If the arbiter finds the test wrong, the test-writer fixes it on Opus as described; if it confirms the test, the implementer is told so. GREEN then runs again, and the task review checks that the changed tests were not weakened.

**Relay check:** the script-runner retypes the CLI's JSON and can drop array items. Every CLI output carries `shape` (the size of each array in the result). The workflow recomputes it from what it received, over the paths of the step's schema (`plan` also checks `taskCount` and `openIds`). On a mismatch, or when the relayed output has no `result` at all, Sonnet relays the saved output again (`tdd-flow replay`; the command does not run twice). If it is still wrong, `cli()` returns `relayFailed: true`: the command may have run, so this is not a CLI error. A task commit whose relay failed runs once more: a rerun after a commit that went through stages nothing and reports that commit (`already`, with its `sha`), so it never commits twice. If it still fails, the task is blocked, but `block` keeps its tick when HEAD already is the task commit. The saved outputs are in `<git dir>/tdd-flow/relay/`, per worktree. `tdd-implement` reports `escalationsToStrongModel`, so you can see how often Opus was needed.

Override per run with `args.models`, e.g. `{feature: "x", models: {worker: "opus"}}` for a hard feature, or `{models: {strong: "sonnet"}}` for the cheapest run.

| Agent | Default model | Role |
|---|---|---|
| stack-detector | haiku | Language, test/build/lint commands, CI, tracker |
| requirements-analyst | sonnet (opus for synthesis) | Drafts and synthesizes specs |
| test-writer | sonnet | RED: one failing test per behaviour, never production code; CHARACTERIZE: tests that pin today's behaviour before a refactor |
| implementer | sonnet | GREEN minimal code, one test at a time, + REFACTOR; SETUP for setup tasks; the change of a refactor task |
| simplifier | sonnet | Read-only: finds duplicates, dead code, single-use abstractions, reinvented helpers, speculative options and pass-through layers, with behaviour-preserving proposals |
| code-reviewer | sonnet (opus for final review) | Read-only review and fact-checking |
| doc-writer | sonnet | Docs from the actual diff |
| release-engineer | sonnet | Push + PR, CI fix commits, merge/release (only with approval); preflight and CI watch for non-GitHub trackers |
| script-runner | haiku | Runs one `tdd-flow` CLI command and returns its JSON |

## Files it creates in your repo

```
.tdd-flow/
  stack.md                  detected stack profile
  state.json                {feature, phase: IDLE|RED|GREEN|REFACTOR|SETUP|REVIEW, task}
  features/<slug>/
    spec.md  tasks.md  tdd-log.md  review.md
```

Add `.tdd-flow/` to `.gitignore`, or commit it if you want specs versioned. The autopilot needs it committed, with only `.tdd-flow/state.json` ignored. Autopilot run results and set-aside patches go to `.git/tdd-flow/runs/` (the shared git dir), not into the working tree, and so does the status pane's heartbeat (`.git/tdd-flow/pane.json`).

## Setup

- Claude Code with dynamic workflows enabled (on Pro, turn on "Dynamic workflows" in `/config`).
- Tracker CLIs, authenticated as needed: `gh auth login`; for Azure DevOps, `az login` + `az extension add --name azure-devops` + `az devops configure --defaults organization=<url> project=<name>`; for Jira, a Jira MCP server or the `jira` CLI.
- A CI pipeline in the repo, for `deploy`.
- To avoid permission prompts on long runs, allow the tools the agents need (Bash for your test command, git, gh/az, Edit/Write, and `Bash(tdd-flow *)` for the CLI) in your Claude Code permission settings. When the workflow prompt appears, choose "Yes, and don't ask again" for each tdd-flow workflow.

## Cost control

- **Agent limits.** Every workflow runs at most 2 agents at the same time (simplify 3) and has a hard cap on agents per run: analyze-requirements 15, document 15, deploy 20, tdd-implement 40, simplify 6 in diff mode and 3 per area + 6 in codebase mode. Override per run with `args.maxAgents` / `args.maxParallel` (positive integers). At the cap a workflow stops with `status: "agent_limit"`. tdd-implement only starts a task whose minimum cost fits, so it normally stops between tasks; rerun it to continue from `tasks.md`. deploy stops before the skeptic pass if verifying all findings would not fit.
- **Code before agents.** Steps that need no judgement run in the tdd-flow CLI through the Haiku `script-runner`, which runs one command and returns its JSON, instead of a Sonnet agent reasoning through git and file edits. CI polling no longer keeps an agent busy for up to 30 minutes, and agents run tests through `tdd-flow test`, so a passing suite costs 3 lines of context and a failure 60 at most. A runner still counts as one agent toward the limits.
- Watch runs with `/workflows`; each agent's token use is shown there, and you can pause (`p`) or stop (`x`).
- Use `tdd-implement` with `{maxTasks: 1}` for small, reviewable increments.
- **Tests first, per task.** For each task, the test-writer writes every failing test before the implementer touches production code (tdd-guard blocks production edits during RED). Each agent start costs about 17k tokens of context, so the tests are written in batches, not one agent per behaviour. `{batchSize: n}` sets how many behaviours share one RED/GREEN pair (default 5); `batchSize: 1` gives one cycle per behaviour, at about 2 extra agents per behaviour.
- For the cheapest runs pass `models: {strong: "sonnet"}`; for hard features `models: {worker: "opus"}`.
- Runs can be resumed in the same session after a pause or stop. Completed agents are replayed from cache.
