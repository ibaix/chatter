#!/usr/bin/env bash
# Change shape, for /chatter-review-code all. It reads git history only.
#
#   change-shape.sh [N] [WINDOW]
#
# Part 1: the last N (default 8) feature and fix commits, with how many files and top folders each changed.
#   Commits for chore, docs, ci, build, style and revert are skipped.
# Part 2: the files that changed most often in the last WINDOW (default 40) commits.
#
# The numbers tell you where to look. Read the commit before you call a wide change a problem.
set -euo pipefail

N=${1:-8}
WINDOW=${2:-40}
SKIP='^(chore|docs|ci|build|style|revert)(\(|:|!)|^Merge '

echo "== feature and fix commits (last $N)"
count=0
while IFS=$'\t' read -r sha subject; do
  [ -z "$sha" ] && continue
  if printf '%s' "$subject" | grep -Eq "$SKIP"; then continue; fi
  files=$(git show --name-only --format= "$sha" | sed '/^$/d' | grep -v 'package-lock.json' || true)
  nfiles=$(printf '%s\n' "$files" | sed '/^$/d' | wc -l | tr -d ' ')
  # The top folder: apps/server, apps/web, packages/shared, tools/<name>, docs, ...
  ndirs=$(printf '%s\n' "$files" | sed '/^$/d' | awk -F/ '{ print (($1 == "apps" || $1 == "packages" || $1 == "tools") && NF > 2 ? $1 "/" $2 : (NF > 1 ? $1 : ".")) }' | sort -u | wc -l | tr -d ' ')
  echo "${sha:0:8}  files=$nfiles folders=$ndirs  $subject"
  count=$((count + 1))
  [ "$count" -ge "$N" ] && break
done < <(git log --format='%H%x09%s' --no-merges)
[ "$count" -eq 0 ] && echo "(none found)"

echo "== files that change most often (last $WINDOW commits)"
git log -n "$WINDOW" --format= --name-only --no-merges | sed '/^$/d' | grep -v 'package-lock.json' | sort | uniq -c | sort -rn | awk '$1 > 2' | head -12
