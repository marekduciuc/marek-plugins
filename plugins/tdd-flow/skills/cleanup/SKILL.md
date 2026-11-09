---
name: cleanup
description: This skill should be used when the user runs /tdd-flow:cleanup, or asks to "clean up the worktrees", "remove the merged specs' worktrees", "free disk space from the autopilot" or "delete finished autopilot runs". It removes the worktree, background session, run file and branch of every tdd-flow spec whose PR is merged, and says why it keeps the others. The autopilot runs the same step at its start.
argument-hint: ""
---

# Cleanup: remove the worktrees of merged specs

Run from the main checkout's root, not from a worktree. `tdd-flow` is the plugin CLI (on the Bash `PATH`); it takes JSON on stdin and prints `{"ok": ..., "result": ...}`.

```bash
tdd-flow cleanup <<'TDD_FLOW_JSON'
{}
TDD_FLOW_JSON
```

It removes the worktree, background session, run file and branch (`git branch -d`) of every spec whose PR is merged with nothing after it, and never forces. A worktree is kept, with the reason, while any of these holds:
- a PR is open, or the branch has newer commits;
- a session there is still open;
- it has uncommitted or untracked changes;
- it has ignored files other than build output, dependencies and IDE metadata (a `.env`, a local database).

Show:
- one line per removed spec: slug, PR, MB freed;
- one line per kept spec: slug - why;
- every entry of `notes`;
- `skipped` as a warning.

On `ok: false`, show the error: it says what to fix (for example, run it from the main checkout).

Do not remove a kept worktree by hand to "finish" the cleanup. Say what the user has to do first, for example commit or delete the uncommitted changes, or close the session with `claude stop <name>`.
