'use strict';
// Tests for bin/tdd-flow. Run from the repo root: node --test plugins/tdd-flow/tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'tdd-flow');
const { parseSpec, parseTasks, parseTaskTable, compact, kebab, onMergeSummary, setSpecStatus, shapeOf, specTitle } = require(CLI);

const SPEC = `- Source: https://github.com/o/r/issues/12
- Slug: 12-csv
- Status: approved

## Acceptance criteria

### AC-1 Export returns header
- **Given** an empty report
- **When** exported
- **Then** only the header row is returned

### AC-2 Compose file valid
- **Given** the repo
- **When** compose config is checked
- **Then** it is valid
- **Verify:** \`docker compose config -q\`
- **Verify (manual):** the db container starts

## Edge cases and error handling

- EC-1 Unicode names → kept as UTF-8

## Task breakdown

| ID  | Task | Kind | ACs | Notes |
|-----|------|------|-----|-------|
| T-1 | Compose | setup | AC-2 | |
| T-2 | Export | tdd | AC-1, EC-1 | |
`;
const TASKS = '- [ ] T-1 Docker compose (AC-2) [setup]\n- [ ] T-2 Export header (AC-1, EC-1)\n- [ ] T-20 Later (AC-1)\n';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-cli-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.tdd-flow/\n');
  g('add', '.gitignore');
  g('commit', '-qm', 'init');
  const f = path.join(dir, '.tdd-flow/features/12-csv');
  fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(path.join(f, 'spec.md'), SPEC);
  fs.writeFileSync(path.join(f, 'tasks.md'), TASKS);
  fs.writeFileSync(path.join(dir, '.tdd-flow/stack.md'), 'test command (all): `node -e 0`\ntest command (single file / filter): `node --test <file>`\ndefault branch: main\n');
  fs.writeFileSync(path.join(dir, '.tdd-flow/state.json'), '{"feature":"12-csv","phase":"IDLE","task":"T-1"}\n');
  return { dir, g, read: (p) => fs.readFileSync(path.join(dir, p), 'utf8'), write: (p, s) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), s); } };
}

function run(dir, cmd, input, env) {
  const r = spawnSync(process.execPath, [CLI, cmd], { cwd: dir, input: JSON.stringify(input || {}), encoding: 'utf8', env: { ...process.env, ...env } });
  return JSON.parse(r.stdout.trim());
}

/** A repo whose .tdd-flow/ is committed on main (state.json stays ignored), as the autopilot requires. */
function trackedRepo() {
  const r = repo();
  r.write('.gitignore', '.tdd-flow/state.json\n');
  r.g('add', '.gitignore', '.tdd-flow');
  r.g('commit', '-qm', 'specs');
  return r;
}

/** Fake `claude` CLI printing the given `claude agents --json --all` sessions. */
function fakeClaude(sessions) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-claude-')), 'claude');
  fs.writeFileSync(f, `#!/bin/sh\necho '${JSON.stringify(sessions)}'\n`, { mode: 0o755 });
  return { TDD_FLOW_CLAUDE_BIN: f };
}

test('parseSpec reads status, criteria text, verify lines and edge cases', () => {
  const s = parseSpec(SPEC);
  assert.strictEqual(s.status, 'approved');
  assert.strictEqual(s.text(s.crit['AC-1']), 'Export returns header: Given an empty report When exported Then only the header row is returned');
  assert.deepStrictEqual(s.crit['AC-2'].verify, [
    { command: 'docker compose config -q', manual: false },
    { command: 'the db container starts', manual: true },
  ]);
  assert.strictEqual(s.text(s.crit['EC-1']), 'Unicode names → kept as UTF-8');
});

test('parseTasks keeps T-2 and T-20 apart and reads [setup]', () => {
  const t = parseTasks(TASKS);
  assert.deepStrictEqual(t.map((x) => [x.id, x.title, x.kind, x.refs.join(',')]), [
    ['T-1', 'Docker compose', 'setup', 'AC-2'], ['T-2', 'Export header', 'tdd', 'AC-1,EC-1'], ['T-20', 'Later', 'tdd', 'AC-1'],
  ]);
  assert.deepStrictEqual(parseTaskTable(SPEC)['T-1'], { kind: 'setup', refs: ['AC-2'] });
});

