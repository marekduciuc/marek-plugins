# tdd-flow

Personal Claude Code plugin: an end-to-end dev pipeline built on **dynamic workflows** (scripted multi-agent orchestration) and specialist subagents. It works with any stack (it detects the language and test commands per repo) and delivers through your existing CI/CD.

## How it is built

- **Workflows** (`workflows/*.js`): the orchestration. Loops, retries, fan-out and verification are code, so every run follows the same process.
- **Agents** (`agents/*.md`): the specialists the workflows call (`agentType: "tdd-flow:<agent>"`). They also carry the domain knowledge: spec template, TDD rules, doc templates.
- **Skill** `ship-feature`: chains the workflows and holds the human approval gates. Workflows can't ask questions mid-run, so the gates sit between runs.
- **Hook** `tdd-guard`: blocks production-code edits while a cycle is in RED.

## Workflows

| Command | Shape | Agents (typical) |
|---|---|---|
| `/tdd-flow:analyze-requirements <issue \| file \| text>` | Context (stack + fetch, parallel) → 3 analysts from different angles (behaviour / risk / minimal scope) → synthesize spec.md + tasks.md → testability & completeness critics → revise | ~8-9 |
| `/tdd-flow:tdd-implement {feature}` | Plan + baseline → per task, sequentially: per behaviour RED (test-writer, retry once) → GREEN (implementer, retry once) → REFACTOR → review with up to 2 fix rounds (behavioural findings become new RED cycles) → commit | ~2 per behaviour + 3 per task |
| `/tdd-flow:document {feature}` | Survey diff → pipeline per target: write → adversarial fact-check → fix → commit | ~6-14 |
| `/tdd-flow:deploy {feature}` | Preflight → 3 review lenses (spec, security, quality) → dedupe → 2 skeptics per finding → PR → CI watch with test-first fix loop (max 2) → stops at `ready_to_merge` | ~8-12 |
| `/tdd-flow:deploy {feature, mode:"merge", approved:true}` | Merge (+ optional release) → watch post-merge pipeline → close out | ~3 |
| `/tdd-flow:ship-feature <input>` (skill) | Runs everything above with Gate 1 (spec approval) and Gate 2 (merge approval) | - |

Each workflow returns `{status, ..., next}`. If a coding step still fails after escalating to Opus, it stops cleanly with `status: "blocked"` and resets the TDD phase, rather than guessing.

## Agents and model policy

Workflows set the model on each call, so each step uses the cheapest model that does it well:

| Step | Model |
|---|---|
| Analyst drafts (x3), spec critics, per-task review, doc writing + fact-check, deploy sceptics | **Sonnet** (worker) |
| Test-writer (RED), implementer (GREEN / REFACTOR / fixes) | **Sonnet**, auto-escalated to **Opus** if the step fails twice |
| Spec synthesis + revision, final pre-merge review (3 lenses) | **Opus** (strong) |
| Fetching the issue, preflight, commits, close-out, stack detection | **Haiku** (light) |

**Escalation ladder** for every coding step: Sonnet, then Sonnet again with the failure output, then Opus with the failure output. Only if all three fail does the workflow stop with `status: "blocked"`. `tdd-implement` reports `escalationsToStrongModel`, so you can see how often Opus was needed.

Override per run with `args.models`, e.g. `{feature: "x", models: {worker: "opus"}}` for a hard feature, or `{models: {strong: "sonnet"}}` for the cheapest run.

| Agent | Default model | Role |
|---|---|---|
| stack-detector | haiku | Language, test/build/lint commands, CI, tracker |
| requirements-analyst | sonnet (opus for synthesis) | Drafts and synthesizes specs |
| test-writer | sonnet | RED: one failing test, never production code |
| implementer | sonnet | GREEN minimal code + REFACTOR |
| code-reviewer | sonnet (opus for final review) | Read-only review and fact-checking |
| doc-writer | sonnet | Docs from the actual diff |
| release-engineer | sonnet | PR, CI watch, merge/release (only with approval) |

## Files it creates in your repo

```
.tdd-flow/
  stack.md                  detected stack profile
  state.json                {feature, phase: IDLE|RED|GREEN|REFACTOR, task}
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

- Watch runs with `/workflows`; each agent's token use is shown there, and you can pause (`p`) or stop (`x`).
- Use `tdd-implement` with `{maxTasks: 1}` for small, reviewable increments.
- For the cheapest runs pass `models: {strong: "sonnet"}`; for hard features `models: {worker: "opus"}`.
- Runs can be resumed in the same session after a pause or stop. Completed agents are replayed from cache.
