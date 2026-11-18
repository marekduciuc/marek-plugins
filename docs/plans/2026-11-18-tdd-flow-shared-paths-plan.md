# Shared paths — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** paths declared in `stack.md` as `shared paths:` are linked from every worktree to the main checkout, and the autopilot does not start while a pinned compose file bind-mounts an undeclared relative path.

**Architecture:** `readStack()` parses and validates the new field; `worktree()` links each path (created and reused worktrees) and excludes it; `autopilotCheck()` gains a `shared paths` check (line-based compose scan) and counts shared paths as outside state for `parallel`.

**Tech Stack:** Node (no dependencies, no YAML parser), `node:test` in `plugins/tdd-flow/tests/cli.test.cjs`.

**Spec:** `docs/plans/2026-11-18-tdd-flow-shared-paths.md`

## Global Constraints

- Branch `tdd-flow/feature/shared-paths` from `main` (7beabba, tdd-flow 0.28.0).
- No new dependency; compose files are read line by line.
- Field line in `.tdd-flow/stack.md`: `shared paths: storage/postgres, storage/uploads`; comma-separated, relative to the repo root; `none` or a missing line = no shared paths.
- A path is rejected when absolute, containing `..`, or inside `.git`, `.tdd-flow` or `.claude/worktrees`, or tracked by git.
- Exclude line per path: `/<path>` (no trailing slash) in `<git common dir>/info/exclude`.
- Error text for a worktree path holding data: `<path> in the worktree holds data of its own; move it away, then run again`. Nothing is deleted.
- Version 0.29.0 in `plugins/tdd-flow/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`; `claude plugin validate .claude-plugin/marketplace.json`.
- Full suite: `node --test plugins/tdd-flow/tests/` (and `claude plugin test plugins/tdd-flow`, unaffected).

## Review Focus

1. **Spelling of a declared path:** `./storage/postgres/`, `storage//postgres` and `storage/postgres` are the same path (normalized before linking, excluding and comparing). Test in Task 1.
2. **A link made by hand before 0.29.0** (the 16.11.2026 case): a relative symlink that already resolves to the main checkout's path is "the right symlink" (compare `realpath`s), not replaced. Test in Task 1.
3. **Compose file in a subdirectory:** `docker/compose.yml` with `../storage/postgres:/data` resolves to `storage/postgres`. Test in Task 2.
4. **Short-syntax variants:** quoted (`- "./data:/var/lib/x"`), with a mode (`./data:/x:ro`), and a bare `./data` (no container path). All count as bind mounts of `data`. Test in Task 2.
5. **Named volumes and absolute host paths** (`pgdata:/var/lib/x`, `/srv/x:/x`) are not reported. Test in Task 2.

---

### Task 1: declare and link shared paths

**Files:**
- Modify: `plugins/tdd-flow/bin/tdd-flow` — `readStack()` (~124), `worktree()` (~1587)
- Test: `plugins/tdd-flow/tests/cli.test.cjs`

**Interfaces:**
- Produces: `readStack().sharedPaths: string[]` (normalized, no `./`, no trailing slash) and `readStack().sharedPathErrors: string[]` (one message per rejected entry, rejected entries left out of `sharedPaths`).
- Produces: `sharedPathError(p: string, root: string): string` — `''` when valid, else the reason (`absolute`, `contains ..`, `inside .git`, `inside .tdd-flow`, `inside .claude/worktrees`, `tracked by git`).
- Produces: `worktree()` result gains `shared: {path: string, linked: boolean}[]` (`linked: false` = the right link was already there) and `notes: string[]` (paths created in the main checkout).

- [ ] **Step 1: Write the failing tests.** Helper `sharedRepo(paths)`: `trackedRepo()` plus `shared paths: <paths>` appended to `.tdd-flow/stack.md`, `storage/` in `.gitignore`, committed.