test('plan returns tasks with behaviours and a passing baseline', () => {
  const { dir } = repo();
  const r = run(dir, 'plan', {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result.approved, true);
  assert.strictEqual(r.result.baselinePass, true);
  assert.deepStrictEqual(r.result.tasks[0].verify.map((v) => v.manual), [false, true]);
  assert.deepStrictEqual(r.result.tasks[1].behaviours.map((b) => b.ref), ['AC-1', 'EC-1']);
});

test('plan reports fallback for an unknown criterion', () => {
  const { dir, write } = repo();
  write('.tdd-flow/features/12-csv/tasks.md', '- [ ] T-1 thing (AC-9)\n');
  const r = run(dir, 'plan', {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fallback, true);
  assert.match(r.error, /AC-9 not found/);
});

test('commit ticks only the task line, writes state, stages only listed files', () => {
  const { dir, g, read, write } = repo();
  g('switch', '-q', '-c', 'feature/12-csv');
  write('a.js', 'x\n');
  write('other.txt', 'not listed\n');
  const r = run(dir, 'commit', {
    message: 'feat(12-csv): T-2 Export header', files: ['a.js', '.tdd-flow/features/12-csv/tasks.md', 'missing.js'],
    tick: { file: '.tdd-flow/features/12-csv/tasks.md', task: 'T-2' }, state: { feature: '12-csv', phase: 'IDLE', task: 'T-20' },
  });
  assert.strictEqual(r.result.committed, true);
  assert.strictEqual(r.result.ticked, true);
  assert.deepStrictEqual(r.result.unexpected, ['other.txt']);
  assert.match(read('.tdd-flow/features/12-csv/tasks.md'), /\[x\] T-2 Export[\s\S]*\[ \] T-20/);
  assert.deepStrictEqual(JSON.parse(read('.tdd-flow/state.json')), { feature: '12-csv', phase: 'IDLE', task: 'T-20' });
  assert.strictEqual(g('show', '--name-only', '--format=%s', 'HEAD').toString().trim(), 'feat(12-csv): T-2 Export header\n\na.js');
});

test('commit refuses to commit on the default branch', () => {
  const { dir, write } = repo();
  write('a.js', 'x\n');
  const r = run(dir, 'commit', { message: 'feat: a', files: ['a.js'] });
  assert.strictEqual(r.result.committed, false);
  assert.match(r.result.reason, /default branch main/);
});

test('every workflow has the same cli() helper', () => {
  const dir = path.join(__dirname, '..', 'workflows');
  const blocks = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => {
    const m = fs.readFileSync(path.join(dir, f), 'utf8').match(/\/\/ Deterministic steps[\s\S]*?\nasync function cli\([\s\S]*?\n}\n/);
    assert.ok(m, `${f} has no cli() helper`);
    return m[0];
  });
  assert.strictEqual(blocks.length, 5);
  blocks.forEach((b) => assert.strictEqual(b, blocks[0]));
});

test('commit refuses a staged secret and unstages it', () => {
  const { dir, g, write } = repo();
  g('switch', '-q', '-c', 'feature/12-csv');
  // Fake AWS-style key, assembled at runtime so secret scanners don't flag this test file.
  write('b.js', `const key = "${'AKIA' + 'ABCDEFGHIJKLMNOP'}"\n`);
  const r = run(dir, 'commit', { message: 'feat: b', files: ['b.js'] });
  assert.strictEqual(r.result.committed, false);
  assert.match(r.result.reason, /b\.js: possible secret/);
  assert.strictEqual(g('diff', '--cached', '--name-only').toString().trim(), '');
});

test('block resets the phase, logs and unticks', () => {
  const { dir, read, write } = repo();
  write('.tdd-flow/features/12-csv/tasks.md', TASKS.replace('[ ] T-2', '[x] T-2'));
  write('.tdd-flow/state.json', '{"feature":"12-csv","phase":"RED","task":"T-1"}');
  const r = run(dir, 'block', { dir: '.tdd-flow/features/12-csv', task: 'T-2', step: 'GREEN AC-1', details: 'tests fail', untick: true });
  assert.deepStrictEqual(r.result, { logged: true, unticked: true });
  assert.deepStrictEqual(JSON.parse(read('.tdd-flow/state.json')), { feature: '12-csv', phase: 'IDLE', task: 'T-2' });
  assert.match(read('.tdd-flow/features/12-csv/tdd-log.md'), /## T-2 - BLOCKED at GREEN AC-1\ntests fail/);
  assert.match(read('.tdd-flow/features/12-csv/tasks.md'), /\[ \] T-2/);
});

test('branch creates feature/<slug> from the base branch', () => {
  const { dir, g } = repo();
  assert.deepStrictEqual(run(dir, 'branch', { slug: '12-csv' }).result, { branch: 'feature/12-csv' });
  assert.strictEqual(g('branch', '--show-current').toString().trim(), 'feature/12-csv');
});

test('test prints a compact failure and exits 1', () => {
  const r = spawnSync(process.execPath, [CLI, 'test', '--', 'echo one; echo two >&2; exit 3'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, 'FAIL (exit 3) `echo one; echo two >&2; exit 3`\none\ntwo\n');
});

test('test caches a pass until a file outside .tdd-flow/ changes', () => {
  const { dir, write } = repo();
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-count-')), 'runs');
  const runs = () => fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  const t = (cmd, env) => spawnSync(process.execPath, [CLI, 'test', '--', cmd], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  const ok = `echo run >> '${counter}'`;
  assert.match(t(ok).stdout, /^PASS \(exit 0\)/);
  assert.match(t(ok).stdout, /^PASS \(cached: no file changed/);
  write('.tdd-flow/features/12-csv/review.md', 'notes');
  assert.match(t(ok).stdout, /cached/);
  assert.strictEqual(runs(), 1);
  write('src.js', 'x');
  t(ok);
  assert.strictEqual(runs(), 2);
  t(ok, { TDD_FLOW_TEST_CACHE: 'off' });
  assert.strictEqual(runs(), 3);
  const bad = `echo run >> '${counter}'; exit 1`;
  t(bad);
  assert.strictEqual(t(bad).status, 1);
  assert.strictEqual(runs(), 5);
});

test('test does not cache a run that changed files, nor in a repo with submodules', () => {
  const { dir, write } = repo();
  const t = (cmd) => spawnSync(process.execPath, [CLI, 'test', '--', cmd], { cwd: dir, encoding: 'utf8' }).stdout;
  t('echo x >> gen.txt');
  assert.match(t('echo x >> gen.txt'), /^PASS \(exit 0\)/);
  write('.gitmodules', '');
  t('node -e 0');
  assert.match(t('node -e 0'), /^PASS \(exit 0\)/);
});

test('suite runs the stack.md test command and reports a cache hit', () => {
  const { dir } = repo();
  const first = run(dir, 'suite', {});
  assert.deepStrictEqual({ ...first.result, summary: undefined }, { ran: true, pass: true, command: 'node -e 0', cached: false, summary: undefined });
  assert.strictEqual(run(dir, 'suite', {}).result.cached, true);
});

test('compact keeps 3 lines on pass and strips ANSI codes', () => {
  assert.strictEqual(compact('a\nb\n\x1b[32mc\x1b[0m\nd\n', true), 'b\nc\nd');
});

test('kebab strips diacritics and cuts at a word boundary', () => {
  assert.strictEqual(kebab('142-Export the Report as CSV, včetně diakritiky!!'), '142-export-the-report-as-csv-vcetne');
});

test('onMergeSummary lists workflows with a push trigger on the base branch', () => {
  const { dir } = repo();
  const w = path.join(dir, '.github/workflows');
  fs.mkdirSync(w, { recursive: true });
  fs.writeFileSync(path.join(w, 'ci.yml'), 'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\njobs: {}\n');
  fs.writeFileSync(path.join(w, 'rel.yml'), 'name: Rel\non:\n  push:\n    branches:\n      - release\njobs: {}\n');
  fs.writeFileSync(path.join(w, 'pr.yml'), 'name: PR\non: [pull_request]\njobs: {}\n');
  const cwd = process.cwd();
  process.chdir(dir);
  try { assert.strictEqual(onMergeSummary('main'), 'Merging into main runs: CI (push triggers in .github/workflows)'); } finally { process.chdir(cwd); }
});

test('setSpecStatus replaces only the status word', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-spec-')), 'spec.md');
  fs.writeFileSync(f, SPEC);
  assert.strictEqual(setSpecStatus(f, 'implemented'), true);
  assert.strictEqual(parseSpec(fs.readFileSync(f, 'utf8')).status, 'implemented');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), SPEC.replace('Status: approved', 'Status: implemented'));
  fs.writeFileSync(f, '# no status\n');
  assert.strictEqual(setSpecStatus(f, 'done'), false);
});

test('commit with specStatus marks the spec implemented in the same commit', () => {
  const { dir, g, read, write } = trackedRepo();
  g('switch', '-q', '-c', 'feature/12-csv');
  write('a.js', 'x\n');
  const spec = '.tdd-flow/features/12-csv/spec.md';
  const tasks = '.tdd-flow/features/12-csv/tasks.md';
  write(tasks, TASKS.replace(/\[ \] T-(1|2) /g, '[x] T-$1 '));
  const r = run(dir, 'commit', { message: 'feat(12-csv): T-20 Later', files: ['a.js', spec, tasks], tick: { file: tasks, task: 'T-20' },
    specStatus: { file: spec, value: 'implemented' } });
  assert.strictEqual(r.result.committed, true);
  assert.strictEqual(r.result.specStatus, 'implemented');
  assert.match(read(spec), /Status: implemented/);
  assert.match(g('show', '--name-only', '--format=', 'HEAD').toString(), /spec\.md/);
});

test('plan treats an implemented spec as approved and reports its status', () => {
  const { dir, write } = repo();
  write('.tdd-flow/features/12-csv/spec.md', SPEC.replace('Status: approved', 'Status: implemented'));
  const r = run(dir, 'plan', { baseline: false });
  assert.strictEqual(r.result.approved, true);
  assert.strictEqual(r.result.status, 'implemented');
});

test('specs refuses a git-ignored .tdd-flow/ and a tracked state.json', () => {
  assert.match(run(repo().dir, 'specs', {}, fakeClaude([])).error, /\.tdd-flow\/ is git-ignored/);
  const { dir, g, write } = repo();
  write('.gitignore', '');
  g('add', '.gitignore', '.tdd-flow');
  g('commit', '-qm', 'all');
  assert.match(run(dir, 'specs', {}, fakeClaude([])).error, /state\.json is tracked on main/);
});

test('specs selects approved specs and says why it skips the others', () => {
  const { dir, g, write } = trackedRepo();
  const add = (slug, status) => {
    write(`.tdd-flow/features/${slug}/spec.md`, SPEC.replace('Status: approved', `Status: ${status}`));
    write(`.tdd-flow/features/${slug}/tasks.md`, TASKS);
  };
  add('a-draft', 'draft');
  add('b-done-on-branch', 'approved');
  add('c-uncommitted', 'approved');
  write('.tdd-flow/features/12-csv/spec.md', `# Export report as CSV\n${SPEC}`);
  g('add', '.tdd-flow/features/a-draft', '.tdd-flow/features/b-done-on-branch', '.tdd-flow/features/12-csv');
  g('commit', '-qm', 'more specs');
  g('switch', '-q', '-c', 'feature/b-done-on-branch');
  write('.tdd-flow/features/b-done-on-branch/spec.md', SPEC.replace('Status: approved', 'Status: implemented'));
  g('commit', '-qam', 'implemented');
  g('switch', '-q', 'main');
  const r = run(dir, 'specs', {}, fakeClaude([]));
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.result.runnable, [{ slug: '12-csv', title: 'Export report as CSV', resume: false, lastRun: null }]);
  assert.deepStrictEqual(Object.fromEntries(r.result.skipped.map((s) => [s.slug, s.why.split(' ').slice(0, 3).join(' ')])), {
    'a-draft': 'status draft', 'b-done-on-branch': 'status implemented', 'c-uncommitted': 'spec is not',
  });
});

test('specs skips a running session and a blocked run unless named', () => {
  const { dir } = trackedRepo();
  // Found by its worktree directory: no run file records the session id yet.
  const busy = fakeClaude([{ id: 'ab12', kind: 'background', name: 'csv-report-export', cwd: path.join(fs.realpathSync(dir), '.claude/worktrees/12-csv'), state: 'working' }]);
  assert.match(run(dir, 'specs', {}, busy).result.skipped[0].why, /still running/);
  run(dir, 'run-report', { slug: '12-csv', status: 'blocked', details: 'GREEN AC-1\nmore' });
  assert.match(run(dir, 'specs', {}, fakeClaude([])).result.skipped[0].why, /blocked last time: GREEN AC-1 -/);
  assert.deepStrictEqual(run(dir, 'specs', { slugs: ['12-csv'] }, fakeClaude([])).result.runnable, [{ slug: '12-csv', title: '', resume: false, lastRun: 'blocked' }]);
});

test('worktree creates .claude/worktrees/<slug> on feature/<slug>, excludes it, and is reused', () => {
  const { dir, g } = trackedRepo();
  const r = run(dir, 'worktree', { slug: '12-csv' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.result.created, true);
  assert.strictEqual(r.result.branch, 'feature/12-csv');
  assert.strictEqual(fs.realpathSync(r.result.path), fs.realpathSync(path.join(dir, '.claude/worktrees/12-csv')));
  assert.ok(fs.existsSync(path.join(r.result.path, '.tdd-flow/features/12-csv/spec.md')));
  assert.match(fs.readFileSync(path.join(dir, '.git/info/exclude'), 'utf8'), /^\/\.claude\/worktrees\/\n\/\.tdd-flow\/state\.json\n$/m);
  assert.strictEqual(g('status', '--porcelain').toString(), '');
  assert.strictEqual(run(dir, 'worktree', { slug: '12-csv' }).result.created, false);
  assert.match(run(r.result.path, 'worktree', { slug: '12-csv' }).error, /main checkout/);
  assert.match(run(dir, 'worktree', { slug: '../x' }).error, /invalid feature slug/);
});

test('runs-wait returns finished runs and stalled sessions, waits for starting ones, and times out', () => {
  const { dir } = trackedRepo();
  run(dir, 'run-report', { slug: 'a', status: 'done', prUrl: 'https://github.com/o/r/pull/1' });
  run(dir, 'run-report', { slug: 'b', status: 'running', session: 's-b' });
  run(dir, 'run-report', { slug: 'c', status: 'running', session: 's-c' });
  run(dir, 'run-report', { slug: 'd', status: 'running', session: 's-d' }); // just started, not listed yet
  const sessions = fakeClaude([
    { id: 's-b', kind: 'background', name: 'invite-reset-flow', state: 'working' },
    { id: 's-c', kind: 'background', name: 'customer-address-crud', state: 'done', status: 'idle' },
    { id: 'old', kind: 'background', name: 'customer-address-crud', state: 'done' },
  ]);
  const r = run(dir, 'runs-wait', { slugs: ['a', 'b', 'c', 'd'] }, sessions).result;
  assert.deepStrictEqual(r.finished.map((f) => [f.slug, f.status, f.prUrl || f.details]), [
    ['a', 'done', 'https://github.com/o/r/pull/1'], ['c', 'stalled', 'session is done without a report'],
  ]);
  assert.strictEqual(r.finished[1].attach, 'claude attach s-c'); // name used by two sessions: the id is unambiguous
  assert.deepStrictEqual(r.running, [{ slug: 'b', attach: 'claude attach invite-reset-flow' }, { slug: 'd' }]);
  const t = run(dir, 'runs-wait', { slugs: ['b'], maxMinutes: 0.005 }, sessions).result;
  assert.deepStrictEqual(t, { finished: [], running: [{ slug: 'b', attach: 'claude attach invite-reset-flow' }], timedOut: true, progress: {} });
  assert.match(run(dir, 'run-report', { slug: 'a', status: 'merged' }).error, /running, done or blocked/);
});

test('board shows status and task progress per spec, read from the worktree once it exists', () => {
  const { dir } = trackedRepo();
  const working = fakeClaude([{ id: 's-1', kind: 'background', name: 'csv-export-flow', state: 'working' }]);
  const idle = fakeClaude([{ id: 's-1', kind: 'background', name: 'csv-export-flow', state: 'done', status: 'idle' }]);
  const board = (env, inp = { slugs: ['12-csv', 'later'], queued: ['later'] }) => run(dir, 'board', inp, env).result;
  run(dir, 'run-report', { slug: '12-csv', status: 'running', session: 's-1' });
  let b = board(working);
  assert.deepStrictEqual(b.rows.map((r) => [r.slug, r.status, r.done, r.total, r.current]), [
    ['12-csv', 'running', 0, 3, 'T-1 Docker compose'], ['later', 'queued', null, null, ''],
  ]);
  assert.deepStrictEqual(b.progress, { '12-csv': 0 });
  assert.deepStrictEqual(b.table.split('\n'), [
    '| Spec | Status | Tasks | PR / reason |', '|---|---|---|---|',
    '| 12-csv | running | 0/3 · T-1 Docker compose |  |', '| later | queued | – |  |',
  ]);
  const wt = run(dir, 'worktree', { slug: '12-csv' }).result.path;
  const tasksFile = path.join(wt, '.tdd-flow/features/12-csv/tasks.md');
  fs.writeFileSync(tasksFile, TASKS.replace('[ ] T-1', '[x] T-1').replace('[ ] T-2', '[x] T-2'));
  assert.strictEqual(board(working).rows[0].current, 'T-20 Later');
  fs.writeFileSync(tasksFile, TASKS.replace(/\[ \]/g, '[x]'));
  assert.strictEqual(board(working).rows[0].current, 'simplify / review / PR');
  b = board(idle);
  assert.strictEqual(b.rows[0].status, 'stalled');
  assert.match(b.table, /\| 12-csv \| stalled \| 3\/3 \| session is done without a report · `claude attach csv-export-flow` \|/);
  run(dir, 'run-report', { slug: '12-csv', status: 'done', prUrl: 'https://github.com/o/r/pull/7' });
  assert.match(board(idle).table, /\| 12-csv \| done \| 3\/3 \| https:\/\/github.com\/o\/r\/pull\/7 \|/);
  assert.deepStrictEqual(run(dir, 'board', {}, idle).result.rows.map((r) => r.slug), ['12-csv']); // worktree + run file, once
});

test('board without slugs reports that nothing ran yet', () => {
  const { dir } = trackedRepo();
  assert.match(run(dir, 'board', {}).error, /no specs to show/);
});

test('board without slugs leaves out done runs whose worktree is gone, but shows them when named', () => {
  const { dir } = trackedRepo();
  const env = fakeClaude([]);
  run(dir, 'run-report', { slug: '22-old', status: 'done', prUrl: 'https://github.com/o/r/pull/22' });
  run(dir, 'run-report', { slug: '23-blocked', status: 'blocked', details: 'red baseline' });
  run(dir, 'run-report', { slug: '12-csv', status: 'done', prUrl: 'https://github.com/o/r/pull/7' });
  run(dir, 'worktree', { slug: '12-csv' });
  assert.deepStrictEqual(run(dir, 'board', {}, env).result.rows.map((r) => [r.slug, r.status]), [['12-csv', 'done'], ['23-blocked', 'blocked']]);
  assert.deepStrictEqual(run(dir, 'board', { slugs: ['22-old'] }, env).result.rows.map((r) => [r.slug, r.status]), [['22-old', 'done']]);
});

test('runs-wait returns when a running spec ticks a task, with a baseline from the first poll for unknown slugs', () => {
  const { dir } = trackedRepo();
  const env = fakeClaude([{ id: 's-1', kind: 'background', name: 'csv-export-flow', state: 'working' }]);
  run(dir, 'run-report', { slug: '12-csv', status: 'running', session: 's-1' });
  const wt = run(dir, 'worktree', { slug: '12-csv' }).result.path;
  fs.writeFileSync(path.join(wt, '.tdd-flow/features/12-csv/tasks.md'), TASKS.replace('[ ] T-1', '[x] T-1'));
  const running = [{ slug: '12-csv', attach: 'claude attach csv-export-flow' }];
  assert.deepStrictEqual(run(dir, 'runs-wait', { slugs: ['12-csv'], progress: { '12-csv': 0 } }, env).result,
    { finished: [], running, progressed: ['12-csv'], progress: { '12-csv': 1 } });
  assert.deepStrictEqual(run(dir, 'runs-wait', { slugs: ['12-csv'], progress: { '12-csv': 1 }, maxMinutes: 0.005 }, env).result,
    { finished: [], running, timedOut: true, progress: { '12-csv': 1 } });
  assert.deepStrictEqual(run(dir, 'runs-wait', { slugs: ['12-csv'], maxMinutes: 0.005 }, env).result,
    { finished: [], running, timedOut: true, progress: { '12-csv': 1 } });
  // A caller that passes the stale map again (a shell loop) waits for the next tick instead of spinning.
  assert.deepStrictEqual(run(dir, 'runs-wait', { slugs: ['12-csv'], progress: { '12-csv': 0 }, maxMinutes: 0.005 }, env).result,
    { finished: [], running, timedOut: true, progress: { '12-csv': 1 } });
  fs.writeFileSync(path.join(wt, '.tdd-flow/features/12-csv/tasks.md'), TASKS.replace('[ ] T-1', '[x] T-1').replace('[ ] T-2', '[x] T-2'));
  assert.deepStrictEqual(run(dir, 'runs-wait', { slugs: ['12-csv'], progress: { '12-csv': 0 } }, env).result,
    { finished: [], running, progressed: ['12-csv'], progress: { '12-csv': 2 } });
  // A reset tasks.md lowers the count: the remembered 2 is stale, the next tick is reported again.
  fs.writeFileSync(path.join(wt, '.tdd-flow/features/12-csv/tasks.md'), TASKS);
  assert.deepStrictEqual(run(dir, 'runs-wait', { slugs: ['12-csv'], progress: { '12-csv': 2 }, maxMinutes: 0.005 }, env).result,
    { finished: [], running, timedOut: true, progress: { '12-csv': 0 } });
  fs.writeFileSync(path.join(wt, '.tdd-flow/features/12-csv/tasks.md'), TASKS.replace('[ ] T-1', '[x] T-1'));
  assert.deepStrictEqual(run(dir, 'runs-wait', { slugs: ['12-csv'], progress: { '12-csv': 0 } }, env).result,
    { finished: [], running, progressed: ['12-csv'], progress: { '12-csv': 1 } });
});

test('board leaves out worktrees that are not on a feature/<slug> branch', () => {
  const { dir, g } = trackedRepo();
  run(dir, 'worktree', { slug: '12-csv' });
  g('worktree', 'add', '-q', '-b', 'fix/web-deps', '.claude/worktrees/web-deps');
  assert.deepStrictEqual(run(dir, 'board', {}, fakeClaude([])).result.rows.map((r) => r.slug), ['12-csv']);
});

test('status returns no rows outside a repo and in a repo with no spec run, and never throws', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-plain-'));
  assert.deepStrictEqual(run(plain, 'status', {}, fakeClaude([])), { ok: true, shape: '', result: { rows: [], paneSeen: false } });
  assert.deepStrictEqual(run(trackedRepo().dir, 'status', {}, fakeClaude([])).result, { rows: [], paneSeen: false });
});

test('status rows carry phase, task, issue URL, title, session and decision, from the main checkout and a worktree', () => {
  const { dir } = trackedRepo();
  const env = fakeClaude([{ id: 's-1', kind: 'background', name: 'csv-export-flow', state: 'working' }]);
  run(dir, 'run-report', { slug: '12-csv', status: 'running', session: 's-1' });
  const at = JSON.parse(fs.readFileSync(path.join(dir, '.git/tdd-flow/runs/12-csv.json'), 'utf8')).at;
  const wt = run(dir, 'worktree', { slug: '12-csv' }).result.path;
  fs.writeFileSync(path.join(wt, '.tdd-flow/features/12-csv/spec.md'), `# CSV export\n\n${SPEC}`);
  const stateFile = path.join(wt, '.tdd-flow/state.json');
  fs.writeFileSync(stateFile, '{"feature":"12-csv","phase":"GREEN","task":"T-2"}\n');
  const row = (from = dir, e = env) => run(from, 'status', {}, e).result.rows[0];
  assert.deepStrictEqual(row(), {
    slug: '12-csv', status: 'running', done: 0, total: 3, current: 'T-1 Docker compose', prUrl: '', details: '',
    attach: 'claude attach csv-export-flow', task: 'T-2', phase: 'GREEN', issueUrl: 'https://github.com/o/r/issues/12',
    title: 'CSV export', session: 'csv-export-flow', sessionState: 'working', at,
  });
  assert.deepStrictEqual(row(wt), row()); // called from the worktree: the same rows
  fs.writeFileSync(stateFile, '{"feature":"12-csv","phase":"IDLE","task":"T-2"}\n');
  assert.strictEqual(row().phase, 'review'); // IDLE while the spec runs with open tasks
  fs.rmSync(stateFile);
  assert.deepStrictEqual([row().phase, row().task], ['', '']);
  // A Source that is not a URL gives no issue link.
  fs.writeFileSync(path.join(wt, '.tdd-flow/features/12-csv/spec.md'), SPEC.replace(/Source: .*/, 'Source: prompt text'));
  assert.deepStrictEqual([row().issueUrl, row().title], ['', '']);
  const decision = { id: 'Q-2', question: 'Keep the old export?', recommendation: 'Keep it', options: ['Keep it', 'Drop it'], tasks: ['T-2'] };
  run(dir, 'run-report', { slug: '12-csv', status: 'blocked', session: 's-1', details: 'needs a decision', decision });
  fs.writeFileSync(stateFile, '{"feature":"12-csv","phase":"IDLE","task":"T-2"}\n');
  const idle = fakeClaude([{ id: 's-1', kind: 'background', name: 'csv-export-flow', state: 'done', status: 'idle' }]);
  const blocked = row(dir, idle);
  assert.deepStrictEqual(blocked.decision, decision);
  assert.deepStrictEqual([blocked.status, blocked.phase, blocked.sessionState, blocked.details], ['blocked', '', 'done', 'needs a decision']);
});

test('status with pane writes a heartbeat; board and runs-wait say paneOpen while it is younger than 60 s', () => {
  const { dir } = trackedRepo();
  const env = fakeClaude([]);
  run(dir, 'run-report', { slug: '12-csv', status: 'done', prUrl: 'https://github.com/o/r/pull/7' });
  assert.strictEqual(run(dir, 'board', { slugs: ['12-csv'] }, env).result.paneOpen, undefined);
  assert.strictEqual(run(dir, 'status', {}, env).result.paneSeen, false);
  assert.strictEqual(fs.existsSync(path.join(dir, '.git/tdd-flow/pane.json')), false); // only with pane: true
  assert.strictEqual(run(dir, 'status', { pane: true }, env).result.paneSeen, true);
  assert.ok(Date.now() - Date.parse(JSON.parse(fs.readFileSync(path.join(dir, '.git/tdd-flow/pane.json'), 'utf8')).at) < 5000);
  assert.strictEqual(run(dir, 'board', { slugs: ['12-csv'] }, env).result.paneOpen, true);
  assert.strictEqual(run(dir, 'runs-wait', { slugs: ['12-csv'] }, env).result.paneOpen, true);
  assert.strictEqual(run(dir, 'status', {}, env).result.paneSeen, true);
  fs.writeFileSync(path.join(dir, '.git/tdd-flow/pane.json'), JSON.stringify({ at: new Date(Date.now() - 61000).toISOString() }));
  assert.strictEqual(run(dir, 'board', { slugs: ['12-csv'] }, env).result.paneOpen, undefined);
  assert.strictEqual(run(dir, 'runs-wait', { slugs: ['12-csv'] }, env).result.paneOpen, undefined);
});

test('runs-wait with ticks: false returns only when a run finishes, not on a ticked task', () => {
  const { dir } = trackedRepo();
  const env = fakeClaude([{ id: 's-1', kind: 'background', name: 'csv-export-flow', state: 'working' }]);
  run(dir, 'run-report', { slug: '12-csv', status: 'running', session: 's-1' });
  const wt = run(dir, 'worktree', { slug: '12-csv' }).result.path;
  fs.writeFileSync(path.join(wt, '.tdd-flow/features/12-csv/tasks.md'), TASKS.replace('[ ] T-1', '[x] T-1'));
  const running = [{ slug: '12-csv', attach: 'claude attach csv-export-flow' }];
  assert.deepStrictEqual(run(dir, 'runs-wait', { slugs: ['12-csv'], progress: { '12-csv': 0 }, ticks: false, maxMinutes: 0.005 }, env).result,
    { finished: [], running, timedOut: true, progress: { '12-csv': 1 } });
  run(dir, 'run-report', { slug: '12-csv', status: 'done', prUrl: 'https://github.com/o/r/pull/7' });
  assert.deepStrictEqual(run(dir, 'runs-wait', { slugs: ['12-csv'], ticks: false }, env).result.finished.map((f) => f.status), ['done']);
});

test('worktree writes state.json (IDLE, first open task) into a new worktree', () => {
  const { dir } = trackedRepo();
  const tasks = TASKS.replace('[ ] T-1', '[x] T-1');
  fs.writeFileSync(path.join(dir, '.tdd-flow/features/12-csv/tasks.md'), tasks);
  execFileSync('git', ['commit', '-qam', 'tick'], { cwd: dir });
  const wt = run(dir, 'worktree', { slug: '12-csv' }).result.path;
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(wt, '.tdd-flow/state.json'), 'utf8')), { feature: '12-csv', phase: 'IDLE', task: 'T-2' });
  assert.strictEqual(execFileSync('git', ['status', '--porcelain'], { cwd: wt }).toString(), ''); // excluded, never committed
  // A reused worktree keeps the state.json its session wrote.
  fs.writeFileSync(path.join(wt, '.tdd-flow/state.json'), '{"feature":"12-csv","phase":"RED","task":"T-2"}\n');
  run(dir, 'worktree', { slug: '12-csv' });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(wt, '.tdd-flow/state.json'), 'utf8')).phase, 'RED');
});

