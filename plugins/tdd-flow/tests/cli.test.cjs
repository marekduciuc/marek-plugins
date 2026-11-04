'use strict';
// Tests for bin/tdd-flow. Run from the repo root: node --test plugins/tdd-flow/tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'tdd-flow');
const { parseSpec, parseTasks, parseTaskTable, compact, kebab, onMergeSummary, setSpecStatus, shapeOf } = require(CLI);

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
  assert.strictEqual(blocks.length, 4);
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
  assert.deepStrictEqual(t, { finished: [], running: [{ slug: 'b', attach: 'claude attach invite-reset-flow' }], timedOut: true });
  assert.match(run(dir, 'run-report', { slug: 'a', status: 'merged' }).error, /running, done or blocked/);
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
  assert.match(why({ ...loggingClaude([{ id: 'cd34', kind: 'interactive', cwd: path.join(wt, '.tdd-flow'), state: 'idle' }]).env, ...fakeGh(merged(tip())) }), /session cd34 is still open \(idle\)/);
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
