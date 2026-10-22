# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A personal Claude Code plugin marketplace (`marek-plugins`). It has no build, package manager or test suite. The content is plugin definitions: Markdown agents/skills, JSON manifests, a bash hook and JavaScript workflow scripts. Currently one plugin: `plugins/tdd-flow`.

## Commands

```bash
# Validate the marketplace and plugin manifests (run after any manifest change)
claude plugin validate .claude-plugin/marketplace.json

# Install from GitHub (inside Claude Code)
/plugin marketplace add marekduciuc/marek-plugins
/plugin install tdd-flow@marek-plugins

# Install locally for manual testing (inside Claude Code)
/plugin marketplace add ./
/plugin install tdd-flow@marek-plugins
/plugin marketplace update marek-plugins   # pick up local edits

# Exercise the tdd-guard hook by hand (exit 2 = blocked, stderr = message)
echo '{"cwd":"/path/to/repo","tool_input":{"file_path":"src/foo.py"}}' \
  | bash plugins/tdd-flow/hooks/scripts/tdd-guard.sh; echo "exit=$?"
```

## Branching and PRs

- Never commit directly to `main`. All changes go through a pull request.
- Before making changes, create a branch from an up-to-date `main` named `<pluginname>/feature/<featurename>` (e.g. `tdd-flow/feature/coverage-gate`). For repo-level changes not tied to one plugin (marketplace manifest, root README, CLAUDE.md), use `marketplace/feature/<descriptive-feature-name>`.
- Push the branch and open the PR with `gh pr create --base main`.

## Releasing

Bump `version` in **both** `plugins/<plugin>/.claude-plugin/plugin.json` and the matching entry in `.claude-plugin/marketplace.json` (they must agree), validate, then tag as `<plugin>-v<version>` (e.g. `tdd-flow-v0.3.0`). The version bump goes through a PR like any other change. Tag the merge commit on `main` after the PR is merged.

## tdd-flow architecture

Four layers that only make sense together:

- **Workflows** (`workflows/*.js`): dynamic-workflow scripts for the Claude Code Workflow tool, not Node modules. Each starts with a pure-literal `export const meta = {...}` and uses the runtime globals `args`, `agent()`, `parallel()`, `pipeline()`, `phase()`. They own all orchestration: loops, retries, fan-out, verification. Every agent call passes a JSON `schema` for structured output, and every workflow returns `{status, ..., next}`.
- **Agents** (`agents/*.md`): the specialists, called from workflows as `agentType: 'tdd-flow:<name>'` via the `A()` helper. They hold the domain rules (spec template, TDD discipline, doc templates). Workflow prompts stay short and rely on the agent file for the rules.
- **Skill** `skills/ship-feature`: chains the workflows in order (analyze → implement → document → deploy pr → deploy merge). Workflows cannot ask the user anything mid-run, so the two human gates (spec approval, merge approval) live in this skill **between** workflow runs. `deploy` with `mode: "merge"` requires `approved: true`, which only the skill may set after explicit user consent.
- **Hook** `hooks/scripts/tdd-guard.sh` (PreToolUse on Write/Edit/MultiEdit): reads `.tdd-flow/state.json` in the *target* repo and blocks source-code edits (exit 2) while `phase` is `RED`, unless the path matches a test-file convention. It deliberately uses only `sed`/`tr` (no jq/python). If you add a language, update both the test-name patterns and the source-extension list.

### Cross-file contracts

- **State file** `.tdd-flow/state.json` = `{feature, phase: IDLE|RED|GREEN|REFACTOR, task}`. Written by workflow prompts (analyze-requirements creates it, tdd-implement advances it and resets to IDLE on block, deploy merge closes it out) and read by the hook. Changing its shape means updating the workflows, the hook and the skill's "Resuming" logic.
- **Per-feature artifacts** live in the target repo under `.tdd-flow/features/<slug>/` (`spec.md`, `tasks.md`, `tdd-log.md`, `review.md`), plus `.tdd-flow/stack.md` from stack-detector. Workflows find them by slug, taken from `args.feature` or `state.json`.
- **Model policy**: each workflow defines `M = {worker: 'sonnet', strong: 'opus', light: 'haiku'}`, overridable with `args.models`. Coding steps escalate worker → worker retry → strong, then return `status: "blocked"`. The `model:` in agent frontmatter is only a default; the workflow's per-call `model` wins.
- The model table, workflow table and agent table in `plugins/tdd-flow/README.md` document this behaviour. Keep them in sync when you change workflow shape or models.
