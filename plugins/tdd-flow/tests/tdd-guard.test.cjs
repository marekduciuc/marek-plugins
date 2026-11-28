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
  for (const phase of ['GREEN', 'REFACTOR', 'SETUP', 'REVIEW', 'IDLE']) assert.strictEqual(guard(path.join(repo(phase), 'src/app.ts'), os.tmpdir()).code, 0, phase);
  assert.strictEqual(guard(path.join(repo(null), 'src/app.ts'), os.tmpdir()).code, 0);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-flow-guard-norepo-'));
  assert.strictEqual(guard(path.join(outside, 'a.ts'), repo('RED')).code, 0);
  const r = spawnSync('bash', [GUARD], { input: JSON.stringify({ tool_input: {} }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
});

test('tdd-guard locks linter, formatter, type-check, CI and git hook settings during RED only', () => {
  const dir = repo('RED');
  const run = (rel) => guard(path.join(dir, rel), dir);
  for (const locked of ['tsconfig.json', 'apps/web/tsconfig.build.json', '.eslintrc.json', 'eslint.config.mjs', '.prettierrc', 'biome.json',
    '.github/workflows/ci.yml', '.github/workflows/unit_test.yml', '.husky/pre-commit', '.pre-commit-config.yaml', 'config/checkstyle.xml', 'ruff.toml', '.golangci.yml',
    'mypy.ini', '.eslintignore']) assert.strictEqual(run(locked).code, 2, locked);
  assert.match(run('tsconfig.json').stderr, /'tsconfig\.json' sets what the linter.*needs a setup step/);
  // Test-runner settings, package manifests and settings inside a test folder or with a test name stay editable.
  for (const free of ['jest.config.js', 'vitest.config.ts', 'jest.config.json', 'pytest.ini', 'package.json', 'pyproject.toml', 'pom.xml', 'setup.cfg', 'tests/tsconfig.json',
    'tsconfig.spec.json', '.github/ISSUE_TEMPLATE/bug.md', 'docs/tsconfig.md']) assert.strictEqual(run(free).code, 0, free);
  for (const phase of ['GREEN', 'REFACTOR', 'IDLE']) {
    const other = repo(phase);
    assert.strictEqual(guard(path.join(other, 'tsconfig.json'), other).code, 0, phase);
  }
});

const shell = require('../hooks/scripts/tdd-guard-bash.cjs');

test('writeTargets finds the files a shell command writes and nothing else', () => {
  const t = (cmd) => shell.writeTargets(cmd, '/repo');
  assert.deepStrictEqual(t('echo x > src/app.ts'), ['/repo/src/app.ts']);
  assert.deepStrictEqual(t('echo x >> "src/my app.ts"'), ['/repo/src/my app.ts']);
  assert.deepStrictEqual(t('cat > src/a.ts <<EOF\nconst a = b > c;\necho > nested.ts\nEOF'), ['/repo/src/a.ts']);
  assert.deepStrictEqual(t('cd apps/web && npm run gen | tee -a src/gen.ts out.log'), ['/repo/apps/web/src/gen.ts', '/repo/apps/web/out.log']);
  assert.deepStrictEqual(t('(cd api; printf x >| Main.java)'), ['/repo/api/Main.java']);
  assert.deepStrictEqual(t("sed -i 's/a/b/' src/a.ts src/b.ts"), ['/repo/src/a.ts', '/repo/src/b.ts']);
  assert.deepStrictEqual(t("sed -i '' -e 's/a/b/' src/a.ts"), ['/repo/src/a.ts']);
  assert.deepStrictEqual(t("sed -Ei.bak 's/a/b/' src/a.ts"), ['/repo/src/a.ts']);
  assert.deepStrictEqual(t('sed --in-place=.bak -e s/a/b/ tsconfig.json'), ['/repo/tsconfig.json']);
  assert.deepStrictEqual(t('npm test &> /repo/src/log.ts'), ['/repo/src/log.ts']);
  assert.deepStrictEqual(t('echo "$(date > stamp.ts)"'), ['/repo/stamp.ts']);
  for (const none of ['npm test 2>&1', 'npm test > /dev/null 2>&1', 'npm test >&2', 'node -e "if (a > b) c()"', "awk '$1 > 5' data.txt",
    'git commit -m "a > b"', "sed -n 's/a/b/p' src/a.ts", "sed 's/a/b/' src/a.ts", 'echo x > "$OUT"', 'echo x > src/*.ts', 'cat < src/a.ts',
    'grep x <<< "a > b.ts"', 'diff <(sort a.ts) <(sort b.ts)', 'npm test | tee /dev/stderr', 'echo done # > src/a.ts', 'ls']) {
    assert.deepStrictEqual(t(none), [], none);
  }
  // Text that only looks like a write: single-quoted backticks, a BSD sed suffix, heredoc delimiters, process substitution.
  for (const none of ["git commit -m 'cover `count > limit.ts` case'", "node -e 'console.log(`a > b.ts`)'", "grep -n '$(echo x > src/a.ts)' README.md",
    "sed -n -e 's/a/b/p' x.ts", 'cat <<\\EOF\nconst f = a > b.ts\nEOF', "cat <<'E O F'\na > b.ts\nE O F", 'npm test | tee >(grep -c fail src.ts)']) {
    assert.deepStrictEqual(t(none), [], none);
  }
  assert.deepStrictEqual(t("sed -i '' 's/old.js/new.js/' tests/a.test.js"), ['/repo/tests/a.test.js']);
  assert.deepStrictEqual(t("sed -i -- 's/old.js/new.js/' tests/a.test.js"), ['/repo/tests/a.test.js']);
  assert.deepStrictEqual(t('cd -- tests && echo x > helper.ts'), ['/repo/tests/helper.ts']);
  assert.deepStrictEqual(t('pushd tests && echo x > helper.ts'), ['/repo/tests/helper.ts']);
  assert.deepStrictEqual(t('(cd /tmp); echo x > src/a.ts'), ['/repo/src/a.ts']);
  assert.deepStrictEqual(t('cd - && echo x > a.ts'), []);
  assert.deepStrictEqual(t('cd "$DIR" && echo x > a.ts; echo y > /abs/b.ts'), ['/abs/b.ts']);
  for (const wrapped of ['sudo tee src/a.ts', 'command sed -i s/a/b/ src/a.ts', 'env A=1 tee src/a.ts', 'time tee src/a.ts', '! sed -i s/a/b/ src/a.ts',
    'gsed -i s/a/b/ src/a.ts', 'echo x>src/a.ts', 'echo x 1> src/a.ts']) assert.deepStrictEqual(t(wrapped), ['/repo/src/a.ts'], wrapped);
  assert.deepStrictEqual(t('[[ a > b.ts ]]'), ['/repo/b.ts']); // read as a redirection: the guard then judges the path
});

test('tdd-guard-bash blocks a shell write of a production or locked file during RED, and lets the rest through', () => {
  const dir = repo('RED');
  const run = (command, cwd = dir) => shell.main(JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }), { ...process.env, CLAUDE_PROJECT_DIR: dir });
  const blocked = run('echo "export const a = 1" > src/app.ts');
  assert.strictEqual(blocked.code, 2);
  assert.match(blocked.stderr, /production file 'src\/app\.ts'[\s\S]*through the shell/);
  assert.strictEqual(run("sed -i 's/strict/loose/' tsconfig.json").code, 2);
  assert.strictEqual(run('cd src && printf x | tee app.ts').code, 2);
  for (const ok of ['npm test > out.log 2>&1', 'echo x > tests/app.test.ts', 'echo x > src/app.spec.ts', 'npm test', 'echo x > /tmp/tdd-flow-guard-out.ts',
    'echo x > .tdd-flow/features/12-csv/tdd-log.md', 'not json']) assert.strictEqual(run(ok).code, 0, ok);
  const green = repo('GREEN');
  assert.strictEqual(shell.main(JSON.stringify({ cwd: green, tool_input: { command: 'echo x > src/app.ts' } }), { ...process.env, CLAUDE_PROJECT_DIR: green }).code, 0);
  assert.strictEqual(shell.main('{broken', process.env).code, 0);
});
