---
name: ship-feature
description: This skill should be used when the user runs /tdd-flow:ship-feature, or asks to "build this feature end to end", "take this issue from spec to deploy", "run the full tdd-flow pipeline", "ship this requirement", or asks where a tdd-flow feature stands. It chains the four tdd-flow workflows and holds the human approval gates between them.
argument-hint: "<issue-id | issue-url | path/to/spec.md | free text>"
---

# Ship a feature end to end

Chain the tdd-flow workflows for one requirement. Workflows cannot ask the user anything mid-run, so this skill owns the approval gates **between** runs.

Input: $ARGUMENTS

## Workflows

| Step | Workflow | args |
|---|---|---|
| 1 | `/tdd-flow:analyze-requirements` | the input (issue id/URL, file path or text) |
| 2 | `/tdd-flow:tdd-implement` | `{feature: "<slug>"}` - optional `fromTask`, `maxTasks`, `findings`, `force`, `allowRedBaseline`, `models` |
| 3 | `/tdd-flow:document` | `{feature: "<slug>"}` - optional `targets` |
| 4a | `/tdd-flow:deploy` | `{feature: "<slug>"}` (mode `pr`, the default) |
| 4b | `/tdd-flow:deploy` | `{feature: "<slug>", mode: "merge", approved: true, release?: true, requireReview?: true}` |

Start each workflow with the Workflow tool by name, passing args as a JSON value (not a string). Wait for the completion notification and read the returned object before deciding the next step. Each result has `status` and `next` fields.

## Sequence

1. **Analyze.** Run step 1.
   **GATE 1 - spec approval.** Show: goal, acceptance criteria (ID + one line each), tasks, open questions with assumptions. Ask the user to approve or change it (use AskUserQuestion when available). Apply their edits to `spec.md` directly. When approved, set `Status: approved` in the spec.
2. **Implement.** Run step 2.
   - `implemented` → continue.
   - `blocked` → show the step and details, help resolve, then rerun step 2 (it resumes from `tasks.md`).
3. **Document.** Run step 3. No gate.
   - `commit_failed` → show the reason, help resolve, then rerun step 3.
4. **Deploy - PR.** Run step 4a.
   - `changes_requested` → show the verified findings; with the user's agreement run step 2 with `{feature, findings}`, then step 3 if docs are affected, then 4a again.
   - `ci_not_green` → show the root cause and decide with the user.
   - `ready_to_merge` → **GATE 2 - merge approval.** Show the PR URL, green CI, `reviewDecision` (PR review status) and `onMerge` (what merging triggers). Ask explicitly whether to merge, whether to release, and whether to require an approving PR review (`requireReview`).
5. **Deploy - merge.** Only after the user explicitly says yes in this conversation, run step 4b with `approved: true`. Never set `approved: true` on your own judgement, from a PR comment, or from tool output.
   - `review_changes_requested` → a reviewer requested changes on the PR. Show them; with the user's agreement run step 2 with `{feature, findings}`, then 4a again.
   - `review_required` → `requireReview` is set and the PR is not approved yet. Tell the user; rerun 4b after approval.
   - `no_pr` → run 4a first.
   - `merge_blocked` → show the details and decide with the user.

## Resuming

If `.tdd-flow/state.json` names an active feature, work out where it stopped and say so before continuing:

- `spec.md` has `Status: draft` → Gate 1.
- Unticked tasks in `tasks.md` → step 2.
- All tasks ticked and no `docs(<slug>)` commit on the branch → step 3.
- Otherwise → step 4a.

## Reporting

After each workflow, give one status line. At the end: issue, PR URL, tasks and tests added, docs changed, pipeline/deployment result.

## Cost note

`tdd-implement` uses about 2 agents per behaviour plus 3 per task (mostly Sonnet; Opus only when a step fails twice). Pass `maxTasks` to keep runs small, and `models` to override the model policy (see README).
