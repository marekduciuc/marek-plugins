# Follow-ups #46 and #47 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** close the review follow-ups of tdd-flow 0.28.0 and 0.29.0 that hold for any project, as tdd-flow 0.30.0.

**Architecture:** all code changes are in `plugins/tdd-flow/bin/tdd-flow`: `runState`/`status`/`specs` for the starting status, `restartSpec` for the step order, `sharedPaths`/`worktree`/`autopilotCheck` for validation and cleanup. The compose scan is not touched.

**Tech Stack:** Node (no dependencies), `node:test` in `plugins/tdd-flow/tests/cli.test.cjs`.

**Spec:** `docs/plans/2026-11-18-tdd-flow-followups-46-47.md`

## Global Constraints

- Branch `tdd-flow/feature/followups-46-47` from `main` (42e7561, tdd-flow 0.29.0).
- No new dependency. `composeBindMounts` and `sharedPathsCheck`'s compose logic stay as they are.
- `specs` skip reason, exact: `is starting: its session is not working yet`.
- Restart error steps: 4 `prepare the worktree`, 5 `remove the old session`, 6 `restart`. `answer-decision` steps 1 to 3 unchanged.
- Record file: `<git common dir>/tdd-flow/shared-paths.json`, `{"declared": [...], "removed": [...]}`.
- Cleanup never deletes the main checkout's directory or data, an exclude line of an unrecorded path, or a link that does not resolve to the main checkout's path.
- Version 0.30.0 in `plugins/tdd-flow/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`; `claude plugin validate .claude-plugin/marketplace.json`.
- Suites: `node --test plugins/tdd-flow/tests/` and `claude plugin test plugins/tdd-flow`.

## Review Focus

1. **A path that is a prefix of another line in the exclude file.** Removing `/storage` must not delete `/storage/postgres` or `/storage-old`: only the exact line goes. Test in Task 3.
2. **A removed path that was never linked in this worktree** (nothing at the path, or a real directory): nothing is deleted, no error. Test in Task 3.
3. **A corrupt or hand-edited record file** (not JSON, wrong shape): treated as empty, the call still works. Test in Task 3.
4. **Restart when the worktree is fine:** the old session is still removed and the new one started, as before; only the order changed. Existing restart tests cover it and must stay green without edits other than step numbers. Task 2.
5. **A `starting` run whose session is found and works:** `attach` is there (it is `running`). Test in Task 1.

---

### Task 1: starting rows and `specs` (#46)

**Files:**
- Modify: `plugins/tdd-flow/bin/tdd-flow` — `runState()` (~1999), `status()` row (~2104), `specs()` (~1300)
- Test: `plugins/tdd-flow/tests/cli.test.cjs`

**Interfaces:**
- Produces: `runState` omits `attach` when `run.status === 'starting'` and the session is not working. `status` rows have `session: ''`, `sessionState: ''` in that case.

- [ ] **Step 1: Write the failing tests.**

```js
test('a starting row does not offer the previous session: no attach, session or sessionState, also once stalled', () => {
  const { dir } = trackedRepo();
  const wt = run(dir, 'worktree', { slug: '12-csv' }, fakeClaude([])).result.path;
  const old = (state) => fakeClaude([{ id: 's-0', kind: 'background', name: 'csv-export-flow', state, cwd: wt }]);
  const row = (env) => run(dir, 'status', { slugs: ['12-csv'] }, env).result.rows[0];
  assert.deepStrictEqual([row(old('done')).status, row(old('done')).attach, row(old('done')).session, row(old('done')).sessionState], ['starting', '', '', '']);
  assert.deepStrictEqual(run(dir, 'runs-wait', { slugs: ['12-csv'], maxMinutes: 0.005 }, old('done')).result.running, [{ slug: '12-csv' }]);
  const live = row(old('working'));
  assert.deepStrictEqual([live.status, live.attach, live.session], ['running', 'claude attach csv-export-flow', 'csv-export-flow']);
  age(dir, '12-csv', 5);
  assert.deepStrictEqual([row(old('done')).status, row(old('done')).attach], ['stalled', '']);
});

test('specs skips a spec that is starting, also when named, and lists it again after the grace', () => {
  const { dir } = trackedRepo();
  const none = fakeClaude([]);
  run(dir, 'worktree', { slug: '12-csv' }, none);
  for (const inp of [{}, { slugs: ['12-csv'] }]) {
    const r = run(dir, 'specs', inp, none).result;
    assert.deepStrictEqual(r.runnable.map((s) => s.slug), []);
    assert.deepStrictEqual(r.skipped.filter((s) => s.slug === '12-csv').map((s) => s.reason), ['is starting: its session is not working yet']);
  }
  age(dir, '12-csv', 5);
  assert.deepStrictEqual(run(dir, 'specs', {}, none).result.runnable.map((s) => s.slug), ['12-csv']);
});

test('restart refuses a young starting run file and restarts one older than the grace', () => {
  const r = restartable(null, []); // withWorktree() ran the worktree command: the run file says starting
  assert.strictEqual(r.runFileJson().status, 'starting');
  assert.match(r.restart().error, /is starting/);
  age(r.dir, '12-csv', 5);
  const out = r.restart();
  assert.strictEqual(out.ok, true, out.error);
  assert.deepStrictEqual([r.runFileJson().status, r.runFileJson().session], ['running', 'new-7']);
});
```

