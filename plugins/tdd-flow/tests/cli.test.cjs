'use strict';
// Tests for bin/tdd-flow. Run from the repo root: node --test plugins/tdd-flow/tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'tdd-flow');
const { parseSpec, parseTasks, parseTaskTable, compact, kebab, onMergeSummary } = require(CLI);

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
  return { dir, g, read: (p) => fs.readFileSync(path.join(dir, p), 'utf8'), write: (p, s) => fs.writeFileSync(path.join(dir, p), s) };
}

function run(dir, cmd, input) {
  const r = spawnSync(process.execPath, [CLI, cmd], { cwd: dir, input: JSON.stringify(input || {}), encoding: 'utf8' });
  return JSON.parse(r.stdout.trim());
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
