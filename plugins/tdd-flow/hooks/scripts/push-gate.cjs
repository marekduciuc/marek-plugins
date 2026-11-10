'use strict';
// push-gate: PreToolUse gate for Bash. Before Claude runs `git push` or `gh pr create`, run the target
// repo's type check, lint and tests, and scan the unpushed commits for secrets with gitleaks.
// Exit 2 blocks the command and feeds stderr back to Claude. See plugins/tdd-flow/README.md "push-gate".
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BUDGET_MS = 540000; // all checks together; stays under the 600 s hook timeout in hooks.json, whose kill would let the push through
const MIN_CHECK_MS = 5000; // less time than this left: block instead of starting a check that cannot finish
const GIT_PUSH_RE = /\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+push\b/;
const PUSH_RE = new RegExp(`${GIT_PUSH_RE.source}|\\bgh\\s+pr\\s+create\\b`);
// Docs-only pushes skip the tests. No `.txt`: requirements.txt / CMakeLists.txt are build input.
const DOC_RE = /(\.(md|mdx|rst|adoc|png|jpe?g|gif|svg|webp|ico|pdf)|(^|\/)(LICENSE|NOTICE|AUTHORS|CODEOWNERS)(\.\w+)?)$/i;
const DIRTY_CMD = "git status --porcelain --untracked-files=no -- . ':(exclude).tdd-flow'";

/** True only for a `git push` that cannot publish code (--dry-run/-n or --delete/-d, no later --no-d*). */
function publishesNothing(seg) {
  const m = seg.match(GIT_PUSH_RE);
  if (!m) return false;
  const toks = seg.slice(m.index + m[0].length).split(/\s+/).filter(Boolean);
  let skip = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '--') break;
    if (t === '-o' || t === '--push-option') { i++; continue; }
    if (/^--no-d/.test(t)) return false;
    if (/^(?:-n|--dry-run|-d|--delete)$/.test(t)) skip = true;
  }
  return skip;
}

/**
 * Unquoted push/PR segments of a shell command with the directory each one runs in: `git -C <dir>` or
 * an earlier `cd <dir>` in the same command, else `cwd`. Quoted text and heredoc commit messages are
 * not commands. `bash -c "..."` and `eval` are not parsed (known gap).
 */
function pushTargets(cmd, cwd) {
  let s = cmd.replace(/\\\r?\n/g, ' ');
  const subs = [];
  const SUB_RE = /\$\(([^()]*)\)|`([^`]*)`/g;
  while (SUB_RE.test(s)) {
    SUB_RE.lastIndex = 0;
    s = s.replace(SUB_RE, (_, a, b) => { subs.push(a ?? b); return "''"; });
  }
  const strip = (p) => p.replace(/'[^']*'|"(?:\\.|[^"\\])*"|(^|\s)#[^\n]*/g, (m, pre) => pre ?? "''");
  const out = [];
  for (const piece of [s, ...subs.filter((b) => !/^\s*cat\s*<</.test(b))]) {
    let dir = cwd;
    for (const seg of strip(piece).split(/[;&|\n]+/)) {
      const cd = seg.match(/^\s*cd\s+([^\s']+)\s*$/);
      if (cd) { dir = path.resolve(dir, cd[1].replace(/^~(?=\/|$)/, process.env.HOME || '~')); continue; }
      if (!PUSH_RE.test(seg)) continue;
      const c = seg.match(/\bgit\s+(?:--[\w-]+(?:=\S+)?\s+)*-C\s+([^\s']+)/);
      out.push({ seg, dir: c ? path.resolve(dir, c[1]) : dir });
    }
  }
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A command line of .tdd-flow/stack.md (`test command (all)`, `type check command`), or null when absent/unknown/none. */
function stackField(root, label) {
  let txt;
  try { txt = fs.readFileSync(path.join(root, '.tdd-flow', 'stack.md'), 'utf8'); } catch { return null; }
  const m = txt.match(new RegExp(`^\\s*${esc(label)}:[ \\t]*(.*)$`, 'mi'));
  if (!m) return null;
  const v = m[1].trim();
  const bt = v.match(/`([^`]+)`/);
  const cmd = (bt ? bt[1] : v.replace(/^`+|`+$/g, '')).trim();
  return !cmd || /^(unknown|none|n\/a)\b/i.test(cmd) ? null : cmd;
}
const stackTestCommand = (root) => stackField(root, 'test command (all)');

