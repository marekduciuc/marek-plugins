#!/usr/bin/env bash
# tdd-guard: during the RED phase of a tdd-flow cycle, only test files (and
# non-code files such as fixtures/docs) may be written, and the settings of the
# linter, formatter, type check, CI and git hooks are locked. Exit 2 blocks the tool
# call and feeds stderr back to Claude. No jq/python/git dependency on purpose.

input="$(cat)"

# Project dir: prefer the env var Claude Code sets, else the "cwd" field. Only used to resolve a relative path.
proj="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$proj" ]; then
  proj="$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi

file="$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$file" ] || exit 0
file="$(printf '%s' "$file" | sed 's#\\\\#/#g; s#\\#/#g')"
case "$file" in
  /*|[A-Za-z]:/*) ;;
  *) [ -n "$proj" ] || exit 0; file="$proj/$file" ;;
esac

# The repo the edited file belongs to: walk up from the file to the first directory with .git (a directory in a
# checkout, a file in a worktree or submodule). Its state.json decides, not the session's directory, which can be a
# subdirectory or another worktree. A file outside any repo is not guarded.
root=""
dir="${file%/*}"
while [ -n "$dir" ]; do
  if [ -e "$dir/.git" ]; then root="$dir"; break; fi
  case "$dir" in */*) dir="${dir%/*}" ;; *) dir="" ;; esac
done
[ -n "$root" ] || exit 0
state="$root/.tdd-flow/state.json"
[ -f "$state" ] || exit 0

phase="$(sed -n 's/.*"phase"[[:space:]]*:[[:space:]]*"\([A-Za-z]*\)".*/\1/p' "$state" | head -n1)"
[ "$phase" = "RED" ] || exit 0

# Patterns match the path inside the repo, so a repo stored under a folder named tests/ or spec/ is still guarded.
rel="${file#"$root"/}"
lower="/$(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]')"
base="${rel##*/}"
lbase="${lower##*/}"

# Always allow the workflow's own state/spec files.
case "$lower" in /.tdd-flow/*) exit 0 ;; esac

# CI and git hook files are locked whatever their name: .github/workflows/unit_test.yml is not a test file.
locked=""
case "$lower" in
  /.github/workflows/*|/.husky/*|/.gitlab-ci.yml|/azure-pipelines.yml|/.pre-commit-config.yaml|/lefthook.yml|/.lefthook.yml) locked=1 ;;
esac

# Allow test files by path or name convention, and the test runner's own settings.
if [ -z "$locked" ]; then
  case "$lower" in
    */test/*|*/tests/*|*/__tests__/*|*/spec/*|*/specs/*|*/testing/*|*.tests/*|*.test/*|*.unittests/*|*.integrationtests/*) exit 0 ;;
    # Browser tests and what only tests use: Playwright's default e2e/ folder, fixtures, mocks.
    */e2e/*|*/__fixtures__/*|*/__mocks__/*|*/cypress/*) exit 0 ;;
  esac
  case "$lbase" in
    test_*|*_test.*|*.test.*|*.spec.*|*_spec.*|*.stories.*|*.cy.*|conftest.py) exit 0 ;;
    jest.config.*|jest.setup.*|vitest.config.*|vitest.setup.*|vitest.workspace.*|playwright.config.*|cypress.config.*|karma.conf.*) exit 0 ;;
  esac
  # JVM and .NET test classes by their case-sensitive suffix (LatestTest.java, not Latest.java).
  case "$base" in
    *Test.java|*Tests.java|*IT.java|*TestCase.java|*Test.kt|*Tests.kt|*IT.kt|*Test.cs|*Tests.cs) exit 0 ;;
  esac
fi

# Files that decide what the checks accept: linter, formatter and type-check settings, CI and git hooks. A test
# must not pass because a check was loosened. Test-runner settings and package manifests stay editable.
case "$lbase" in
  .eslintrc|.eslintrc.*|eslint.config.*|.eslintignore|.prettierrc|.prettierrc.*|prettier.config.*|.prettierignore|biome.json|biome.jsonc) locked=1 ;;
  tsconfig.json|tsconfig.*.json|jsconfig.json|pyrightconfig.json|.stylelintrc|.stylelintrc.*|stylelint.config.*) locked=1 ;;
  checkstyle*.xml|detekt.yml|detekt.yaml|.rubocop.yml|.rubocop_todo.yml|phpstan.neon|phpstan.neon.dist|phpcs.xml|phpcs.xml.dist|.swiftlint.yml) locked=1 ;;
  ruff.toml|.ruff.toml|.flake8|mypy.ini|.mypy.ini|.pylintrc|pylintrc|.golangci.yml|.golangci.yaml|.golangci.toml|.golangci.json) locked=1 ;;
  clippy.toml|.clippy.toml|rustfmt.toml|.rustfmt.toml|.clang-tidy|.clang-format) locked=1 ;;
esac
if [ -n "$locked" ]; then
  echo "tdd-guard: RED phase is active ($state). '$rel' sets what the linter, formatter, type check, CI or git hooks accept, so it may not change while a failing test is written. Do not try another way to change it. If the test cannot run without this change (for example test types in tsconfig.json), stop and report that the task needs a setup step for '$rel'. If no tdd-flow workflow is running (an earlier run stopped mid-cycle), ask the user before setting \"phase\" to \"IDLE\" in that file." >&2
  exit 2
fi

# Only guard source-code files, UI templates and styles; fixtures, docs and other configs are fine during RED.
case "$lbase" in
  *.cs|*.vb|*.fs|*.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.py|*.go|*.rs|*.java|*.kt|*.rb|*.php|*.c|*.cc|*.cpp|*.h|*.hpp|*.swift|*.scala|*.vue|*.svelte|*.astro|*.razor|*.cshtml|*.css|*.scss|*.sass|*.less)
    echo "tdd-guard: RED phase is active ($state). Write a failing test first; production file '$rel' may only change in GREEN or REFACTOR. If this is a test file with an unusual name, rename it to match the repo's test convention, or set phase to GREEN after the test fails for the right reason. If no tdd-flow workflow is running (an earlier run stopped mid-cycle), ask the user before setting \"phase\" to \"IDLE\" in that file." >&2
    exit 2 ;;
esac
exit 0