test('specTitle takes the # heading, else the first sentence of the Goal', () => {
  assert.strictEqual(specTitle('# CSV export\n\n- Status: approved\n\n## Goal\n\nX.'), 'CSV export');
  assert.strictEqual(specTitle('- Status: approved\n\n## Goal\n\nUsers export the report as CSV. It has a header.\n\n## Context\n'), 'Users export the report as CSV.');
  assert.strictEqual(specTitle(`## Goal\n\n${'a'.repeat(100)}`), `${'a'.repeat(79)}…`);
  assert.strictEqual(specTitle('- Status: draft\n'), '');
});

// Shapes taken from real specs: suffixed ids, a note after a verify command, a verify list under one "Verify" line.
const SUFFIXED_SPEC = `- Status: approved

### AC-1 Mailpit in compose (setup task)
- **Given** compose
- **When** mailpit is added
- **Then** it is valid
- **Verify:** \`t=$(sed -n 1p compose.yaml) && [ -n "$t" ]\` (passes only after T-2)

### AC-2a Migration tables
- **Given** the schema
- **When** migrated
- **Then** tables exist
- **Verify** (from the repo root, each exits 0):
  - \`cd apps/backend && ./mvnw -B -q compile\`
  - \`grep -q '^springdoc:' application.yml\`

### AC-8b Unique ICO per tenant
- **Given** two customers
- **When** the same ICO is used
- **Then** the second is rejected
`;

test('parseSpec reads suffixed ids, drops notes after verify commands and reads verify lists', () => {
  const s = parseSpec(SUFFIXED_SPEC);
  assert.deepStrictEqual(Object.keys(s.crit), ['AC-1', 'AC-2a', 'AC-8b']);
  assert.deepStrictEqual(s.crit['AC-1'].verify, [{ command: 't=$(sed -n 1p compose.yaml) && [ -n "$t" ]', manual: false }]);
  assert.deepStrictEqual(s.crit['AC-2a'].verify.map((v) => v.command), ['cd apps/backend && ./mvnw -B -q compile', "grep -q '^springdoc:' application.yml"]);
  assert.strictEqual(s.text(s.crit['AC-2a']), 'Migration tables: Given the schema When migrated Then tables exist');
  assert.strictEqual(s.text(s.crit['AC-8b']), 'Unique ICO per tenant: Given two customers When the same ICO is used Then the second is rejected');
});

test('parseTasks and parseTaskTable read suffixed ids and do not split AC-2 from AC-2a', () => {
  const t = parseTasks('- [ ] T-2 Migration V5 (AC-2a, AC-8b)\n- [ ] T-3 Other (AC-2)\n');
  assert.deepStrictEqual(t.map((x) => [x.id, x.title, x.refs.join(',')]), [['T-2', 'Migration V5', 'AC-2a,AC-8b'], ['T-3', 'Other', 'AC-2']]);
  assert.deepStrictEqual(parseTaskTable('| ID | Task | Kind | ACs |\n|---|---|---|---|\n| T-2 | M | tdd | AC-2a, EC-3b |\n')['T-2'].refs, ['AC-2a', 'EC-3b']);
});

test('commit does not mark the spec implemented while tasks.md has open tasks, but still commits', () => {
  const { dir, g, read, write } = trackedRepo();
  g('switch', '-q', '-c', 'feature/12-csv');
  write('a.js', 'x\n');
  const spec = '.tdd-flow/features/12-csv/spec.md';
  const tasks = '.tdd-flow/features/12-csv/tasks.md';
  const r = run(dir, 'commit', { message: 'feat(12-csv): T-1', files: ['a.js', spec, tasks], tick: { file: tasks, task: 'T-1' },
    specStatus: { file: spec, value: 'implemented' } });
  assert.strictEqual(r.result.committed, true);
  assert.strictEqual(r.result.specStatus, undefined);
  assert.match(r.result.specStatusSkipped, /2 task\(s\) still open in tasks.md \(T-2, T-20\)/);
  assert.match(read(spec), /Status: approved/);
});

test('plan gives criteria only to the tasks the run reaches and reports taskCount and openIds', () => {
  const { dir, write } = repo();
  write('.tdd-flow/features/12-csv/tasks.md', TASKS.replace('[ ] T-1 ', '[x] T-1 '));
  const one = run(dir, 'plan', { maxTasks: 1 }).result;
  assert.strictEqual(one.taskCount, 3);
  assert.deepStrictEqual(one.openIds, ['T-2', 'T-20']);
  assert.deepStrictEqual(one.tasks.map((t) => t.behaviours.length), [0, 2, 0]);
  assert.strictEqual(one.tasks[0].verify, undefined);
  const from = run(dir, 'plan', { maxTasks: 1, fromTask: 'T-20' }).result;
  assert.deepStrictEqual(from.tasks.map((t) => t.behaviours.length), [0, 0, 1]);
  const all = run(dir, 'plan', {}).result;
  assert.deepStrictEqual(all.tasks.map((t) => t.behaviours.length), [0, 2, 1]);
});

/** The relay-check helpers of the shared cli() block in a workflow (identical in all of them). */
function relayHelpers() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'tdd-implement.js'), 'utf8');
  const block = src.match(/\/\/ Deterministic steps[\s\S]*?\nasync function cli\([\s\S]*?\n}\n/)[0];
  return new Function('str', `${block}\nreturn { shapeOf, relayProblem };`)({ type: 'string' });
}

test('every output carries the shape of its result, and replay prints a saved output again', () => {
  const { dir } = repo();
  const first = run(dir, 'plan', { _relay: 'plan-1' });
  assert.strictEqual(first.shape, 'tasks=3 tasks.0.behaviours=1 tasks.0.verify=2 tasks.1.behaviours=2 tasks.2.behaviours=1 openIds=3');
  assert.deepStrictEqual(run(dir, 'replay', { id: 'plan-1' }), first);
  const none = run(dir, 'replay', { id: 'plan-2' });
  assert.strictEqual(none.ok, false);
  assert.match(none.error, /no saved output for "plan-2"/);
  assert.strictEqual(run(dir, 'nope', {}).shape, '');
});

test('the workflow copy of shapeOf matches the CLI copy', () => {
  const fixture = { a: [1, [2, 3], { b: [] }], c: { d: [{ e: [4] }] }, f: 'x' };
  assert.deepStrictEqual(relayHelpers().shapeOf(fixture), shapeOf(fixture));
});

test('relayProblem catches dropped items and fields, ignores paths outside the schema', () => {
  const { shapeOf: wfShape, relayProblem } = relayHelpers();
  const schema = { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties: { behaviours: { type: 'array' } } } } } };
  const cli = { tasks: [{ behaviours: [1, 2] }, { behaviours: [] }], extra: [1] };
  const shape = wfShape(cli).join(' ');
  assert.strictEqual(relayProblem({ ok: true, shape, result: { tasks: cli.tasks } }, schema), '');
  assert.match(relayProblem({ ok: true, shape, result: { tasks: [cli.tasks[0]] } }, schema), /CLI: tasks=2; relayed: tasks=1/);
  assert.match(relayProblem({ ok: true, shape, result: { tasks: [{ behaviours: [] }, { behaviours: [] }] } }, schema), /tasks\.0\.behaviours=2/);
  assert.match(relayProblem({ ok: true, result: cli }, schema), /no shape/);
  assert.strictEqual(relayProblem({ ok: true, shape, result: { tasks: cli.tasks } }, schema, () => 'custom'), 'custom');
});

/** Fake `gh` printing the given PR list; `exit 1` when prs is null. */
function fakeGh(prs) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-gh-')), 'gh');
  fs.writeFileSync(f, prs ? `#!/bin/sh\necho '${JSON.stringify(prs)}'\n` : '#!/bin/sh\necho "gh: not logged in" >&2\nexit 1\n', { mode: 0o755 });
  return { TDD_FLOW_GH_BIN: f };
}
/**
 * Fake `claude` that prints sessions for `agents` and logs `rm` calls. `--bg -n <name> <prompt>` calls are logged with
 * the directory they ran in and print `bgOut` (default: `backgrounded · new-7 · <name>`, as the real CLI does).
 */
function loggingClaude(sessions, { bgOut } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-claude-'));
  const f = path.join(d, 'claude');
  const bg = bgOut == null ? 'echo "backgrounded · new-7 · $3"' : `echo '${bgOut}'`;
  fs.writeFileSync(f, `#!/bin/sh\nif [ "$1" = rm ]; then echo "$@" >> "${d}/log"; elif [ "$1" = --bg ]; then echo "$@ in $(pwd -P)" >> "${d}/log"; ${bg}; else echo '${JSON.stringify(sessions)}'; fi\n`, { mode: 0o755 });
  return { env: { TDD_FLOW_CLAUDE_BIN: f }, log: () => (fs.existsSync(path.join(d, 'log')) ? fs.readFileSync(path.join(d, 'log'), 'utf8') : '') };
}
/** Main checkout with the worktree of 12-csv; returns the worktree path and its branch tip. */
function withWorktree() {
  const r = trackedRepo();
  const wt = run(r.dir, 'worktree', { slug: '12-csv' }).result.path;
  const tip = () => execFileSync('git', ['rev-parse', 'feature/12-csv'], { cwd: r.dir }).toString().trim();
  return { ...r, wt: fs.realpathSync(wt), tip };
}
const merged = (oid) => [{ number: 7, state: 'MERGED', url: 'https://example.test/pr/7', headRefOid: oid }];

test('cleanup removes a merged, clean worktree with its session, run file and branch, ignored files included', () => {
  const { dir, wt, tip } = withWorktree();
  // Ignored files of any kind go with the worktree: a .env, e2e output, installed dependencies.
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), 'node_modules/\n.env\nstorage/e2e-*\n');
  fs.writeFileSync(path.join(wt, '.env'), 'PORT=3201');
  fs.mkdirSync(path.join(wt, 'storage/e2e-uploads'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'storage/e2e-sample-data.json'), '{}');
  fs.writeFileSync(path.join(wt, 'storage/e2e-uploads/a.pdf'), 'pdf');
  fs.mkdirSync(path.join(wt, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'node_modules/x/i.js'), '1');
  run(dir, 'run-report', { slug: '12-csv', status: 'done', session: 'ab12' });
  const claude = loggingClaude([{ id: 'ab12', kind: 'background', cwd: wt, state: 'done' }]);
  const r = run(dir, 'cleanup', {}, { ...claude.env, ...fakeGh(merged(tip())) });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.result.kept, []);
  assert.strictEqual(r.result.removed[0].slug, '12-csv');
  assert.strictEqual(r.result.removed[0].branchDeleted, true);
  assert.ok(!fs.existsSync(wt));
  assert.match(claude.log(), /^rm ab12$/m);
  assert.ok(!fs.existsSync(path.join(dir, '.git/tdd-flow/runs/12-csv.json')));
});

test('cleanup also deletes the branch of a squash-merged PR, whose tip is not in main', () => {
  const { dir, wt, tip, g } = withWorktree();
  fs.writeFileSync(path.join(wt, 'csv.txt'), 'export');
  execFileSync('git', ['add', 'csv.txt'], { cwd: wt });
  execFileSync('git', ['commit', '-qm', 'csv export'], { cwd: wt });
  const r = run(dir, 'cleanup', {}, { ...loggingClaude([]).env, ...fakeGh(merged(tip())) });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.result.notes, []);
  assert.strictEqual(r.result.removed[0].branchDeleted, true);
  assert.ok(!fs.existsSync(wt));
  assert.strictEqual(g('branch', '--list', 'feature/12-csv').toString().trim(), '');
});

