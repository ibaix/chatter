#!/usr/bin/env bash
# Prints the moving image tags that a public release gets, one on each line:
#   latest   when the release is the newest public release
#   X.Y      when the release is the newest public release of X.Y (for example 1.7 for v1.7.2)
# The fixed tag X.Y.Z is not printed: the image of the tag has it from the start.
# An older release, such as a fix of an old version, does not move a tag back.
#
# Run:   tools/release/moving-tags.sh v1.7.0
# Needs: gh, with GH_REPO set or run in the repo. It reads the public releases (no drafts, no pre-releases).
set -euo pipefail

RELEASE_TAG='^v[0-9]+\.[0-9]+\.[0-9]+$'

tag="${1:-}"
if ! [[ "$tag" =~ $RELEASE_TAG ]]; then
  echo "Give a release tag such as v1.7.0, not \"$tag\"" >&2
  exit 2
fi

# True when version $1 is newer than version $2 (both X.Y.Z, without the v)
is_newer() {
  local a b i
  IFS=. read -r -a a <<< "$1"
  IFS=. read -r -a b <<< "$2"
  for i in 0 1 2; do
    if [ "${a[$i]}" -gt "${b[$i]}" ]; then return 0; fi
    if [ "${a[$i]}" -lt "${b[$i]}" ]; then return 1; fi
  done
  return 1
}

version="${tag#v}"
minor="${version%.*}"
newest_overall=1
newest_in_minor=1

while IFS= read -r other; do
  [[ "$other" =~ $RELEASE_TAG ]] || continue
  other="${other#v}"
  if is_newer "$other" "$version"; then
    newest_overall=0
    if [ "${other%.*}" = "$minor" ]; then newest_in_minor=0; fi
  fi
done < <(gh release list --exclude-drafts --exclude-pre-releases --limit 1000 --json tagName --jq '.[].tagName')

if [ "$newest_overall" = 1 ]; then echo latest; fi
if [ "$newest_in_minor" = 1 ]; then echo "$minor"; fi
