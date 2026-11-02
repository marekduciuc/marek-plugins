---
name: implement-spec
description: This skill should be used when the user runs /tdd-flow:implement-spec, usually as the prompt of a background session the tdd-flow autopilot started in a spec's worktree. It implements one approved spec unattended - all tasks through tdd-implement, a superpowers code review with one fix round, then push and a pull request - and records the result for the autopilot.
argument-hint: "<feature-slug> [base-branch]"
---

# Implement one spec unattended

Input: $ARGUMENTS - the feature slug, optionally followed by the base branch (default: the repo's default branch).

This runs without a human watching, usually in a `claude --bg` session started by `/tdd-flow:autopilot`. Do not ask questions and do not stop to wait for input: every way this skill ends goes through `tdd-flow run-report`, so the autopilot sees the result. Never merge, release or force-push.

`tdd-flow` is the plugin CLI (on the Bash `PATH`); it takes JSON on stdin and prints `{"ok": ..., "result": ...}`:

```bash
tdd-flow run-report <<'TDD_FLOW_JSON'
{"slug": "<slug>", "status": "blocked", "details": "<step>: <what failed, short>"}
TDD_FLOW_JSON
```

**Report blocked and stop** means: run `run-report` with `status: "blocked"` and a short `details` (step, reason, what the user must do), print the same in your reply, and end.

## 0. Check the place

`git branch --show-current` must be `feature/<slug>` and the current directory must be a worktree (`git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`). Otherwise report blocked ("not in the spec's worktree") and stop.

## 1. Implement the tasks, one workflow run per task

Tasks run in order, each in its own `tdd-implement` run, so each task gets the full agent budget and a failure stops at that task. Loop:

1. Count the open tasks: lines `- [ ] T-<n>` in `.tdd-flow/features/<slug>/tasks.md`.
2. Run the `tdd-implement` workflow with the Workflow tool, args `{"feature": "<slug>", "maxTasks": 1}`, and wait for its completion notification. It takes the first open task in `tasks.md` order.
3. Act on the result `status`:

| Result `status` | Action |
|---|---|
| `implemented` | The task is committed and ticked. Keep `unverified` for the PR body. If the open-task count did not go down, report blocked ("task not ticked after a successful run"); otherwise go back to 1. |
| `nothing_to_do` | No open task is left: leave the loop. Continue if the branch has commits that are not on the base (`git log --oneline <base>..HEAD`); otherwise report blocked ("no changes to review"). |
| `agent_limit` | The task did not fit into one run. Run the same args once more (it redoes the task on top of the uncommitted changes); if that also ends in `agent_limit`, report blocked. |
| `blocked` or an error | report blocked with the result's `task`, `step` and `details`. |

Never start the next task while the previous run is still going: the runs share one working tree.

After the loop, `spec.md` says `Status: implemented` (set in the commit of the last task).

## 2. Code review (superpowers)

Invoke the `superpowers:requesting-code-review` skill and follow it, with:

- `BASE_SHA` = `git merge-base <base> HEAD`, `HEAD_SHA` = `git rev-parse HEAD`
- `{DESCRIPTION}` = the spec's goal (first paragraph of `.tdd-flow/features/<slug>/spec.md`) and the list of tasks
- `{PLAN_OR_REQUIREMENTS}` = "`.tdd-flow/features/<slug>/spec.md` (acceptance criteria and edge cases)"

If that skill is not available, dispatch the `tdd-flow:code-reviewer` agent on `git diff <base>...HEAD` against the spec instead, and sort its blocker/major/minor findings into Critical/Important/Minor.

Sort the findings by severity. You act as the executor in that skill: drop a finding only with a technical reason, and keep the reason for the PR body.

## 3. One fix round

If there are Critical or Important findings, run the `tdd-implement` workflow once more with `{"feature": "<slug>", "findings": [...]}`. Write each finding as one string: `"<severity>: <file:line> - <issue>. Expected: <fix>"`.

- `implemented` → continue. Do **not** review again (one review pass per change).
- `blocked`, `agent_limit` or an error → report blocked with the details, and say which findings are still open.

Minor findings are not fixed; they go into the PR body.

## 4. Push and open the PR

1. `gh pr list --head feature/<slug> --state all --json number,state,url --limit 1`
   - `MERGED` → report blocked ("feature/<slug> was already merged; start a new branch").
   - `OPEN` → push only (it updates that PR) and use its URL.
2. `git push -u origin feature/<slug>`. The push-gate hook runs the type check, lint, tests and a secret scan first. If it blocks the push, report blocked with the gate's message. Never bypass it (`--no-verify`, `TDD_FLOW_PUSH_GATE=off`).
3. With no open PR: `gh pr create --base <base> --head feature/<slug> --title "feat(<slug>): <spec title from its first # heading>" --body-file <file>` (write the body to a file in the scratchpad or a temp directory). Body:
   - **Summary**: the spec's goal, with a link to the source issue if `spec.md` has `Source:` with an issue
   - **Acceptance criteria**: AC ids with one line each
   - **Tasks**: the commits from step 1 (`git log --oneline <base>..HEAD`)
   - **Code review**: counts per severity; what the fix round fixed; Minor findings as a list; findings set aside, with the reason
   - **Not verified here**: the `unverified` list from step 1 (verify commands that could not run), if any
   - **Test plan**: the test command from `.tdd-flow/stack.md`, and that the push-gate ran it before the push
   - the attribution line your instructions give for PR descriptions
4. Read the URL that `gh pr create` printed (or `gh pr view --json url`).

## 5. Record the result

```bash
tdd-flow run-report <<'TDD_FLOW_JSON'
{"slug": "<slug>", "status": "done", "prUrl": "<url>"}
TDD_FLOW_JSON
```

End with one line: slug, PR URL, number of tasks, number of review findings fixed and the number left in the PR.