test('cleanup keeps worktrees with open PRs, later commits, changes or open sessions', () => {
  const { dir, wt, tip, g } = withWorktree();
  const none = loggingClaude([]).env;
  const why = (env) => { const r = run(dir, 'cleanup', {}, env); assert.strictEqual(r.ok, true, r.error); assert.deepStrictEqual(r.result.removed, []); return r.result.kept[0].why; };
  assert.match(why({ ...none, ...fakeGh([{ number: 8, state: 'OPEN', headRefOid: tip() }, ...merged(tip())]) }), /PR #8 is open/);
  assert.match(why({ ...none, ...fakeGh([]) }), /no PR/);
  assert.match(why({ ...loggingClaude([{ id: 'cd34', kind: 'interactive', cwd: path.join(wt, '.tdd-flow'), state: 'idle' }]).env, ...fakeGh(merged(tip())) }), /session cd34 is still open \(idle\) - if its work is done, close it with `claude stop cd34`/);
  // `claude stop` takes only the id; the unique name is offered for `claude attach` alone.
  assert.match(why({ ...loggingClaude([{ id: 'ef56', name: 'csv-export', kind: 'background', cwd: wt, state: 'blocked' }]).env, ...fakeGh(merged(tip())) }), /session csv-export is still open \(blocked\) - if its work is done, close it with `claude stop ef56`/);
  fs.appendFileSync(path.join(wt, '.gitignore'), '# changed\n');
  assert.match(why({ ...none, ...fakeGh(merged(tip())) }), /git worktree remove refused/);
  const mergedOid = tip();
  execFileSync('git', ['commit', '-qam', 'follow-up'], { cwd: wt });
  assert.match(why({ ...none, ...fakeGh(merged(mergedOid)) }), /commits after the merged PR #7/);
  assert.ok(fs.existsSync(wt));
  assert.match(g('branch', '--list', 'feature/12-csv').toString(), /feature\/12-csv/);
});

test('cleanup is skipped when gh or the session list is unavailable', () => {
  const { dir, tip } = withWorktree();
  assert.match(run(dir, 'cleanup', {}, { ...loggingClaude([]).env, ...fakeGh(null) }).result.skipped, /gh: gh: not logged in/);
  const noClaude = { TDD_FLOW_CLAUDE_BIN: '/nonexistent/claude', ...fakeGh(merged(tip())) };
  assert.match(run(dir, 'cleanup', {}, noClaude).result.skipped, /claude agents is not available/);
});

// ---------- simplify ----------
test('parseTasks and parseTaskTable read the refactor kind, plan passes it on', () => {
  assert.deepStrictEqual(parseTasks('- [ ] T-1 Drop dead helper (AC-1) [refactor]\n- [ ] T-2 X (AC-2) [setup]').map((t) => [t.id, t.title, t.kind]),
    [['T-1', 'Drop dead helper', 'refactor'], ['T-2', 'X', 'setup']]);
  assert.strictEqual(parseTaskTable('| ID | Task | Kind | ACs |\n|---|---|---|---|\n| T-3 | y | refactor | AC-1 |')['T-3'].kind, 'refactor');
  const { dir, write } = repo();
  write('.tdd-flow/features/12-csv/tasks.md', '- [ ] T-2 Export header (AC-1) [refactor]\n');
  const r = run(dir, 'plan', { feature: '12-csv' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.result.tasks[0].kind, 'refactor');
});

const FINDING = (i) => ({ tag: 'duplicate', title: `Merge parser copy ${i} (AC-9)`, where: `src/a.js:${i}`, files: ['src/a.js'],
  issue: 'two copies of the same parser', proposal: 'use parseRow from src/rows.js', gain: 12, risk: 'low' });

test('simplify-spec writes draft refactor specs that plan reads, 8 tasks each, never over a taken slug', () => {
  const { dir, g, read, write } = trackedRepo();
  write('.tdd-flow/features/simplify-src/spec.md', 'taken');
  g('branch', 'feature/simplify-src-2');
  const r = run(dir, 'simplify-spec', { area: 'src/', findings: Array.from({ length: 9 }, (_, i) => FINDING(i + 1)) });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.result.specs.map((s) => [s.slug, s.tasks]), [['simplify-src-3', 8], ['simplify-src-4', 1]]);
  assert.match(read('.tdd-flow/features/simplify-src-3/spec.md'), /Status: draft[\s\S]*Source: tdd-flow simplify-codebase|Source: tdd-flow simplify-codebase[\s\S]*Status: draft/);
  assert.match(read('.tdd-flow/features/simplify-src-4/tasks.md'), /^- \[ \] T-1 Merge parser copy 9 AC 9 \(AC-1\) \[refactor\]$/m);
  for (const slug of ['simplify-src-3', 'simplify-src-4']) {
    setSpecStatus(path.join(dir, `.tdd-flow/features/${slug}/spec.md`), 'approved');
    const p = run(dir, 'plan', { feature: slug, baseline: false });
    assert.strictEqual(p.ok, true, p.error);
    assert.ok(p.result.tasks.every((t) => t.kind === 'refactor' && t.behaviours.length === 1 && /parseRow/.test(t.behaviours[0].text)));
  }
  assert.match(run(dir, 'simplify-spec', { area: 'x', findings: [] }).error, /no findings/);
});

test('areas groups tracked source files by directory, skips tests, generated code and other files', () => {
  const { dir, g, write } = trackedRepo();
  for (let i = 0; i < 5; i++) write(`src/big/f${i}.js`, 'x');
  write('src/small/a.ts', 'x');
  write('src/tiny/b.py', 'x');
  write('src/top.go', 'x');
  write('src/big/f0.test.js', 'x');
  write('tests/t.py', 'x');
  write('vendor/v.js', 'x');
  write('web/app.min.js', 'x');
  write('README.md', 'x');
  write('src/untracked.js', 'x');
  g('add', 'src', 'tests', 'vendor', 'web', 'README.md');
  g('reset', '-q', '--', 'src/untracked.js');
  const r = run(dir, 'areas', { maxFiles: 3 });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.result.areas.map((a) => [a.area, a.include, a.files]), [
    ['src/*', ['src/top.go'], 1],
    ['src/big/*', ['src/big/f0.js', 'src/big/f1.js', 'src/big/f2.js'], 3],
    ['src/big/*', ['src/big/f3.js', 'src/big/f4.js'], 2],
    ['src/{small,tiny}', ['src/small/', 'src/tiny/'], 2],
  ]);
  assert.strictEqual(r.result.noTestSuite, false);
  assert.deepStrictEqual(run(dir, 'areas', { paths: ['src/small'] }).result.areas.map((a) => a.area), ['.']);
});

test('spec-branch approves a draft on feature/<slug> without touching main, and refuses taken or tracked specs', () => {
  const { dir, g, write } = trackedRepo();
  run(dir, 'simplify-spec', { area: 'lib', findings: [FINDING(1)] });
  const head = g('rev-parse', 'main').toString();
  const r = run(dir, 'spec-branch', { slug: 'simplify-lib' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.result.branch, 'feature/simplify-lib');
  assert.strictEqual(g('rev-parse', 'main').toString(), head);
  assert.ok(!fs.existsSync(path.join(dir, '.tdd-flow/features/simplify-lib')));
  assert.match(g('show', 'feature/simplify-lib:.tdd-flow/features/simplify-lib/spec.md').toString(), /Status: approved/);
  assert.strictEqual(execFileSync('git', ['status', '--porcelain'], { cwd: r.result.path }).toString(), '');
  // The autopilot finds it by name only.
  const s = run(dir, 'specs', { slugs: ['simplify-lib'] }, fakeClaude([]));
  assert.strictEqual(s.ok, true, s.error);
  assert.deepStrictEqual(s.result.runnable.map((x) => [x.slug, x.title, x.resume]), [['simplify-lib', 'Simplify lib', true]]);
  assert.ok(!run(dir, 'specs', {}, fakeClaude([])).result.runnable.some((x) => x.slug === 'simplify-lib'));
  // Taken branch, tracked spec, missing spec.
  write('.tdd-flow/features/simplify-lib/spec.md', '- Status: draft\n');
  write('.tdd-flow/features/simplify-lib/tasks.md', '- [ ] T-1 x (AC-1) [refactor]\n');
  assert.match(run(dir, 'spec-branch', { slug: 'simplify-lib' }).error, /already exists/);
  assert.match(run(dir, 'spec-branch', { slug: '12-csv' }).error, /already in git/);
  assert.match(run(dir, 'spec-branch', { slug: 'nope' }).error, /missing/);
});

test('set-aside saves uncommitted changes as a patch and restores HEAD, only on a feature branch', () => {
  const { dir, g, read, write } = trackedRepo();
  write('src/a.js', 'one\n');
  g('add', 'src/a.js');
  g('commit', '-qm', 'a');
  assert.match(run(dir, 'set-aside', { slug: '12-csv', label: 'R-1' }).error, /feature branch/);
  g('switch', '-q', '-c', 'feature/12-csv');
  assert.deepStrictEqual(run(dir, 'set-aside', { slug: '12-csv', label: 'R-1' }).result, { setAside: false, files: [] });
  write('src/a.js', 'two\n');
  write('src/new.js', 'new\n');
  const r = run(dir, 'set-aside', { slug: '12-csv', label: 'simplify 1' });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.result.files.sort(), ['src/a.js', 'src/new.js']);
  assert.match(r.result.patch, /tdd-flow\/runs\/12-csv-simplify-1\.patch$/);
  assert.strictEqual(read('src/a.js'), 'one\n');
  assert.ok(!fs.existsSync(path.join(dir, 'src/new.js')));
  assert.strictEqual(g('status', '--porcelain').toString(), '');
  g('apply', r.result.patch);
  assert.strictEqual(read('src/a.js'), 'two\n');
});

test('commit with includeDeletions also commits tracked files the agent did not list', () => {
  const { dir, g, write } = trackedRepo();
  write('src/old.js', 'x\n');
  g('add', 'src/old.js');
  g('commit', '-qm', 'old');
  g('switch', '-q', '-c', 'feature/12-csv');
  fs.rmSync(path.join(dir, 'src/old.js'));
  write('src/new.js', 'x\n');
  const r = run(dir, 'commit', { message: 'refactor: move', files: ['src/new.js'], includeDeletions: true });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.result.committed, true);
  assert.strictEqual(g('status', '--porcelain').toString(), '');
});

/** The shared cli() helper of a workflow, run against scripted script-runner replies (null = agent failed). */
function cliWithReplies(replies) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'tdd-implement.js'), 'utf8');
  const block = src.match(/\/\/ Deterministic steps[\s\S]*?\nasync function cli\([\s\S]*?\n}\n/)[0];
  const labels = [];
  const fakeRun = async (prompt, opts) => { labels.push(opts.label); return replies.shift(); };
  const cli = new Function('str', 'run', 'log', 'A', 'M', `${block}\nreturn cli;`)({ type: 'string' }, fakeRun, () => {}, (n) => n, { light: 'haiku', worker: 'sonnet' });
  return { cli, labels };
}
const COMMIT_SCHEMA = { type: 'object', properties: { committed: { type: 'boolean' }, unexpected: { type: 'array' } } };

test('cli() relays the saved output again when the relay drops the result', async () => {
  const { cli, labels } = cliWithReplies([{ ok: true, shape: '' }, { ok: true, shape: '', result: { committed: true } }]);
  const r = await cli('commit', {}, COMMIT_SCHEMA, { label: 'T-2 commit' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result.committed, true);
  assert.deepStrictEqual(labels, ['T-2 commit', 'T-2 commit (relay retry)']);
});

test('cli() marks a relay that never brings the result as relayFailed, but not an error the CLI reported', async () => {
  const dropped = await cliWithReplies([{ ok: true, shape: '' }, { ok: true, shape: '' }]).cli('commit', {}, COMMIT_SCHEMA);
  assert.strictEqual(dropped.ok, false);
  assert.strictEqual(dropped.relayFailed, true);
  const agentDied = await cliWithReplies([null]).cli('commit', {}, COMMIT_SCHEMA);
  assert.strictEqual(agentDied.relayFailed, true);
  const cliError = await cliWithReplies([{ ok: false, shape: '', error: 'git commit failed' }]).cli('commit', {}, COMMIT_SCHEMA);
  assert.strictEqual(cliError.ok, false);
  assert.strictEqual(cliError.relayFailed, undefined);
});

test('commit run again after it went through reports the existing commit and keeps the tick', () => {
  const { dir, g, write } = repo();
  g('switch', '-q', '-c', 'feature/12-csv');
  write('a.js', 'x\n');
  const input = { message: 'feat(12-csv): T-2 Export header\n\nbody', files: ['a.js'], tick: { file: '.tdd-flow/features/12-csv/tasks.md', task: 'T-2' } };
  const first = run(dir, 'commit', input);
  assert.strictEqual(first.result.committed, true);
  const again = run(dir, 'commit', input);
  assert.strictEqual(again.result.nothingToCommit, true);
  assert.strictEqual(again.result.ticked, true);
  assert.strictEqual(again.result.already, true);
  assert.strictEqual(again.result.sha, first.result.sha);
  write('b.js', 'y\n');
  g('add', 'b.js');
  g('commit', '-qm', 'other');
  assert.strictEqual(run(dir, 'commit', input).result.already, undefined, 'only HEAD counts, not an older commit');
});

test('block keeps the tick when the task commit is already HEAD', () => {
  const { dir, g, read, write } = repo();
  g('switch', '-q', '-c', 'feature/12-csv');
  write('a.js', 'x\n');
  g('add', 'a.js');
  g('commit', '-qm', 'feat(12-csv): T-2 Export header');
  write('.tdd-flow/features/12-csv/tasks.md', TASKS.replace('[ ] T-2', '[x] T-2'));
  const inp = { dir: '.tdd-flow/features/12-csv', task: 'T-2', step: 'COMMIT', details: 'relay failed', untick: true };
  const kept = run(dir, 'block', { ...inp, commitMessage: 'feat(12-csv): T-2 Export header' });
  assert.deepStrictEqual(kept.result, { logged: true, unticked: false, alreadyCommitted: true });
  assert.match(read('.tdd-flow/features/12-csv/tasks.md'), /\[x\] T-2/);
  const other = run(dir, 'block', { ...inp, commitMessage: 'feat(12-csv): T-3 Something else' });
  assert.deepStrictEqual(other.result, { logged: true, unticked: true });
});

/** trackedRepo on feature/12-csv with tracked src/a.js, src/b.js and a root testreport.md. */
function taskRepo() {
  const r = trackedRepo();
  r.write('src/a.js', 'a\n');
  r.write('src/b.js', 'b\n');
  r.write('testreport.md', 'old\n');
  r.g('add', 'src', 'testreport.md');
  r.g('commit', '-qm', 'src');
  r.g('switch', '-q', '-c', 'feature/12-csv');
  return r;
}
const committedFiles = (g) => g('show', '--name-only', '--format=', 'HEAD').toString().trim().split('\n').sort();

test('commit with stageChanged also stages unlisted changes and new files in the directories the task touched', () => {
  const { dir, g, write } = taskRepo();
  write('src/a.js', 'a2\n');
  write('src/b.js', 'b2\n');
  write('src/new file.js', 'n\n');
  write('testreport.md', 'new\n');
  write('.tdd-flow/features/12-csv/review.md', 'approved\n');
  write('notes.md', 'loose note\n');
  write('other/x.js', 'x\n');
  write('.tdd-flow/state.json', '{"phase":"IDLE"}\n');
  const r = run(dir, 'commit', { message: 'feat(12-csv): T-2 Export header', files: ['src/a.js', '.tdd-flow/features/12-csv/tasks.md'],
    tick: { file: '.tdd-flow/features/12-csv/tasks.md', task: 'T-2' }, stageChanged: true });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.result.committed, true);
  assert.deepStrictEqual(committedFiles(g), ['.tdd-flow/features/12-csv/review.md', '.tdd-flow/features/12-csv/tasks.md', 'src/a.js', 'src/b.js', 'src/new file.js', 'testreport.md']);
  assert.deepStrictEqual(r.result.extraStaged.sort(), ['.tdd-flow/features/12-csv/review.md', 'src/b.js', 'src/new file.js', 'testreport.md']);
  assert.deepStrictEqual(r.result.unstaged.sort(), ['notes.md', 'other/x.js']);
  assert.match(r.shape, /extraStaged=4/);
});