```js
test('worktree links each shared path to the main checkout, excludes it, and keeps the worktree clean', () => {
  const { dir, write } = sharedRepo('./storage/postgres/, storage/uploads');
  write('storage/postgres/PG_VERSION', '18\n');
  const r = run(dir, 'worktree', { slug: '12-csv' }, fakeClaude([])).result;
  assert.deepStrictEqual(r.shared, [{ path: 'storage/postgres', linked: true }, { path: 'storage/uploads', linked: true }]);
  assert.strictEqual(fs.realpathSync(path.join(r.path, 'storage/postgres')), fs.realpathSync(path.join(dir, 'storage/postgres')));
  assert.strictEqual(fs.readFileSync(path.join(r.path, 'storage/postgres/PG_VERSION'), 'utf8'), '18\n');
  assert.deepStrictEqual(r.notes, ['created storage/uploads in the main checkout']);
  assert.match(fs.readFileSync(path.join(dir, '.git/info/exclude'), 'utf8'), /^\/storage\/postgres$/m);
  assert.strictEqual(execFileSync('git', ['-C', r.path, 'status', '--porcelain']).toString(), '');
  // Second call: nothing to do. A reused worktree without the link gets it.
  assert.deepStrictEqual(run(dir, 'worktree', { slug: '12-csv' }, fakeClaude([])).result.shared.map((s) => s.linked), [false, false]);
  fs.unlinkSync(path.join(r.path, 'storage/uploads'));
  assert.deepStrictEqual(run(dir, 'worktree', { slug: '12-csv' }, fakeClaude([])).result.shared.map((s) => s.linked), [false, true]);
});

test('worktree keeps a hand-made link, replaces a wrong one and an empty directory, and refuses a directory with data', () => {
  // Cases (each its own fresh worktree on the same repo, via a second slug where needed):
  // relative symlink ../../../storage/postgres made by hand → linked: false, link unchanged (readlink equal)
  // symlink to another dir → replaced, linked: true
  // empty directory → replaced, linked: true
  // directory with a file → ok: false, error /storage\/postgres in the worktree holds data of its own; move it away, then run again/, the file still there
});

test('shared paths that are absolute, leave the repo, sit in tool dirs or are tracked are rejected', () => {
  // For each of '/srv/x', '../x', '.git/x', '.tdd-flow/x', '.claude/worktrees/x', 'src/tracked.js' (committed):
  // run(dir, 'worktree') → ok: false, error names the path and its reason (Interfaces list).
});

test('removing a worktree leaves the shared data in the main checkout', () => {
  // sharedRepo('storage/postgres') with storage/postgres/PG_VERSION; worktree; `git worktree remove <path>` succeeds
  // without --force; PG_VERSION still in the main checkout.
});
```

- [ ] **Step 2: Run** `node --test --test-name-pattern="shared|removing a worktree" plugins/tdd-flow/tests/cli.test.cjs` — Expected: the four tests FAIL (`shared` undefined, no rejection).

- [ ] **Step 3: Implement.**
  - `readStack()`: `get('shared paths')`; `none()` → `[]`; else split on `,`, trim, normalize with `path.posix.normalize`, strip leading `./` and trailing `/`, drop duplicates; validate each with `sharedPathError` (tracked: `git ls-files -- <path>` non-empty in the main checkout).
  - `worktree()`: after the existing exclude block, throw on the first `sharedPathErrors` entry (`shared path <p>: <reason>`), add missing `/<path>` lines to `info/exclude`. After the worktree exists (both the reused and the created path), per path apply the spec's table: create the main checkout's directory when missing (note), then in the worktree: missing → `mkdir -p` parent + `fs.symlinkSync(<abs main path>, <wt path>)`; symlink whose `realpath` equals the main path's → nothing; other symlink → replace; empty directory → `rmdir` + link; anything else → throw the Global Constraints error.

- [ ] **Step 4: Run** `node --test plugins/tdd-flow/tests/` — Expected: all PASS.

- [ ] **Step 5: Commit** `feat(tdd-flow): shared paths from stack.md are linked into every worktree`.

### Task 2: pre-flight check and parallel

**Files:**
- Modify: `plugins/tdd-flow/bin/tdd-flow` — `autopilotCheck()` (~1540), new `composeBindMounts(root)` above it
- Test: `plugins/tdd-flow/tests/cli.test.cjs`

**Interfaces:**
- Consumes: `readStack().sharedPaths`, `readStack().sharedPathErrors` (Task 1).
- Produces: `composeBindMounts(root: string): {file: string, pinned: boolean, sources: string[], unresolved: string[]}[]` — per tracked compose file (`git ls-files` matching basename `docker-compose*.yml|yaml` or `compose*.yml|yaml`, any directory); `sources` repo-relative, normalized; `unresolved` the raw `${...}` sources.
- Produces: check `{name: 'shared paths', status: 'ok'|'warn'|'fail', details, fix?}`; `autopilotCheck` result unchanged otherwise.

