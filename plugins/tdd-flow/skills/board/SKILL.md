---
name: board
description: This skill should be used when the user runs /tdd-flow:board, or asks "how far are the specs", "show the autopilot status", "which specs are running" or "show the task table". It prints one table row per tdd-flow spec with a worktree or an autopilot run - status, ticked/total tasks and the open task, PR or the reason it stopped - without starting or changing anything.
argument-hint: "[slug ...]"
---

# Board: status of the autopilot specs

Input: $ARGUMENTS - optional feature slugs (default: every spec with a worktree in `.claude/worktrees/`, or a recorded autopilot run that is not done).

Read-only: this starts, stops and changes nothing.

Run from the main checkout's root (not from a worktree), passing the slugs from the input (`[]` for all):

```bash
tdd-flow board <<'TDD_FLOW_JSON'
{"slugs": []}
TDD_FLOW_JSON
```

On `ok: false`, show the error (it says what is missing, e.g. no worktree and no run yet) and stop.

Otherwise print `result.table` exactly as returned. Below it, only if there are any:
- for each `blocked` or `stalled` row: `claude attach <name>` is in the table; add that a blocked spec restarts with `/tdd-flow:autopilot <slug>` after the cause is fixed, and a stalled one needs `claude attach` and an answer;
- for each `done` row: its PR URL is in the table; nothing else to do here.

Add nothing else: no analysis of the specs, no file reads.
