#!/usr/bin/env bash
# Stops a release job when the tag commit is not on main. Only a commit on main can become a release.
# In .github/workflows/docker.yml, the publish job and the sign job run it before they publish or sign.
# The check stops a mistake, not an attack: for a tag, GitHub runs the workflow file of the tagged commit
# (see docs/security.md).
#
# Run:   GITHUB_SHA=<tag commit> GITHUB_REF_NAME=<tag> tools/release/check-tag-on-main.sh
# Needs: a checkout with the history of main (actions/checkout with fetch-depth: 0)
set -euo pipefail

main() {
  local commit="${GITHUB_SHA:-}"
  local tag="${GITHUB_REF_NAME:-this tag}"

  [ -n "$commit" ] || fail "GITHUB_SHA is empty. It must be the commit of the tag."
  git rev-parse --verify --quiet refs/remotes/origin/main > /dev/null ||
    fail "origin/main is not in the checkout. Check out with fetch-depth: 0."

  if ! git merge-base --is-ancestor "$commit" refs/remotes/origin/main 2> /dev/null; then
    fail "The tag $tag is not on main. Tag only a commit on main."
  fi
  echo "The tag $tag is on main."
}

fail() {
  echo "::error::$*" >&2
  exit 1
}

main "$@"