- [ ] **Step 1: Write the failing tests** (style of `autopilot-check: tests that need Docker…`, using its `autopilotCheck` helper and `opts(0)`):
  - `autopilot-check: a pinned compose file must not bind-mount an undeclared relative path` — compose with `container_name: db` and `- ./storage/postgres:/var/lib/postgresql/data`: `ok: false`, check `fail`, `fix` contains exactly `shared paths: storage/postgres`. With `shared paths: storage/postgres` → `ok`. With `shared paths: storage` (parent) → `ok`.
  - `autopilot-check: top-level name, long bind syntax, a subdirectory compose file and short-syntax variants are read` — `name: app` + `type: bind` / `source: ./data`; `docker/compose.yml` with `- ../storage/postgres:/data`; `- "./a:/x"`, `- ./b:/x:ro`, `- ./c`: the `fix` lists every source (`data`, `storage/postgres`, `a`, `b`, `c`).
  - `autopilot-check: an unpinned compose file, named volumes and absolute host paths pass with nothing declared` — no `container_name`/`name:`, plus a pinned file with `pgdata:/var/lib/x` and `/srv/x:/x` only: check absent or `ok`, `ok: true`.
  - `autopilot-check: a ${VAR} source warns; a rejected declared path fails` — `- ${DATA_DIR}:/data` → `warn`, `ok: true`; `shared paths: /srv/x` → `fail`.
  - `autopilot-check: shared paths run one spec at a time unless --parallel is passed` — `shared paths: storage/postgres`, `tests need: none`: `parallel: 1`, parallel check details match `/^1 at a time, because worktrees share storage\/postgres/`; with `parallel: 2` → `warn`.

- [ ] **Step 2: Run** `node --test --test-name-pattern="autopilot-check" plugins/tdd-flow/tests/cli.test.cjs` — Expected: the five new tests FAIL, the existing ones PASS.

- [ ] **Step 3: Implement.**
  - `composeBindMounts`: pinned = a line matching `/^name\s*:/` or `/^\s+container_name\s*:/`. Sources: list items `/^\s*-\s*["']?([^"'\s]+)/` whose first `:`-separated part starts with `./` or `../`, and `/^\s*source\s*:\s*["']?([^"'\s]+)/` with the same prefix; a part starting with `${` goes to `unresolved`. Resolve with `path.posix.join(dirname(file), src)`; drop results outside the repo.
  - Check: for pinned files, sources not equal to or under a `sharedPaths` entry → `fail`, details name file and source, `fix`: `` add `shared paths: <all needed paths, comma-separated>` to .tdd-flow/stack.md ``; `sharedPathErrors` → `fail`; only `unresolved` → `warn`; pinned files all covered → `ok` with the shared paths; no pinned file and nothing declared → no check.
  - Parallel: outside state = `testsNeed !== 'none'` or `sharedPaths.length`; the reason in the details is `the tests need <need>` or `worktrees share <paths>` (both joined with ` and ` when both hold).

- [ ] **Step 4: Run** `node --test plugins/tdd-flow/tests/` — Expected: all PASS.

- [ ] **Step 5: Commit** `feat(tdd-flow): autopilot-check stops on a pinned compose bind mount that is not shared`.

### Task 3: docs and release

**Files:**
- Modify: `plugins/tdd-flow/README.md` — rows `worktree` (~98) and `autopilot-check` (~97), the autopilot section (shared data and its trade-off, next to the line about ports and a shared database, ~164)
- Modify: `plugins/tdd-flow/agents/stack-detector.md` — profile template line `shared paths:` after `tests need:` (~47), and the rule: the relative bind-mount sources of pinned compose files, `none` without such
- Modify: `plugins/tdd-flow/skills/implement-spec/SKILL.md` — one line: a session never removes or replaces a shared link
- Modify: `docs/plans/2026-11-18-tdd-flow-shared-paths.md` — status line: implemented in 0.29.0, plus any rulings
- Modify: both manifests — `0.29.0`

- [ ] **Step 1:** Edit the docs as listed. README trade-off sentence: all sessions and the main checkout use the same data; a migration from an unmerged branch runs on the development database.
- [ ] **Step 2:** Bump both versions to `0.29.0`.
- [ ] **Step 3: Run** `claude plugin validate .claude-plugin/marketplace.json`, `node --test plugins/tdd-flow/tests/`, `claude plugin test plugins/tdd-flow` — Expected: valid, all PASS.
- [ ] **Step 4: Commit** `docs(tdd-flow): shared paths; 0.29.0`, then `git status --porcelain`.
