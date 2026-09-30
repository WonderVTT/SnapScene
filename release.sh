#!/usr/bin/env bash
# Publish a new version: ./release.sh 1.0.1
# Bumps module.json, commits, tags and pushes; GitHub Actions builds the release.
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${1:?usage: ./release.sh <version>, e.g. 1.0.1}"
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first." >&2
  exit 1
fi
BASE="$(jq -r .url module.json)"
jq --arg v "$VERSION" --arg d "$BASE/releases/download/v$VERSION/module.zip" \
  '.version = $v | .download = $d' module.json > module.tmp && mv module.tmp module.json
git commit -am "Release v$VERSION"
git tag "v$VERSION"
git push origin HEAD "v$VERSION"
echo "Pushed v$VERSION. The release appears on $BASE/releases in a minute or so."
