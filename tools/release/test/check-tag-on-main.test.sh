#!/usr/bin/env bash
# Tests for check-tag-on-main.sh. Each test makes a small git repo with an "origin" repo next to it, so the tests
# need no GitHub.
# Run:  tools/release/test/check-tag-on-main.test.sh
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/check-tag-on-main.sh"
failures=0

sandboxes=()
trap 'rm -rf "${sandboxes[@]}"' EXIT

# A git command that does not read the git settings of this computer
git_in() {
  local dir="$1"
  shift
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$dir" \
    -c user.name=Test -c user.email=test@example.com -c init.defaultBranch=main -c commit.gpgsign=false "$@"
}

commit_in() {
  git_in "$1" commit --quiet --allow-empty -m "$2"
  git_in "$1" rev-parse HEAD
}

# Makes "origin" with two commits on main and one commit on the branch "side", and the clone "work" of it.
# Sets main_commit, side_commit and work.
set_up() {
  sandbox="$(mktemp -d)"
  sandboxes+=("$sandbox")
  local origin="$sandbox/origin"
  work="$sandbox/work"
  git_in "$sandbox" init --quiet origin
  local first
  first="$(commit_in "$origin" first)"
  main_commit="$(commit_in "$origin" second)"
  git_in "$origin" checkout --quiet -b side "$first"
  side_commit="$(commit_in "$origin" "side work")"
  git_in "$origin" checkout --quiet main
  git_in "$sandbox" clone --quiet origin work
}

# Runs the script in the repo $1 as the workflow does: GITHUB_SHA is the tag commit
check_tag() {
  (cd "$1" && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GITHUB_SHA="$2" GITHUB_REF_NAME=v1.2.0 "$SCRIPT") \
    > "$sandbox/output.log" 2>&1
}

check() {
  local description="$1"
  shift
  if "$@"; then
    echo "ok   - $description"
  else
    echo "FAIL - $description"
    failures=$((failures + 1))
  fi
}

refuses() {
  ! check_tag "$@" && grep -q '::error::' "$sandbox/output.log"
}

test_accepts_a_commit_on_main() {
  set_up
  check "accepts the newest commit of main" check_tag "$work" "$main_commit"
  check "accepts an older commit of main" check_tag "$work" "$(git_in "$work" rev-parse HEAD~1)"
}

test_refuses_a_commit_only_on_another_branch() {
  set_up
  check "refuses a commit that is only on the branch side" refuses "$work" "$side_commit"
}

test_refuses_a_commit_after_main() {
  set_up
  local after
  after="$(commit_in "$work" "not pushed to main")"
  check "refuses a commit after origin/main" refuses "$work" "$after"
}

test_refuses_a_commit_that_is_not_in_the_repo() {
  set_up
  check "refuses a commit that the repo does not have" refuses "$work" 0123456789abcdef0123456789abcdef01234567
}

test_refuses_when_there_is_no_origin_main() {
  set_up
  git_in "$work" update-ref -d refs/remotes/origin/main
  check "refuses when origin/main is not there" refuses "$work" "$main_commit"
}

test_refuses_when_the_commit_is_not_given() {
  set_up
  check "refuses an empty GITHUB_SHA" refuses "$work" ""
}

test_accepts_a_commit_on_main
test_refuses_a_commit_only_on_another_branch
test_refuses_a_commit_after_main
test_refuses_a_commit_that_is_not_in_the_repo
test_refuses_when_there_is_no_origin_main
test_refuses_when_the_commit_is_not_given

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All checks passed"
