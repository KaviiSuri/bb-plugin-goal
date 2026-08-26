#!/usr/bin/env bash
# Validate, version, build, commit, and tag a Goal plugin release.
# Nothing leaves the machine unless --push is present.
set -euo pipefail

cd "$(dirname "$0")/.."

BUMP="${1:-}"
PUSH=0
for arg in "${@:2}"; do
  case "$arg" in
    --push) PUSH=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$BUMP" ]]; then
  echo "usage: scripts/release.sh <patch|minor|major|X.Y.Z> [--push]" >&2
  exit 2
fi

branch=$(git branch --show-current)
if [[ "$branch" != "main" ]]; then
  echo "error: releases must be cut from main (currently '$branch')" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty" >&2
  git status --short >&2
  exit 1
fi

git fetch origin main --tags
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "error: main must exactly match origin/main before release" >&2
  exit 1
fi

npm ci
npm run check

version=$(npm version "$BUMP" --no-git-tag-version)
version="${version#v}"
tag="v${version}"
if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  echo "error: tag $tag already exists" >&2
  git restore package.json package-lock.json
  exit 1
fi

# Rebuild after the version bump so dist metadata names the released version.
npm run build

git add package.json package-lock.json
git add --force dist/
git commit -m "release: $tag"
git tag --annotate "$tag" --message "$tag"

echo "created release commit and annotated tag $tag"
if [[ "$PUSH" -eq 1 ]]; then
  git push --atomic origin HEAD:main "refs/tags/$tag"
  echo "published $tag"
else
  echo "not pushed; publish with:"
  echo "  git push --atomic origin HEAD:main refs/tags/$tag"
fi
