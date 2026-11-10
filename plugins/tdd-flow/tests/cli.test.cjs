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
/** Fake `claude` that prints sessions for `agents` and logs `rm` calls. */
function loggingClaude(sessions) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-claude-'));
  const f = path.join(d, 'claude');
  fs.writeFileSync(f, `#!/bin/sh\nif [ "$1" = rm ]; then echo "$@" >> "${d}/log"; else echo '${JSON.stringify(sessions)}'; fi\n`, { mode: 0o755 });
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

test('cleanup removes a merged, clean worktree with its session, run file and branch', () => {
  const { dir, wt, tip } = withWorktree();
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), 'node_modules/\n.classpath\ntestreport.md\n');
  fs.writeFileSync(path.join(wt, '.classpath'), '<classpath/>');
  fs.writeFileSync(path.join(wt, 'testreport.md'), '# report');
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

test('cleanup keeps worktrees with open PRs, later commits, changes, open sessions or precious ignored files', () => {
  const { dir, wt, tip, g } = withWorktree();
  const none = loggingClaude([]).env;
  const why = (env) => { const r = run(dir, 'cleanup', {}, env); assert.strictEqual(r.ok, true, r.error); assert.deepStrictEqual(r.result.removed, []); return r.result.kept[0].why; };
  assert.match(why({ ...none, ...fakeGh([{ number: 8, state: 'OPEN', headRefOid: tip() }, ...merged(tip())]) }), /PR #8 is open/);
  assert.match(why({ ...none, ...fakeGh([]) }), /no PR/);
  assert.match(why({ ...loggingClaude([{ id: 'cd34', kind: 'interactive', cwd: path.join(wt, '.tdd-flow'), state: 'idle' }]).env, ...fakeGh(merged(tip())) }), /session cd34 is still open \(idle\) - if its work is done, close it with `claude stop cd34`/);
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), '*.local\n');
  fs.writeFileSync(path.join(wt, 'db.local'), 'data');
  assert.match(why({ ...none, ...fakeGh(merged(tip())) }), /ignored files would be deleted: db\.local/);
  fs.rmSync(path.join(wt, 'db.local'));
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
