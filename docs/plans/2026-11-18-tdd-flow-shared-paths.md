# tdd-flow: shared paths, so a worktree session cannot replace the project's services

Date: 18.11.2026. Target: tdd-flow 0.29.0.

Status: approved 18.11.2026 (share the data, plus a pre-flight check; builder's calls accepted), not implemented.

## Problem

Seen in a project run on 16.11.2026: an autopilot session (UUID v7 spec) ran `docker compose up` in its worktree. The compose file gives the database container a fixed name and mounts its data from a relative path (`storage/postgres`). Compose therefore replaced the project's running container with one whose data directory was inside the worktree. The app in the main checkout then worked on the worktree's database, and removing the worktree would have deleted that data.

The fix by hand was a symlink `storage/postgres` in the next worktree, pointing at the main checkout, hidden from git through `.git/info/exclude`. Nothing in tdd-flow prevents the same thing in the next project or the next worktree.

## Goal

- A project declares once which paths every worktree shares with the main checkout.
- `tdd-flow worktree` links them into each worktree, so a service started from a worktree uses the project's data.
- The autopilot does not start while a compose file can still cause the problem.

## Non-goals

- A database, ports or containers of its own for each worktree.
- Blocking `docker` commands in sessions.
- Cleaning up finished runs and their worktrees (assumed out of scope; `/tdd-flow:cleanup` covers merged worktrees).

## Accepted trade-off

All sessions and the main checkout use the same data. A migration from an unmerged branch runs on the project's development database, and parallel specs can disturb each other. The README says so, and parallel runs are limited (see Pre-flight).

## Approaches

| Approach | Trade-off |
|---|---|
| **A. Share: declared paths are linked into every worktree, with a pre-flight check** (chosen) | Smallest change, works with compose files as they are. Sessions share the development data. |
| B. Isolate: a compose project, ports and data per worktree | Clean separation, but every project has to drop fixed container names and ports first. |
| C. Forbid: a hook blocks `docker compose up/down/rm` in sessions | Data is safe, but a spec that has to start a service ends as `blocked`. |

## Design

### Declaration

One line in `.tdd-flow/stack.md`, next to `tests need:`:

```
shared paths: storage/postgres, storage/uploads
```

- Comma-separated, relative to the repo root. `none` or a missing line means no shared paths.
- A path is rejected when it is absolute, contains `..`, or lies in `.git`, `.tdd-flow` or `.claude/worktrees`.
- The `stack-detector` agent writes the line for a new profile, from the compose files it finds (rule in Pre-flight). An existing profile gets the line from the user, prompted by the failing check.

### `tdd-flow worktree`

For every shared path, on a created and on a reused worktree (so existing worktrees and `restart` / `answer-decision` get the links too):

| State in the worktree | Action |
|---|---|
| Nothing there | Create the parent directories and a symlink to the absolute path in the main checkout. |
| Already the right symlink | Nothing. |
| Symlink to somewhere else | Replace it. |
| Empty directory | Remove it and link. |
| File or non-empty directory | Error: `<path> in the worktree holds data of its own; move it away, then run again`. Nothing is deleted. |

- A shared path missing in the main checkout is created there as a directory, and the result names it in `notes`.
- A shared path tracked by git is an error: a link would show up as a change in every worktree.
- Each path is added as `/<path>` (no trailing slash) to `<git common dir>/info/exclude`, the file `worktree` already extends for `.claude/worktrees/`. A `.gitignore` pattern with a trailing slash does not match a symlink, so the project's own ignore rule is not enough.
- The result gains `shared: [{path, linked: true|false}]`.

### Pre-flight (`tdd-flow autopilot-check`)

New check `shared paths`:

1. Read every tracked compose file (`docker-compose*.yml|yaml`, `compose*.yml|yaml`, any directory).
2. A file is *pinned* when it has a top-level `name:` or a service with `container_name:`. Without either, compose names the project after the directory, so a worktree gets containers of its own and cannot replace the project's.
3. In a pinned file, collect every bind mount with a relative source (`./x`, `../x`; short syntax and `type: bind` with `source:`), resolved against the compose file's directory.
4. `fail` for each source that is not a declared shared path or inside one. The fix text is the exact `shared paths:` line to add.
5. `warn` for a source with `${...}`: it cannot be resolved.
6. `fail` for a declared path that is tracked by git or fails the validation above.

The compose files are read line by line; the plugin has no dependencies and gets no YAML parser.

Declared shared paths count as outside state, like `tests need: docker`: one spec at a time unless `--parallel N` is passed, with the existing warning for N above 1.

### Removal

`tdd-flow cleanup` and `git worktree remove` delete the link, never its target. A test pins this.

### Docs

- README: the `worktree` and `autopilot-check` rows, the autopilot section (shared data, the trade-off above), `stack.md` fields.
- `skills/implement-spec/SKILL.md`: one line, a session never removes or replaces a shared link.
- `agents/stack-detector.md`: the `shared paths:` line.

## Builder's calls (not decided in chat)

- A shared path missing in the main checkout is created as a directory instead of failing.
- An empty directory in the worktree is replaced by the link without asking.
- Only pinned compose files are checked; fixed host ports alone are not reported.

## Tests (`tests/cli.test.cjs`, written first)

1. `worktree` links each declared path to the main checkout and adds it to `info/exclude`; `git status` in the worktree is clean.
2. A second `worktree` call changes nothing; a reused worktree without the link gets it.
3. A non-empty directory at the path: error, content untouched.
4. A missing path in the main checkout is created and named in `notes`.
5. A tracked path, an absolute path, `..` and `.git/x` are rejected.
6. `autopilot-check` fails for `container_name` plus `./storage/postgres:/var/lib/postgresql/data` when the path is not declared, and passes when it is (also when a parent directory is declared).
7. The same for a top-level `name:` and for the long `type: bind` syntax.
8. A compose file without `container_name` and `name:` passes with nothing declared.
9. A `${VAR}` source gives a warning.
10. Declared shared paths set `parallel` to 1 unless `--parallel` is passed.
11. Removing the worktree leaves the files in the main checkout's shared path.

## Release

Bump `version` to 0.29.0 in `plugins/tdd-flow/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, then `claude plugin validate .claude-plugin/marketplace.json`.
