# `starting` status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a spec whose background session has just been started reports `starting` everywhere (status, board, runs-wait, pane) instead of `stalled`.

**Architecture:** `tdd-flow worktree` writes a run file `{status: 'starting'}`; `runState` maps a young `starting`/`running` run without a working session to `starting`; the readers (runs-wait, pane) treat `starting` like `running` except for the restart button.

**Tech Stack:** Node (no dependencies), `node:test` for `tests/cli.test.cjs`, the Claude Code plugin test runner for `tests/pane.test.tsx`.

**Spec:** `docs/plans/2026-11-18-tdd-flow-starting-status.md`

## Global Constraints

- Precondition: the uncommitted 0.27.1 change (`resumed` in `runState`, its test) is committed and merged first; this work starts from that `main` on a new branch `tdd-flow/feature/starting-status` (git-workflow skill).
- `run-report` still accepts only `running`, `done`, `blocked`; `starting` is written by the CLI only.
- Grace is the existing `START_GRACE_MS` (90000). Stalled details for a `starting` run: exactly `session did not start within 90 s`.
- Pane: kind `starting`, colour `suggestion`; order decision, blocked, stalled, starting, running, queued, done; no restart button.
- Version 0.28.0 in both `plugins/tdd-flow/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
- Tests: `node --test plugins/tdd-flow/tests/` and `claude plugin test plugins/tdd-flow`, both from the repo root.

## Review Focus

1. **Old idle session in the same worktree.** A `starting` run has no session id, so `findSession` matches by worktree directory and can find the previous run's `done` session (restart kept it, or `claude rm` failed). Expected: `starting` until the grace ends, not an instant `stalled`. Test in Task 1.
2. **`claude agents` fails during `worktree`.** Expected: a `running` run file is left untouched (its session may be working). Test in Task 1.
3. **`restart` right after a restart.** The new session is not listed yet. Expected: refused with `is starting`. Existing restart test updated in Task 1.
4. **`runs-wait` on a slug that never starts.** Expected: keeps waiting during the grace, then returns it as `stalled`. Test in Task 2.
5. **"answer sent" in the pane after an answer.** The spec goes `blocked` → `starting` → `running`. Expected: "answer sent" clears at `starting`. Test in Task 3.

---

### Task 1: run file `starting` and `runState`

**Files:**
- Modify: `plugins/tdd-flow/bin/tdd-flow` — `worktree()` (~1586), `runState()` (~1819), its doc comment
- Test: `plugins/tdd-flow/tests/cli.test.cjs`

**Interfaces:**
- Produces: `runState(slug, sessions, root)` may return `{slug, status: 'starting', attach?}`. `worktree()` result unchanged.

- [ ] **Step 1: Write the failing tests** (next to the `worktree` and `blocked run whose session works again` tests). Helper for aging a run file: reuse the pattern of the 0.27.1 test (rewrite `at` in `<git common dir>/tdd-flow/runs/<slug>.json`).

```js
test('a spec whose worktree exists but whose session has not reported yet is starting, then stalled after the grace', () => {
  const { dir } = trackedRepo();
  const none = fakeClaude([]);
  run(dir, 'worktree', { slug: '12-csv' }, none);
  assert.deepStrictEqual(runFile(dir, '12-csv').status, 'starting');
  assert.strictEqual(run(dir, 'status', { slugs: ['12-csv'] }, none).result.rows[0].status, 'starting');
  assert.match(run(dir, 'board', { slugs: ['12-csv'] }, none).result.table, /\| 12-csv \| starting \|/);
  age(dir, '12-csv', 5);
  const r = run(dir, 'board', { slugs: ['12-csv'] }, none).result.rows[0];
  assert.deepStrictEqual([r.status, r.details], ['stalled', 'session did not start within 90 s']);
});

test('a starting run is running once its session works, and starting while only the previous idle session is found', () => {
  const { dir } = trackedRepo();
  const wt = run(dir, 'worktree', { slug: '12-csv' }, fakeClaude([])).result.path;
  const at = (state) => fakeClaude([{ id: 's-1', kind: 'background', name: 'csv-export-flow', state, cwd: wt }]);
  assert.strictEqual(run(dir, 'status', { slugs: ['12-csv'] }, at('working')).result.rows[0].status, 'running');
  assert.strictEqual(run(dir, 'status', { slugs: ['12-csv'] }, at('done')).result.rows[0].status, 'starting');
});

