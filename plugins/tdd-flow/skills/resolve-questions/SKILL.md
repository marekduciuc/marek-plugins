---
name: resolve-questions
description: This skill should be used when the user runs /tdd-flow:resolve-questions, or asks to "answer the open questions of a spec", "go through the spec questions", "resolve the open questions" or "clarify the spec before approval". It walks the Open questions of one tdd-flow spec one at a time in chat and updates spec.md (and tasks.md) after each answer.
argument-hint: "[feature-slug]"
---

# Resolve the open questions of a spec

Input: $ARGUMENTS - the feature slug. Without it, use `feature` from `.tdd-flow/state.json`. If neither names a spec, list the folders in `.tdd-flow/features/` whose `spec.md` has entries under `## Open questions`, and ask which one.

Files: `.tdd-flow/features/<slug>/spec.md` and `tasks.md`. The format is in the `requirements-analyst` agent: questions are lines `- Q-<n> <question> - *assumption if unanswered:* <assumption>` under `## Open questions`.

## 1. Show all questions

Read `spec.md`. Print every open question in chat as a numbered list: id, question, and the assumption. Also print the spec's `Status`. If there are none, say so and stop.

If the status is `approved` or later (`implemented`, `done`), say that an answer which changes the acceptance criteria or tasks sets the spec back to `draft`. Then it needs approval again before the autopilot or `tdd-implement` takes it. Ask whether to go on.

## 2. One question at a time

For each question, in order:

1. Ask it in chat as plain text: the id, the question, why it matters (which AC, edge case or task depends on it) and the assumption. The user can answer it, accept the assumption, or skip it. Do not ask the next question in the same message. Wait for the answer.
2. Apply the answer to `spec.md` right away:
   - **Move the question.** Take it out of `## Open questions` and put it under `## Resolved questions` (create the section after Open questions if it is missing): `- Q-<n> <question> - **Answer:** <answer> (<dd.MM.yyyy>) → <where it went: AC-3, EC-2, Out of scope, or "no change">`. An accepted assumption is written as `**Answer:** assumption accepted: <assumption>`.
   - **Change what the answer decides.** Edit the acceptance criteria (Given/When/Then), edge cases, out of scope and the task table. Keep the existing ids. A new criterion takes the next free number (`AC-7`, `EC-4`), and a removed one is deleted, not renumbered, so references stay valid.
   - **Keep `tasks.md` in step** with the task table: the same ids, titles and AC lists.
   - **Set `Status: draft`** if the spec was approved and the answer changed criteria or tasks.
3. In one line, say what changed (sections and ids). If an answer raises a new question, add it to `## Open questions` with an assumption and ask it at the end.

A skipped question stays under `## Open questions` as it is.

## 3. Finish

Print the result:
- the answered questions, each with where it went;
- the questions still open;
- whether `Status` changed.

Then ask whether to approve the spec (`Status: approved`). Set it only on an explicit yes in this conversation. Do not commit. The autopilot needs the spec committed on the base branch, so tell the user to commit `spec.md` and `tasks.md` when they are done.
