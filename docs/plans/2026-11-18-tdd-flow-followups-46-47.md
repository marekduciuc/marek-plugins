# tdd-flow: follow-ups from the 0.28.0 and 0.29.0 reviews (issues #46, #47)

Date: 18.11.2026. Target: tdd-flow 0.30.0.

Status: implemented in tdd-flow 0.30.0. Changes against the design below, decided during implementation:

- The record file has a third field, `excluded`: the declared paths whose exclude line tdd-flow added itself. Only those lines are deleted when a path is removed; a line that was already there stays. Links are cleaned for every removed path, because each one is checked against the main checkout.
- The `specs` result names the reason in its existing field `why`.

## Goal

Close the review follow-ups that hold for any project, in one PR. The plugin must work on any stack, so the hand-written Docker Compose scan gets no further refinement.

## Scope

| # | Item | Issue | In scope |
|---|---|---|---|
| 1 | A `starting` row shows the old session's attach command | #46 | yes |
| 2 | `specs` lists a spec that is starting right now as runnable | #46 | yes |
| 3 | Missing tests: restart of a `starting` run file; the 0.27.1 test uses `age()` | #46 | yes |
| 4 | `restartSpec` removes the old session before `worktree()` can fail | #47 | yes |
| 5 | `worktree` throws only the first shared-path error | #47 | yes |
| 6 | Exclude lines and links of a path removed from `shared paths:` stay | #47 | yes |
| 7 | `readStack()` runs `git ls-files` per declared path on every CLI call | #47 | yes |
| 8 | stack-detector finds shared paths only in compose files | new | yes |
| 9 | `volumes:` with a trailing comment or anchor | #47 | no |
| 10 | A bind-mount source outside the repo | #47 | no |
| 11 | One `container_name:` pins every service in the directory | #47 | no |

Items 9 to 11 are refinements of the compose line scan. The scan stays as it is in 0.29.0: a guard for the common case that warns on what it cannot read. They are closed in #47 as not planned, with this reason.

## Non-goals

- A YAML parser, or calling `docker compose config`.
- Checks for other tools (Podman files, Kubernetes manifests, process managers).
- Any change to how `shared paths:` links are made.

## Design

### 1. No attach command on a `starting` row

`runState` leaves `attach` out when the run file says `starting` and the session is not working. A `starting` run has no session id, so the session found by the worktree is the previous run's. This also holds once the row has become `stalled` with `session did not start within 90 s`.

`status` leaves `session` and `sessionState` empty in the same case. `runs-wait` gets the same result through `runState`.

### 2. `specs` skips a spec that is starting

`specs` skips a spec whose `runState` is `starting`, with the reason `is starting: its session is not working yet`. Unlike a blocked spec, naming the slug does not override the skip: a second session on the same worktree is never wanted.

### 3. Tests

- `restart` on a young `starting` run file: refused with `is starting`.
- `restart` on a `starting` run file older than the grace: restarted, run `running` with the new session id.
- The 0.27.1 test (`a blocked run whose session works again…`) uses the `age()` helper.

### 4. Worktree before the old session goes

`restartSpec` prepares the worktree first, then removes the old session, then starts the new one. A shared-path error, or a worktree path that holds data of its own, then stops the restart while the old session and the run file are untouched.

Steps in error messages: 4 `prepare the worktree`, 5 `remove the old session`, 6 `restart`. `answer-decision` keeps its steps 1 to 3.

### 5. All shared-path errors at once

`worktree` throws every rejected entry joined with `; `, as `autopilot-check` already shows them.

### 6. A path removed from `shared paths:` is cleaned up

tdd-flow records the paths it has added to the exclude file in `<git common dir>/tdd-flow/shared-paths.json`: `{"declared": [...], "removed": [...]}`.

On every `worktree` call:

1. Paths in `declared` that `stack.md` no longer declares move to `removed`. A path declared again moves back.
2. For each `removed` path, the line `/<path>` is deleted from `<git common dir>/info/exclude`. Lines tdd-flow did not add are never touched: only recorded paths are considered.
3. In the worktree being prepared, a symlink at a `removed` path is deleted when it resolves to the main checkout's path. Any other link, file or directory stays.
4. `removed` is kept, so worktrees prepared later are cleaned too.

The result's `notes` names each deleted link. The main checkout's directory and its data are never deleted.

Why links go too: without the exclude line, git sees the link as a new file, and a session could commit it.

Projects on 0.29.0 have no record yet. The first call records what is declared then. An exclude line for a path removed before the upgrade stays and is deleted by hand; the README says so.

### 7. Validation where it is used

`readStack()` keeps the checks that need no git call (absolute, `..`, tool directories, not a plain path) and returns `sharedPaths` and `sharedPathErrors` from them. The `tracked by git` check moves to `worktree` and `autopilot-check`, the two commands that act on the paths. Every other CLI call (`tdd-flow test`, `status`, `board`) runs no `git ls-files` for them.

### 8. stack-detector: any local state, not only compose

The `shared paths:` rule in `agents/stack-detector.md` becomes technology-neutral: any git-ignored path in the repo that holds local state a service or command started from a worktree would use and that must be the same as in the main checkout. Examples in the text: a database data directory mounted by a compose file with a fixed name, a SQLite file the app opens by a relative path, an uploads or media directory. Build output, dependency directories and caches are not shared paths. `none` when there is nothing.

The deterministic check in `autopilot-check` is unchanged and remains a guard for compose only.

## Tests (`tests/cli.test.cjs`, written first)

1. A `starting` run with the previous idle session in its worktree: `status` row has no `attach`, `session` or `sessionState`; `runs-wait` lists the slug without `attach`. After the grace: `stalled`, still no `attach`.
2. `specs` skips a `starting` spec, also when named; after the grace it is runnable again.
3. The three tests of section 3.
4. `restart` with a rejected shared path: fails at step 4, `claude rm` and `claude --bg` were not called, the run file is unchanged.
5. `worktree` with two rejected entries: the error names both.
6. A declared path is recorded. After it is removed from `stack.md`: the exclude line is gone, the link in the worktree is deleted and named in `notes`, the main checkout's data is still there. A second worktree prepared later loses its link too. A user's own `/storage` line in the exclude file stays. A link that points elsewhere stays.
7. A path declared again: linked and excluded again.
8. `status` and `board` with a declared path run no `git ls-files` for it (a fake `git` wrapper logs calls, or the test asserts that a tracked declared path is reported only by `worktree` and `autopilot-check`).

## Release

- Bump `version` to 0.30.0 in `plugins/tdd-flow/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, then `claude plugin validate .claude-plugin/marketplace.json`.
- README: rows `worktree`, `specs`, `restart`, `status`; the Shared paths bullet (cleanup, the 0.29.0 note).
- Close #46. In #47 tick items 4 to 7, mark 9 to 11 as not planned with the reason from Scope, and close it.
