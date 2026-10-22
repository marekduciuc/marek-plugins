---
name: git-workflow
description: This skill should be used before any git or GitHub action in the marek-plugins repo - starting work on a change, creating a branch, committing, pushing, opening or updating a pull request, merging, or tagging a plugin release. It defines the branch naming, the PR-only flow into main, and the gh commands to use.
---

# Git workflow for marek-plugins

All changes reach `main` through a pull request. Use `gh` for everything on GitHub.

## Rules

- Never commit directly to `main`, and never push to `main`.
- Commit, push, open a PR, merge or tag only when the user asks for it in the current conversation.
- Never merge a PR on your own initiative.

## 1. Pick the branch name

Look at which paths the change touches:

| Change touches | Branch name |
|---|---|
| Only `plugins/<plugin>/` | `<plugin>/feature/<feature-name>` |
| Anything else (`.claude-plugin/`, root files, `.claude/`) | `marketplace/feature/<feature-name>` |

`<feature-name>` is short, descriptive, kebab-case, e.g. `tdd-flow/feature/coverage-gate`, `marketplace/feature/github-install-docs`.

If a change touches more than one plugin, split it into one branch per plugin. If the changes cannot be separated, use `marketplace/feature/<feature-name>`.

## 2. Start the branch

Before editing, if you are on `main` with a clean tree:

```bash
git fetch origin
git switch main && git pull --ff-only
git switch -c <branch>
```

If changes were already made on `main` (uncommitted), run `git switch -c <branch>`. The uncommitted changes come with you.

If the current branch already has an open PR for the same piece of work, keep working on it instead of starting a new branch:

```bash
gh pr list --head "$(git branch --show-current)" --state open
```

## 3. Commit and push

```bash
git add <files>            # name the files; don't use `git add -A` blindly
git commit                 # imperative subject line, body says what and why
git push -u origin <branch>
```

## 4. Open or update the PR

If the branch has no open PR yet:

```bash
gh pr create --base main --head <branch> --title "<title>" --body "<summary + test plan>"
```

If a PR is already open, pushing updates it. Change the title or description with `gh pr edit` if the scope changed. Report the PR URL to the user.

Useful checks: `gh pr view --json url,state,mergeable`, `gh pr checks`.

## 5. Release tag (after merge)

The version bump goes through a PR like any other change. After the user has merged it, tag the merge commit:

```bash
gh pr view <number> --json state,mergeCommit --jq '.state, .mergeCommit.oid'   # must be MERGED
git fetch origin
git tag <plugin>-v<version> <merge-commit-oid>
git push origin <plugin>-v<version>
```

Tag format: `<plugin>-v<version>`, e.g. `tdd-flow-v0.3.0`.
