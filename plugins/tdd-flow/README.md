# tdd-flow

Personal Claude Code plugin: an end-to-end dev pipeline built on **dynamic workflows** (scripted multi-agent orchestration) and specialist subagents. It works with any stack (it detects the language and test commands per repo) and delivers through your existing CI/CD.

## How it is built

- **Workflows** (`workflows/*.js`): the orchestration. Loops, retries, fan-out and verification are code, so every run follows the same process.
- **Agents** (`agents/*.md`): the specialists the workflows call (`agentType: "tdd-flow:<agent>"`). They also carry the domain knowledge: spec template, TDD rules, doc templates.
- **Skill** `ship-feature`: chains the workflows and holds the human approval gates. Workflows can't ask questions mid-run, so the gates sit between runs.
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

All git actions (branch, commits, push, PR, merge) go through the `release-engineer` agent. The feature branch is `feature/<slug>`.

Each workflow returns `{status, ..., next}`. If a coding step still fails after escalating to Opus, it stops cleanly with `status: "blocked"` and resets the TDD phase, rather than guessing.

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
| Fetching the issue, preflight, commits (incl. ticking the task), close-out, stack detection | **Haiku** (light) |

**Escalation ladder** for every coding step: Sonnet, then Sonnet again with the failure output, then Opus with the failure output. Only if all three fail does the workflow stop with `status: "blocked"`. `tdd-implement` reports `escalationsToStrongModel`, so you can see how often Opus was needed.

Override per run with `args.models`, e.g. `{feature: "x", models: {worker: "opus"}}` for a hard feature, or `{models: {strong: "sonnet"}}` for the cheapest run.

| Agent | Default model | Role |
|---|---|---|
| stack-detector | haiku | Language, test/build/lint commands, CI, tracker |
| requirements-analyst | sonnet (opus for synthesis) | Drafts and synthesizes specs |
| test-writer | sonnet | RED: one failing test per behaviour, never production code |
| implementer | sonnet | GREEN minimal code, one test at a time, + REFACTOR; SETUP for setup tasks |
| code-reviewer | sonnet (opus for final review) | Read-only review and fact-checking |
| doc-writer | sonnet | Docs from the actual diff |
| release-engineer | sonnet (haiku for branch/commits) | All git: feature branch, commits, PR, CI watch, review status, merge/release (only with approval) |

## Files it creates in your repo

```
.tdd-flow/
  stack.md                  detected stack profile
  state.json                {feature, phase: IDLE|RED|GREEN|REFACTOR|SETUP, task}
  features/<slug>/
    spec.md  tasks.md  tdd-log.md  review.md
```

Add `.tdd-flow/` to `.gitignore`, or commit it if you want specs versioned.

## Setup

- Claude Code with dynamic workflows enabled (on Pro, turn on "Dynamic workflows" in `/config`).
- Tracker CLIs, authenticated as needed: `gh auth login`; for Azure DevOps, `az login` + `az extension add --name azure-devops` + `az devops configure --defaults organization=<url> project=<name>`; for Jira, a Jira MCP server or the `jira` CLI.
- A CI pipeline in the repo, for `deploy`.
- To avoid permission prompts on long runs, allow the tools the agents need (Bash for your test command, git, gh/az, Edit/Write) in your Claude Code permission settings. When the workflow prompt appears, choose "Yes, and don't ask again" for each tdd-flow workflow.

## Cost control

- **Agent limits.** Every workflow runs at most 2 agents at the same time and has a hard cap on agents per run: analyze-requirements 12, document 15, deploy 20, tdd-implement 40. Override per run with `args.maxAgents` / `args.maxParallel` (positive integers). At the cap a workflow stops with `status: "agent_limit"`. tdd-implement only starts a task whose minimum cost fits, so it normally stops between tasks; rerun it to continue from `tasks.md`. deploy stops before the skeptic pass if verifying all findings would not fit.
- Watch runs with `/workflows`; each agent's token use is shown there, and you can pause (`p`) or stop (`x`).
- Use `tdd-implement` with `{maxTasks: 1}` for small, reviewable increments.
- **Tests first, per task.** For each task, the test-writer writes every failing test before the implementer touches production code (tdd-guard blocks production edits during RED). Each agent start costs about 17k tokens of context, so the tests are written in batches, not one agent per behaviour. `{batchSize: n}` sets how many behaviours share one RED/GREEN pair (default 5); `batchSize: 1` gives one cycle per behaviour, at about 2 extra agents per behaviour.
- For the cheapest runs pass `models: {strong: "sonnet"}`; for hard features `models: {worker: "opus"}`.
- Runs can be resumed in the same session after a pause or stop. Completed agents are replayed from cache.
