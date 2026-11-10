#!/usr/bin/env bash
# tdd-guard: during the RED phase of a tdd-flow cycle, only test files (and
# non-code files such as fixtures/docs) may be written. Exit 2 blocks the tool
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

# Allow test files by path or name convention.
case "$lower" in
  */test/*|*/tests/*|*/__tests__/*|*/spec/*|*/specs/*|*/testing/*|*.tests/*|*.test/*|*.unittests/*|*.integrationtests/*) exit 0 ;;
esac
case "$lbase" in
  test_*|*_test.*|*.test.*|*.spec.*|*_spec.*|conftest.py) exit 0 ;;
esac
# JVM and .NET test classes by their case-sensitive suffix (LatestTest.java, not Latest.java).
case "$base" in
  *Test.java|*Tests.java|*IT.java|*TestCase.java|*Test.kt|*Tests.kt|*IT.kt|*Test.cs|*Tests.cs) exit 0 ;;
esac

# Only guard source-code files; fixtures, docs, configs are fine during RED.
case "$lbase" in
  *.cs|*.vb|*.fs|*.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.py|*.go|*.rs|*.java|*.kt|*.rb|*.php|*.c|*.cc|*.cpp|*.h|*.hpp|*.swift|*.scala)
    echo "tdd-guard: RED phase is active ($state). Write a failing test first; production file '$rel' may only change in GREEN or REFACTOR. If this is a test file with an unusual name, rename it to match the repo's test convention, or set phase to GREEN after the test fails for the right reason. If no tdd-flow workflow is running (an earlier run stopped mid-cycle), ask the user before setting \"phase\" to \"IDLE\" in that file." >&2
    exit 2 ;;
esac
exit 0
