#!/usr/bin/env bash
#
# Interactive secret setup for the supy-expansion Worker.
#
#   cd worker && ./setup-secrets.sh
#
# Values are read silently, piped straight into `wrangler secret put`, and never
# echoed, logged or written to disk. Press Enter to skip any one — you can rerun
# this at any time to fill in the rest.
set -uo pipefail

command -v npx >/dev/null || { echo "npx not found. Install Node first."; exit 1; }

echo
echo "Setting secrets for the supy-expansion Worker."
echo "Nothing is displayed or saved locally. Enter to skip."
echo

put() {                      # put NAME "where it comes from"
  local name="$1" hint="$2" value=""
  printf '\n%s\n  %s\n  value (hidden, Enter to skip): ' "$name" "$hint"
  read -rs value; echo
  if [ -z "$value" ]; then echo "  skipped"; return; fi
  if printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null 2>&1; then
    echo "  set"
  else
    echo "  FAILED — run: npx wrangler secret put $name"
  fi
  unset value
}

echo "── HubSpot ── contact, note and deal linking"
echo "   Same three values the supy-onboarding Worker uses."
put CLIENT_ID     "HubSpot app client id"
put CLIENT_SECRET "HubSpot app client secret"
put REFRESH_TOKEN "HubSpot OAuth refresh token"

echo
echo "── Slack ── where the team sees new requests"
echo "   Create an incoming webhook for the channel that should receive these."
echo "   Decide first: same channel as onboarding, or a new one?"
put SLACK_WEBHOOK_URL "https://hooks.slack.com/services/..."

echo
echo "── Cloudinary ── stores the uploaded trade licences and VAT certificates"
echo "   Same account as supy-onboarding; files go under a separate prefix."
put CLOUDINARY_CLOUD_NAME "Cloudinary cloud name"
put CLOUDINARY_API_KEY    "Cloudinary API key"
put CLOUDINARY_API_SECRET "Cloudinary API secret"

echo
echo "── Admin ── guards /debug, /logs and the prefill-link endpoint"
echo "   Make up a NEW long random string. Generate one with:"
echo "     openssl rand -hex 32"
put ADMIN_TOKEN "your new admin token"

echo
echo "── Optional: email receipts ── skip and emails simply do not send"
put GMAIL_CLIENT_ID     "Gmail OAuth client id"
put GMAIL_CLIENT_SECRET "Gmail OAuth client secret"
put GMAIL_REFRESH_TOKEN "Gmail OAuth refresh token"

echo
echo "── Optional: spreadsheet mirror ── skip and rows simply are not written"
put GOOGLE_SCRIPT_URL "Apps Script web app URL (see google-apps-script/Code.gs)"

echo
echo "Deploying so the new secrets take effect..."
npx wrangler deploy >/dev/null 2>&1 && echo "Deployed." || echo "Deploy failed — run: npx wrangler deploy"

echo
echo "Check what landed (needs the admin token you just set):"
echo "  curl -s -H 'x-admin-token: YOUR_TOKEN' \\"
echo "    https://supy-expansion.vaishnavi-5d1.workers.dev/debug | python3 -m json.tool"
echo
