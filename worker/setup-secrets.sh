#!/usr/bin/env bash
#
# Secret setup for the supy-expansion Worker.
#
#   cd worker && ./setup-secrets.sh
#
# Values are read silently, piped straight into `wrangler secret put`, and never
# echoed, logged or written to disk. Press Enter to skip any one — you can rerun
# this at any time to fill in the rest.
#
# The list below is the set the Worker actually reads, checked against
# worker/src/index.js and against the 11 secrets the original deployment ran
# with. An earlier version of this script prompted for HubSpot OAuth and Gmail
# and omitted four secrets production depended on; following it produced a
# Worker that looked configured and could not deliver.
set -uo pipefail

command -v npx >/dev/null || { echo "npx not found. Install Node first."; exit 1; }

acct=$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)
echo
echo "Setting secrets for the supy-expansion Worker."
if [ "$acct" = "f3adfa5ed42dea46fdeb8be255b1cd2b" ]; then
  echo "Account: supy.io  ✓"
elif [ -n "$acct" ]; then
  echo "Account: $acct"
  echo "WARNING: that is not the supy.io account. Check wrangler.toml's account_id"
  echo "         and 'npx wrangler whoami' before continuing."
  printf 'Continue anyway? [y/N] '; read -r go; [ "$go" = "y" ] || exit 1
fi
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

echo "════ REQUIRED — at least one delivery channel, or submissions are refused ════"

echo
echo "── HubSpot ── contact, note and deal linking"
echo "   A Private App token, starting 'pat-'. This is the path production uses."
echo "   HubSpot -> Settings -> Integrations -> Private Apps -> your app -> Auth"
put HUBSPOT_ACCESS_TOKEN "HubSpot private app token (pat-...)"

echo
echo "── Slack ── where the team sees new requests"
echo "   The SAME channel supy-onboarding posts to. Expansion posts are titled"
echo "   'New Expansion Request', so they stay distinguishable in a shared channel."
echo "     api.slack.com/apps -> your app -> Incoming Webhooks"
put SLACK_WEBHOOK_URL "https://hooks.slack.com/services/..."

echo
echo "════ STORAGE — without these, uploaded documents are lost ════"
echo
echo "── Cloudinary ── stores the uploaded trade licences and VAT certificates"
echo "   Same account as supy-onboarding; files go under a separate prefix."
put CLOUDINARY_CLOUD_NAME "Cloudinary cloud name"
put CLOUDINARY_API_KEY    "Cloudinary API key"
put CLOUDINARY_API_SECRET "Cloudinary API secret"

echo
echo "════ OPERATIONS ════"
echo
echo "── Admin ── guards /debug, /logs and the prefill-link endpoint"
echo "   Make up a NEW long random string. Generate one with:"
echo "     openssl rand -hex 32"
put ADMIN_TOKEN "your new admin token"

echo
echo "── Slack threading ── posts warnings as replies rather than new messages"
echo "   Both are needed for threading; skip both and warnings post standalone."
put SLACK_BOT_TOKEN "Slack bot token (xoxb-...)"
put SLACK_CHANNEL   "Slack channel id (C...)"

echo
echo "── Country managers ── who gets named on a request, by country"
echo '   JSON object, e.g. {"AE":"someone@supy.io","SA":"someone@supy.io"}'
put COUNTRY_MANAGERS_JSON "country -> owner email, as JSON"

echo
echo "── Spreadsheet mirror ── skip and rows simply are not written"
echo "   The Apps Script web app URL — see google-apps-script/Code.gs"
put GOOGLE_SCRIPT_URL "Apps Script web app URL"

echo
echo "── Rate limit ── requests per IP per window. Skip to use the built-in default."
put RATE_LIMIT "a number, e.g. 20"

echo
echo "════ OPTIONAL ════"
echo
echo "── Retailer lookup ── separate Apps Script endpoints, if you use them."
echo "   Both fall back to GOOGLE_SCRIPT_URL when unset."
put RETAILER_SHEET_URL    "retailer list Apps Script URL"
put USER_ACCESS_SHEET_URL "user access Apps Script URL"

echo
echo "── Form shared secret ── rejects posts that do not carry it. See README."
put FORM_SHARED_SECRET "shared secret, or skip"

echo
echo "── Email receipts ── skip and emails simply do not send."
echo "   Production has never had these set."
put GMAIL_CLIENT_ID     "Gmail OAuth client id"
put GMAIL_CLIENT_SECRET "Gmail OAuth client secret"
put GMAIL_REFRESH_TOKEN "Gmail OAuth refresh token"

echo
echo "Deploying so the new secrets take effect..."
npx wrangler deploy >/dev/null 2>&1 && echo "Deployed." || echo "Deploy failed — run: npx wrangler deploy"

echo
echo "Check what landed — no token needed, this endpoint is public:"
echo "  curl -s https://expansion.supy.io/health | python3 -m json.tool"
echo
echo "A fuller picture, with the admin token you just set:"
echo "  curl -s -H 'x-admin-token: YOUR_TOKEN' \\"
echo "    https://expansion.supy.io/debug | python3 -m json.tool"
echo
