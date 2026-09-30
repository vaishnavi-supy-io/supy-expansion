#!/usr/bin/env bash
#
# Push whichever secrets you have filled into .secrets.local, and skip the rest.
#
#   cp .secrets.local.example .secrets.local
#   $EDITOR .secrets.local
#   ./push-secrets.sh
#
# Safe to run repeatedly. Blank values are skipped, so you can fill the file in
# over several sittings without disturbing what is already set. Values are piped
# straight into `wrangler secret put` and never printed.
#
#   ./push-secrets.sh --dry-run   show what would be pushed, push nothing
#   ./push-secrets.sh --shred     securely delete .secrets.local when you are done
set -uo pipefail
cd "$(dirname "$0")"

FILE=.secrets.local
DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  --shred)
    [ -f "$FILE" ] || { echo "Nothing to shred — $FILE does not exist."; exit 0; }
    printf 'Securely delete %s? Every value in it must already be pushed. [y/N] ' "$FILE"
    read -r go; [ "$go" = "y" ] || { echo "Left alone."; exit 0; }
    if command -v shred >/dev/null; then shred -u "$FILE"; else rm -P "$FILE" 2>/dev/null || rm -f "$FILE"; fi
    echo "Deleted. The values now live only in Cloudflare, which cannot hand them back."
    exit 0 ;;
  "") ;;
  *) echo "Unknown option: $1"; exit 1 ;;
esac

[ -f "$FILE" ] || { echo "No $FILE — start with: cp .secrets.local.example $FILE"; exit 1; }

perms=$(stat -f '%Lp' "$FILE" 2>/dev/null || stat -c '%a' "$FILE" 2>/dev/null)
[ "$perms" = "600" ] || { echo "Tightening permissions on $FILE (was $perms)"; chmod 600 "$FILE"; }

acct=$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)
if [ -n "$acct" ] && [ "$acct" != "f3adfa5ed42dea46fdeb8be255b1cd2b" ]; then
  echo "WARNING: wrangler is pointed at $acct, not the supy.io account."
  printf 'Continue anyway? [y/N] '; read -r go; [ "$go" = "y" ] || exit 1
fi

set=0; skipped=0; failed=0
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  name=${line%%=*}
  value=${line#*=}
  case "$name" in *[!A-Z0-9_]*|'') continue ;; esac
  if [ -z "$value" ]; then skipped=$((skipped+1)); continue; fi
  value=${value%\"}; value=${value#\"}          # tolerate quoted values
  value=${value%\'}; value=${value#\'}
  if [ "$DRY" = "1" ]; then
    echo "  would push: $name (${#value} chars)"; set=$((set+1)); continue
  fi
  if printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null 2>&1; then
    echo "  set: $name"; set=$((set+1))
  else
    echo "  FAILED: $name — run: npx wrangler secret put $name"; failed=$((failed+1))
  fi
done < "$FILE"
unset value

echo
if [ "$DRY" = "1" ]; then
  echo "dry run — $set would be pushed, $skipped still blank"
  exit 0
fi
echo "$set set, $skipped still blank, $failed failed"

echo
echo "Where that leaves the Worker:"
curl -s --max-time 20 https://expansion.supy.io/health | python3 -m json.tool 2>/dev/null || echo "  (could not reach /health)"
echo
echo "Full picture:"
echo "  read -rs -p \"admin token: \" T; echo; curl -s -H \"x-admin-token: \$T\" https://expansion.supy.io/debug | python3 -m json.tool; unset T"
echo
echo "Once every value is in and a test submission has gone through:"
echo "  ./push-secrets.sh --shred"