test('a running run inside the grace whose session is not listed yet is starting; with a done session it is stalled', () => {
  const { dir } = trackedRepo();
  run(dir, 'run-report', { slug: '12-csv', status: 'running', session: 's-1' });
  assert.strictEqual(run(dir, 'board', { slugs: ['12-csv'] }, fakeClaude([])).result.rows[0].status, 'starting');
  const done = fakeClaude([{ id: 's-1', kind: 'background', name: 'csv-export-flow', state: 'done' }]);
  assert.strictEqual(run(dir, 'board', { slugs: ['12-csv'] }, done).result.rows[0].status, 'stalled');
});

test('worktree leaves the run file of a working session, and of a running run when claude agents fails', () => {
  const { dir } = trackedRepo();
  run(dir, 'run-report', { slug: '12-csv', status: 'running', session: 's-1' });
  const before = runFile(dir, '12-csv');
  run(dir, 'worktree', { slug: '12-csv' }, fakeClaude([{ id: 's-1', kind: 'background', name: 'x', state: 'working' }]));
  assert.deepStrictEqual(runFile(dir, '12-csv'), before);
  run(dir, 'worktree', { slug: '12-csv' }, failingClaude());
  assert.deepStrictEqual(runFile(dir, '12-csv'), before);
});
```

Add two small helpers at the top of the file: `runFile(dir, slug)` (parsed run file) and `age(dir, slug, minutes)` (sets `at` that many minutes back); `failingClaude()` is a fake `claude` that exits 1 (pattern in the `restart refuses` test). Update the 0.27.1-era assertion in `restart starts a blocked run without decision again`: `A second restart is refused` now matches `/starting/`. In the `runs-wait returns finished runs…` test, slug `d` stays in `running` (Task 2 makes that pass again).

- [ ] **Step 2: Run** `node --test plugins/tdd-flow/tests/cli.test.cjs` — Expected: the four new tests FAIL (`unknown`/`stalled`/`running` instead of `starting`).

- [ ] **Step 3: Implement.**
  - `worktree()`: at the end of both the reused and the created path, call `markStarting(slug)`: read the run; `sessions = claudeSessions(true)`; return unchanged when `sessions === null && run && run.status === 'running'`, or when `isLive(findSession(sessions || [], run, abs))`; else `writeRun(slug, {slug, status: 'starting', at: now})`.
  - `runState()`, in this order: (1) final and not resumed → the run, as now; (2) `isLive(s)` → `running`; (3) young (`< START_GRACE_MS`) and (`run.status === 'starting'`, or `run.status === 'running'` and `s` not `done`) → `starting`; (4) else `stalled`, details `session did not start within 90 s` for a `starting` run, today's details otherwise. Update the doc comment to name `starting`.

- [ ] **Step 4: Run** `node --test plugins/tdd-flow/tests/cli.test.cjs` — Expected: the new tests PASS; only the `runs-wait returns finished runs…` test fails (slug `d` is now in `finished`).

- [ ] **Step 5: Commit** `feat(tdd-flow): starting status for a spec whose session has not reported yet`.

### Task 2: `runs-wait` waits on `starting`

**Files:**
- Modify: `plugins/tdd-flow/bin/tdd-flow` — `runsWait()` (~1985), its doc comment
- Test: `plugins/tdd-flow/tests/cli.test.cjs`

**Interfaces:**
- Consumes: `runState` returning `starting` (Task 1).
- Produces: `runs-wait` lists a `starting` slug in `running` as `{slug, attach?}`, never in `finished`.

- [ ] **Step 1: Write the failing test**

```js
test('runs-wait keeps waiting on a starting spec and returns it as stalled when the grace ends', () => {
  const { dir } = trackedRepo();
  const none = fakeClaude([]);
  run(dir, 'worktree', { slug: '12-csv' }, none);
  const t = run(dir, 'runs-wait', { slugs: ['12-csv'], maxMinutes: 0.005 }, none).result;
  assert.deepStrictEqual([t.finished, t.running, t.timedOut], [[], [{ slug: '12-csv' }], true]);
  age(dir, '12-csv', 5);
  const r = run(dir, 'runs-wait', { slugs: ['12-csv'] }, none).result;
  assert.deepStrictEqual(r.finished.map((f) => [f.slug, f.status]), [['12-csv', 'stalled']]);
});
```

- [ ] **Step 2: Run** `node --test plugins/tdd-flow/tests/cli.test.cjs` — Expected: this test and `runs-wait returns finished runs…` FAIL.

- [ ] **Step 3: Implement** in `runsWait()`: a run is finished when its status is neither `running` nor `starting`. A `starting` slug goes into `running`; it has no task progress to track yet, so the progress block may run for it unchanged.

- [ ] **Step 4: Run** `node --test plugins/tdd-flow/tests/` — Expected: all PASS.

- [ ] **Step 5: Commit** `feat(tdd-flow): runs-wait waits on starting specs`.

### Task 3: status pane

**Files:**
- Modify: `plugins/tdd-flow/hooks/register.tsx` — `KINDS` (~26), `isActive` (~41), "answer sent" filter (~121), status line count (~136)
- Modify: `plugins/tdd-flow/types/index.d.ts` — doc comment on `StatusRow.status` listing the values incl. `starting`
- Test: `plugins/tdd-flow/tests/pane.test.tsx`

**Interfaces:**
- Consumes: status rows with `status: 'starting'` (Task 1).

- [ ] **Step 1: Write the failing tests** (style of `the restart button is on blocked rows…` and the sort test at ~141):
  - `a starting row sorts between stalled and running, has no restart button and opens the pane`: rows `[RUNNING, {…RUNNING, slug: '43-new', status: 'starting'}, stalled]`; status words in order `['stalled', 'starting', 'running']`; no `Button` with key `restart:43-new`; the pane opens with only a starting row (as the existing auto-open test does for running).
  - `"answer sent" clears when the spec is starting`: after sending an answer for `DECISION`, rows switch to `{…DECISION, status: 'starting', decision: undefined}`; "answer sent" text is gone.
  - The status line counts starting rows with running: one running and one starting row, pane closed → `tdd-flow: 2 running, 0 waiting`.

- [ ] **Step 2: Run** `claude plugin test plugins/tdd-flow` — Expected: the three new tests FAIL.

- [ ] **Step 3: Implement:** add `{ kind: 'starting', color: 'suggestion' }` between `stalled` and `running`; `isActive` includes `starting`; the "answer sent" filter keeps an entry only while the row is neither `starting` nor `running`; the status line count includes `starting`. `isRestartable` stays as it is.

- [ ] **Step 4: Run** `claude plugin test plugins/tdd-flow` — Expected: all PASS.

- [ ] **Step 5: Commit** `feat(tdd-flow): status pane shows starting specs`.

### Task 4: docs and release

**Files:**
- Modify: `plugins/tdd-flow/README.md` — rows `worktree`, `runs-wait`, `board`, `status`; the `stalled` bullet (~162); status pane "What it shows" order (~171) and "Opening" (~179)
- Modify: `plugins/tdd-flow/skills/autopilot/SKILL.md` — section 3: a `starting` spec takes a slot like `running` and is passed to `runs-wait`
- Modify: `plugins/tdd-flow/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.28.0`

- [ ] **Step 1:** Edit the docs: `worktree` writes a `starting` run file unless the session works; `starting` = worktree made or session started, not working yet, at most 90 s, then `stalled`.
- [ ] **Step 2:** Bump both versions to `0.28.0`.
- [ ] **Step 3: Run** `claude plugin validate .claude-plugin/marketplace.json` and `node --test plugins/tdd-flow/tests/` — Expected: valid, all PASS.
- [ ] **Step 4: Commit** `docs(tdd-flow): starting status; 0.28.0`. Then `git status --porcelain` is empty for these files.
