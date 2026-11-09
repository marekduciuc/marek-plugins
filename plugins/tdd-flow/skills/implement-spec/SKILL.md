---
name: implement-spec
description: This skill should be used when the user runs /tdd-flow:implement-spec, usually as the prompt of a background session the tdd-flow autopilot started in a spec's worktree. It implements one approved spec unattended - all tasks through tdd-implement, a simplification pass over the whole PR, a superpowers code review with one fix round, then push and a pull request - and records the result for the autopilot.
argument-hint: "<feature-slug> [base-branch]"
---

# Implement one spec unattended

Input: $ARGUMENTS - the feature slug, optionally followed by the base branch (default: the repo's default branch).

This runs without a human watching, usually in a `claude --bg` session started by `/tdd-flow:autopilot`. Do not ask questions and do not stop to wait for input: every way this skill ends goes through `tdd-flow run-report`, so the autopilot sees the result. Never merge, release or force-push.

**Shell:** this session's shell keeps a `cd` for every later command, and the paths below are relative to the worktree root. Never use a bare `cd` into a subdirectory. Use a subshell `(cd apps/web && npm ci)` or a tool flag (`npm --prefix`, `mvn -f`, `git -C`).

`tdd-flow` is the plugin CLI (on the Bash `PATH`); it takes JSON on stdin and prints `{"ok": ..., "result": ...}`:

```bash
tdd-flow run-report <<'TDD_FLOW_JSON'
{"slug": "<slug>", "status": "blocked", "details": "<step>: <what failed, short>"}
TDD_FLOW_JSON
```

**Report blocked and stop** means: run `run-report` with `status: "blocked"` and a short `details` (step, reason, what the user must do), print the same in your reply, and end.

**Report a decision and stop** is the same, for a block that only the user can resolve because it needs a choice, not a fix. Examples: the spec contradicts itself or the code, an acceptance criterion allows two behaviours, or a review finding needs a product call. Technical failures (a red test, the environment, a merge conflict, the agent limit) stay **report blocked**. Do not guess the answer and do not go on with later tasks.
1. Add the question to `## Open questions` in `.tdd-flow/features/<slug>/spec.md`, numbered after the highest `Q-<n>` in Open and Resolved questions: `- Q-<n> <question> - *assumption if unanswered:* <your recommendation>`. Then the options and the tasks it blocks, on indented lines.
2. Commit only that file: `git add .tdd-flow/features/<slug>/spec.md && git commit -m "docs(<slug>): open question Q-<n>"`. Then set the rest of the uncommitted work aside with `tdd-flow set-aside` and `{"slug": "<slug>", "label": "decision-Q-<n>"}`. The restart needs a clean worktree, and the answer may change the blocked task, so it is redone from the committed code. Mention the patch path in `details`.
3. Report it:
   ```bash
   tdd-flow run-report <<'TDD_FLOW_JSON'
   {"slug": "<slug>", "status": "blocked", "details": "<step>: needs a decision (Q-<n>)", "decision": {"id": "Q-<n>", "question": "<question>", "recommendation": "<recommendation>", "options": ["<option>", "..."], "tasks": ["T-<n>"]}}
   TDD_FLOW_JSON
   ```
   The autopilot asks the user, writes the answer into the spec and starts this skill again, and the run resumes from `tasks.md`.

## 0. Check the place

`git branch --show-current` must be `feature/<slug>` and the current directory must be a worktree (`git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`). Otherwise report blocked ("not in the spec's worktree") and stop.

A new worktree has no installed dependencies. For JavaScript, install them for each directory that has a tracked lockfile (`git ls-files '*package-lock.json' '*pnpm-lock.yaml' '*yarn.lock' '*bun.lock' '*bun.lockb'`) and no `node_modules`, using the frozen command for its lockfile, in a subshell so the shell stays at the worktree root: `(cd apps/web && npm ci)`.

| Lockfile | Command |
|---|---|
| `package-lock.json` | `npm ci` |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| `yarn.lock` | `yarn install --immutable` if the repo has `.yarnrc.yml` (Yarn 2+), else `yarn install --frozen-lockfile` |
| `bun.lock` / `bun.lockb` | `bun install --frozen-lockfile` |

In a workspace monorepo, run it once at the root that holds the lockfile. If a frozen install fails, report blocked with its output; never fall back to a command that rewrites the lockfile (`npm install`). Other stacks: if `.tdd-flow/stack.md` or the README names a setup step that creates a local environment (a Python virtualenv, `bundle install`), run it the same way. Build tools that fetch dependencies themselves (Maven, Gradle, Cargo, Go) need nothing.

## 1. Implement the tasks, one workflow run per task

Tasks run in order, each in its own `tdd-implement` run, so each task gets the full agent budget and a failure stops at that task. Loop:

1. Count the open tasks: lines `- [ ] T-<n>` in `.tdd-flow/features/<slug>/tasks.md`.
2. Run the workflow `tdd-flow:tdd-implement` with the Workflow tool (`name` is that full name, with the plugin prefix), args `{"feature": "<slug>", "maxTasks": 1}`, and wait for its completion notification. It takes the first open task in `tasks.md` order.
3. Act on the result `status`:

| Result `status` | Action |
|---|---|
| `implemented` | The task is committed and ticked. Keep `unverified` for the PR body. If the open-task count did not go down, report blocked ("task not ticked after a successful run"); otherwise go back to 1. |
| `nothing_to_do` | No open task is left: leave the loop. Continue if the branch has commits that are not on the base (`git log --oneline <base>..HEAD`); otherwise report blocked ("no changes to review"). |
| `agent_limit` | The task did not fit into one run. Run the same args once more (it redoes the task on top of the uncommitted changes); if that also ends in `agent_limit`, report blocked. For a `[refactor]` task, first set its uncommitted changes aside (`tdd-flow set-aside` with `{"slug": "<slug>", "label": "<task id>"}`), so the rerun starts from committed code. |
| `blocked` or an error | report blocked with the result's `task`, `step` and `details`, or **report a decision** when the cause is a choice for the user. |

Never start the next task while the previous run is still going: the runs share one working tree.

After the loop, `spec.md` says `Status: implemented` (set in the commit of the last task). A result's `skipped` lists refactor tasks whose change no longer applied; keep them for the PR body.

## 2. Simplify the PR

Skip this step when `spec.md` has `Source: tdd-flow simplify-codebase`, because the PR is already a simplification.

1. Run the workflow `tdd-flow:simplify` with args `{"mode": "diff", "base": "<base>"}` and wait for it. It returns `findings`: at most 8 confirmed proposals for code this PR does not need. It also returns `dropped`, with reasons. No findings → note "lean already" for the PR body and go to step 3.
2. For each finding, in order, run `tdd-flow:tdd-implement` with `{"feature": "<slug>", "refactors": ["<finding>"]}`, one finding per run. Each run pins the behaviour with characterization tests, applies the change, reviews and commits it.
   - `implemented`: note the commit, or the `skipped` reason when the change no longer applied.
   - `blocked`, `agent_limit` or an error: this simplification is set aside, not the PR. Run:
     ```bash
     tdd-flow set-aside <<'TDD_FLOW_JSON'
     {"slug": "<slug>", "label": "simplify-<n>"}
     TDD_FLOW_JSON
     ```
     It saves the uncommitted changes as a patch in the shared git dir and restores the working tree. Note the finding, the reason and the `patch` path, then continue with the next finding.

## 3. Code review (superpowers)

Invoke the `superpowers:requesting-code-review` skill and follow it, with:

- `BASE_SHA` = `git merge-base <base> HEAD`, `HEAD_SHA` = `git rev-parse HEAD` (the review covers the simplification commits too)
- `{DESCRIPTION}` = the spec's goal (first paragraph of `.tdd-flow/features/<slug>/spec.md`) and the list of tasks
- `{PLAN_OR_REQUIREMENTS}` = "`.tdd-flow/features/<slug>/spec.md` (acceptance criteria and edge cases)"

If that skill is not available, dispatch the `tdd-flow:code-reviewer` agent on `git diff <base>...HEAD` against the spec instead, and sort its blocker/major/minor findings into Critical/Important/Minor.

Sort the findings by severity. You act as the executor in that skill: drop a finding only with a technical reason, and keep the reason for the PR body.

## 4. One fix round

If there are Critical or Important findings, run the workflow `tdd-flow:tdd-implement` once more with `{"feature": "<slug>", "findings": [...]}`. Write each finding as one string: `"<severity>: <file:line> - <issue>. Expected: <fix>"`.

- `implemented` → continue. Do **not** review again (one review pass per change).
- `blocked`, `agent_limit` or an error → report blocked with the details, and say which findings are still open. A finding that needs a product call → **report a decision**.

Minor findings are not fixed; they go into the PR body.

## 5. Push and open the PR

1. `gh pr list --head feature/<slug> --state all --json number,state,url --limit 1`
   - `MERGED` → report blocked ("feature/<slug> was already merged; start a new branch").
   - `OPEN` → push only (it updates that PR) and use its URL.
2. Bring the base in, with the Bash tool and `timeout: 600000` (it may run the generate command):
   ```bash
   tdd-flow sync-base <<'TDD_FLOW_JSON'
   {"base": "<base>"}
   TDD_FLOW_JSON
   ```
   It merges `origin/<base>` into the branch, so conflicts with specs merged in the meantime show up here and not when the PR is merged. It never rebases, so an open PR needs no force-push. Running this skill (and the autopilot) is the user's approval for this merge. Conflicts in `generated files` from `stack.md` are resolved by running the `generate command`, in the same merge commit; with nothing to merge, it still regenerates and commits stale generated files.
   - `conflict` → report blocked: "`<base>` conflicts in <files>: run `git merge origin/<base>` in the worktree, resolve, commit, then `/tdd-flow:autopilot <slug>`" (`reason` says which files). The merge is already aborted, so the branch is as it was.
   - `generateFailed` → report blocked with `reason`.
   - `merged` or `regenerated` → note it for the PR body (**Test plan**).
3. `git push -u origin feature/<slug>`. The push-gate hook runs the type check, lint, tests and a secret scan first, after a merge on the merged code. If it blocks the push, report blocked with the gate's message. Never bypass it (`--no-verify`, `TDD_FLOW_PUSH_GATE=off`).
4. With no open PR: `gh pr create --base <base> --head feature/<slug> --title "<type>(<slug>): <spec title>" --body-file <file>`. The spec title is its first `# ` heading. A spec without one takes the issue title (`gh issue view <n> --json title`) when `Source:` names an issue, else the first sentence of `## Goal`. `<type>` is `refactor` for a spec with `Source: tdd-flow simplify-codebase`, otherwise `feat`. (write the body to a file in the scratchpad or a temp directory). Body:
   - **Summary**: the spec's goal, with a link to the source issue if `spec.md` has `Source:` with an issue
   - **Acceptance criteria**: AC ids with one line each
   - **Tasks**: the commits from step 1 (`git log --oneline <base>..HEAD`), and refactor tasks skipped with their reason
   - **Simplification**: the changes step 2 applied (commits). Also, with their reasons: proposals refuted by the verifier (`dropped`), proposals set aside, with the patch path, and proposals that no longer applied. "Lean already" if there were none.
   - **Code review**: counts per severity; what the fix round fixed; Minor findings as a list; findings set aside, with the reason
   - **Not verified here**: the `unverified` list from step 1 (verify commands that could not run), if any
   - **Test plan**: the test command from `.tdd-flow/stack.md`, that the push-gate ran it before the push, and whether `sync-base` merged `<base>` or regenerated files
   - the attribution line your instructions give for PR descriptions
5. Read the URL that `gh pr create` printed (or `gh pr view --json url`).

## 6. Record the result

```bash
tdd-flow run-report <<'TDD_FLOW_JSON'
{"slug": "<slug>", "status": "done", "prUrl": "<url>"}
TDD_FLOW_JSON
```

End with one line: slug, PR URL, number of tasks, simplifications applied, number of review findings fixed and the number left in the PR.
