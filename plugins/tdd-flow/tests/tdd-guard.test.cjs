// Tests for hooks/scripts/tdd-guard.sh: which edits it blocks while a repo's .tdd-flow/state.json says RED.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'hooks', 'scripts', 'tdd-guard.sh');

/** A git repo at <tmp>/<sub> whose state.json has the given phase (no state.json when phase is null). */
function repo(phase, sub = 'app') {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-guard-')), sub);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  if (phase) {
    fs.mkdirSync(path.join(dir, '.tdd-flow'));
    fs.writeFileSync(path.join(dir, '.tdd-flow', 'state.json'), JSON.stringify({ feature: '12-csv', phase, task: 'T-1' }));
  }
  return dir;
}

/** Runs the guard for a Write of `file`; the session runs in `projectDir`. Returns the exit code and stderr. */
function guard(file, projectDir, extra = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const input = JSON.stringify({ tool_name: 'Write', cwd: projectDir, tool_input: { file_path: file, content: 'x' }, ...extra });
  const r = spawnSync('bash', [GUARD], { input, env, encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr };
}

test('tdd-guard blocks production code during RED and lets tests, fixtures and .tdd-flow/ through', () => {
  const dir = repo('RED');
  const code = (rel) => guard(path.join(dir, rel), dir).code;
  assert.strictEqual(code('src/app.ts'), 2);
  assert.match(guard(path.join(dir, 'src/app.ts'), dir).stderr, /production file 'src\/app\.ts'.*ask the user before setting "phase" to "IDLE"/);
  assert.strictEqual(code('src/new/dir/created.py'), 2); // the folder does not exist yet
  for (const ok of ['tests/app.test.ts', 'tests/test_app.py', 'src/__tests__/a.ts', 'src/app.spec.ts', 'pkg/a_test.go',
    'README.md', 'fixtures/data.json', '.tdd-flow/features/12-csv/tdd-log.md', 'conftest.py']) assert.strictEqual(code(ok), 0, ok);
  assert.strictEqual(code('test/a.js'), 0); // a top-level test folder
});

test('tdd-guard matches test folders inside the repo, not in the folders the repo lives in', () => {
  for (const parent of ['tests', 'spec', 'testing']) {
    const dir = repo('RED', `${parent}/app`);
    assert.strictEqual(guard(path.join(dir, 'src/app.ts'), dir).code, 2, parent);
    assert.strictEqual(guard(path.join(dir, 'tests/app.test.ts'), dir).code, 0, parent);
  }
});

test('tdd-guard takes JVM and .NET test classes by their case-sensitive suffix', () => {
  const dir = repo('RED');
  const code = (rel) => guard(path.join(dir, rel), dir).code;
  for (const prod of ['src/main/java/Latest.java', 'src/Contest.kt', 'src/Latest.cs']) assert.strictEqual(code(prod), 2, prod);
  for (const t of ['src/LatestTest.java', 'src/OrderTests.java', 'src/OrderIT.java', 'src/OrderTestCase.java', 'src/ContestTest.kt',
    'src/OrderIT.kt', 'src/LatestTests.cs']) assert.strictEqual(code(t), 0, t);
});

test('tdd-guard reads the state of the repo the file is in, not of the session directory', () => {
  const red = repo('RED');
  const idle = repo('IDLE');
  // The session runs in another checkout (IDLE) or in a subfolder of the RED repo: the file's repo decides.
  assert.strictEqual(guard(path.join(red, 'src/app.ts'), idle).code, 2);
  assert.strictEqual(guard(path.join(idle, 'src/app.ts'), red).code, 0);
  fs.mkdirSync(path.join(red, 'apps/web'), { recursive: true });
  assert.strictEqual(guard(path.join(red, 'apps/web/src/app.ts'), path.join(red, 'apps/web')).code, 2);
  // A worktree has a .git file and its own state.json.
  const wt = path.join(path.dirname(red), 'wt');
  execFileSync('git', ['-C', idle, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' } });
  execFileSync('git', ['-C', idle, 'worktree', 'add', '-q', '-b', 'feature/x', wt]);
  fs.mkdirSync(path.join(wt, '.tdd-flow'));
  fs.writeFileSync(path.join(wt, '.tdd-flow', 'state.json'), '{"phase":"RED"}');
  assert.strictEqual(guard(path.join(wt, 'src/app.ts'), idle).code, 2);
  // A relative path resolves against the session directory.
  assert.strictEqual(guard('src/app.ts', red).code, 2);
});

test('tdd-guard lets everything through outside RED, outside a repo and without a file path', () => {
  assert.strictEqual(guard(path.join(repo('GREEN'), 'src/app.ts'), os.tmpdir()).code, 0);
  assert.strictEqual(guard(path.join(repo(null), 'src/app.ts'), os.tmpdir()).code, 0);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-guard-norepo-'));
  assert.strictEqual(guard(path.join(outside, 'a.ts'), repo('RED')).code, 0);
  const r = spawnSync('bash', [GUARD], { input: JSON.stringify({ tool_input: {} }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
});
