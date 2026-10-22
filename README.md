# marek-plugins

Personal Claude Code plugin marketplace.

| Plugin | What it does |
|---|---|
| [tdd-flow](plugins/tdd-flow/README.md) | End-to-end dev pipeline on dynamic workflows: requirements analysis, TDD implementation, documentation, CI/CD deployment |

## Install

In Claude Code:

```
/plugin marketplace add marekduciuc/marek-plugins
/plugin install tdd-flow@marek-plugins
```

From a local clone:

```
/plugin marketplace add ./path/to/this/repo
```

Update after pushing changes:

```
/plugin marketplace update marek-plugins
```

For a private repo, Claude Code uses your existing git credentials (e.g. `gh auth login`).

## Repository layout

```
.claude-plugin/marketplace.json   marketplace catalog
plugins/
  tdd-flow/                       plugin (manifest, agents, workflows, skills, hooks)
```

## Releasing a new plugin version

1. Change the plugin.
2. Bump `version` in `plugins/<plugin>/.claude-plugin/plugin.json` **and** in `.claude-plugin/marketplace.json`.
3. Validate: `claude plugin validate .claude-plugin/marketplace.json`
4. Open a PR (see the `git-workflow` skill); after merge, tag `<plugin>-v<version>` (e.g. `tdd-flow-v0.3.0`) on the merge commit.
