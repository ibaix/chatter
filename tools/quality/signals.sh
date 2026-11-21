#!/usr/bin/env bash
# Runs the code checks for a branch and prints one table. The review skills use it, and you can too:
#
#   npm run quality                         the changes of this branch, compared with origin/main
#   npm run quality -- --base main          compare with a different base
#   npm run quality -- --all                the whole repo
#   npm run quality -- --coverage           also run the coverage and list the changed lines that no test runs
#
# Marks:  ✓ passed   ✗ failed (a gate: the CI fails too)   ! a signal to look at   ⊘ skipped, with the reason
# The full output of each check is in .quality/<check>.log.
# The script always exits with 0. It reports; it does not decide.
set -uo pipefail

BASE=origin/main
ALL=0
COVERAGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --all) ALL=1; shift ;;
    --coverage) COVERAGE=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 2
LOGS=.quality
mkdir -p "$LOGS"
ROWS=()
row() { ROWS+=("$1  $2  $3"); }

if ! MERGE_BASE="$(git merge-base "$BASE" HEAD 2>/dev/null)"; then
  echo "Cannot find the base $BASE. Run \"git fetch origin\", or give --base <ref>." >&2
  exit 2
fi

# The changed files: committed, not committed, and new files that git does not track yet
CHANGED="$( { git diff --name-only --diff-filter=d "$MERGE_BASE"; git ls-files --others --exclude-standard; } | sort -u)"
CHANGED_CODE="$(printf '%s\n' "$CHANGED" | grep -E '^(apps|packages|tools)/.*\.(ts|tsx|js|mjs)$' | grep -vE '^tools/pi-image/' || true)"

echo "Base: $BASE ($(git rev-parse --short "$MERGE_BASE"))"
if [ "$ALL" = 1 ]; then
  echo "Scope: the whole repo"
else
  echo "Scope: $(printf '%s\n' "$CHANGED" | sed '/^$/d' | wc -l | tr -d ' ') changed files, $(printf '%s\n' "$CHANGED_CODE" | sed '/^$/d' | wc -l | tr -d ' ') of them code"
fi
echo

# gate <name> <command...>: runs a check that the CI also fails on
gate() {
  local name="$1"; shift
  if "$@" > "$LOGS/$name.log" 2>&1; then row "✓" "$name" ""; else row "✗" "$name" "see $LOGS/$name.log"; fi
}

gate build-shared npm run build:shared
gate typecheck npm run typecheck

# Lint: errors are a gate, warnings are a signal
if [ "$ALL" = 1 ]; then LINT_FILES=(.); else LINT_FILES=(); while IFS= read -r f; do [ -n "$f" ] && LINT_FILES+=("$f"); done <<< "$CHANGED_CODE"; fi
if [ "${#LINT_FILES[@]}" -eq 0 ]; then
  row "⊘" lint "no changed code"
else
  npx eslint --format json --output-file "$LOGS/eslint.json" "${LINT_FILES[@]}" > "$LOGS/lint.log" 2>&1
  npx eslint "${LINT_FILES[@]}" >> "$LOGS/lint.log" 2>&1
  COUNTS="$(node -e 'const r=require(process.argv[1]);let e=0,w=0;for(const f of r){e+=f.errorCount;w+=f.warningCount}console.log(e+" "+w)' "$ROOT/$LOGS/eslint.json" 2>/dev/null || echo "? ?")"
  read -r ERRORS WARNINGS <<< "$COUNTS"
  if [ "$ERRORS" = 0 ]; then row "✓" lint "0 errors"; else row "✗" lint "$ERRORS errors, see $LOGS/lint.log"; fi
  if [ "$WARNINGS" != 0 ]; then row "!" lint-warnings "$WARNINGS warnings (complexity, depth, hook deps), see $LOGS/lint.log"; fi
fi

# Tests. The coverage run is the same tests in one run, with coverage.
if [ "$COVERAGE" = 1 ]; then
  gate tests npm run coverage
else
  gate tests npm test
fi

# Copied code: a new copy fails the CI. Copies on the base branch do not.
if [ "$ALL" = 1 ]; then
  npm run -s dup > "$LOGS/dup.log" 2>&1
  CLONES="$(sed -nE 's/.*Found ([0-9]+) clones.*/\1/p' "$LOGS/dup.log" | tail -1)"
  if [ "${CLONES:-0}" = 0 ]; then row "✓" copied-code "no copies"; else row "!" copied-code "$CLONES copies, see $LOGS/dup.log"; fi
else
  gate new-copied-code npm run -s dup -- --baseline-from-ref "$BASE" --fail-on-new-clones
fi

# Unused code (knip): a signal only
npx knip --no-progress --no-exit-code --reporter compact > "$LOGS/dead-all.log" 2>&1
if [ "$ALL" = 1 ]; then
  cp "$LOGS/dead-all.log" "$LOGS/dead.log"
else
  # Keep the findings in changed files, and the package findings when a package.json changed
  : > "$LOGS/dead.log"
  while IFS= read -r f; do
    [ -n "$f" ] && awk -v file="$f:" 'index($0, file) == 1' "$LOGS/dead-all.log" >> "$LOGS/dead.log"
  done <<< "$CHANGED"
  sort -u -o "$LOGS/dead.log" "$LOGS/dead.log"
fi
DEAD="$(grep -c . "$LOGS/dead.log" || true)"
if [ "$DEAD" = 0 ]; then row "✓" unused-code "none in the scope"; else row "!" unused-code "$DEAD findings in the scope, see $LOGS/dead.log"; fi

# Coverage of the changed lines: a signal only
if [ "$COVERAGE" = 1 ]; then
  if npm run -s coverage:changed -- --base "$BASE" > "$LOGS/coverage-changed.log" 2>&1; then
    row "!" changed-line-coverage "see $LOGS/coverage-changed.log"
  else
    row "⊘" changed-line-coverage "the report failed, see $LOGS/coverage-changed.log"
  fi
  npm run -s coverage:summary > "$LOGS/coverage-summary.log" 2>&1 || true
else
  row "⊘" changed-line-coverage "add --coverage to measure it"
fi

printf '%s\n' "${ROWS[@]}"
exit 0