/** Checks for the repo root: [{name, cmd, needs}]. `needs` is a path that must exist first. */
function detectChecks(root, hasCmd) {
  const has = (f) => fs.existsSync(path.join(root, f));
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
  const checks = [];
  let test = null;
  if (has('package.json')) {
    let scripts = {};
    try { scripts = JSON.parse(read('package.json')).scripts || {}; } catch { /* unreadable: no scripts */ }
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    const runS = (n) => (pm === 'npm' ? `npm run --silent ${n}` : `${pm} run ${n}`);
    const tc = ['typecheck', 'type-check', 'check-types', 'tsc'].find((n) => scripts[n]);
    if (tc) checks.push({ name: `typecheck (${tc})`, cmd: runS(tc), needs: 'node_modules' });
    else if (has('tsconfig.json') && has('node_modules/.bin/tsc')) checks.push({ name: 'typecheck (tsc)', cmd: 'npx --no-install tsc --noEmit', needs: 'node_modules' });
    if (scripts.lint) checks.push({ name: 'lint', cmd: runS('lint'), needs: 'node_modules' });
    if (scripts.test && !/no test specified/.test(scripts.test)) test = { cmd: pm === 'npm' ? 'npm test --silent' : `${pm} test`, needs: 'node_modules' };
  } else if (has('mvnw') || has('pom.xml')) {
    test = { cmd: has('mvnw') ? './mvnw -q -B test' : 'mvn -q -B test' };
  } else if (has('gradlew') || has('build.gradle') || has('build.gradle.kts')) {
    test = { cmd: has('gradlew') ? './gradlew test --quiet' : 'gradle test --quiet' };
  } else if (has('pytest.ini') || has('conftest.py') || /\[tool\.pytest/.test(read('pyproject.toml')) ||
    ((has('pyproject.toml') || has('setup.cfg') || has('tox.ini')) && (has('tests') || has('test')))) {
    const py = has('uv.lock') && hasCmd('uv') ? 'uv run pytest' : has('.venv/bin/python') ? '.venv/bin/python -m pytest' : 'python3 -m pytest';
    test = { cmd: `${py} -q`, pytest: true };
  } else if (has('go.mod')) {
    test = { cmd: 'go test ./...' };
  } else if (has('Cargo.toml')) {
    test = { cmd: 'cargo test --quiet' };
  } else if (fs.readdirSync(root).some((f) => /\.(sln|csproj)$/.test(f))) {
    test = { cmd: 'dotnet test --nologo -v q' };
  }
  // A stack profile knows the repo better than the root manifests (a monorepo has none): its type check runs
  // first, unless the test command already contains it, and its test command replaces the detected one.
  const stackTest = stackTestCommand(root);
  const stackTypeCheck = stackField(root, 'type check command');
  if (stackTypeCheck && !(stackTest || '').includes(stackTypeCheck)) {
    const i = checks.findIndex((c) => c.name.startsWith('typecheck'));
    if (i >= 0) checks.splice(i, 1);
    checks.unshift({ name: 'type check (.tdd-flow/stack.md)', cmd: stackTypeCheck });
  }
  if (stackTest) checks.push({ name: 'tests (.tdd-flow/stack.md)', cmd: stackTest });
  else if (test) checks.push({ name: 'tests', ...test });
  return checks;
}

/**
 * Run a shell command in its own process group; on timeout kill the whole group, so a grandchild
 * (vitest worker, gradle) cannot keep the hook alive past its own timeout. Resolves {code, out, timedOut}.
 */
function runCheck(cmd, cwd, timeoutMs, env) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ out, ...r }); } };
    const child = spawn('/bin/sh', ['-c', cmd], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (d) => { out = (out + d).slice(-200000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { kill(); finish({ code: null, timedOut: true }); }, timeoutMs);
    child.on('error', (e) => finish({ code: 127, out: String(e) }));
    child.on('close', (code) => finish({ code, timedOut: false }));
    // A daemon that keeps the pipes open must not stall us after the command itself exited.
    child.on('exit', (code) => setTimeout(() => { kill(); finish({ code, timedOut: false }); }, 2000).unref());
  });
}

