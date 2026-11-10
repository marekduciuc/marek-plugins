// Tests for hooks/scripts/push-gate.cjs: the checks a .tdd-flow/stack.md profile adds, the HEAD cache and the budget.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const gate = require('../hooks/scripts/push-gate.cjs');

/** A git repo with one commit and the given stack.md; no package.json, like a monorepo root. */
function repo(stack) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-gate-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'src.txt'), 'x\n');
  g('add', 'src.txt');
  g('commit', '-qm', 'init');
  if (stack != null) { fs.mkdirSync(path.join(dir, '.tdd-flow')); fs.writeFileSync(path.join(dir, '.tdd-flow', 'stack.md'), stack); }
  return dir;
}

const env = { ...process.env, PATH: process.env.PATH, TDD_FLOW_PUSH_GATE: '' };
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;
const push = (dir, e = env) => gate.main(JSON.stringify({ tool_input: { command: 'git push -u origin feature/x' }, cwd: dir }), e);
const cacheOf = (dir) => { try { return fs.readFileSync(path.join(dir, '.git', 'tdd-flow-push-gate'), 'utf8').trim(); } catch { return null; } };
const headOf = (dir) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

test('stackField reads a command line, strips backticks, treats none/unknown as absent', () => {
  const dir = repo('test command (all): `(cd app && npm test)`\ntype check command: none\nlint/format command: unknown (none configured)\n');
  assert.strictEqual(gate.stackField(dir, 'test command (all)'), '(cd app && npm test)');
  assert.strictEqual(gate.stackField(dir, 'type check command'), null);
  assert.strictEqual(gate.stackField(dir, 'lint/format command'), null);
  assert.strictEqual(gate.stackField(dir, 'build command'), null);
  assert.strictEqual(gate.stackField(repo(null), 'test command (all)'), null);
});

test('detectChecks: the stack profile adds its type check before its test command, unless the tests already run it', () => {
  const both = repo('type check command: node -e "process.exit(0)"\ntest command (all): node -e 0\n');
  assert.deepStrictEqual(gate.detectChecks(both, () => true).map((c) => [c.name, c.cmd]), [
    ['type check (.tdd-flow/stack.md)', 'node -e "process.exit(0)"'],
    ['tests (.tdd-flow/stack.md)', 'node -e 0'],
  ]);
  const inside = repo('type check command: npx tsc --noEmit\ntest command (all): npx tsc --noEmit && npm test\n');
  assert.deepStrictEqual(gate.detectChecks(inside, () => true).map((c) => c.name), ['tests (.tdd-flow/stack.md)']);
  assert.deepStrictEqual(gate.detectChecks(repo(null), () => true), []);
});

test('push-gate blocks on a failing stack type check, passes and caches on success', async () => {
  const dir = repo('type check command: node -e "console.log(\'type error in a.ts\'); process.exit(1)"\ntest command (all): node -e 0\n');
  const r = await push(dir);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /type check \(\.tdd-flow\/stack\.md\) failed .*exit 1/);
  assert.match(r.stderr, /type error in a\.ts/);

  // The test command appends to a marker file outside the repo, so the test sees whether the checks ran.
  const mark = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-gate-mark-')), 'runs');
  const stack = (extra = '') => fs.writeFileSync(path.join(dir, '.tdd-flow', 'stack.md'),
    `type check command: node -e 0\ntest command (all): node -e "require('fs').appendFileSync(process.env.MARK, 'x')"\n${extra}`);
  const runs = () => (fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8').length : 0);
  const e = { ...env, MARK: mark };
  stack();
  const ok = await push(dir, e);
  assert.strictEqual(ok.code, 0, ok.stderr);
  assert.strictEqual(runs(), 1);
  assert.ok(cacheOf(dir).startsWith(`${headOf(dir)} `), cacheOf(dir));

  // The cache is keyed on HEAD and the check commands: an unchanged commit with the same commands is not run again,
  // also when other lines of stack.md change.
  stack('notes: a note\n');
  assert.strictEqual((await push(dir, e)).code, 0);
  assert.strictEqual(runs(), 1);
  // A changed command runs again for the same commit.
  fs.writeFileSync(path.join(dir, '.tdd-flow', 'stack.md'), 'test command (all): node -e "process.exit(1)"\n');
  assert.strictEqual((await push(dir, e)).code, 2);
});

test('push-gate blocks when a stack profile command is not found, and caches no skipped check', async (t) => {
  // Like `(cd apps/web && npm test)` without node_modules: the profile's command exits 127.
  const dir = repo('test command (all): `tdd-flow-no-such-tool --run`\n');
  const r = await push(dir);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /tests \(\.tdd-flow\/stack\.md\) .* exited 127: a command it runs was not found\. Install the dependencies/);
  assert.match(r.stderr, /hook's PATH/);
  assert.strictEqual(cacheOf(dir), null);

  // An auto-detected check whose tool is missing still only warns, but the commit is not marked as passed.
  const auto = repo(null);
  fs.writeFileSync(path.join(auto, 'go.mod'), 'module x\n');
  execFileSync('git', ['add', 'go.mod'], { cwd: auto });
  execFileSync('git', ['commit', '-qm', 'go'], { cwd: auto });
  const noGo = { ...env, PATH: path.dirname(process.execPath) + ':/usr/bin:/bin' };
  if (spawnSync('sh', ['-c', 'command -v go'], { env: noGo }).status === 0) { t.skip('go is installed in /usr/bin, so the missing-tool case cannot be shown'); return; }
  const w = await push(auto, noGo);
  assert.strictEqual(w.code, 0, w.stderr);
  assert.match(w.stdout, /tests skipped, tool not found \(`go test \.\/\.\.\.`\)/);
  assert.strictEqual(cacheOf(auto), null);
});
