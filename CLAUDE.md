# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A personal Claude Code plugin marketplace (`marek-plugins`). It has no build, package manager or test suite. `.claude-plugin/marketplace.json` lists the plugins, and each plugin lives in `plugins/<plugin>/` with its own `.claude-plugin/plugin.json`. Each plugin's architecture and usage are documented in its own `plugins/<plugin>/README.md`. Read that file before changing a plugin.

## Commands

```bash
# Validate the marketplace and plugin manifests (run after any manifest change)
claude plugin validate .claude-plugin/marketplace.json
```

Inside Claude Code:

```
/plugin marketplace add marekduciuc/marek-plugins   # from GitHub
/plugin marketplace add ./                          # from a local clone, for testing
/plugin install <plugin>@marek-plugins
/plugin marketplace update marek-plugins            # pick up changes
```

## Adding or releasing a plugin

- A new plugin needs its own directory under `plugins/` and an entry in `.claude-plugin/marketplace.json` whose `source` points to that directory.
- When a plugin changes, bump `version` in **both** `plugins/<plugin>/.claude-plugin/plugin.json` and the plugin's entry in `.claude-plugin/marketplace.json`. The two must match. Then validate.

## Git and GitHub

Use the `git-workflow` skill (`.claude/skills/git-workflow/`) for branches, commits, pushes, pull requests and release tags.
