'use strict';
// Tests for the watched test jobs of bin/tdd-flow (runTests, regenerate): a slow run continues over several calls,
// a hung or capped run is killed. Run from the repo root: node --test plugins/tdd-flow/tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'tdd-flow');

/** Repo on feature/12-csv with a git-ignored .tdd-flow/ whose stack.md runs `testAll`. */
function repo(testAll = 'node -e 0') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-jobs-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.tdd-flow/\n');
  g('add', '.gitignore');
  g('commit', '-qm', 'init');
  g('switch', '-qc', 'feature/12-csv');
  const write = (p, s) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), s); };
  const stack = (all, extra = '') => write('.tdd-flow/stack.md', `test command (all): \`${all}\`\ndefault branch: main\n${extra}`);
  stack(testAll);
  return { dir, g, write, stack, read: (p) => fs.readFileSync(path.join(dir, p), 'utf8') };
}

const run = (dir, cmd, input, env) => {
  const r = spawnSync(process.execPath, [CLI, cmd], { cwd: dir, input: JSON.stringify(input || {}), encoding: 'utf8', env: { ...process.env, ...env } });
  return JSON.parse(r.stdout.trim());
};
const tdd = (dir, command, env) => spawnSync(process.execPath, [CLI, 'test', '--', command], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });

