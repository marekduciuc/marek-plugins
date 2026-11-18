# tdd-flow: `starting` status for a session that has just been started

Date: 18.11.2026. Target: tdd-flow 0.28.0 (after 0.27.1, the blocked-session-resumed change in `runState`).

Status: approved 18.11.2026, not implemented.

## Problem

A spec whose background session has just been started shows as `stalled` in the status pane, with a restart button. It should show `starting`.

Cause: the autopilot starts a spec in four steps (`skills/autopilot/SKILL.md`, section 2):

1. `tdd-flow worktree` creates the worktree.
2. The model picks the session name.
3. `claude --bg` starts the session.
4. `tdd-flow run-report` writes the run file with `running`.

The pane runs `tdd-flow status` every 10 s. Between steps 1 and 4 it finds a worktree without a run file. `runState` (`bin/tdd-flow`) then has `run.status === 'unknown'`, no session, and returns `stalled` with "no session found". Steps 2 and 3 are model turns, so the gap is often longer than 10 s.

After step 4 the 90 s grace (`START_GRACE_MS`) applies, but it reports `running` for a session that is not listed as working yet.

## Goal

- From the moment the worktree exists until the session works, every reader (`status`, `board`, `runs-wait`, the pane) reports `starting`.
- A session that never comes up still ends as `stalled`, as today.

Not in scope: a single CLI command that replaces autopilot steps 1 to 4, and any change to how session names are picked.

## Approaches

| Approach | Trade-off |
|---|---|
| **A. `worktree` writes a `starting` run file; `runState` knows `starting`** (chosen) | Small change in the CLI. Every reader gets the new status from one place. |
| B. The pane shows `starting` for a `stalled` row with a young worktree | `board` and `runs-wait` still say `stalled`, so the autopilot could report a stall that is not one. |
| C. One `tdd-flow start` command does steps 1 to 4 | Closes the gap completely, but the model picks the name between the steps today; a larger change to the autopilot skill for the same visible result. |

## Design

### Run file

- New run status `starting`: `{slug, status: 'starting', at}`. No session id.
- `tdd-flow worktree` writes it at the end of every call, for a created and for a reused worktree, unless the run's session is working (`isLive`). A working session keeps its run file untouched, and so does a `running` run while `claude agents` fails.
- `run-report` accepts only `running`, `done` and `blocked`, as today. `starting` is written by the CLI only.
- `restartSpec` (used by `restart` and `answer-decision`) calls `worktree` and then writes `running` with the new session id, as today. The `starting` file exists in between.

### `runState`

In order:

1. Run is `done` or `blocked` and not resumed: the run, as today.
2. The session is working: `running`. This holds for a `starting` run too: the session can work before step 4 writes `running`.
3. Younger than `START_GRACE_MS`, and either a `starting` run, or a `running` run whose session is not `done`: `starting`. A `starting` run has no session id, so the session found by its worktree may be the previous run's idle one; it does not end the grace.
4. Otherwise: `stalled`. For a `starting` run the details are `session did not start within 90 s`; the other details stay as they are.

A worktree with no run file at all (made by hand) stays `stalled`, as today.

### Readers

- `board` / `boardTable`: prints `starting`. The `progress` map still holds only `running` rows.
- `runs-wait`: `starting` is not a result. It keeps waiting, and it returns `stalled` when the grace ends without a working session.
- `restart`: refuses a `starting` spec with the existing "only a blocked or stalled spec is restarted" error.
- Status pane (`hooks/register.tsx`):
  - new kind `starting`, colour `suggestion` (the colour of "restarting…");
  - sort order: decision, blocked, stalled, starting, running, queued, done;
  - `isActive` includes `starting`, so the pane opens by itself;
  - no restart button (`isRestartable` is unchanged);
  - "restarting…" and "answer sent" end when the status is `starting` or `running`;
  - the status line (`tdd-flow: N running, M waiting`) counts `starting` rows as running.
- `types/index.d.ts`: `starting` added to the status type.
- Autopilot skill: a `starting` spec takes one of the N slots, like `running`. One line in section 3.
- README: the `worktree`, `runs-wait`, `board`, `status` rows and the status pane section name `starting`.

## Tests (`tests/cli.test.cjs`, written first)

1. After `worktree` and before any `run-report`, `status` and `board` return `starting`, not `stalled`.
2. A `starting` run older than the grace, with no session: `stalled`, details `session did not start within 90 s`.
3. A `starting` run whose session (found by the worktree's directory) is `working`: `running`.
4. A `running` run inside the grace whose session is not listed yet: `starting`. With a `done` session: `stalled`.
5. `worktree` on a spec whose session is working leaves the run file unchanged.
6. `restart` refuses a `starting` spec.
7. `runs-wait` does not return on `starting`.

## Release

Bump `version` to 0.28.0 in `plugins/tdd-flow/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, then `claude plugin validate .claude-plugin/marketplace.json`.
