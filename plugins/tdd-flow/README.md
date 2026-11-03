# tdd-flow

Personal Claude Code plugin: an end-to-end dev pipeline built on **dynamic workflows** (scripted multi-agent orchestration) and specialist subagents. It works with any stack (it detects the language and test commands per repo) and delivers through your existing CI/CD.

## How it is built

- **Workflows** (`workflows/*.js`): the orchestration. Loops, retries, fan-out and verification are code, so every run follows the same process.
- **Agents** (`agents/*.md`): the specialists the workflows call (`agentType: "tdd-flow:<agent>"`). They also carry the domain knowledge: spec template, TDD rules, doc templates.
- **CLI** `bin/tdd-flow`: the deterministic steps (parsing the spec, git bookkeeping, commits, GitHub preflight, CI polling) as plain Node code. Workflow scripts cannot run commands, so they call it through the `script-runner` agent (Haiku, Bash only, a few lines of prompt) instead of a reasoning agent. See [tdd-flow CLI](#tdd-flow-cli).
- **Skill** `ship-feature`: chains the workflows and holds the human approval gates. Workflows can't ask questions mid-run, so the gates sit between runs.
- **Skills** `autopilot` + `implement-spec`: implement every approved spec in parallel, one background session per spec in its own worktree, each ending with a code review and a PR. See [Autopilot](#autopilot).
- **Hook** `tdd-guard`: blocks production-code edits while a cycle is in RED.
- **Hook** `push-gate`: before Claude runs `git push` or `gh pr create` in any repo, runs the type check, lint and tests and a gitleaks secret scan; a failure blocks the command. See [push-gate](#push-gate).

## Workflows

| Command | Shape | Agents (typical) |
|---|---|---|
| `/tdd-flow:analyze-requirements <issue \| file \| text>` | Context (stack + fetch, parallel) → 3 analysts from different angles (behaviour / risk / minimal scope) → synthesize spec.md + tasks.md → testability & completeness critics → revise | ~8-9 |
| `/tdd-flow:tdd-implement {feature}` | Plan + baseline → per task, sequentially: RED (test-writer writes all of the task's failing tests) → GREEN (implementer makes them pass one at a time, then refactors) → review with up to 2 fix rounds (behavioural findings go through RED → GREEN again) → commit (also ticks the task). `[setup]` tasks: SETUP + verify commands → review → commit | ~4 per task (2 more per 5 extra behaviours); ~3 per setup task |
| `/tdd-flow:document {feature}` | Survey diff → pipeline per target: write → adversarial fact-check → fix → commit | ~6-14 |
| `/tdd-flow:deploy {feature}` | Preflight → 3 review lenses (spec, security, quality) → dedupe → 2 skeptics per finding → PR → CI watch with test-first fix loop (max 2) → stops at `ready_to_merge` | ~8-12 |
| `/tdd-flow:deploy {feature, mode:"merge", approved:true}` | PR review status check → merge (+ optional release) → watch post-merge pipeline → close out | ~3 |
| `/tdd-flow:ship-feature <input>` (skill) | Runs everything above with Gate 1 (spec approval) and Gate 2 (merge approval) | - |
| `/tdd-flow:autopilot [slug ...] [--parallel N]` (skill) | Per approved spec, up to N at once: worktree → background session running `implement-spec` (one tdd-implement run per task → superpowers code review → one fix round → push + PR) → summary of PRs | per spec as tdd-implement, plus review and fix round |

### Spec status

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

**Bootstrapping a new project.** The repo does not need a test suite yet. The baseline counts as passing. A setup task can install the test framework and update `.tdd-flow/stack.md`, and the tdd tasks after it use the new test commands. A tdd task with no test command stops with `blocked`.

Merge mode stops with `review_changes_requested` when a reviewer requested changes on the PR. Pass `requireReview: true` to also require an approving review (`review_required` otherwise). This is off by default because GitHub does not let you approve your own PR.

The feature branch (`feature/<slug>`), task and docs commits run in the tdd-flow CLI. Pushing, the PR, CI fix commits and merge/release go through the `release-engineer` agent, so pushes still pass the push-gate hook.

Each workflow returns `{status, ..., next}`. If a coding step still fails after escalating to Opus, it stops cleanly with `status: "blocked"` and resets the TDD phase, rather than guessing.

## tdd-flow CLI

`bin/tdd-flow` does the steps that need no judgement. Claude Code adds the plugin's `bin/` to the Bash `PATH`, so agents call it as `tdd-flow`. Workflows pass JSON on stdin; it prints `{"ok": true, "result": {...}}` or `{"ok": false, "error": "...", "fallback": true?}`.

| Command | Used by | Does |
|---|---|---|
| `context` | analyze-requirements | Reads an existing `.tdd-flow/stack.md`; fetches a GitHub issue (`gh issue view`) or reads a spec file. Text input needs no fetch. |
| `plan` | tdd-implement | Parses `spec.md` and `tasks.md` (tasks, behaviours, verify commands, approval) and runs the baseline suite. Criteria text only for the tasks the run reaches (`maxTasks`, `fromTask`); returns `taskCount` and `openIds`, which the workflow checks against the relayed plan |
| `branch` | tdd-implement | Switches to or creates `feature/<slug>` |
| `commit` | tdd-implement, document | Optionally sets the spec status (`specStatus`), ticks the task line (`T-1` never matches `T-10`), writes `state.json`, stages only the listed files, refuses secret-looking content, secret files and files over 5 MB (plus gitleaks on the staged changes when installed), commits. Never pushes. |
| `block` | tdd-implement | Records a stop: `state.json` phase `IDLE`, an entry in `tdd-log.md`, optional untick |
| `preflight` | deploy | Base and current branch, open tasks, CI, `gh` auth and `workflow` scope, secret scan, open PR and its review status |
| `ci-watch` | deploy | Polls `gh pr checks` (or `gh run list --commit` after merge) for up to 30 minutes; on failure returns the failed-step log tail. Each call stops after about 8.5 minutes with `"again": true` and the runner repeats it. |
| `ci-rerun`, `add-secret-scan`, `close-out` | deploy | Rerun failed jobs; add the gitleaks workflow; mark the spec done and reset `state.json` |
| `specs` | autopilot | Checks that `.tdd-flow/` is in git and `state.json` is not; lists the specs to start, with their title (status `approved` on `feature/<slug>` or, without that branch, on the base; committed, no local changes, no session running, not blocked last time unless named) and why the others are skipped |
| `worktree` | autopilot | Creates or reuses `.claude/worktrees/<slug>` on `feature/<slug>`; adds `/.claude/worktrees/` and `/.tdd-flow/state.json` to `.git/info/exclude` |
| `replay` | every workflow | Prints the saved output of an earlier call again (see the relay check below), without running the command a second time |
| `run-report` | autopilot, implement-spec | Writes a run result (`running` / `done` / `blocked`, session id, PR URL, details) to `<git common dir>/tdd-flow/runs/<slug>.json`, shared by all worktrees and never committed |
| `runs-wait` | autopilot | Blocks until one of the given runs is `done` or `blocked`, or its session is idle or gone without a report (`stalled`); reads `claude agents --json --all` |
| `test [-- <command>]` | test-writer, implementer, code-reviewer | Runs the suite from `stack.md` (or the given command) and prints PASS/FAIL, the exit code and only the tail of a failure |

**Fallbacks.** Where the input is outside what the code handles, the step reports `fallback` and the workflow runs the agent that did it before: a `spec.md`/`tasks.md` the parser does not recognise or a missing `stack.md` (planning agent), a tracker other than GitHub (release-engineer for preflight, CI watch, rerun and close-out; fetch agent for Azure DevOps and Jira issues), no `stack.md` yet (stack-detector). A failed CI check still gets an agent, which reads the log tail and classifies the root cause.

Self-check: `node --test plugins/tdd-flow/tests/` from the repo root.

## Autopilot

`/tdd-flow:autopilot` implements every approved spec without you watching, several at once. Run it in the main checkout.

1. `tdd-flow specs` selects the specs (see the CLI table) and shows why the others are skipped.
2. For each spec, at most N at a time (`--parallel N`, default 3): `tdd-flow worktree` creates `.claude/worktrees/<slug>` on `feature/<slug>`, and `claude --bg -n <name> "/tdd-flow:implement-spec <slug> <base>"` starts a background session there. `<name>` is a 3-word kebab-case summary of the spec (e.g. `invitation-password-reset`), so you watch it with `claude attach invitation-password-reset`.
3. `implement-spec`, in that session: installs JavaScript dependencies the fresh worktree lacks (frozen install per tracked lockfile: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`/`--frozen-lockfile`, `bun install --frozen-lockfile`) → one `tdd-implement {maxTasks: 1}` run per task, in `tasks.md` order (a task that hits `agent_limit` gets one more run) → `superpowers:requesting-code-review` over the branch (falls back to the `code-reviewer` agent without superpowers) → Critical and Important findings go through one `tdd-implement {findings}` run, with no second review → `git push` (push-gate runs the checks) → `gh pr create` with goal, ACs, tasks, review findings (Minor ones listed) and unverified checks. It ends with `tdd-flow run-report`.
4. `tdd-flow runs-wait`, in a background Bash call, waits for results. The autopilot then starts the next queued spec and finally prints a table: PR URL, or why a spec is blocked or stalled, and `claude attach <name>` for those.

**Requirements**

- `.tdd-flow/` is committed: the worktree gets the spec from git, and the status is committed with the code. `specs` stops if `.tdd-flow/` is git-ignored or `.tdd-flow/state.json` is tracked (every PR would change it). A spec must be committed on the base branch without local changes in `spec.md`/`tasks.md`.
- The repo folder is trusted in Claude Code (worktrees under `.claude/worktrees/` inherit it), and `gh` is logged in.
- Background sessions pause at permission prompts until you attach. Allow what they need (the Workflow tool for the tdd-flow workflows, `Bash(tdd-flow:*)`, your test commands, `Bash(git:*)`, `Bash(gh pr:*)`, Edit, Write) or use auto mode.

**Things to know**

- A run that ends `blocked` keeps its worktree. Fix the cause there and run `/tdd-flow:autopilot <slug>`: it resumes from `tasks.md`. Without the slug, blocked specs are skipped.
- `stalled` means the session went idle without a report, for example because it asked a question. Answer it with `claude attach <name>`.
- N sessions use the rolling rate-limit window N times faster. Tests running at the same time can collide on ports, a shared local database or docker compose; use `--parallel 1` for such repos. PRs of parallel specs can conflict; that is resolved at merge.
- Worktrees stay until you remove them (`claude rm <id>` or `git worktree remove .claude/worktrees/<slug>`), so fixes after PR review can go into the same branch.

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

`test command (all)` in `.tdd-flow/stack.md` replaces the detected test command. Its lint command is not used, because it may be a formatter that rewrites files. Checks run with `CI=true`, so Vitest and Jest run once instead of watching.

**Secret scan.** `gitleaks git --log-opts="HEAD --not --remotes"`: only commits that are on no remote yet. Leaks block. False positives go into `.gitleaksignore`. Without gitleaks installed (`brew install gitleaks`), or if gitleaks cannot scan, the hook shows a warning and lets the push through.

**Skips the tests (not the secret scan) when:** the repo has its own `.claude/hooks/pre-push-check.*` gate; a git `pre-push` hook exists (husky, `core.hooksPath`) and the command is a `git push`; every changed file vs the default branch is docs or images; or the checks already passed for this `HEAD` (cached in `.git/tdd-flow-push-gate`, so `git push` + `gh pr create` runs the suite once).

**Blocks when:** a check fails; tracked files are uncommitted (`.tdd-flow/` excepted), because the checks run on the working tree; a check modified tracked files (e.g. `lint --fix`); dependencies are missing (`node_modules`); or the 280 s budget runs out. A check whose tool is not installed (exit 127, or no pytest module) gives a warning instead; pytest exit 5 (no tests collected) passes.

**Turn it off** for a session: start Claude Code with `TDD_FLOW_PUSH_GATE=off` in its environment. Setting it inside the Bash command has no effect.

**Known gaps:** only the repo root is detected, so monorepo sub-packages need their own `.claude/hooks/pre-push-check.*` (as in symple-crm); no type check or lint for Python and Go.

**CI side.** In GitHub repos with no secret scan in `.github/workflows`, `/tdd-flow:deploy` adds `.github/workflows/secret-scan.yml` as a separate `ci: add gitleaks secret scan` commit in the PR. It scans only the PR's commits, with the gitleaks Docker image, so organisation repos need no `GITLEAKS_LICENSE`. If the `gh` token lacks the `workflow` scope (`gh auth refresh -s workflow`), deploy skips it and lists it under risks in the PR body. The result reports `secretScan`.

## Agents and model policy

Workflows set the model on each call, so each step uses the cheapest model that does it well:

| Step | Model |
|---|---|
| Analyst drafts (x3), spec critics, per-task review, doc writing + fact-check, deploy sceptics | **Sonnet** (worker) |
| Test-writer (RED), implementer (GREEN + REFACTOR / fixes) | **Sonnet**, auto-escalated to **Opus** if the step fails twice |
| Spec synthesis + revision, final pre-merge review (3 lenses) | **Opus** (strong) |
| CLI steps through `script-runner` (spec parsing, branch, commits, preflight, CI polling, close-out), stack detection, fetching non-GitHub issues | **Haiku** (light) |
| Classifying a failed CI check from its log | **Sonnet** (worker), low effort |

**Escalation ladder** for every coding step: Sonnet, then Sonnet again with the failure output, then Opus with the failure output. Only if all three fail does the workflow stop with `status: "blocked"`.

**Wrong tests:** if the implementer finds that a test itself is wrong (a broken helper, a wrong field), it reports `testDefects` instead of bending production code. The ladder stops, and the test-writer fixes the test or keeps it (once per batch, logged in `tdd-log.md`). A test it keeps goes to an arbiter (the code-reviewer on Opus, read-only), with the behaviour text as the authority. If the arbiter finds the test wrong, the test-writer fixes it on Opus as described; if it confirms the test, the implementer is told so. GREEN then runs again, and the task review checks that the changed tests were not weakened.

**Relay check:** the script-runner retypes the CLI's JSON and can drop array items. Every CLI output carries `shape` (the size of each array in the result). The workflow recomputes it from what it received, over the paths of the step's schema (`plan` also checks `taskCount` and `openIds`). On a mismatch, Sonnet relays the saved output again (`tdd-flow replay`; the command does not run twice); if it is still wrong, the step fails. The saved outputs are in `<git dir>/tdd-flow/relay/`, per worktree. `tdd-implement` reports `escalationsToStrongModel`, so you can see how often Opus was needed.

Override per run with `args.models`, e.g. `{feature: "x", models: {worker: "opus"}}` for a hard feature, or `{models: {strong: "sonnet"}}` for the cheapest run.

| Agent | Default model | Role |
|---|---|---|
| stack-detector | haiku | Language, test/build/lint commands, CI, tracker |
| requirements-analyst | sonnet (opus for synthesis) | Drafts and synthesizes specs |
| test-writer | sonnet | RED: one failing test per behaviour, never production code |
| implementer | sonnet | GREEN minimal code, one test at a time, + REFACTOR; SETUP for setup tasks |
| code-reviewer | sonnet (opus for final review) | Read-only review and fact-checking |
| doc-writer | sonnet | Docs from the actual diff |
| release-engineer | sonnet | Push + PR, CI fix commits, merge/release (only with approval); preflight and CI watch for non-GitHub trackers |
| script-runner | haiku | Runs one `tdd-flow` CLI command and returns its JSON |

## Files it creates in your repo

```
.tdd-flow/
  stack.md                  detected stack profile
  state.json                {feature, phase: IDLE|RED|GREEN|REFACTOR|SETUP, task}
  features/<slug>/
    spec.md  tasks.md  tdd-log.md  review.md
```

Add `.tdd-flow/` to `.gitignore`, or commit it if you want specs versioned. The autopilot needs it committed, with only `.tdd-flow/state.json` ignored. Autopilot run results go to `.git/tdd-flow/runs/` (the shared git dir), not into the working tree.

## Setup

- Claude Code with dynamic workflows enabled (on Pro, turn on "Dynamic workflows" in `/config`).
- Tracker CLIs, authenticated as needed: `gh auth login`; for Azure DevOps, `az login` + `az extension add --name azure-devops` + `az devops configure --defaults organization=<url> project=<name>`; for Jira, a Jira MCP server or the `jira` CLI.
- A CI pipeline in the repo, for `deploy`.
- To avoid permission prompts on long runs, allow the tools the agents need (Bash for your test command, git, gh/az, Edit/Write, and `Bash(tdd-flow:*)` for the CLI) in your Claude Code permission settings. When the workflow prompt appears, choose "Yes, and don't ask again" for each tdd-flow workflow.

## Cost control

- **Agent limits.** Every workflow runs at most 2 agents at the same time and has a hard cap on agents per run: analyze-requirements 12, document 15, deploy 20, tdd-implement 40. Override per run with `args.maxAgents` / `args.maxParallel` (positive integers). At the cap a workflow stops with `status: "agent_limit"`. tdd-implement only starts a task whose minimum cost fits, so it normally stops between tasks; rerun it to continue from `tasks.md`. deploy stops before the skeptic pass if verifying all findings would not fit.
- **Code before agents.** Steps that need no judgement run in the tdd-flow CLI through the Haiku `script-runner`, which runs one command and returns its JSON, instead of a Sonnet agent reasoning through git and file edits. CI polling no longer keeps an agent busy for up to 30 minutes, and agents run tests through `tdd-flow test`, so a passing suite costs 3 lines of context and a failure 60 at most. A runner still counts as one agent toward the limits.
- Watch runs with `/workflows`; each agent's token use is shown there, and you can pause (`p`) or stop (`x`).
- Use `tdd-implement` with `{maxTasks: 1}` for small, reviewable increments.
- **Tests first, per task.** For each task, the test-writer writes every failing test before the implementer touches production code (tdd-guard blocks production edits during RED). Each agent start costs about 17k tokens of context, so the tests are written in batches, not one agent per behaviour. `{batchSize: n}` sets how many behaviours share one RED/GREEN pair (default 5); `batchSize: 1` gives one cycle per behaviour, at about 2 extra agents per behaviour.
- For the cheapest runs pass `models: {strong: "sonnet"}`; for hard features `models: {worker: "opus"}`.
- Runs can be resumed in the same session after a pause or stop. Completed agents are replayed from cache.
