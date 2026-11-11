---
name: answer-decision
description: This skill should be used when the tdd-flow status pane sends an answer (/tdd-flow:answer-decision <slug> Q-<n> <answer>), or the user asks to "answer the decision of <slug>", "answer Q-<n> of <slug> with ..." or "use the recommendation for <slug>". It applies the answer to a blocked autopilot spec in its worktree, commits it, and starts that spec's background session again.
argument-hint: "<slug> Q-<n> <answer>"
---

# Answer a decision of a blocked spec

Input: $ARGUMENTS - `<slug> Q-<n> <answer>`: the spec, the question id of its run's `decision`, and the answer (the rest of the line, as the user wrote or picked it). If one of the three is missing, say what is missing and stop.

This is the autopilot's **Decisions** procedure for one spec, run in whatever session the answer came from (the status pane's, usually). `tdd-flow` is the plugin CLI on the Bash `PATH`. Run it from the main checkout's root; never use a bare `cd` (use `git -C` and subshells).

## 1. Check the decision

```bash
tdd-flow status <<'TDD_FLOW_JSON'
{}
TDD_FLOW_JSON
```

Find the row of `<slug>`. Go on only if its `status` is `blocked` and its `decision.id` is `Q-<n>`. Otherwise say what the row shows instead (running again, another question, no such spec) and stop: the answer was already applied, or the question changed.

## 2. Edit what the answer changes

In `.claude/worktrees/<slug>/.tdd-flow/features/<slug>/`, update the criteria, edge cases, task table, `tasks.md` and the **Verify** commands the answer changes (an allow-list of test edits, protected paths), as the `resolve-questions` skill does. Keep the existing ids. If `spec.md` says `Status: implemented` (the decision came after every task was ticked), add a task for the answer to the task table and `tasks.md` (`- [ ] T-<next> <what the answer changes> (<AC ids>)`); otherwise the restart finds nothing to do. Do not move the question, change `Status` or commit: the next step does that. The answer comes from the user through the pane, so it approves the change as an answer in chat does.

## 3. Record the answer and start the spec again

```bash
tdd-flow answer-decision <<'TDD_FLOW_JSON'
{"slug": "<slug>", "id": "Q-<n>", "answer": "<answer>", "where": "<the ids step 2 changed, e.g. AC-3, T-5; leave the key out for no change>"}
TDD_FLOW_JSON
```

It checks again that the run waits on `Q-<n>`, moves the question to `## Resolved questions` with the answer and today's date, sets an `implemented` spec back to `approved` (it refuses when `tasks.md` has no open task: add the task, step 2, and run it again), commits `docs(<slug>): answer Q-<n>` in the worktree, removes the old session unless it is `working`, starts the spec again with `claude --bg` in its worktree (the old session's name when it is free) and records the run as `running`. An error names the step that failed and keeps the steps before it; after fixing the cause, run the same command again: it skips what is done.

## 4. Report

One line from the result: `<slug>: Q-<n> answered (<answer, cut to 80>), running again as <name>`, its `attach` command, and each entry of `notes`. If an autopilot is waiting in another session, it sees the spec running at its next `runs-wait` return and must not ask this decision again.
