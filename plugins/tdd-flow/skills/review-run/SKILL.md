---
name: review-run
description: This skill should be used when the user runs /tdd-flow:review-run, or asks to look at how a tdd-flow run went - "review that autopilot run", "go through session <id>", "why did it ask so many questions", "why did the spec stop", "what did not work in the last run", "did sync-base / the decision / the pre-flight behave as intended" - for an autopilot, implement-spec, analyze-requirements or ship-feature session that already ran. Use it whenever the user points at a finished or stuck tdd-flow session and wants to know what happened, even if they do not say "review". It reads the session transcript and the repo state, and reports in chat what went wrong, why, and whether the fix belongs in the plugin, in the repo or nowhere.
argument-hint: "[session-id | job name | spec slug]"
---

# Review a tdd-flow run

Input: $ARGUMENTS - a session id (full or the 8-char prefix), the `claude --bg` job name, or a spec slug. Without it, list the last few finished background sessions (`claude agents --json --all`, kind `background`, state `done`, `blocked` or `stopped`, newest first) and ask which one.

This is a read-only investigation. Do not edit files, do not commit, do not restart sessions. The result is a report in chat; fixes are a separate step the user asks for afterwards.

The helper script is `scripts/transcript.cjs` in this skill's base directory (printed above as "Base directory for this skill"). Run it with `node`. It streams the transcript, so a multi-megabyte file is fine; it never prints a whole file, so use its filters instead of `cat`.

```bash
node <base>/scripts/transcript.cjs locate <id | name | slug>      # transcript path(s), job state, run file
node <base>/scripts/transcript.cjs summary <file.jsonl>            # key events with line numbers
node <base>/scripts/transcript.cjs show <file.jsonl> --from 410 --to 480 [--grep <regex>] [--role tool|result|user|assistant] [--max 1500] [--lines 300]
node <base>/scripts/transcript.cjs agents <file.jsonl>             # subagents and workflow runs, with their transcript files
```

## 1. Find the session and the facts around it

1. `locate`. A slug matches the background session in the worktree (the run itself) and, listed separately as "main-checkout sessions", the user's session that started the autopilot or ran the analysis. Review the run first; open the main session for what happened around it (the analysis and its critics, the pre-flight, the decision the user answered, `runs-wait`). If several transcripts match and it is not clear which one the user means, ask.
2. From the transcript's first lines, note which plugin version ran: the skill text starts with `Base directory for this skill: .../tdd-flow/<version>/skills/...`. The user may have updated the plugin since; findings have to be judged against the version that ran, and the report says when the installed version already differs.
3. Collect the repo-side facts, from the repo the session ran in (the `cwd` that `locate` prints; the worktree may be gone, then use the main checkout):
   - the run file `<git common dir>/tdd-flow/runs/<slug>.json` if it still exists (cleanup removes it after the merge);
   - the PR: `gh pr list --head feature/<slug> --state all --json number,state,mergedAt,url,createdAt`, and `gh pr view <n> --json commits,statusCheckRollup` for the commit list and CI;
   - `git log --format='%h %ad %s' --date=format:'%d.%m %H:%M' origin/<base>..<branch>` or the PR's commits;
   - the spec: `## Open questions`, `## Resolved questions`, the task table, every `- **Verify:**` line, and `.tdd-flow/stack.md` (test commands, `tests need`, `generate command`);
   - for a question raised during the run, the base commit the analysis ran on: did the thing the question is about already exist there (`git show <base-sha>:<file> | grep ...`)? That decides whether the analysis could have caught it.

## 2. Read the run

1. `summary` gives the timeline: commands, workflow runs, decisions (`RUN` lines with `blocked`), questions (`ASK`, `USER`), denied tool calls, cross-session messages, compaction points, pushes and PRs. Start from the end: how did it finish, and did `run-report` match what really happened (PR open, branch pushed, tasks ticked)?
2. For each event that matters, open the surrounding lines with `show --from --to` and read the assistant's own explanation: a background session usually says why it stopped. Check its claim against the evidence (the tool result, the commit, the file), not against its wording.
3. Workflow steps live in separate transcripts. `agents` lists them with the label the workflow gave each one (`T-13 GREEN`, `critic:completeness`, `review 1`). Open the one you need with `show --grep` and look at what the agent actually ran: the test commands, their output, what it staged.
4. Typical places where runs go wrong, each worth one check:
   - **Questions during implementation.** A decision in a background session means the spec was wrong or contradicted the code. Find the contradiction, then ask whether the analysis saw the same code (step 1.3). If the test or behaviour already existed at the analysis base, the analysis missed it.
   - **A red suite that got committed.** Compare `test command (all)` in `stack.md` with what the repo really has (a second package, a frontend). A task's "full suite PASS" means only what that command runs.
   - **Blocked at `sync-base`, the push or the PR.** Read the CLI result (`conflict`, `generateFailed`, push-gate output, `gh` errors) and what the session did next: stop with `run-report`, or improvise.
   - **Denied tool calls and prompts.** `DENIED` lines, or a long gap before a `USER` message, mean the session waited for a human. Check which rule or hook stopped it and whether the pre-flight should have warned.
   - **Stale state.** A worktree started from an old base, a `Verify` command or allow-list a later answer did not update, a run file that disagrees with the session state, `tasks.md` ticks that do not match the commits.
   - **Shell and loops.** Repeated identical commands in a short time (a polling loop), bare `cd` in a main session, commands run from the wrong directory.
   - **Compaction.** After a `COMPACTED` line the session worked from a summary. A mistake right after it may come from a detail the summary dropped.
5. Compare what happened with what the plugin text of that version promises: the skill that ran, the workflow and the agent files under the base directory from step 1.2. A step the text describes and the session skipped, or did differently, is a plugin finding even when the outcome was fine.

## 3. Classify and report

Each finding gets one of three classes, and the class decides where the fix goes:
- **plugin**: the skill, workflow, agent text or CLI did not do what it says, or lacks a check that would have caught this. Name the file and the step.
- **repo**: the repository's own setup caused it: `stack.md`, the spec, `CLAUDE.md`, a tracked file that should be ignored, a flaky test. Name the file.
- **one-off**: a human action, the network, a rate limit, a tool outage. Nothing to change, unless it repeats.

A finding without evidence is a guess; say so. Put the transcript line numbers, commit shas and file paths in the finding, so the user can look for themselves. Keep raw excerpts short: transcripts carry environment output and sometimes tokens, and the report is chat. Do not quote more than a line or two of any tool result.

Report in the user's language, in this shape:

```
## Run <slug or job name> - session <8-char id>, tdd-flow <version>, <start> .. <end>
Outcome: <done | blocked | ...>; <n/m tasks>; PR <url or none>; <k> question(s) asked; <wall time>.

### Findings
1. **<what, in one line>** - plugin | repo | one-off
   - What happened: <facts with transcript line numbers, commits, files>
   - Why: <the cause, and whether the plugin or the analysis could have caught it>
   - Fix: <the concrete change, or "none">
2. ...

### Worked as designed
- <checks that passed and are worth knowing: sync-base, decision flow, push-gate, pre-flight ...>

### Not checked
- <what you could not verify and why: transcript missing, worktree gone, no PR>
```

End with one question: which of the findings the user wants fixed now (plugin changes go through a PR in the plugin repo; repo changes through a PR in that repo). Do not start fixing before the answer.
