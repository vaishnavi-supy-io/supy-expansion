#!/usr/bin/env bash
# Copy the form into the Worker's asset directory.
#
# The form lives at the repo root so GitHub Pages can keep serving it during the
# move to expansion.supy.io. The Worker needs it under its own directory, and
# pointing [assets] at the repo root would sweep up node_modules. So: one copy,
# regenerated on every deploy, ignored by git.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
mkdir -p "$here/public"
cp "$root/index.html"  "$here/public/index.html"
cp "$root/sample.html" "$here/public/sample.html"
cp "$root/favicon.svg" "$here/public/favicon.svg"
echo "synced: index.html, sample.html, favicon.svg -> worker/public/"