test('commit without stageChanged stages only listed files, but a listed new file in a tracked .tdd-flow/ folder too', () => {
  const { dir, g, write } = taskRepo();
  write('src/a.js', 'a2\n');
  write('src/b.js', 'b2\n');
  write('.tdd-flow/features/12-csv/review.md', 'approved\n');
  write('.tdd-flow/features/99-new/spec.md', 'not tracked yet\n');
  const r = run(dir, 'commit', { message: 'feat(12-csv): T-2', files: ['src/a.js', '.tdd-flow/features/12-csv/review.md', '.tdd-flow/features/99-new/spec.md', '.tdd-flow/state.json'] });
  assert.strictEqual(r.result.committed, true);
  assert.deepStrictEqual(committedFiles(g), ['.tdd-flow/features/12-csv/review.md', 'src/a.js']);
  assert.strictEqual(r.result.extraStaged, undefined);
});

test('commands called from a subdirectory work from the repo root', () => {
  const { dir, g, read, write } = repo();
  g('switch', '-q', '-c', 'feature/12-csv');
  write('a.js', 'x\n');
  fs.mkdirSync(path.join(dir, 'apps/web'), { recursive: true });
  const r = run(path.join(dir, 'apps/web'), 'commit', {
    message: 'feat(12-csv): T-2 Export header', files: ['a.js'], tick: { file: '.tdd-flow/features/12-csv/tasks.md', task: 'T-2' },
    state: { feature: '12-csv', phase: 'IDLE', task: 'T-20' },
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.result.committed, true);
  assert.strictEqual(r.result.ticked, true);
  assert.deepStrictEqual(JSON.parse(read('.tdd-flow/state.json')), { feature: '12-csv', phase: 'IDLE', task: 'T-20' });
  assert.ok(!fs.existsSync(path.join(dir, 'apps/web/.tdd-flow')), 'nothing written below the subdirectory');
});

test('test runs the stack.md command at the repo root and a command after -- in the caller directory', () => {
  const { dir, write } = repo();
  const mark = 'node -e "require(\'fs\').writeFileSync(\'ran-here.txt\', \'x\')"';
  write('.tdd-flow/stack.md', `test command (all): \`${mark}\`\ndefault branch: main\n`);
  const sub = path.join(dir, 'apps/web');
  fs.mkdirSync(sub, { recursive: true });
  const env = { ...process.env, TDD_FLOW_TEST_CACHE: 'off' };
  const own = spawnSync(process.execPath, [CLI, 'test'], { cwd: sub, encoding: 'utf8', env });
  assert.match(own.stdout, /^PASS/, own.stdout);
  assert.ok(fs.existsSync(path.join(dir, 'ran-here.txt')) && !fs.existsSync(path.join(sub, 'ran-here.txt')));
  fs.rmSync(path.join(dir, 'ran-here.txt'));
  const given = spawnSync(process.execPath, [CLI, 'test', '--', mark], { cwd: sub, encoding: 'utf8', env });
  assert.match(given.stdout, /^PASS/, given.stdout);
  assert.ok(fs.existsSync(path.join(sub, 'ran-here.txt')) && !fs.existsSync(path.join(dir, 'ran-here.txt')));
});

test('plan passes the stack profile type check command on, and leaves it out when there is none', () => {
  const { dir, read, write } = repo();
  write('.tdd-flow/stack.md', read('.tdd-flow/stack.md') + 'type check command: `(cd apps/web && npx tsc --noEmit)`\n');
  assert.strictEqual(run(dir, 'plan', {}).result.typeCheck, '(cd apps/web && npx tsc --noEmit)');
  write('.tdd-flow/stack.md', read('.tdd-flow/stack.md').replace(/type check command: .*\n/, 'type check command: none (Python)\n'));
  assert.strictEqual(run(dir, 'plan', {}).result.typeCheck, undefined);
});

/** Runs the CLI with no git identity from config or the environment (git then falls back to user@hostname). */
function runWithoutIdentity(dir, cmd, input, env) {
  const clean = { ...process.env, ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  ['EMAIL', 'GIT_COMMITTER_EMAIL', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_AUTHOR_NAME'].forEach((k) => delete clean[k]);
  const r = spawnSync(process.execPath, [CLI, cmd], { cwd: dir, input: JSON.stringify(input || {}), encoding: 'utf8', env: clean });
  return JSON.parse(r.stdout.trim());
}

test('specs warns about an automatic git identity and stops when git has none', () => {
  const { dir, g } = trackedRepo();
  assert.strictEqual(run(dir, 'specs', {}, fakeClaude([])).result.warnings, undefined);
  g('config', '--unset', 'user.email');
  g('config', '--unset', 'user.name');
  const auto = runWithoutIdentity(dir, 'specs', {}, fakeClaude([]));
  assert.strictEqual(auto.ok, true, auto.error);
  assert.match(auto.result.warnings.join('\n'), /user\.email is not set.*git config --global user\.email/);
  g('config', 'user.useConfigOnly', 'true');
  const none = runWithoutIdentity(dir, 'specs', {}, fakeClaude([]));
  assert.strictEqual(none.ok, false);
  assert.match(none.error, /no git identity.*git config --global user\.email/);
});

test('commit with stageChanged commits a staged deletion and leaves a new secret-looking file out', () => {
  const { dir, g, write } = taskRepo();
  g('rm', '-q', 'src/b.js');
  write('src/a.js', 'a2\n');
  write('src/.env.local', 'TOKEN=x\n');
  const r = run(dir, 'commit', { message: 'feat(12-csv): T-2', files: ['src/a.js'], stageChanged: true });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.result.committed, true, r.result.reason);
  assert.deepStrictEqual(committedFiles(g), ['src/a.js', 'src/b.js']);
  assert.ok(!fs.existsSync(path.join(dir, 'src/b.js')));
  assert.strictEqual(g('ls-files', 'src/b.js').toString(), '');
  assert.deepStrictEqual(r.result.unstaged, ['src/.env.local']);
});

/** Executable `name` in a temp dir running the given shell body. */
function fakeBin(name, body) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `tdd-flow-${name}-`)), name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
}
/** autopilot-check with a logged-in gh, a claude of the given version and HOME holding the given user settings. */
function autopilotCheck(dir, input, { settings, version = '2.1.200', env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-home-'));
  if (settings) { fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings)); }
  const r = run(dir, 'autopilot-check', input, { HOME: home, ...fakeGh([]), TDD_FLOW_CLAUDE_BIN: fakeBin('claude', `echo '${version} (Claude Code)'`), ...env });
  assert.strictEqual(r.ok, true, r.error);
  return { ...r.result, check: (name) => r.result.checks.find((c) => c.name === name) };
}
const SESSION_ALLOW = ['Workflow', 'Bash(tdd-flow:*)', 'Bash(git *)', 'Bash(gh pr:*)', 'Bash(gh issue view *)', 'Edit', 'Write'];

test('autopilot-check: tests need from the stack.md field, else inferred from its test lines only', () => {
  const { dir, write } = repo();
  const need = (txt) => {
    write('.tdd-flow/stack.md', txt);
    const r = autopilotCheck(dir, { runnable: 1 }, { settings: { permissions: { defaultMode: 'auto' } }, env: { TDD_FLOW_DOCKER_BIN: fakeBin('docker', 'exit 0') } });
    const c = r.check('tests need') || {};
    return [r.testsNeed, /inferred/.test(c.details || ''), c.status];
  };
  assert.deepStrictEqual(need('tests need: docker (Testcontainers)\n'), ['docker (Testcontainers)', false, 'ok']);
  assert.deepStrictEqual(need('tests need: none\ntest command (all): ./mvnw verify\n  note: needs Docker\n'), ['none', false, undefined]);
  assert.deepStrictEqual(need('test command (all): ./mvnw verify\n  note: ITs use Testcontainers, need Docker\nbuild command: npm run build\n'), ['docker', true, 'warn']);
  assert.deepStrictEqual(need('test command (all): npm test\nbuild command: docker build .\nci system: GitHub Actions builds a docker image\n'), ['none', false, undefined]);
});

test('autopilot-check: gh login is required', () => {
  const { dir } = trackedRepo();
  const r = run(dir, 'autopilot-check', { runnable: 1 }, { ...fakeGh(null), TDD_FLOW_CLAUDE_BIN: fakeBin('claude', 'echo 2.1.300') });
  assert.strictEqual(r.result.ok, false);
  assert.deepStrictEqual(r.result.checks.find((c) => c.name === 'gh'), { name: 'gh', status: 'fail', details: 'not logged in; every session opens its PR with it', fix: 'run `! gh auth login`' });
  assert.strictEqual(autopilotCheck(dir, { runnable: 1 }, { settings: { permissions: { allow: SESSION_ALLOW } } }).ok, true);
});

