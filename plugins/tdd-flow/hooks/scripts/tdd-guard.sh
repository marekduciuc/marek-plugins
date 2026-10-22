#!/usr/bin/env bash
# tdd-guard: during the RED phase of a tdd-flow cycle, only test files (and
# non-code files such as fixtures/docs) may be written. Exit 2 blocks the tool
# call and feeds stderr back to Claude. No jq/python dependency on purpose.

input="$(cat)"

# Project dir: prefer the env var Claude Code sets, else the "cwd" field.
proj="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$proj" ]; then
  proj="$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi
state="$proj/.tdd-flow/state.json"
[ -f "$state" ] || exit 0

phase="$(sed -n 's/.*"phase"[[:space:]]*:[[:space:]]*"\([A-Za-z]*\)".*/\1/p' "$state" | head -n1)"
[ "$phase" = "RED" ] || exit 0

file="$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$file" ] || exit 0
file="$(printf '%s' "$file" | sed 's#\\\\#/#g; s#\\#/#g')"
lower="$(printf '%s' "$file" | tr '[:upper:]' '[:lower:]')"
base="${lower##*/}"

# Always allow the workflow's own state/spec files.
case "$lower" in */.tdd-flow/*|.tdd-flow/*) exit 0 ;; esac

# Allow test files by path or name convention.
case "$lower" in
  */test/*|*/tests/*|*/__tests__/*|*/spec/*|*/specs/*|*/testing/*|*.tests/*|*.test/*|*.unittests/*|*.integrationtests/*) exit 0 ;;
esac
case "$base" in
  test_*|*_test.*|*.test.*|*.spec.*|*_spec.*|*tests.cs|*test.cs|*test.java|*tests.java|*test.kt|*_test.go|conftest.py) exit 0 ;;
esac

# Only guard source-code files; fixtures, docs, configs are fine during RED.
case "$base" in
  *.cs|*.vb|*.fs|*.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.py|*.go|*.rs|*.java|*.kt|*.rb|*.php|*.c|*.cc|*.cpp|*.h|*.hpp|*.swift|*.scala)
    echo "tdd-guard: RED phase is active (.tdd-flow/state.json). Write a failing test first; production file '$file' may only change in GREEN or REFACTOR. If this is a test file with an unusual name, rename it to match the repo's test convention, or set phase to GREEN after the test fails for the right reason." >&2
    exit 2 ;;
esac
exit 0