/** A file outside the repo that the command appends to once per start, so the tree hash does not change. */
function counter() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-count-')), 'runs');
  return { f, runs: () => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0) };
}
const jobsDir = (dir) => path.join(dir, '.git', 'tdd-flow', 'test-jobs');
const jobs = (dir) => (fs.existsSync(jobsDir(dir)) ? fs.readdirSync(jobsDir(dir)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(jobsDir(dir), f), 'utf8'))) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function gone(pid) {
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

test('a run longer than one call returns again, the identical call finishes the same run, and the pass is cached', () => {
  const c = counter();
  const { dir, stack } = repo();
  stack(`echo run >> '${c.f}'; sleep 2`);
  const env = { TDD_FLOW_CALL_MS: '700' };
  const first = run(dir, 'suite', {}, env);
  assert.strictEqual(first.again, true);
  assert.strictEqual(first.ok, true);
  assert.deepStrictEqual([first.result.ran, first.result.pass, first.result.running], [true, false, true]);
  assert.ok(Number.isInteger(first.result.elapsedS) && Number.isInteger(first.result.idleS), JSON.stringify(first.result));
  let r = first;
  for (let i = 0; i < 6 && r.again; i++) r = run(dir, 'suite', {}, env);
  assert.strictEqual(r.again, undefined);
  assert.deepStrictEqual({ ...r.result, summary: undefined }, { ran: true, pass: true, command: `echo run >> '${c.f}'; sleep 2`, cached: false, summary: undefined });
  assert.strictEqual(c.runs(), 1);
  assert.deepStrictEqual(jobs(dir), []);
  assert.strictEqual(run(dir, 'suite', {}, env).result.cached, true);
  assert.strictEqual(c.runs(), 1);
});

test('test prints RUNNING and exits 3 while the run continues, then PASS for the same run', () => {
  const c = counter();
  const { dir } = repo();
  const cmd = `echo run >> '${c.f}'; echo working; sleep 2`;
  const env = { TDD_FLOW_CALL_MS: '700' };
  const first = tdd(dir, cmd, env);
  assert.strictEqual(first.status, 3, first.stdout);
  assert.match(first.stdout, /^RUNNING \(\d+ s, no output for \d+ s\) `echo run/);
  assert.match(first.stdout, /run the identical command again/i);
  let r = first;
  for (let i = 0; i < 6 && r.status === 3; i++) r = tdd(dir, cmd, env);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /^PASS \(exit 0\)/);
  assert.strictEqual(c.runs(), 1);
});

test('a silent sleeping run is killed after the idle limit, with its process group', async () => {
  const { dir } = repo();
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-pid-')), 'pid');
  const r = tdd(dir, `echo started; echo $$ > '${pidFile}'; sleep 30`, { TDD_FLOW_TEST_IDLE_MS: '1500', TDD_FLOW_CALL_MS: '20000' });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /^FAIL \(exit timeout\)/);
  assert.match(r.stdout, /no output and no CPU for 1\.5 s/);
  assert.match(r.stdout, /started\n$/);
  assert.ok(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), 'the killed run is still alive');
  assert.deepStrictEqual(jobs(dir), []);
});

test('the watcher kills a hung run even when no call is waiting for it', async () => {
  const { dir } = repo();
  assert.strictEqual(tdd(dir, 'sleep 30', { TDD_FLOW_CALL_MS: '300', TDD_FLOW_TEST_IDLE_MS: '1000' }).status, 3);
  const [job] = jobs(dir);
  assert.ok(await gone(job.pid), 'the hung run is still alive');
  const r = tdd(dir, 'sleep 30', { TDD_FLOW_CALL_MS: '300' });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /no output and no CPU for 1 s/);
});

test('a run that prints regularly is not killed, though it runs longer than the idle limit', () => {
  const { dir } = repo();
  const r = tdd(dir, 'for i in 1 2 3 4 5 6 7 8 9 10; do echo line $i; sleep 0.3; done', { TDD_FLOW_TEST_IDLE_MS: '1000', TDD_FLOW_CALL_MS: '20000' });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /^PASS \(exit 0\)/);
});

test('a silent run that burns CPU is not killed; a silent run that sleeps is', () => {
  const { dir } = repo();
  const env = { TDD_FLOW_TEST_IDLE_MS: '2000', TDD_FLOW_CALL_MS: '20000' };
  const busy = tdd(dir, `node -e "const end = Date.now() + 4500; while (Date.now() < end);"`, env);
  assert.strictEqual(busy.status, 0, busy.stdout);
  const idle = run(dir, 'suite', {}, env);
  assert.strictEqual(idle.result.pass, true);
  const sleeper = tdd(dir, 'sleep 20', env);
  assert.strictEqual(sleeper.status, 1, sleeper.stdout);
  assert.match(sleeper.stdout, /no output and no CPU for 2 s/);
});

test('the hard cap kills a run whatever it prints', () => {
  const { dir } = repo();
  const r = tdd(dir, 'i=0; while true; do i=$((i+1)); echo tick $i; sleep 0.2; done', { TDD_FLOW_TEST_HARD_CAP_MS: '1500', TDD_FLOW_TEST_IDLE_MS: '60000', TDD_FLOW_CALL_MS: '20000' });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /^FAIL \(exit timeout\)/);
  assert.match(r.stdout, /exceeded the 1\.5 s cap/);
  assert.match(r.stdout, /tick \d+\n$/);
});

test('a job whose process vanished without an exit code fails as interrupted', () => {
  const { dir } = repo();
  const env = { TDD_FLOW_CALL_MS: '500' };
  assert.strictEqual(tdd(dir, 'sleep 30', env).status, 3);
  const [job] = jobs(dir);
  assert.deepStrictEqual([job.cmd, job.status, typeof job.pid, typeof job.watcher, typeof job.startedAt, fs.existsSync(job.logFile)], ['sleep 30', 'running', 'number', 'number', 'number', true]);
  assert.strictEqual(fs.realpathSync(job.cwd), fs.realpathSync(dir));
  // As after a reboot: the watcher and the command are gone, and nobody wrote an exit code.
  process.kill(job.watcher, 'SIGKILL');
  process.kill(-job.pid, 'SIGKILL');
  const r = tdd(dir, 'sleep 30', env);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /^FAIL/);
  assert.match(r.stdout, /the test run was interrupted/);
  assert.deepStrictEqual(jobs(dir), []);
});

test('the same command on the same tree attaches to the running job, also after the run wrote a file; a changed tree starts a new one', () => {
  const c = counter();
  const { dir, write } = repo();
  const env = { TDD_FLOW_CALL_MS: '400' };
  const cmd = `echo run >> '${c.f}'; echo x > out.txt; sleep 2`;
  assert.strictEqual(tdd(dir, cmd, env).status, 3);
  assert.strictEqual(tdd(dir, cmd, env).status, 3);
  assert.strictEqual(c.runs(), 1);
  write('src.js', 'changed\n');
  assert.strictEqual(tdd(dir, cmd, env).status, 3);
  assert.strictEqual(c.runs(), 2);
  assert.strictEqual(jobs(dir).length, 1, 'the run on the old tree is replaced, not left running');
  let r;
  for (let i = 0; i < 10; i++) { r = tdd(dir, cmd, env); if (r.status !== 3) break; }
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(c.runs(), 2);
});

test('a failing run is not cached and runs again', () => {
  const c = counter();
  const { dir } = repo();
  const cmd = `echo run >> '${c.f}'; exit 4`;
  assert.match(tdd(dir, cmd).stdout, /^FAIL \(exit 4\)/);
  assert.match(tdd(dir, cmd).stdout, /^FAIL \(exit 4\)/);
  assert.strictEqual(c.runs(), 2);
});

test('commit with runTests returns again while the suite runs and commits once it passed', () => {
  const { dir, write, stack, g } = repo();
  stack('sleep 1.5');
  write('a.js', 'x\n');
  const env = { TDD_FLOW_CALL_MS: '500' };
  const input = { message: 'feat: a', files: ['a.js'], runTests: true };
  const first = run(dir, 'commit', input, env);
  assert.strictEqual(first.again, true);
  assert.deepStrictEqual([first.result.committed, first.result.running], [false, true]);
  let r = first;
  for (let i = 0; i < 8 && r.again; i++) r = run(dir, 'commit', input, env);
  assert.strictEqual(r.result.committed, true, JSON.stringify(r));
  assert.strictEqual(g('log', '-1', '--format=%s'), 'feat: a');
});

test('plan returns again while the baseline runs, then the baseline result', () => {
  const { dir, write, stack } = repo();
  write('.tdd-flow/features/12-csv/spec.md', '- Status: approved\n\n## Acceptance criteria\n\n### AC-1 One\n- **Given** a\n- **When** b\n- **Then** c\n');
  write('.tdd-flow/features/12-csv/tasks.md', '- [ ] T-1 One (AC-1)\n');
  write('.tdd-flow/state.json', '{"feature":"12-csv","phase":"IDLE"}\n');
  stack('sleep 1.5');
  const env = { TDD_FLOW_CALL_MS: '500' };
  const first = run(dir, 'plan', {}, env);
  assert.strictEqual(first.again, true, JSON.stringify(first));
  assert.deepStrictEqual([first.result.running, first.result.baselinePass, first.result.taskCount], [true, false, 1]);
  let r = first;
  for (let i = 0; i < 8 && r.again; i++) r = run(dir, 'plan', {}, env);
  assert.strictEqual(r.again, undefined);
  assert.strictEqual(r.result.baselinePass, true);
  assert.strictEqual(r.result.running, undefined);
});

/** Repo with an origin; gen.js writes gen.json from src/; on feature/12-csv. `onBase` moves origin/main. */
function syncRepo(generate) {
  const r = repo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-jobs-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  r.g('switch', '-q', 'main');
  r.write('gen.js', "const fs = require('fs'); fs.writeFileSync('gen.json', JSON.stringify(fs.readdirSync('src').sort()) + '\\n');\n");
  r.write('src/a.txt', 'a\n');
  r.write('gen.json', '["a.txt"]\n');
  r.g('add', 'gen.js', 'src', 'gen.json');
  r.g('commit', '-qm', 'base');
  r.g('remote', 'add', 'origin', remote);
  r.g('push', '-q', 'origin', 'main');
  r.g('switch', '-q', 'feature/12-csv');
  r.g('merge', '-q', '--ff-only', 'main');
  r.stack('node -e 0', `generate command: \`${generate}\`\ngenerated files: gen.json\n`);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-jobs-other-'));
  execFileSync('git', ['clone', '-q', remote, other]);
  const og = (...a) => execFileSync('git', a, { cwd: other, stdio: 'pipe' });
  og('config', 'user.email', 'o@example.com');
  og('config', 'user.name', 'O');
  const onBase = (p, s) => { fs.mkdirSync(path.dirname(path.join(other, p)), { recursive: true }); fs.writeFileSync(path.join(other, p), s); og('add', '-A'); og('commit', '-qm', 'base moves'); og('push', '-q', 'origin', 'main'); };
  const commitHere = (p, s) => { r.write(p, s); r.g('add', '--', p); r.g('commit', '-qm', 'feature work'); };
  return { ...r, onBase, commitHere };
}
const syncUntilDone = (dir, env) => {
  let r = run(dir, 'sync-base', { base: 'main' }, env);
  const first = r;
  for (let i = 0; i < 10 && r.again; i++) r = run(dir, 'sync-base', { base: 'main' }, env);
  return { first, last: r };
};

test('sync-base: a slow generate command finishes over several calls, with and without a merge', () => {
  const s = syncRepo('sleep 1.5 && node gen.js');
  const env = { TDD_FLOW_CALL_MS: '500' };
  s.commitHere('src/b.txt', 'b\n');
  const up = syncUntilDone(s.dir, env);
  assert.strictEqual(up.first.again, true);
  assert.strictEqual(up.first.result.running, true);
  assert.deepStrictEqual(up.last.result, { base: 'main', merged: false, upToDate: true, regenerated: ['gen.json'] });
  assert.strictEqual(s.read('gen.json'), '["a.txt","b.txt"]\n');
  s.onBase('src/c.txt', 'c\n');
  const merge = syncUntilDone(s.dir, env);
  assert.strictEqual(merge.first.again, true);
  assert.deepStrictEqual(merge.last.result, { base: 'main', merged: true, upToDate: false, regenerated: ['gen.json'] });
  assert.strictEqual(s.read('gen.json'), '["a.txt","b.txt","c.txt"]\n');
  assert.strictEqual(s.g('log', '-1', '--format=%P').split(' ').length, 2);
  assert.strictEqual(s.g('status', '--porcelain'), '');
});

test('sync-base: a hung generate command is killed and the merge is aborted', () => {
  const s = syncRepo('sleep 30');
  const env = { TDD_FLOW_CALL_MS: '20000', TDD_FLOW_TEST_IDLE_MS: '1000' };
  s.commitHere('src/b.txt', 'b\n');
  s.onBase('src/c.txt', 'c\n');
  const head = s.g('rev-parse', 'HEAD');
  const r = run(s.dir, 'sync-base', { base: 'main' }, env).result;
  assert.deepStrictEqual([r.generateFailed, r.merged], [true, false]);
  assert.match(r.reason, /`sleep 30` was killed: no output and no CPU for 1 s/);
  assert.strictEqual(s.g('rev-parse', 'HEAD'), head);
  assert.strictEqual(s.g('status', '--porcelain', '--untracked-files=no'), '');
});
