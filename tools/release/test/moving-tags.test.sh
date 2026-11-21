#!/usr/bin/env bash
# Tests for moving-tags.sh. A fake "gh" gives the list of public releases, so the tests need no GitHub.
# Run:  tools/release/test/moving-tags.test.sh
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/moving-tags.sh"
failures=0

sandboxes=()
trap 'rm -rf "${sandboxes[@]}"' EXIT

# Makes a temporary folder with a fake gh. "gh release list" prints the given tags, one on each line.
set_up() {
  sandbox="$(mktemp -d)"
  sandboxes+=("$sandbox")
  mkdir -p "$sandbox/bin"
  printf '%s\n' "$@" > "$sandbox/releases.txt"
  cat > "$sandbox/bin/gh" << 'EOF'
#!/usr/bin/env bash
sandbox="$(dirname "$0")/.."
echo "$*" >> "$sandbox/gh-calls.log"
case "$1 $2" in
  "release list") cat "$sandbox/releases.txt" ;;
  *) echo "fake gh: unknown command $*" >&2; exit 1 ;;
esac
EOF
  chmod +x "$sandbox/bin/gh"
}

moving_tags() {
  PATH="$sandbox/bin:$PATH" "$SCRIPT" "$@" 2> "$sandbox/errors.log"
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

test_the_newest_release_gets_both_tags() {
  set_up v1.7.0 v1.6.0 v1.5.0
  check "v1.7.0, the newest: latest and 1.7" test "$(moving_tags v1.7.0)" = "$(printf 'latest\n1.7')"
}

test_an_old_patch_gets_only_its_minor_tag() {
  set_up v1.7.0 v1.6.1 v1.6.0
  check "v1.6.1 after v1.7.0: only 1.6" test "$(moving_tags v1.6.1)" = "1.6"
}

test_an_older_patch_of_the_same_minor_gets_nothing() {
  set_up v1.6.2 v1.6.1 v1.6.0
  check "v1.6.1 after v1.6.2: no tags" test -z "$(moving_tags v1.6.1)"
}

test_compares_numbers_not_text() {
  set_up v1.10.0 v1.9.0
  check "v1.10.0 is newer than v1.9.0" test "$(moving_tags v1.10.0)" = "$(printf 'latest\n1.10')"
  set_up v1.9.0 v1.10.0
  check "v1.9.0 is older than v1.10.0: only 1.9" test "$(moving_tags v1.9.0)" = "1.9"
}

test_counts_the_version_when_the_list_does_not_have_it_yet() {
  set_up v1.6.0
  check "v1.7.0, not in the list yet: latest and 1.7" test "$(moving_tags v1.7.0)" = "$(printf 'latest\n1.7')"
}

test_ignores_tags_that_are_not_releases() {
  set_up v1.6.0 v2.0.0-rc1 nightly
  check "a pre-release name in the list does not count" test "$(moving_tags v1.7.0)" = "$(printf 'latest\n1.7')"
}

test_refuses_a_tag_that_is_not_a_release() {
  local tag
  for tag in "1.7.0" "v1.7" "v1.7.0-rc1"; do
    set_up v1.6.0
    moving_tags "$tag" > /dev/null
    check "refuses the tag $tag" test "$?" -ne 0
  done
}

test_the_newest_release_gets_both_tags
test_an_old_patch_gets_only_its_minor_tag
test_an_older_patch_of_the_same_minor_gets_nothing
test_compares_numbers_not_text
test_counts_the_version_when_the_list_does_not_have_it_yet
test_ignores_tags_that_are_not_releases
test_refuses_a_tag_that_is_not_a_release

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All checks passed"