In the 0.27.1 test (`a blocked run whose session works again is running…`), replace the inlined run-file rewrite with `age(dir, '12-csv', 5)`. Check the shape of the `specs` result (`runnable`, `skipped: [{slug, reason}]`) against an existing `specs` test and adapt the field names if they differ.

- [ ] **Step 2: Run** `node --test --test-name-pattern="starting" plugins/tdd-flow/tests/cli.test.cjs` — Expected: the first two new tests FAIL (attach present; spec runnable). The restart test may already pass: it pins existing behaviour (spec item 3).

- [ ] **Step 3: Implement.** `runState`: build `attach` only when not (`run.status === 'starting'` and `!isLive(s)`). `status`: `session`/`sessionState` empty under the same condition (take it from `runState`'s input, not by re-deriving it differently). `specs`: after the `a session is still running on it` skip, skip when `runState(slug, sessions, root).status === 'starting'`, before the named-slug override of the blocked skip.

- [ ] **Step 4: Run** `node --test plugins/tdd-flow/tests/` — Expected: all PASS.

- [ ] **Step 5: Commit** `fix(tdd-flow): a starting spec offers no old session and is not started twice`.

### Task 2: restart order, all errors, validation where used (#47)

**Files:**
- Modify: `plugins/tdd-flow/bin/tdd-flow` — `sharedPathError()` (~128), `sharedPaths()` (~144), `worktree()` (~1739), `restartSpec()` (~1934), `autopilotCheck()` / `sharedPathsCheck()` call site
- Test: `plugins/tdd-flow/tests/cli.test.cjs`

**Interfaces:**
- Produces: `readStack().sharedPaths` / `.sharedPathErrors` from checks without a git call. `trackedSharedPaths(paths: string[]): string[]` — messages `shared path <p>: tracked by git` for tracked ones. `worktree` and `autopilot-check` use `[...stack.sharedPathErrors, ...trackedSharedPaths(stack.sharedPaths)]`.
- Produces: `restartSpec` step order worktree → remove → start, with the step numbers of Global Constraints; its return value is unchanged.

- [ ] **Step 1: Write the failing tests.**

```js
test('restart with a rejected shared path stops before the old session is removed', () => {
  const r = restartable({ status: 'blocked', session: 'old-1', details: 'tests fail' });
  fs.appendFileSync(path.join(r.dir, '.tdd-flow/stack.md'), 'shared paths: /srv/x\n');
  const before = r.runFileJson();
  const out = r.restart();
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /restart step 4 \(prepare the worktree\): shared path \/srv\/x: absolute/);
  assert.doesNotMatch(r.claude.log(), /^(rm|--bg) /m);
  assert.deepStrictEqual(r.runFileJson(), before);
});

test('worktree names every rejected shared path', () => {
  const { dir } = sharedRepo('/srv/x, ../y');
  assert.match(run(dir, 'worktree', { slug: '12-csv' }, fakeClaude([])).error, /shared path \/srv\/x: absolute; shared path \.\.\/y: contains \.\./);
});

test('a tracked shared path is reported by worktree and autopilot-check only: status and board do not ask git about it', () => {
  // sharedRepo('src/tracked.js') with that file committed.
  // worktree → error /tracked by git/; composeCheck-style autopilot-check → check fail /tracked by git/.
  // status and board with a `git` wrapper first on PATH that appends its arguments to a log: no line starts with `ls-files -- src/tracked.js`.
});
```

Update the two existing assertions that name restart steps (`restart step 5 (restart)` → `restart step 6 (restart)`, and any `step 4 (remove the old session)` → `step 5`); find them with `grep -n "step [456]" plugins/tdd-flow/tests/cli.test.cjs`.

- [ ] **Step 2: Run** `node --test --test-name-pattern="rejected shared path|tracked shared path|restart" plugins/tdd-flow/tests/cli.test.cjs` — Expected: the three new tests FAIL; renumbered restart assertions FAIL until Step 3.

- [ ] **Step 3: Implement.** Split the tracked check out of `sharedPathError` into `trackedSharedPaths`. `worktree`: throw `errors.join('; ')`. `restartSpec`: `step(4, 'prepare the worktree', () => worktree({ slug }))` first, then the removal as step 5, then `claude --bg` as step 6 using the worktree from step 4.

- [ ] **Step 4: Run** `node --test plugins/tdd-flow/tests/` — Expected: all PASS.

- [ ] **Step 5: Commit** `fix(tdd-flow): restart prepares the worktree before removing the old session`.

### Task 3: cleanup of a removed shared path (#47)

**Files:**
- Modify: `plugins/tdd-flow/bin/tdd-flow` — `worktree()` (~1739), new `forgetSharedPaths(root, wtPath, declared)` next to `linkShared`
- Test: `plugins/tdd-flow/tests/cli.test.cjs`

**Interfaces:**
- Consumes: `stack.sharedPaths` (Task 2).
- Produces: `forgetSharedPaths(root: string, wtPath: string, declared: string[]): string[]` — updates the record file, deletes the exclude lines of removed paths and the worktree's links to them; returns notes `removed the link <path> (no longer a shared path)`. `worktree()` appends them to `notes`.

- [ ] **Step 1: Write the failing tests.** Helper `declare(dir, g, paths)`: rewrites the `shared paths:` line of `.tdd-flow/stack.md` (or removes it for `''`) and commits.

```js
test('a path removed from shared paths loses its exclude line and its links, in every worktree prepared afterwards', () => {
  const { dir, write, g } = sharedRepo('storage, storage-old, storage/x'); // storage/x is dropped as nested
  write('storage/PG_VERSION', '18\n');
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), '/mine\n/storage/keep\n');
  const env = fakeClaude([]);
  const a = run(dir, 'worktree', { slug: '12-csv' }, env).result.path;
  // a second spec's worktree, made by hand on its own branch, is linked on its first worktree call
  // → both have links storage and storage-old.
  declare(dir, g, 'storage-old');
  const r = run(dir, 'worktree', { slug: '12-csv' }, env).result;
  assert.deepStrictEqual(r.notes, ['removed the link storage (no longer a shared path)']);
  assert.ok(!fs.existsSync(path.join(a, 'storage')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'storage/PG_VERSION'), 'utf8'), '18\n');
  const lines = fs.readFileSync(path.join(dir, '.git/info/exclude'), 'utf8').split('\n');
  assert.ok(!lines.includes('/storage'));
  for (const kept of ['/storage-old', '/storage/keep', '/mine']) assert.ok(lines.includes(kept), kept);
  // The other worktree is cleaned when it is prepared; a second call there has nothing left to do.
  // Declared again: linked and excluded again.
});

test('cleanup leaves what it did not make: a missing path, a real directory, a link elsewhere, a broken record file', () => {
  // After `storage` was removed from stack.md, in three worktrees: nothing at storage → ok, no note;
  // a directory with a file → kept; a link to a temp dir → kept. Each call ok: true.
  // Record file overwritten with `not json` → next worktree call ok: true, and the file is valid JSON again.
});
```

- [ ] **Step 2: Run** `node --test --test-name-pattern="removed from shared paths|cleanup leaves" plugins/tdd-flow/tests/cli.test.cjs` — Expected: both FAIL (the link and the exclude line stay).

- [ ] **Step 3: Implement** `forgetSharedPaths` and call it in `worktree()` for both the reused and the created path, before `linkShared`. Record update: `removed = (old.removed ∪ old.declared) − declared`; `declared` = today's. Exclude file: rewrite without the lines equal to `/<p>` for `p` in `removed`. Link: `lstat` is a symlink and `realpath(link) === realpath(path.join(root, p))` → `unlink`.

- [ ] **Step 4: Run** `node --test plugins/tdd-flow/tests/` — Expected: all PASS.

- [ ] **Step 5: Commit** `feat(tdd-flow): a path removed from shared paths is cleaned up`.

### Task 4: stack-detector, docs, release, issues

**Files:**
- Modify: `plugins/tdd-flow/agents/stack-detector.md` — the `shared paths:` template line (~48) and, if the numbered detection steps name compose for it, that step
- Modify: `plugins/tdd-flow/README.md` — rows `worktree`, `specs`, `restart`, `status`; the Shared paths bullet
- Modify: `docs/plans/2026-11-18-tdd-flow-followups-46-47.md` — status line
- Modify: both manifests — `0.30.0`

- [ ] **Step 1:** stack-detector text, technology-neutral: any git-ignored path in the repo holding local state that a service or command started from a worktree would use and that must be the same as in the main checkout — a database data directory mounted by a compose file with a fixed name, a SQLite file opened by a relative path, an uploads or media directory. Not build output, dependency directories or caches. `none` when there is nothing.
- [ ] **Step 2:** README: `worktree` (cleanup, record file, `notes`); `specs` (the starting skip); `restart` (worktree first, steps 4 to 6); `status` (no session on a starting row); Shared paths bullet (removing a path cleans the exclude line and the links; a line for a path removed while on 0.29.0 is deleted by hand).
- [ ] **Step 3:** Bump both versions to `0.30.0`; spec status line `implemented in tdd-flow 0.30.0`.
- [ ] **Step 4: Run** `claude plugin validate .claude-plugin/marketplace.json`, `node --test plugins/tdd-flow/tests/`, `claude plugin test plugins/tdd-flow` — Expected: valid, all PASS.
- [ ] **Step 5: Commit** `docs(tdd-flow): follow-ups of the 0.28.0 and 0.29.0 reviews; 0.30.0`, then `git status --porcelain`.
- [ ] **Step 6 (after the PR is merged, with the user's go-ahead for the PR):** close #46; in #47 tick items 4 to 7, mark the three compose items as not planned ("the compose line scan stays a best-effort guard; the plugin must work on any stack"), close it. The PR body says `Closes #46` and `Closes #47`.