test('autopilot-check: permissions from user and local settings, broader rules cover, auto mode needs no rules', () => {
  const { dir, g, write } = trackedRepo();
  const perms = (opts) => autopilotCheck(dir, { runnable: 1 }, opts).check('permissions');
  const missing = perms({ settings: { permissions: { allow: ['Bash(git push *)', 'Edit(src/**)'] } } });
  assert.strictEqual(missing.status, 'warn');
  assert.match(missing.details, /stop at a permission prompt until you attach for: Workflow, Bash\(tdd-flow \*\), Bash\(git \*\), Bash\(gh pr \*\), Bash\(gh issue view \*\), Edit, Write \(mode default, Claude Code default\)/);
  assert.match(missing.fix, /settings\.local\.json or ~\/\.claude\/settings\.json/);
  assert.strictEqual(perms({ settings: { permissions: { allow: ['Workflow', 'Bash', 'Edit'] } } }).status, 'warn');
  assert.strictEqual(perms({ settings: { permissions: { allow: ['Workflow', 'Bash', 'Edit', 'Write'] } } }).status, 'ok');
  assert.strictEqual(perms({ settings: { permissions: { allow: ['Workflow', 'Bash(*)'], defaultMode: 'acceptEdits' } } }).status, 'ok');
  assert.match(perms({ settings: { permissions: { allow: ['Workflow'], defaultMode: 'dontAsk' } } }).details, /deny without asking for: Bash/);
  assert.strictEqual(perms({ settings: { permissions: { defaultMode: 'auto' } } }).status, 'ok');
  assert.match(perms({ version: '2.1.300' }).details, /^mode auto \(Claude Code default\)/);
  // The main checkout's settings.local.json applies to worktree sessions, but cannot switch to auto mode.
  write('.claude/settings.local.json', JSON.stringify({ permissions: { allow: SESSION_ALLOW, defaultMode: 'auto' } }));
  assert.match(perms({}).details, /rules background sessions need are allowed/);
  write('.claude/settings.local.json', JSON.stringify({ permissions: { defaultMode: 'auto' } }));
  assert.strictEqual(perms({}).status, 'warn');
  write('.claude/settings.local.json', '{ not json');
  assert.match(perms({ settings: { permissions: { defaultMode: 'auto' } } }).details, /settings\.local\.json is not valid JSON/);
  // implement-spec installs the dependencies of a fresh worktree: a tracked lockfile needs its frozen install command.
  fs.rmSync(path.join(dir, '.claude/settings.local.json'));
  write('apps/web/package-lock.json', '{}\n');
  g('add', 'apps/web/package-lock.json');
  g('commit', '-qm', 'lockfile');
  assert.match(perms({ settings: { permissions: { allow: SESSION_ALLOW } } }).details, /for: Bash\(npm ci\) \(mode default/);
  assert.strictEqual(perms({ settings: { permissions: { allow: [...SESSION_ALLOW, 'Bash(npm *)'] } } }).status, 'ok');
});

test('autopilot-check: tests that need Docker check the engine and run one spec at a time', () => {
  const { dir, write, g } = trackedRepo();
  write('.tdd-flow/stack.md', 'test command (all): `node -e 0`\ntests need: docker (Testcontainers)\n');
  g('commit', '-qam', 'docker');
  const opts = (code) => ({ settings: { permissions: { defaultMode: 'auto' } }, env: { TDD_FLOW_DOCKER_BIN: fakeBin('docker', `exit ${code}`) } });
  const up = autopilotCheck(dir, { runnable: 1 }, opts(0));
  assert.deepStrictEqual([up.ok, up.parallel, up.testsNeed, up.check('docker').status], [true, 1, 'docker (Testcontainers)', 'ok']);
  assert.deepStrictEqual([up.check('tests need').status, up.check('parallel').status], ['ok', 'ok']);
  assert.match(up.check('tests need').details, /parallel sessions share it/);
  assert.match(up.check('parallel').details, /^1 at a time, because the tests need docker/);
  const down = autopilotCheck(dir, { runnable: 1 }, opts(1));
  assert.deepStrictEqual([down.ok, down.check('docker').status], [false, 'fail']);
  assert.match(down.check('docker').fix, /start Docker Desktop/);
  const given = autopilotCheck(dir, { runnable: 1, parallel: 2 }, opts(0));
  assert.deepStrictEqual([given.parallel, given.check('parallel').status], [2, 'warn']);
  write('.tdd-flow/stack.md', 'test command (all): `node -e 0`\n');
  g('commit', '-qam', 'no docker');
  const plain = autopilotCheck(dir, { runnable: 1 }, opts(1));
  assert.deepStrictEqual([plain.ok, plain.parallel, plain.check('docker'), plain.check('tests need')], [true, 3, undefined, undefined]);
  const bad = run(dir, 'autopilot-check', { parallel: 0 }, fakeGh([]));
  assert.match(bad.error, /parallel must be a positive whole number/);
});

test('autopilot-check: base suite runs once for two or more specs on a clean base checkout', () => {
  const { dir, write, g } = trackedRepo();
  const suite = (runnable) => autopilotCheck(dir, { runnable }, { settings: { permissions: { defaultMode: 'auto' } } });
  assert.match(suite(1).check('base suite').details, /^one spec; each session runs its own baseline/);
  assert.deepStrictEqual([suite(2).check('base suite').status, suite(2).ok], ['ok', true]);
  write('scratch.txt', 'x\n');
  assert.match(suite(2).check('base suite').details, /local changes/);
  fs.rmSync(path.join(dir, 'scratch.txt'));
  write('.tdd-flow/stack.md', 'test command (all): `node -e "process.exit(1)"`\n');
  g('commit', '-qam', 'red');
  const red = suite(2);
  assert.deepStrictEqual([red.ok, red.check('base suite').status], [false, 'fail']);
  assert.match(red.check('base suite').details, /fails on main, so every session would stop at its baseline/);
  g('switch', '-qc', 'other');
  assert.match(suite(2).check('base suite').details, /main checkout is on other, not main/);
});

test('autopilot-check: the local base must have what origin has, else the worktrees start from old code', () => {
  const { dir, g, write } = trackedRepo();
  const check = (runnable = 2) => autopilotCheck(dir, { runnable }, { settings: { permissions: { defaultMode: 'auto' } } });
  const noRemote = check();
  assert.deepStrictEqual([noRemote.ok, noRemote.check('base').status, noRemote.check('base suite').status], [true, 'warn', 'ok']);
  assert.match(noRemote.check('base').details, /^cannot fetch origin\/main \(.+\): worktrees start from the local main/);

  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  g('remote', 'add', 'origin', remote);
  g('push', '-q', 'origin', 'main');
  assert.deepStrictEqual(check().check('base'), { name: 'base', status: 'ok', details: 'main is up to date with origin/main' });

  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-other-'));
  execFileSync('git', ['clone', '-q', remote, other]);
  const og = (...a) => execFileSync('git', a, { cwd: other, stdio: 'pipe' });
  og('-c', 'user.email=o@example.com', '-c', 'user.name=O', 'commit', '-q', '--allow-empty', '-m', 'merged on GitHub');
  og('push', '-q', 'origin', 'main');
  const behind = check();
  assert.deepStrictEqual([behind.ok, behind.check('base').status, behind.check('base').fix], [false, 'fail', 'run `! git pull --ff-only` in the main checkout']);
  assert.match(behind.check('base').details, /^main is 1 commit\(s\) behind origin\/main/);
  assert.match(behind.check('base suite').details, /^main is not in line with origin\/main/);
  g('switch', '-qc', 'other');
  assert.strictEqual(check().check('base').fix, 'run `! git fetch origin main:main`');
  g('switch', '-q', 'main');

  write('local.txt', 'x\n');
  g('add', 'local.txt');
  g('commit', '-qm', 'local only');
  const diverged = check().check('base');
  assert.strictEqual(diverged.status, 'fail');
  assert.match(diverged.details, /^main and origin\/main have diverged \(1 local, 1 on origin\)/);

  g('pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
  const ahead = check().check('base');
  assert.strictEqual(ahead.status, 'warn');
  assert.match(ahead.details, /^main has 2 commit\(s\) that are not on origin\/main, and every feature branch and PR gets them: \w+ Merge branch/);

  g('switch', '-q', 'other');
  g('branch', '-q', '-D', 'main');
  assert.deepStrictEqual(check(1).check('base'), { name: 'base', status: 'fail', details: 'there is no local main, only origin/main; worktrees branch from the local one', fix: 'run `! git branch main origin/main`' });
});

test('stack-fill writes tests need into stack.md when the detector left it out or kept the template hint', () => {
  const { dir, write, read } = repo();
  write('.tdd-flow/stack.md', 'test command (all): `npm test`\nci system: GitHub Actions\nnotes: x\n');
  assert.deepStrictEqual(run(dir, 'stack-fill', { testsNeed: 'docker (Testcontainers)' }).result, { added: true });
  assert.strictEqual(read('.tdd-flow/stack.md'), 'test command (all): `npm test`\ntests need: docker (Testcontainers)\nci system: GitHub Actions\nnotes: x\n');
  assert.deepStrictEqual(run(dir, 'stack-fill', { testsNeed: 'none' }).result, { added: false, reason: 'stack.md already has tests need' });
  write('.tdd-flow/stack.md', 'test command (all): `npm test`\ntests need:         (none | docker (...) | database (...))\n');
  run(dir, 'stack-fill', { testsNeed: 'none' });
  assert.strictEqual(read('.tdd-flow/stack.md'), 'test command (all): `npm test`\ntests need: none\n');
  write('.tdd-flow/stack.md', 'test command (all): `npm test`');
  run(dir, 'stack-fill', { testsNeed: 'database (local PostgreSQL)' });
  assert.strictEqual(read('.tdd-flow/stack.md'), 'test command (all): `npm test`\ntests need: database (local PostgreSQL)\n');
  assert.match(run(dir, 'stack-fill', {}).error, /testsNeed is required/);
  fs.rmSync(path.join(dir, '.tdd-flow/stack.md'));
  assert.deepStrictEqual(run(dir, 'stack-fill', { testsNeed: 'none' }).result, { added: false, reason: '.tdd-flow/stack.md is missing' });
});

/** Repo with an origin (bare) and a second clone that moves origin/main; on feature/12-csv. gen.js writes gen.json from src/. */
function syncRepo(generate = true) {
  const r = repo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  r.write('gen.js', "const fs = require('fs'); fs.writeFileSync('gen.json', JSON.stringify(fs.readdirSync('src').sort()) + '\\n');\n");
  r.write('src/a.txt', 'a\n');
  r.write('gen.json', '["a.txt"]\n');
  r.g('add', 'gen.js', 'src', 'gen.json');
  r.g('commit', '-qm', 'base');
  r.g('remote', 'add', 'origin', remote);
  r.g('push', '-q', 'origin', 'main');
  r.write('.tdd-flow/stack.md', `test command (all): \`node -e 0\`\n${generate ? 'generate command: `node gen.js`\ngenerated files: gen.json\n' : ''}`);
  r.g('switch', '-qc', 'feature/12-csv');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-other-'));
  execFileSync('git', ['clone', '-q', remote, other]);
  const og = (...a) => execFileSync('git', a, { cwd: other, stdio: 'pipe' });
  og('config', 'user.email', 'o@example.com');
  og('config', 'user.name', 'O');
  const onBase = (files) => {
    for (const [p, s] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(other, p)), { recursive: true }); fs.writeFileSync(path.join(other, p), s); }
    og('add', '-A');
    og('commit', '-qm', 'base moves');
    og('push', '-q', 'origin', 'main');
  };
  const commitHere = (files, msg = 'feature work') => {
    for (const [p, s] of Object.entries(files)) r.write(p, s);
    r.g('add', '-A', '--', ...Object.keys(files));
    r.g('commit', '-qm', msg);
  };
  const parents = () => r.g('log', '-1', '--format=%P').toString().trim().split(' ').length;
  return { ...r, onBase, commitHere, parents, head: () => r.g('rev-parse', 'HEAD').toString().trim() };
}

test('sync-base merges a moved base, and leaves an up-to-date branch alone', () => {
  const s = syncRepo(false);
  s.commitHere({ 'src/b.txt': 'b\n' });
  const head = s.head();
  assert.deepStrictEqual(run(s.dir, 'sync-base', { base: 'main' }).result, { base: 'main', merged: false, upToDate: true, regenerated: [] });
  assert.strictEqual(s.head(), head);
  s.onBase({ 'src/c.txt': 'c\n' });
  const r = run(s.dir, 'sync-base', { base: 'main' });
  assert.deepStrictEqual(r.result, { base: 'main', merged: true, upToDate: false, regenerated: [] });
  assert.strictEqual(s.parents(), 2);
  assert.strictEqual(s.read('src/c.txt'), 'c\n');
});

test('sync-base aborts on a conflict outside the generated files', () => {
  const s = syncRepo();
  s.commitHere({ 'src/a.txt': 'mine\n' });
  s.onBase({ 'src/a.txt': 'theirs\n' });
  const head = s.head();
  const r = run(s.dir, 'sync-base', { base: 'main' }).result;
  assert.deepStrictEqual([r.conflict, r.files, r.merged], [true, ['src/a.txt'], false]);
  assert.match(r.reason, /origin\/main conflicts with this branch in src\/a\.txt/);
  assert.strictEqual(s.head(), head);
  assert.strictEqual(s.read('src/a.txt'), 'mine\n');
  assert.strictEqual(s.g('status', '--porcelain', '--untracked-files=no').toString(), '');
});

test('sync-base resolves a conflict in a generated file by regenerating it in the merge commit', () => {
  const s = syncRepo();
  s.commitHere({ 'src/b.txt': 'b\n', 'gen.json': '["a.txt","b.txt"]\n' });
  s.onBase({ 'src/c.txt': 'c\n', 'gen.json': '["a.txt","c.txt"]\n' });
  const r = run(s.dir, 'sync-base', { base: 'main' }).result;
  assert.deepStrictEqual(r, { base: 'main', merged: true, upToDate: false, regenerated: ['gen.json'] });
  assert.strictEqual(s.read('gen.json'), '["a.txt","b.txt","c.txt"]\n');
  assert.strictEqual(s.parents(), 2);
  assert.strictEqual(s.g('status', '--porcelain').toString(), '');
});

test('sync-base without a merge commits stale generated files, and refuses a generate that touches other files', () => {
  const s = syncRepo();
  s.commitHere({ 'src/b.txt': 'b\n' });
  const r = run(s.dir, 'sync-base', { base: 'main' }).result;
  assert.deepStrictEqual(r, { base: 'main', merged: false, upToDate: true, regenerated: ['gen.json'] });
  assert.strictEqual(s.g('log', '-1', '--format=%s').toString().trim(), 'chore(12-csv): regenerate gen.json');
  s.commitHere({ 'gen.js': "require('fs').writeFileSync('src/a.txt', 'touched\\n');\n" }, 'bad generator');
  s.onBase({ 'src/c.txt': 'c\n' });
  const head = s.head();
  const bad = run(s.dir, 'sync-base', { base: 'main' }).result;
  assert.deepStrictEqual([bad.generateFailed, bad.merged], [true, false]);
  assert.match(bad.reason, /changed files outside generated files: src\/a\.txt/);
  assert.strictEqual(s.head(), head);
  assert.strictEqual(s.read('src/a.txt'), 'a\n');
  assert.strictEqual(s.g('status', '--porcelain', '--untracked-files=no').toString(), '');
});

test('sync-base refuses the base branch and uncommitted changes', () => {
  const s = syncRepo(false);
  s.write('src/a.txt', 'dirty\n');
  assert.match(run(s.dir, 'sync-base', { base: 'main' }).error, /uncommitted changes/);
  s.g('checkout', '-q', '--', 'src/a.txt');
  s.g('switch', '-q', 'main');
  assert.match(run(s.dir, 'sync-base', { base: 'main' }).error, /runs on a feature branch, not on main/);
});

