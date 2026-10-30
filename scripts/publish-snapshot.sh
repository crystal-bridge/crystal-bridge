#!/usr/bin/env bash
# Builds the public repository's first commit: the tree of one ref (default origin/main) as a fresh repository with a
# single commit and no history, so no old revision or commit metadata goes public. The commit uses this checkout's
# repo-local git identity (the noreply one), never a global one. Run it on the machine that scans, then scan the
# result before pushing it anywhere (docs/OPERATIONS.md, "Publishing").
# Usage: scripts/publish-snapshot.sh <out-dir> [ref]
set -euo pipefail

out=${1:-}
ref=${2:-origin/main}
if [[ -z $out ]]; then
  echo "Usage: scripts/publish-snapshot.sh <out-dir> [ref]   (ref defaults to origin/main)" >&2
  exit 2
fi
if [[ -e $out && -n $(ls -A "$out") ]]; then
  echo "publish-snapshot: $out is not empty; pick a new folder" >&2
  exit 2
fi

name=$(git config --local user.name || true)
email=$(git config --local user.email || true)
if [[ -z $name || -z $email ]]; then
  echo "publish-snapshot: set a repo-local identity first (git config --local user.name/user.email)" >&2
  exit 2
fi

commit=$(git rev-parse --verify "$ref^{commit}")
mkdir -p "$out"
git archive "$commit" | tar -x -C "$out"

cd "$out"
git init -q -b main
git add -A
GIT_AUTHOR_NAME=$name GIT_AUTHOR_EMAIL=$email GIT_COMMITTER_NAME=$name GIT_COMMITTER_EMAIL=$email \
  git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m "Crystal Bridge: first public release"
echo "publish-snapshot: $(git ls-files | wc -l | tr -d ' ') files from ${commit:0:12} in $out, one commit by $name <$email>"
echo "publish-snapshot: scan it now (gitleaks, trufflehog, the deny list) before pushing it anywhere"
