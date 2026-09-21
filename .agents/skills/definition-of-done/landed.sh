#!/usr/bin/env sh
# landed — did this commit actually reach the trunk?
#
# Usage:  ./landed.sh <sha> [remote] [branch]     (default: origin main)
# Prints one tier to stdout and exits:
#
#   ancestor        0  it landed — the sha is on the trunk
#   not_ancestor    1  it did NOT land, and we fetched successfully enough to say so
#   unknown_object  2  this repo has never heard of that sha (wrong clone? other repo?)
#   fetch_failed    3  could not reach the remote — we do not know, and we do not guess
#   unattested      4  no sha was given
#
# The point of the tiers: REFUSE ON POSITIVE EVIDENCE ONLY. A failed fetch and a
# genuinely unmerged commit are different facts, and collapsing them into "not
# merged" turns an offline laptop into a false accusation. Only `not_ancestor`
# is evidence of not-landed, and only after a fetch that worked.
#
# No daemon, no server, no network beyond the git remote you already have.

set -u

sha=${1:-}
remote=${2:-origin}
branch=${3:-main}

if [ -z "$sha" ]; then
  echo unattested
  exit 4
fi

# Is the object even in this repository?
if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
  # It may simply be absent until we fetch; try once, then re-check.
  git fetch --quiet "$remote" "$branch" 2>/dev/null || true
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    echo unknown_object
    exit 2
  fi
fi

# A stale ref can make a landed commit look unlanded, so a NEGATIVE answer is
# only trustworthy behind a fetch that actually succeeded.
if git fetch --quiet "$remote" "$branch" 2>/dev/null; then
  fetched=yes
else
  fetched=no
fi

if git merge-base --is-ancestor "$sha" "$remote/$branch" 2>/dev/null; then
  echo ancestor
  exit 0
fi

if [ "$fetched" = yes ]; then
  echo not_ancestor
  exit 1
fi

echo fetch_failed
exit 3