test('a blocked run can carry a decision: run-report checks it, board and runs-wait show it', () => {
  const { dir } = trackedRepo();
  const env = fakeClaude([{ id: 's-1', kind: 'background', name: 'csv-export-flow', state: 'done', status: 'idle' }]);
  const decision = { id: 'Q-3', question: 'Should an empty report export only the header?', recommendation: 'yes, header only',
    options: ['header only', 'no file, 204'], tasks: ['T-2'] };
  const r = run(dir, 'run-report', { slug: '12-csv', status: 'blocked', session: 's-1', details: 'T-2: AC-1 allows two behaviours', decision });
  assert.deepStrictEqual(r.result.decision, decision);
  assert.match(run(dir, 'run-report', { slug: '12-csv', status: 'blocked', decision: { ...decision, id: '3' } }).error, /decision\.id must be the spec's question id/);
  assert.match(run(dir, 'run-report', { slug: '12-csv', status: 'blocked', decision: { id: 'Q-3', question: 'x' } }).error, /decision\.recommendation is required/);
  assert.match(run(dir, 'run-report', { slug: '12-csv', status: 'done', decision }).error, /decision goes with status blocked/);
  const b = run(dir, 'board', { slugs: ['12-csv'] }, env).result;
  assert.deepStrictEqual(b.rows[0].decision, decision);
  assert.match(b.table, /\| 12-csv \| blocked \| 0\/3 · T-1 Docker compose \| decision Q-3: Should an empty report export only the header\? \|/);
  const w = run(dir, 'runs-wait', { slugs: ['12-csv'] }, env).result;
  assert.deepStrictEqual([w.finished[0].status, w.finished[0].decision], ['blocked', decision]);
});

test('branch resets a phase an earlier run left behind, also when already on the feature branch', () => {
  const { dir, read, write } = repo();
  write('.tdd-flow/state.json', '{"feature":"12-csv","phase":"RED","task":"T-2"}\n');
  assert.deepStrictEqual(run(dir, 'branch', { slug: '12-csv' }).result, { branch: 'feature/12-csv', phaseReset: 'RED' });
  assert.deepStrictEqual(JSON.parse(read('.tdd-flow/state.json')), { feature: '12-csv', phase: 'IDLE', task: 'T-2' });
  write('.tdd-flow/state.json', '{"feature":"12-csv","phase":"GREEN","task":"T-2"}\n');
  assert.deepStrictEqual(run(dir, 'branch', { slug: '12-csv' }).result, { branch: 'feature/12-csv', phaseReset: 'GREEN' });
  assert.deepStrictEqual(run(dir, 'branch', { slug: '12-csv' }).result, { branch: 'feature/12-csv' });
  // No state.json: none is created.
  fs.rmSync(path.join(dir, '.tdd-flow/state.json'));
  run(dir, 'branch', { slug: '12-csv' });
  assert.ok(!fs.existsSync(path.join(dir, '.tdd-flow/state.json')));
});

test('add-secret-scan removes the file again when its commit fails, and commits its own leftover', () => {
  const { dir, g } = trackedRepo();
  g('switch', '-q', '-c', 'feature/12-csv');
  const file = path.join(dir, '.github/workflows/secret-scan.yml');
  const hook = path.join(dir, '.git/hooks/pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
  const failed = run(dir, 'add-secret-scan', {}).result;
  assert.strictEqual(failed.committed, false);
  assert.match(failed.reason, /git commit failed: hook says no/);
  assert.ok(!fs.existsSync(file));
  assert.strictEqual(g('status', '--porcelain').toString(), '');
  fs.rmSync(hook);
  assert.strictEqual(run(dir, 'add-secret-scan', {}).result.committed, true);
  assert.match(run(dir, 'add-secret-scan', {}).result.reason, /already exists/);
  // A leftover of an earlier failed run (untracked, same content) is committed; another untracked file is left alone.
  g('reset', '-q', 'HEAD~1');
  assert.strictEqual(run(dir, 'add-secret-scan', {}).result.committed, true);
  g('reset', '-q', 'HEAD~1');
  fs.appendFileSync(file, '# my own scan\n');
  const other = run(dir, 'add-secret-scan', {}).result;
  assert.strictEqual(other.committed, false);
  assert.match(other.reason, /exists but is not committed/);
  assert.match(fs.readFileSync(file, 'utf8'), /# my own scan/);
});

/** Fake `gh` answering by its first two arguments: {'pr checks': {out, err, code}}; a key may end in `*`. */
function scriptedGh(answers) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const cases = Object.entries(answers).map(([k, a]) => `  ${k.replace(/ /g, '\\ ')}) ${a.out != null ? `printf '%s\\n' ${q(a.out)};` : ''} ${a.err ? `printf '%s\\n' ${q(a.err)} >&2;` : ''} exit ${a.code || 0} ;;`);
  return { TDD_FLOW_GH_BIN: fakeBin('gh', `case "$1 $2" in\n${cases.join('\n')}\n  *) echo "unexpected: gh $*" >&2; exit 1 ;;\nesac`) };
}
/** The test repo with a GitHub origin (nothing is fetched). */
function githubRepo() {
  const r = repo();
  r.g('remote', 'add', 'origin', 'https://github.com/o/r.git');
  return r;
}

test('preflight falls back off GitHub, and reports a missing or logged-out gh', () => {
  const off = run(repo().dir, 'preflight', {});
  assert.strictEqual(off.fallback, true);
  assert.match(off.error, /tracker is none; the script handles GitHub only/);
  const { dir } = githubRepo();
  const missing = run(dir, 'preflight', {}, { TDD_FLOW_GH_BIN: path.join(os.tmpdir(), 'tdd-flow-no-gh-here') }).result;
  assert.deepStrictEqual([missing.cliReady, missing.cliFix], [false, 'Install the GitHub CLI (https://cli.github.com), then run: gh auth login']);
  const out = run(dir, 'preflight', {}, scriptedGh({ 'auth status': { err: 'You are not logged into any GitHub hosts.', code: 1 } })).result;
  assert.deepStrictEqual([out.cliReady, out.cliFix], [false, 'gh auth login']);
});

test('preflight reads tasks, issue, token scope, the open PR and counts only a committed secret scan', () => {
  const { dir, g, write } = githubRepo();
  g('switch', '-q', '-c', 'feature/12-csv');
  const env = scriptedGh({
    'auth status': { err: "  - Token scopes: 'gist', 'repo', 'workflow'" },
    'pr view': { out: JSON.stringify({ url: 'https://github.com/o/r/pull/9', state: 'OPEN', reviewDecision: '' }) },
  });
  const p = run(dir, 'preflight', {}, env).result;
  assert.deepStrictEqual(
    [p.slug, p.base, p.branch, p.openTasks, p.issueId, p.cliReady, p.workflowScope, p.existingPr, p.reviewDecision, p.secretScan, p.hasCi],
    ['12-csv', 'main', 'feature/12-csv', ['T-1', 'T-2', 'T-20'], '12', true, true, 'https://github.com/o/r/pull/9', 'NONE', 'not_github', false]);
  write('.github/workflows/ci.yml', 'on: push\n');
  g('add', '.github');
  g('commit', '-qm', 'ci');
  const scan = () => run(dir, 'preflight', {}, env).result.secretScan;
  assert.strictEqual(scan(), 'missing');
  write('.github/workflows/secret-scan.yml', 'jobs:\n  gitleaks:\n');
  assert.strictEqual(scan(), 'missing'); // not committed: it does not run in CI
  g('add', '.github');
  g('commit', '-qm', 'scan');
  assert.strictEqual(scan(), 'present');
});

test('ci-watch: pending returns again and keeps its state, a failure brings the log, review status and what merging runs', () => {
  const { dir, write } = githubRepo();
  const stFile = path.join(dir, '.git', 'tdd-flow-ci-watch.json');
  const checks = (bucket) => ({ out: JSON.stringify([{ name: 't', state: 'X', bucket, link: 'https://github.com/o/r/actions/runs/1/job/2', workflow: 'ci' }]), code: bucket === 'pending' ? 8 : 0 });
  const pending = run(dir, 'ci-watch', { pr: 5, callSeconds: 1 }, scriptedGh({ 'pr checks': checks('pending') }));
  assert.strictEqual(pending.again, true);
  assert.deepStrictEqual(pending.result, { status: 'pending', pendingChecks: ['ci / t'] });
  assert.strictEqual(JSON.parse(fs.readFileSync(stFile, 'utf8')).key, 'pr:5');
  write('.github/workflows/deploy.yml', 'name: deploy\non:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      - run: ./deploy.sh\n');
  const failed = run(dir, 'ci-watch', { pr: 5, callSeconds: 1 }, scriptedGh({
    'pr checks': checks('fail'),
    'run view': { out: 't\tstep\t2026-01-01T10:00:00.1234567Z Error: boom' },
    'pr view': { out: '{"reviewDecision":"CHANGES_REQUESTED"}' },
  })).result;
  const { onMerge, ...rest } = failed;
  assert.deepStrictEqual(rest, { status: 'failed', runUrl: 'https://github.com/o/r/actions/runs/1', failingJob: 'ci / t', log: 'Error: boom', reviewDecision: 'CHANGES_REQUESTED' });
  assert.match(onMerge, /^Merging into main runs: deploy \(has deploy\/release steps\)/);
  assert.ok(!fs.existsSync(stFile));
});

test('ci-watch: no checks after the grace period, a timeout, a stale state file and a commit watch', () => {
  const { dir, g } = githubRepo();
  const stFile = path.join(dir, '.git', 'tdd-flow-ci-watch.json');
  const seed = (key, agoMs) => fs.writeFileSync(stFile, JSON.stringify({ key, start: Date.now() - agoMs }));
  seed('pr:5', 200000);
  const none = run(dir, 'ci-watch', { pr: 5, callSeconds: 1 }, scriptedGh({ 'pr checks': { err: 'no checks reported on the feature/x branch', code: 1 } })).result;
  assert.strictEqual(none.status, 'none');
  assert.ok(!fs.existsSync(stFile));
  const pending = scriptedGh({ 'pr checks': { out: JSON.stringify([{ name: 't', bucket: 'pending', link: '', workflow: '' }]), code: 8 } });
  seed('pr:5', 31 * 60000);
  assert.deepStrictEqual(run(dir, 'ci-watch', { pr: 5, callSeconds: 1 }, pending).result, { status: 'timeout' });
  assert.ok(!fs.existsSync(stFile));
  // A state file left by an aborted run (older than the watch plus 10 minutes) starts a new watch.
  seed('pr:5', 41 * 60000);
  assert.strictEqual(run(dir, 'ci-watch', { pr: 5, callSeconds: 1 }, pending).again, true);
  assert.ok(JSON.parse(fs.readFileSync(stFile, 'utf8')).start > Date.now() - 60000);
  // After the merge: the runs of the commit, skipped counts as passed, plus its deployments.
  const sha = g('rev-parse', 'HEAD').toString().trim();
  const c = run(dir, 'ci-watch', { commit: sha, callSeconds: 1 }, scriptedGh({
    'run list': { out: JSON.stringify([{ databaseId: 3, name: 'd', workflowName: 'deploy', status: 'completed', conclusion: 'skipped', url: 'https://github.com/o/r/actions/runs/3' }]) },
    'api *': { out: '[]' },
  })).result;
  assert.deepStrictEqual(c, { status: 'passed', runUrl: 'https://github.com/o/r/actions/runs/3', commit: sha, deployments: [] });
});

test('context fetches a GitHub issue, reads a spec file, keeps text, and reports the feature state.json names', () => {
  const { dir, write } = githubRepo();
  const issue = { number: 12, title: 'CSV export', body: 'Export the report.', labels: [{ name: 'feature' }],
    comments: [{ author: { login: 'ann' }, body: 'Header too' }], url: 'https://github.com/o/r/issues/12' };
  const r = run(dir, 'context', { input: '#12' }, scriptedGh({ 'issue view': { out: JSON.stringify(issue) } })).result;
  assert.strictEqual(r.kind, 'issue');
  assert.deepStrictEqual(r.req, { ok: true, title: 'CSV export', source: 'https://github.com/o/r/issues/12', issueId: '12', slug: '12-csv-export',
    text: 'CSV export\n\nExport the report.\n\nLabels: feature\n\nComment by @ann:\nHeader too' });
  assert.deepStrictEqual(r.state, { feature: '12-csv', specStatus: 'approved' });
  const gone = run(dir, 'context', { input: 'https://github.com/o/r/issues/99' }, scriptedGh({ 'issue view': { err: 'GraphQL: Could not resolve to an issue', code: 1 } })).result;
  assert.match(gone.note, /^gh issue view failed: GraphQL/);
  write('docs/req.md', '# Bulk import\n\nUsers upload a CSV.\n');
  const f = run(dir, 'context', { input: 'docs/req.md' }).result;
  assert.deepStrictEqual([f.kind, f.req.title, f.req.slug, f.req.source], ['file', 'Bulk import', 'bulk-import', 'docs/req.md']);
  const t = run(dir, 'context', { input: 'Users export the report as CSV' }).result;
  assert.deepStrictEqual([t.kind, t.req], ['text', undefined]);
  write('.tdd-flow/state.json', '{"feature":"99-gone","phase":"IDLE","task":"T-1"}\n');
  assert.deepStrictEqual(run(dir, 'context', { input: 'x' }).result.state, { feature: '99-gone', specStatus: 'missing' });
  write('.tdd-flow/state.json', '{"feature":null,"phase":"IDLE","task":null}\n');
  assert.strictEqual(run(dir, 'context', { input: 'x' }).result.state, undefined);
  assert.strictEqual(run(repo().dir, 'context', { input: '#12' }).result.note, 'not a GitHub issue in this repo');
});

test('board keeps the other specs when one worktree entry cannot be read', () => {
  const { dir } = trackedRepo();
  run(dir, 'worktree', { slug: '12-csv' });
  run(dir, 'run-report', { slug: '12-csv', status: 'done', prUrl: 'https://github.com/o/r/pull/7' });
  fs.symlinkSync(path.join(dir, 'no-such-dir'), path.join(dir, '.claude/worktrees/zz-dangling'));
  assert.deepStrictEqual(run(dir, 'board', {}, fakeClaude([])).result.rows.map((r) => [r.slug, r.status]), [['12-csv', 'done']]);
});

/** A spec with a title, one AC, out of scope items and the given `## Resolved questions` lines. */
const decidedSpec = (title, resolved) => `# ${title}\n\n- Slug: x\n- Status: approved\n\n## Acceptance criteria\n\n### AC-1 Export works\n- **Given** a report\n- **When** exported\n- **Then** a file\n\n## Out of scope\n\n- PDF export\n- Scheduling\n\n## Open questions\n\n## Resolved questions\n\n${resolved}\n\n## Task breakdown\n\n- Q-9 not in the section - **Answer:** ignored (01.01.2026) → no change\n`;

test('decisions parses resolved questions with continuation lines, skips malformed lines, leaves out the asking slug', () => {
  const { dir, g, write } = trackedRepo();
  write('.tdd-flow/features/a-export/spec.md', decidedSpec('CSV export', [
    '- Q-1 Include hidden columns? - **Answer:** no, only visible ones (03.11.2026) → AC-1',
    '- Q-2 Which delimiter',
    '  for European locales? - **Answer:** semicolon, as decided in b-import Q-1 (04.11.2026) → EC-1, T-2',
    '- Q-3 Malformed, no answer here',
    '- Q-4 Sort - by name or date? - **Answer:** assumption accepted: by name (see AC-1 (old)) (05.11.2026) → no change',
    'stray prose line',
  ].join('\n')));
  write('.tdd-flow/features/b-import/spec.md', decidedSpec('CSV import', '- Q-1 Delimiter? - **Answer:** semicolon (01.11.2026) → AC-1'));
  g('add', '.tdd-flow');
  g('commit', '-qm', 'specs with decisions');
  const r = run(dir, 'decisions', { slug: 'b-import' });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.result.decisions, [
    { slug: 'a-export', title: 'CSV export', id: 'Q-1', question: 'Include hidden columns?', answer: 'no, only visible ones', date: '03.11.2026', where: 'AC-1' },
    { slug: 'a-export', title: 'CSV export', id: 'Q-2', question: 'Which delimiter for European locales?', answer: 'semicolon, as decided in b-import Q-1', date: '04.11.2026', where: 'EC-1, T-2' },
    { slug: 'a-export', title: 'CSV export', id: 'Q-4', question: 'Sort - by name or date?', answer: 'assumption accepted: by name (see AC-1 (old))', date: '05.11.2026', where: 'no change' },
  ]);
  assert.deepStrictEqual(r.result.conflicts, []);
  assert.strictEqual(r.result.skippedLines, 2);
  assert.deepStrictEqual(run(dir, 'decisions', {}).result.decisions.map((d) => `${d.slug} ${d.id}`), ['a-export Q-1', 'a-export Q-2', 'a-export Q-4', 'b-import Q-1']);
  assert.match(run(dir, 'decisions', { slug: '../x' }).error, /invalid feature slug/);
});

test('decisions prefers the worktree copy, reads feature/* branches, and works from a worktree', () => {
  const { dir, g, wt } = withWorktree();
  // A spec that exists only on its branch (spec-branch / an interactive run).
  g('switch', '-qc', 'feature/c-branch');
  fs.mkdirSync(path.join(dir, '.tdd-flow/features/c-branch'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tdd-flow/features/c-branch/spec.md'), decidedSpec('Branch only', '- Q-1 Branch? - **Answer:** yes (02.11.2026) → no change'));
  g('add', '.tdd-flow/features/c-branch');
  g('commit', '-qm', 'branch spec');
  g('switch', '-q', 'main');
  assert.ok(!fs.existsSync(path.join(dir, '.tdd-flow/features/c-branch')));
  // The worktree's uncommitted answer is newer than the committed spec.
  fs.writeFileSync(path.join(wt, '.tdd-flow/features/12-csv/spec.md'), decidedSpec('CSV', '- Q-1 Header row? - **Answer:** always (05.11.2026) → AC-1'));
  const fromMain = run(dir, 'decisions', {}).result.decisions.map((d) => `${d.slug} ${d.id} ${d.answer}`);
  assert.deepStrictEqual(fromMain, ['12-csv Q-1 always', 'c-branch Q-1 yes']);
  const fromWt = run(wt, 'decisions', { slug: '12-csv' });
  assert.strictEqual(fromWt.ok, true, fromWt.error);
  assert.deepStrictEqual(fromWt.result.decisions.map((d) => `${d.slug} ${d.id}`), ['c-branch Q-1']);
  assert.deepStrictEqual(run(wt, 'decisions', {}).result.decisions.map((d) => d.slug), ['12-csv', 'c-branch']);
});

test('context returns the other specs and their decisions, without the spec being analysed', () => {
  const { dir, g, write } = trackedRepo();
  write('.tdd-flow/features/a-export/spec.md', decidedSpec('CSV export', '- Q-1 Delimiter? - **Answer:** semicolon (03.11.2026) → AC-1'));
  write('.tdd-flow/features/a-export/tasks.md', '- [ ] T-1 Export (AC-1)\n');
  g('add', '.tdd-flow');
  g('commit', '-qm', 'spec');
  write('docs/req.md', '# CSV export\n\nAgain.\n');
  const r = run(dir, 'context', { input: 'Users import a CSV' });
  assert.strictEqual(r.ok, true, r.error);
  const byslug = Object.fromEntries(r.result.otherSpecs.map((s) => [s.slug, s]));
  assert.deepStrictEqual(Object.keys(byslug), ['12-csv', 'a-export']);
  const a = byslug['a-export'];
  assert.deepStrictEqual([a.title, a.status, a.acs, a.outOfScope], ['CSV export', 'approved', [{ id: 'AC-1', name: 'Export works' }], ['PDF export', 'Scheduling']]);
  assert.strictEqual(a.path, 'main:.tdd-flow/features/a-export/spec.md');
  assert.deepStrictEqual(byslug['12-csv'].acs.map((c) => c.id), ['AC-1', 'AC-2']);
  assert.deepStrictEqual(r.result.decisions.map((d) => `${d.slug} ${d.id} ${d.answer}`), ['a-export Q-1 semicolon']);
  // A file input whose slug names an existing spec leaves that spec out.
  const f = run(dir, 'context', { input: 'docs/req.md' }).result;
  assert.strictEqual(f.req.slug, 'csv-export');
  write('docs/req.md', '# A export\n\nAgain.\n');
  const again = run(dir, 'context', { input: 'docs/req.md' }).result;
  assert.deepStrictEqual([again.otherSpecs.map((s) => s.slug), again.decisions], [['12-csv'], []]);
});

// ---------- phase, suite {phase}, answer-decision (0.25.0) ----------
const PHASE_VALUES = ['RED', 'GREEN', 'REFACTOR', 'SETUP', 'REVIEW', 'IDLE'];

test('phase writes each allowed value and keeps feature and task, through a rename', () => {
  const { dir, read } = repo();
  const file = path.join(dir, '.tdd-flow/state.json');
  let previous = 'IDLE';
  for (const phase of PHASE_VALUES) {
    const ino = fs.statSync(file).ino;
    const r = run(dir, 'phase', { phase });
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.result, { phase, previous });
    assert.deepStrictEqual(JSON.parse(read('.tdd-flow/state.json')), { feature: '12-csv', phase, task: 'T-1' });
    assert.notStrictEqual(fs.statSync(file).ino, ino); // a new file renamed over the old one: never half written
    previous = phase;
  }
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.tdd-flow')).filter((f) => f.endsWith('.tmp')), []);
});

test('phase refuses other values and a broken state.json, and creates no state.json', () => {
  const { dir, read, write } = repo();
  const bad = run(dir, 'phase', { phase: 'review' });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /RED, GREEN, REFACTOR, SETUP, REVIEW, IDLE/);
  assert.match(run(dir, 'phase', {}).error, /RED, GREEN, REFACTOR, SETUP, REVIEW, IDLE/);
  assert.strictEqual(JSON.parse(read('.tdd-flow/state.json')).phase, 'IDLE');
  write('.tdd-flow/state.json', '{"feature":');
  assert.match(run(dir, 'phase', { phase: 'RED' }).error, /state\.json/);
  fs.rmSync(path.join(dir, '.tdd-flow/state.json'));
  assert.deepStrictEqual(run(dir, 'phase', { phase: 'RED' }).result, { skipped: 'no state.json' });
  assert.ok(!fs.existsSync(path.join(dir, '.tdd-flow/state.json')));
});

test('suite with phase REVIEW leaves REVIEW in state.json, and status shows it as review', () => {
  const { dir, read } = repo();
  assert.strictEqual(run(dir, 'suite', { phase: 'REVIEW' }).result.pass, true);
  assert.deepStrictEqual(JSON.parse(read('.tdd-flow/state.json')), { feature: '12-csv', phase: 'REVIEW', task: 'T-1' });
  assert.match(run(dir, 'suite', { phase: 'LATER' }).error, /RED, GREEN, REFACTOR, SETUP, REVIEW, IDLE/);
  // status: REVIEW shows as review, also for a blocked spec; IDLE keeps the older fallback.
  const t = trackedRepo();
  const env = fakeClaude([{ id: 's-1', kind: 'background', name: 'csv-export-flow', state: 'working' }]);
  run(t.dir, 'run-report', { slug: '12-csv', status: 'running', session: 's-1' });
  const wt = run(t.dir, 'worktree', { slug: '12-csv' }).result.path;
  const stateFile = path.join(wt, '.tdd-flow/state.json');
  fs.writeFileSync(stateFile, '{"feature":"12-csv","phase":"REVIEW","task":"T-1"}\n');
  assert.strictEqual(run(t.dir, 'status', {}, env).result.rows[0].phase, 'review');
  fs.writeFileSync(stateFile, '{"feature":"12-csv","phase":"IDLE","task":"T-1"}\n');
  assert.strictEqual(run(t.dir, 'status', {}, env).result.rows[0].phase, 'review');
  run(t.dir, 'run-report', { slug: '12-csv', status: 'blocked', details: 'x' });
  assert.strictEqual(run(t.dir, 'status', {}, env).result.rows[0].phase, '');
  fs.writeFileSync(stateFile, '{"feature":"12-csv","phase":"REVIEW","task":"T-1"}\n');
  assert.strictEqual(run(t.dir, 'status', {}, env).result.rows[0].phase, 'review');
});

test('the agents set the phase through tdd-flow phase, and the workflow passes phase REVIEW to suite', () => {
  const agents = path.join(__dirname, '..', 'agents');
  const calls = (f) => [...fs.readFileSync(path.join(agents, f), 'utf8').matchAll(/tdd-flow phase <<'TDD_FLOW_JSON'\n\s*\{"phase": "([A-Z]+)"\}\n\s*TDD_FLOW_JSON/g)].map((m) => m[1]);
  for (const f of fs.readdirSync(agents)) {
    const text = fs.readFileSync(path.join(agents, f), 'utf8');
    for (const re of [/set (its )?`phase`/i, /`phase`[^.\n]*state\.json/i, /state\.json[^.\n]*\b(set|write|change)\b[^.\n]*phase/i]) {
      assert.doesNotMatch(text, re, `${f} still edits the phase in state.json by hand`);
    }
  }
  assert.deepStrictEqual(calls('test-writer.md'), ['RED', 'RED', 'RED']);
  assert.deepStrictEqual(calls('implementer.md'), ['GREEN', 'REFACTOR', 'REFACTOR', 'SETUP']);
  const wf = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'tdd-implement.js'), 'utf8');
  assert.match(wf, /cli\('suite', \{ phase: 'REVIEW' \}/);
});

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const today = () => { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`; };
const OPEN_QUESTIONS = '## Open questions\n\n- Q-1 Keep the header row? - *assumption if unanswered:* yes\n' +
  '- Q-2 Should an empty report export only the header? - *assumption if unanswered:* header only\n  - Options: header only / no file, 204\n  - Blocks: T-2\n\n';
const Q2_DECISION = { id: 'Q-2', question: 'Should an empty report export only the header?', recommendation: 'header only', options: ['header only', 'no file, 204'], tasks: ['T-2'] };

/** A spec blocked on Q-2 in its worktree (spec committed on feature/12-csv), with the given fake claude. */
function blockedSpec({ spec = SPEC.replace('## Edge cases', `${OPEN_QUESTIONS}## Edge cases`), tasks = TASKS, sessions } = {}) {
  const w = withWorktree();
  const wg = (...a) => execFileSync('git', ['-C', w.wt, ...a], { stdio: 'pipe' }).toString().trim();
  const specFile = path.join(w.wt, '.tdd-flow/features/12-csv/spec.md');
  fs.writeFileSync(specFile, spec);
  fs.writeFileSync(path.join(w.wt, '.tdd-flow/features/12-csv/tasks.md'), tasks);
  wg('commit', '-qam', 'docs(12-csv): open Q-2');
  run(w.dir, 'run-report', { slug: '12-csv', status: 'blocked', session: 'old-1', details: 'T-2 needs a decision', decision: Q2_DECISION });
  const claude = loggingClaude(sessions || [{ id: 'old-1', kind: 'background', name: 'csv-export-flow', state: 'done', cwd: w.wt }]);
  const runFileJson = () => JSON.parse(fs.readFileSync(path.join(w.dir, '.git/tdd-flow/runs/12-csv.json'), 'utf8'));
  return { ...w, wg, specFile, claude, runFileJson, answer: (inp, env = claude.env) => run(w.dir, 'answer-decision', { slug: '12-csv', id: 'Q-2', answer: 'header only', ...inp }, env) };
}

