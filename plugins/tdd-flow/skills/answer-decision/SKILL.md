---
name: answer-decision
description: This skill should be used when the tdd-flow status pane sends an answer (/tdd-flow:answer-decision <slug> Q-<n> <answer>), or the user asks to "answer the decision of <slug>", "answer Q-<n> of <slug> with ..." or "use the recommendation for <slug>". It applies the answer to a blocked autopilot spec in its worktree, commits it, and starts that spec's background session again.
argument-hint: "<slug> Q-<n> <answer>"
---

# Answer a decision of a blocked spec

Input: $ARGUMENTS - `<slug> Q-<n> <answer>`: the spec, the question id of its run's `decision`, and the answer (the rest of the line, as the user wrote or picked it). If one of the three is missing, say what is missing and stop.

This is the autopilot's **Decisions** procedure for one spec, run in whatever session the answer came from (the status pane's, usually). The steps are in `skills/autopilot/SKILL.md`; follow them there and do not change them here. `tdd-flow` is the plugin CLI on the Bash `PATH`. Run it from the main checkout's root; never use a bare `cd` (use `git -C` and subshells).

## 1. Check the decision

```bash
tdd-flow status <<'TDD_FLOW_JSON'
{}
TDD_FLOW_JSON
```

Find the row of `<slug>`. Go on only if its `status` is `blocked` and its `decision.id` is `Q-<n>`. Otherwise say what the row shows instead (running again, another question, no such spec) and stop: the answer was already applied, or the question changed.

## 2. Apply the answer and commit

Do autopilot **Decisions** step 3 with this answer, in `.claude/worktrees/<slug>`: move the question to `## Resolved questions` with the answer, update what it changes, keep or set `Status: approved` (add a task for the answer when the spec says `implemented`), and commit with `docs(<slug>): answer Q-<n>`. The answer comes from the user through the pane, so it approves the change as an answer in chat does.

## 3. Remove the old session

Autopilot **Decisions** step 4: `claude rm <session>` with the run's `session` id, only when `claude agents --json --all` does not list it as `working`. A failed `rm` is noted, not an error.

## 4. Start the spec again

Autopilot step **2. Start sessions**, items 1-4, for this one spec: `tdd-flow worktree` (it reuses the worktree), the session name (reuse the old session's name when it is free), `claude --bg` in a subshell with `/tdd-flow:implement-spec <slug> <base>` (`<base>` from `tdd-flow specs {"slugs": ["<slug>"]}`), then `tdd-flow run-report` with `status: "running"` and the new session id. The new session resumes from the first open task.

## 5. Report

One line: `<slug>: Q-<n> answered (<answer, cut to 80>), running again as <name>` and `claude attach <name>`. If an autopilot is waiting in another session, it sees the spec running at its next `runs-wait` return and must not ask this decision again.