async function main(input, env = process.env) {
  const res = { code: 0, stderr: '', stdout: '' };
  const warnings = [];
  const block = (msg) => { res.code = 2; res.stderr += `BLOCKED by tdd-flow push-gate: ${msg}\n`; return res; };
  const finish = () => { if (warnings.length) res.stdout = JSON.stringify({ systemMessage: `tdd-flow push-gate: ${warnings.join(' | ')}` }) + '\n'; return res; };

  if ((env.TDD_FLOW_PUSH_GATE || '').toLowerCase() === 'off') return res;
  let cmd = '';
  let cwd = env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const data = JSON.parse(input);
    cmd = data.tool_input?.command || '';
    if (data.cwd) cwd = data.cwd;
  } catch { return res; } // not hook JSON: let it through
  const targets = pushTargets(cmd, cwd).filter((t) => !publishesNothing(t.seg));
  if (!targets.length) return res;
  // A plain force push is denied by the global git guard anyway; don't make the user wait for the suite.
  if (targets.some((t) => GIT_PUSH_RE.test(t.seg) && /\s(--force|-f)(\s|$)/.test(t.seg))) return res;

  const runEnv = { ...env, CI: 'true' }; // one-shot mode for watch-by-default runners (vitest, jest)
  const git = (c, dir) => { try { return execSync(c, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, env: runEnv }).trim(); } catch { return ''; } };
  const hasCmd = (c) => !!git(`command -v ${c}`, cwd);
  const deadline = Date.now() + BUDGET_MS;

  const roots = [...new Set(targets.map((t) => git('git rev-parse --show-toplevel', t.dir)).filter(Boolean))];
  for (const root of roots) {
    const onlyGh = targets.every((t) => !GIT_PUSH_RE.test(t.seg));

    // ---- Tests, lint, type check ----
    const hooksDir = git('git config core.hooksPath', root) || git('git rev-parse --git-path hooks', root);
    const gitPrePush = (() => { try { fs.accessSync(path.resolve(root, hooksDir, 'pre-push'), fs.constants.X_OK); return true; } catch { return false; } })();
    let ownGate = false;
    try { ownGate = fs.readdirSync(path.join(root, '.claude', 'hooks')).some((f) => f.startsWith('pre-push-check')); } catch { /* no hooks dir */ }
    const defRef = git('git symbolic-ref --quiet --short refs/remotes/origin/HEAD', root) ||
      ['origin/main', 'origin/master'].find((r) => git(`git rev-parse --verify --quiet ${r}`, root)) || '';
    const changed = defRef ? git(`git diff --name-only --no-renames ${defRef}...HEAD`, root).split('\n').filter(Boolean) : null;
    const docsOnly = changed !== null && changed.length > 0 && changed.every((p) => DOC_RE.test(p));
    const head = git('git rev-parse HEAD', root);
    const cacheFile = path.resolve(root, git('git rev-parse --git-path tdd-flow-push-gate', root) || '.git/tdd-flow-push-gate');
    let cached = false;
    try { cached = !!head && fs.readFileSync(cacheFile, 'utf8').trim() === head; } catch { /* no cache */ }

    const checks = ownGate || docsOnly || cached || (gitPrePush && !onlyGh) ? [] : detectChecks(root, hasCmd);
    if (checks.length) {
      const dirty = git(DIRTY_CMD, root);
      if (dirty) return block(`uncommitted changes in ${root}; the checks run on the working tree, so commit or stash them first:\n${dirty}`);
      for (const c of checks) {
        if (c.needs && !fs.existsSync(path.join(root, c.needs))) return block(`${c.needs} is missing in ${root} - install dependencies first (e.g. \`npm ci\`).`);
        const left = deadline - Date.now();
        if (left < MIN_CHECK_MS) return block(`${c.name} not run: the ${BUDGET_MS / 1000} s check budget is used up.`);
        const r = await runCheck(c.cmd, root, left, runEnv);
        if (r.timedOut) return block(`${c.name} (\`${c.cmd}\`) timed out after ${Math.round(left / 1000)} s (shared check budget; a first run may still be filling the dependency cache, retry once).`);
        if (r.code === 0 || (c.pytest && r.code === 5)) continue; // pytest 5 = no tests collected
        if (r.code === 127 || (c.pytest && /No module named pytest/.test(r.out))) { warnings.push(`${c.name} skipped, tool not found (\`${c.cmd}\`)`); continue; }
        return block(`${c.name} failed (\`${c.cmd}\`, exit ${r.code}). Fix these before pushing:\n${r.out.trim().split('\n').slice(-40).join('\n')}`);
      }
      const after = git(DIRTY_CMD, root);
      if (after) return block(`the checks modified tracked files (a lint --fix or formatter?). Review and commit them, then push again:\n${after}`);
      if (head) { try { fs.writeFileSync(cacheFile, `${head}\n`); } catch { /* cache is optional */ } }
    }

    // ---- Secret scan on commits that are on no remote yet ----
    if (!hasCmd('gitleaks')) { warnings.push('gitleaks is not installed, secret scan skipped (`brew install gitleaks`)'); continue; }
    const left = deadline - Date.now();
    if (left < MIN_CHECK_MS) return block('secret scan not run: the check budget is used up.');
    const g = await runCheck('gitleaks git --no-banner --redact --exit-code 3 --log-level warn --log-opts="HEAD --not --remotes" .', root, left, runEnv);
    if (g.timedOut) return block(`secret scan timed out after ${Math.round(left / 1000)} s.`);
    if (g.code === 3) return block(`gitleaks found secrets in unpushed commits of ${root}. Remove them from the commits, or add the fingerprint of a false positive to .gitleaksignore:\n${g.out.trim().split('\n').slice(-40).join('\n')}`);
    if (g.code !== 0) warnings.push(`gitleaks could not scan (exit ${g.code}), secret scan skipped: ${g.out.trim().split('\n').slice(-2).join(' ')}`);
  }
  return finish();
}

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', async () => {
    const r = await main(input);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.code);
  });
}

module.exports = { main, pushTargets, publishesNothing, detectChecks, stackField, stackTestCommand, runCheck };