test('answer-decision moves the entry to a new Resolved questions section, commits, replaces the session and reports running', () => {
  const b = blockedSpec();
  const r = b.answer({ where: 'AC-1' });
  assert.strictEqual(r.ok, true, r.error);
  const spec = fs.readFileSync(b.specFile, 'utf8');
  assert.ok(spec.includes('## Open questions\n\n- Q-1 Keep the header row? - *assumption if unanswered:* yes\n\n' +
    `## Resolved questions\n\n- Q-2 Should an empty report export only the header? - **Answer:** header only (${today()}) → AC-1\n  - Options: header only / no file, 204\n  - Blocks: T-2\n\n## Edge cases`), spec);
  assert.match(spec, /Status: approved/);
  // decisions parses the moved entry.
  const d = run(b.dir, 'decisions', {}).result.decisions.find((x) => x.slug === '12-csv');
  assert.deepStrictEqual([d.id, d.question, d.answer, d.date], ['Q-2', 'Should an empty report export only the header?', 'header only', today()]);
  assert.match(d.where, /^AC-1\b/);
  // The commit holds the spec folder only.
  assert.strictEqual(b.wg('log', '-1', '--format=%s'), 'docs(12-csv): answer Q-2');
  assert.strictEqual(b.wg('show', '--name-only', '--format=', 'HEAD'), '.tdd-flow/features/12-csv/spec.md');
  // The old session (done) is removed and its free name reused; the new one starts in the worktree.
  assert.match(b.claude.log(), /^rm old-1$/m);
  assert.match(b.claude.log(), new RegExp(`^--bg -n csv-export-flow /tdd-flow:implement-spec 12-csv main in ${esc(b.wt)}$`, 'm'));
  assert.deepStrictEqual(r.result, { slug: '12-csv', id: 'Q-2', answer: 'header only', session: 'new-7', name: 'csv-export-flow', attach: 'claude attach csv-export-flow', notes: [] });
  const runNow = b.runFileJson();
  assert.deepStrictEqual([runNow.status, runNow.session, runNow.decision], ['running', 'new-7', undefined]);
  // Answered: a second call errors and changes nothing.
  const again = b.answer({});
  assert.match(again.error, /already answered or another question/);
  assert.strictEqual(fs.readFileSync(b.specFile, 'utf8'), spec);
});

test('answer-decision appends to an existing Resolved questions section, where defaults to no change', () => {
  const resolved = '## Resolved questions\n\n- Q-1 Delimiter? - **Answer:** semicolon (03.11.2026) → AC-1\n\n';
  const b = blockedSpec({ spec: SPEC.replace('## Edge cases', `${OPEN_QUESTIONS}${resolved}## Edge cases`).replace('- Q-1 Keep the header row? - *assumption if unanswered:* yes\n', '') });
  const r = b.answer({ name: 'csv-header-answer' });
  assert.strictEqual(r.ok, true, r.error);
  const spec = fs.readFileSync(b.specFile, 'utf8');
  assert.ok(spec.includes('## Open questions\n\n## Resolved questions\n\n- Q-1 Delimiter? - **Answer:** semicolon (03.11.2026) → AC-1\n' +
    `- Q-2 Should an empty report export only the header? - **Answer:** header only (${today()}) → no change\n  - Options: header only / no file, 204\n  - Blocks: T-2\n\n## Edge cases`), spec);
  assert.strictEqual((spec.match(/## Resolved questions/g) || []).length, 1);
  assert.strictEqual(r.result.name, 'csv-header-answer');
  assert.match(b.claude.log(), /^--bg -n csv-header-answer /m);
});

test('answer-decision for an implemented spec needs an open task first, then sets approved', () => {
  const ticked = TASKS.replace(/\[ \]/g, '[x]');
  const b = blockedSpec({ spec: SPEC.replace('## Edge cases', `${OPEN_QUESTIONS}## Edge cases`).replace('Status: approved', 'Status: implemented'), tasks: ticked });
  const head = b.wg('rev-parse', 'HEAD');
  const before = fs.readFileSync(b.specFile, 'utf8');
  const r = b.answer({});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /add the task for the answer first/);
  assert.strictEqual(fs.readFileSync(b.specFile, 'utf8'), before);
  assert.strictEqual(b.wg('rev-parse', 'HEAD'), head);
  assert.strictEqual(b.claude.log(), '');
  assert.strictEqual(b.runFileJson().status, 'blocked');
  // The model adds the task for the answer (uncommitted); then the spec goes back to approved in the same commit.
  fs.writeFileSync(path.join(b.wt, '.tdd-flow/features/12-csv/tasks.md'), `${ticked}- [ ] T-21 Header-only export (AC-1)\n`);
  const ok = b.answer({});
  assert.strictEqual(ok.ok, true, ok.error);
  assert.match(fs.readFileSync(b.specFile, 'utf8'), /Status: approved/);
  assert.strictEqual(b.wg('show', '--name-only', '--format=', 'HEAD'), '.tdd-flow/features/12-csv/spec.md\n.tdd-flow/features/12-csv/tasks.md');
});

test('answer-decision keeps a working session and picks a name from the slug', () => {
  const b = blockedSpec({ sessions: [{ id: 'old-1', kind: 'background', name: 'csv-export-flow', state: 'working', cwd: '/elsewhere' }] });
  const r = b.answer({});
  assert.strictEqual(r.ok, true, r.error);
  assert.doesNotMatch(b.claude.log(), /^rm /m);
  assert.strictEqual(r.result.name, 'csv');
  assert.match(r.result.notes.join('\n'), /old-1.*working/);
  // Unknown session list: no rm either.
  const u = blockedSpec();
  const broken = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-claude-')), 'claude');
  fs.writeFileSync(broken, `#!/bin/sh\nif [ "$1" = agents ]; then exit 1; fi\necho "$@" >> "${broken}.log"\necho "backgrounded · new-8 · $3"\n`, { mode: 0o755 });
  const ru = u.answer({}, { TDD_FLOW_CLAUDE_BIN: broken });
  assert.strictEqual(ru.ok, true, ru.error);
  assert.doesNotMatch(fs.readFileSync(`${broken}.log`, 'utf8'), /^rm /m);
  assert.match(ru.result.notes.join('\n'), /not removed/);
  assert.strictEqual(ru.result.session, 'new-8');
});

test('answer-decision errors on a wrong id or a run that is not blocked, without touching files', () => {
  const b = blockedSpec();
  const before = fs.readFileSync(b.specFile, 'utf8');
  for (const inp of [{ id: 'Q-9' }, { id: '2' }, { answer: ' ' }]) {
    const r = b.answer(inp);
    assert.strictEqual(r.ok, false, JSON.stringify(inp));
  }
  assert.match(b.answer({ id: 'Q-9' }).error, /already answered or another question/);
  run(b.dir, 'run-report', { slug: '12-csv', status: 'running', session: 'old-1' });
  assert.match(b.answer({}).error, /already answered or another question/);
  assert.strictEqual(fs.readFileSync(b.specFile, 'utf8'), before);
  assert.strictEqual(b.wg('log', '-1', '--format=%s'), 'docs(12-csv): open Q-2');
  assert.strictEqual(b.claude.log(), '');
});

test('answer-decision stops at the restart when claude --bg prints no id, and a rerun finishes the job', () => {
  const b = blockedSpec();
  const noId = loggingClaude([{ id: 'old-1', kind: 'background', name: 'csv-export-flow', state: 'done', cwd: '/x' }], { bgOut: 'something went wrong' });
  const r = b.answer({}, noId.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /step 5.*backgrounded/);
  assert.strictEqual(b.wg('log', '-1', '--format=%s'), 'docs(12-csv): answer Q-2'); // earlier steps stay
  assert.strictEqual(b.runFileJson().status, 'blocked');
  const again = b.answer({});
  assert.strictEqual(again.ok, true, again.error);
  assert.strictEqual(b.wg('log', '-2', '--format=%s'), 'docs(12-csv): answer Q-2\ndocs(12-csv): open Q-2'); // no second commit
  assert.strictEqual((fs.readFileSync(b.specFile, 'utf8').match(/Q-2 /g) || []).length, 1);
  assert.strictEqual(b.runFileJson().session, 'new-7');
});
