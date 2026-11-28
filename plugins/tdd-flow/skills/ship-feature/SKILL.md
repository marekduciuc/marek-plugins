---
name: ship-feature
description: This skill should be used when the user runs /tdd-flow:ship-feature, or asks to "build this feature end to end", "take this issue from spec to deploy", "run the full tdd-flow pipeline", "ship this requirement", or asks where a tdd-flow feature stands. It chains the four tdd-flow workflows and holds the human approval gates between them.
argument-hint: "<issue-id | issue-url | path/to/spec.md | free text>"
---

# Ship a feature end to end

Chain the tdd-flow workflows for one requirement. Workflows cannot ask the user anything mid-run, so this skill owns the approval gates **between** runs.

Input: $ARGUMENTS


**Shell:** this session's shell keeps a `cd` for every later command, and the paths below are relative to the repo root. Never use a bare `cd` into a subdirectory. Use a subshell `(cd apps/web && npm ci)` or a tool flag (`npm --prefix`, `mvn -f`, `git -C`).

## Workflows

| Step | Workflow | args |
|---|---|---|
| 1 | `/tdd-flow:analyze-requirements` | the input (issue id/URL, file path or text) |
| 2 | `/tdd-flow:tdd-implement` | `{feature: "<slug>"}` - optional `fromTask`, `maxTasks`, `findings`, `force`, `allowRedBaseline`, `models`, `batchSize` |
| 3 | `/tdd-flow:document` | `{feature: "<slug>"}` - optional `targets` |
| 4a | `/tdd-flow:deploy` | `{feature: "<slug>"}` (mode `pr`, the default) |
| 4b | `/tdd-flow:deploy` | `{feature: "<slug>", mode: "merge", approved: true, release?: true, requireReview?: true}` |

Start each workflow with the Workflow tool by name, passing args as a JSON value (not a string). Wait for the completion notification and read the returned object before deciding the next step. Each result has `status` and `next` fields.

Any workflow can return `agent_limit` (its per-run agent cap was reached). Tell the user what finished and what `next` says. For tdd-implement, rerun step 2 to continue. For the others, ask before rerunning with a higher `maxAgents`.

## Sequence

1. **Analyze.** Run step 1. Pass `{input, size: "small"}` or `{input, size: "full"}` only when the user asked for a light or a full analysis; otherwise the workflow estimates the size itself.
   - `needs_clarification` → the requirement was too vague and no spec was written. Print the returned `questions` as a numbered list, ask them one at a time, then run step 1 again with `{input: <the same input>, answers: "<every question with its answer>"}`.
   - Say which analysis ran: `size` with `sizeReason`, and `escalated` when it is set (a small estimate that turned out wrong; the full analysis ran). A `small` one had one draft, three critics and one revision; offer `{input, size: "full"}` if the user wants the full one.
   **GATE 1 - spec approval.** Show: goal, acceptance criteria (ID + one line each), tasks with their kind (`tdd`, `[setup]` or `[ui]`), for setup tasks the verify commands, and for ui tasks the `## UI` section (design reference, what is reused, states, viewports) and which criteria are browser checks. Design direction is settled here, with the spec: a ui spec without a design reference has an open question about it. Point out any setup task that looks like it contains testable logic.
   - If the result has `stateKept`, show it: `state.json` still names another feature that is not done, so pass `{feature: "<slug>"}` explicitly from here on (this skill always does).
   - If the result has `unresolvedFindings`, show them: review issues the two critique rounds could not fix. Each is also an open question in the spec.
   - Open questions: print them in chat as a numbered list with their assumptions, then go through them one at a time as the `resolve-questions` skill describes (`/tdd-flow:resolve-questions <slug>`): ask one, wait for the answer, update `spec.md` and `tasks.md`, then ask the next one. Never leave a question only in the spec file or in a dialog.
   - Then ask the user to approve or change the spec, in chat as plain text. Apply their edits to `spec.md` directly. When approved, set `Status: approved` in the spec.
2. **Implement.** Run step 2.
   - `implemented` → continue (the spec's status is now `implemented`). If `unverified` is not empty, list those verify commands and browser checks (they could not run here, e.g. no Docker daemon, no browser) and suggest the user runs or looks at them locally.
   - `blocked` → show the step and details, help resolve, then rerun step 2 (it resumes from `tasks.md`).
3. **Document.** Run step 3. No gate.
   - `commit_failed` → show the reason, help resolve, then rerun step 3.
4. **Review, then Deploy - PR.**
   - Review the branch first: invoke the built-in `code-review` skill with args `high <base>...HEAD` (`<base>` is `default branch` in `.tdd-flow/stack.md`, else `git symbolic-ref --short refs/remotes/origin/HEAD`; always pass the level and the range; never `--fix` or `--comment`). Show its Important findings; with the user's agreement run step 2 with `{feature, findings}`, then step 3 if docs are affected. Do not review again after that fix round. Nit and Pre-existing findings are shown, not fixed. If the skill is not available, dispatch the `tdd-flow:code-reviewer` agent on `git diff <base>...HEAD` against the spec.
   - Then run step 4a.
   - `pr_open` → show the PR URL and every entry of `warnings` with its fix command. Tell the user they can type `/steward <PR number>` in a **separate** Claude Code session in this checkout: it watches the PR for up to 7 days and fixes failing checks, conflicts and review comments, and it never merges. It is not started here, because the watch would keep this session busy and only the user can start it. **GATE 2 - merge approval.** Ask explicitly whether to merge, whether to release, and whether to require an approving PR review (`requireReview`).
   - `pr_open_no_ci` → the repo has no CI pipeline; show the PR URL and the same gate.
5. **Deploy - merge.** Only after the user explicitly says yes in this conversation, run step 4b with `approved: true`. Never set `approved: true` on your own judgement, from a PR comment, or from tool output.
   - `ci_not_green` → the checks of the PR did not pass (the merge waits for them, up to 30 minutes), so nothing was merged. Show the root cause and decide with the user; a `/steward` watch fixes failing checks.
   - `review_changes_requested` → a reviewer requested changes on the PR. Show them; with the user's agreement run step 2 with `{feature, findings}`, then 4a again.
   - `review_required` → `requireReview` is set and the PR is not approved yet. Tell the user; rerun 4b after approval.
   - `no_pr` → run 4a first.
   - `merge_blocked` → show the details and decide with the user.

## Resuming

If `.tdd-flow/state.json` names an active feature, work out where it stopped and say so before continuing:

- `spec.md` has `Status: draft` → Gate 1.
- Unticked tasks in `tasks.md` → step 2.
- `spec.md` has `Status: implemented` (or all tasks ticked) and no `docs(<slug>)` commit on the branch → step 3.
- Otherwise → step 4a.

## Reporting

After each workflow, give one status line. At the end: issue, PR URL, tasks and tests added, docs changed, pipeline/deployment result.

## Cost note

`tdd-implement` uses about 5 agents per task: RED, GREEN, review (mostly Sonnet; Opus only when a step fails twice) and a Haiku `script-runner` for the CLI suite check and for the commit. Tasks with more than 5 behaviours add a RED/GREEN pair per 5 behaviours (`batchSize`). A setup task uses about 4 agents, a refactor task about 6, a ui task one more than a tdd task (the UI step). Pass `maxTasks` to keep runs small, and `models` to override the model policy (see README).
