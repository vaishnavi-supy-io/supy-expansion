# Moving the form to `expansion.supy.io`

The form and the Worker were built on personal infrastructure — a GitHub Pages
site under a personal org, and a Worker on a personal Cloudflare account. Both
work. Neither is somewhere Supy can maintain long-term, and neither is a URL you
would want to paste into an email to a client.

This is the move to `expansion.supy.io`, with the Worker on Supy's own
Cloudflare account.

---

## Status — 2026-09-28

**`https://expansion.supy.io` is live and working.** Everything that does not
need a credential is done. It refuses submissions, and that is the correct
behaviour until delivery credentials exist.

| | |
|---|---|
| Worker on the `supy.io` account | ✅ |
| KV namespaces | ✅ bound: DRAFTS, LOGS, RATELIMIT |
| Custom domain, DNS, certificate | ✅ |
| Drafts copied | ✅ re-synced — **run once more at cutover** |
| `ADMIN_TOKEN` | ✅ generated and set. Held only by Cloudflare and the Apps Script property — no copy on any machine |
| `RATE_LIMIT` | ✅ 500 |
| Delivery credentials | ❌ **the only thing left** |

Verified end to end. A real multipart POST, exactly as the form sends one:

```
POST /webhook  → 503
{"status":"error","message":"This form is not accepting submissions yet.
 Please contact your Supy customer success manager directly so your request
 is not lost."}
```

That is the Worker parsing the payload, validating it, finding no delivery
channel and turning the request away by design. Routing, assets, KV bindings and
request handling all work.

```
GET /health  → {"ok":true,"sheets":"unset","admin":true,…}
GET /geo     → {"country":"IN","cfCountry":"IN","headerCountry":"IN"}
GET /debug   → acceptingSubmissions: false
```

### What is left, and why nobody else can do it

Cloudflare secrets are write-only — the API and the dashboard both return names,
never values — so nothing could be copied from the old Worker, and nothing on
the machine that built it has them either.

There is one way round that, recorded here in case it is ever needed. Cloudflare
hides secrets from people, not from the Worker itself: `env.CLOUDINARY_API_SECRET`
is perfectly readable at runtime, so a build that returns its own `env` hands
them over.

```
wrangler versions upload    # a version with its own preview URL,
                            # WITHOUT moving production traffic
```

Gate that endpoint behind a one-time token, pull the values from the preview
URL, pipe them straight into `wrangler secret put` on the destination, delete
the version. Production keeps serving throughout. Caveat: workers-sdk#10068
suggests uploaded versions may not inherit secrets, so it may return nothing.

It was not used, because it is not necessary. **None of these are one-time-view
secrets.** Every one is displayed permanently in its own console, so reading
them from source gives the same values with nothing deployed and nothing
exposed:

| Secret | Where from |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | HubSpot → Settings → Integrations → Private Apps → Auth (`pat-…`) |
| `SLACK_WEBHOOK_URL` | api.slack.com/apps → your app → Incoming Webhooks |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | Cloudinary console → Dashboard |
| `COUNTRY_MANAGERS_JSON` | `{"AE":"…@supy.io","SA":"…@supy.io"}` |
| `GOOGLE_SCRIPT_URL` | the `google-apps-script/Code.gs` deployment |
| `SLACK_BOT_TOKEN`, `SLACK_CHANNEL` | optional — enables threaded warnings |

`ADMIN_TOKEN` and `RATE_LIMIT` are already set; skip them when the script asks.

Two ways to do it. Both push into the same place; pick whichever suits.

**One sitting, prompted:**

```bash
cd worker && ./setup-secrets.sh
```

**Over several sittings, a value at a time** — better if the credentials have to
be collected from different places or different people:

```bash
cd worker
cp .secrets.local.example .secrets.local     # gitignored, created 0600
$EDITOR .secrets.local                       # fill in whatever you have today
./push-secrets.sh --dry-run                  # see what would go, push nothing
./push-secrets.sh                            # pushes only the filled-in ones
```

Blank values are skipped, so it is safe to run as many times as you like —
nothing already set gets clobbered. It warns if wrangler is pointed at the wrong
account, tolerates quoted values, never prints one, and prints `/health`
afterwards so you can watch the channels come up.

`.secrets.local` is plaintext on disk, which is a step down from Cloudflare's
write-only store. Once every value is pushed and a test submission has gone
through, get rid of it:

```bash
./push-secrets.sh --shred
```

Check progress at any point:

```bash
curl -s https://expansion.supy.io/health | python3 -m json.tool
# /debug, /logs, /pending and /export.csv need ADMIN_TOKEN. Cloudflare will not
# hand it back, and it is deliberately not stored locally, so paste it at the
# prompt rather than keeping a copy:
read -rs -p "admin token: " T; echo
curl -s -H "x-admin-token: $T" https://expansion.supy.io/debug | python3 -m json.tool
unset T
```

`sheets` should stop saying `"unset"`, and `acceptingSubmissions` should flip to
`true` as soon as HubSpot or Slack has credentials.

### Then, and only then

These three steps are deliberately **not** done, because doing them before
secrets exist would break the system that is currently serving clients:

1. **Test a real submission** on the new domain. Confirm it reaches HubSpot,
   Slack and the sheet.
2. **Re-run the drafts copy** — catches anything saved in the meantime.
3. **Disable the `*/15` cron on the old Worker.** Doing this early would strip
   the Sheets-replay safety net from the deployment still serving every client.
   Doing it late means two Workers replaying against one sheet — duplicate rows.
   It belongs exactly at cutover.
4. **Put the redirect stub up** on GitHub Pages. Doing this early replaces a
   working form with a redirect to one that refuses submissions. Leave it up for
   30 days afterwards.

### Note on `.html` URLs

Cloudflare's asset serving strips the extension by default
(`html_handling: "auto-trailing-slash"`), so `/sample.html` 307s to `/sample`.
Both work. Set `html_handling = "none"` under `[assets]` if exact paths ever
matter.

### Still to do, in order

1. **Set the secrets** — `cd worker && ./setup-secrets.sh`. Needs whoever holds
   the HubSpot, Cloudinary and Slack credentials.
2. **Test a real submission** end to end on the new domain.
3. **Re-run the drafts copy** to catch anything saved in the meantime.
4. **Disable the `*/15` cron on the old Worker.** Both run the Sheets replay.
   It is a no-op today because the new `LOGS` is empty; once secrets are set, two
   Workers replaying against the same sheet is a duplicate-row problem.
5. **Put the redirect stub up** on GitHub Pages, and leave it for 30 days.

The old form and Worker are untouched and still serving every client.

---

## What changes

| | Before | After |
|---|---|---|
| Form | `vaishnavi-supy-io.github.io/supy-expansion/` | `expansion.supy.io` |
| API | `supy-expansion.vaishnavi-5d1.workers.dev` | `expansion.supy.io` (same origin) |
| Hosting | GitHub Pages + Cloudflare Workers | Cloudflare Workers, one deploy |
| Cloudflare account | `Vaishnavi@supy.io's Account` | `supy.io` (`f3adfa5e…`) |
| CORS | Cross-origin, allowlisted | Same-origin — stops being a concern |

The form becomes a static asset served by the Worker itself. A request that
matches a file in `worker/public/` is served as that file; everything else falls
through to the fetch handler where `/webhook`, `/draft/save`, `/download` and
the rest already live. One origin, one deploy, no CORS.

**Webflow is untouched.** `supy.io` and `www.supy.io` stay pointed at Webflow
exactly as they are. This adds one subdomain and changes nothing else on the
zone.

---

## DNS: you can do this yourself

An earlier version of this document said DNS belonged to someone else. That was
wrong, and the mistake is worth recording so nobody repeats it.

The evidence was a 403:

```
GET /zones/{supy.io}/dns_records  → 403  Authentication error
```

That 403 is about the **token**, not the person. Wrangler's OAuth token requests
`zone:read` and no DNS scope whatsoever, so that call fails for everyone. The
actual role on the supy.io account says otherwise:

```
dns_records    {"edit": true, "read": true}
worker         {"edit": true, "read": true}
zone           {"edit": false, "read": true}
domain         {"edit": false, "read": true}
```

DNS edit and Worker edit, which is everything this migration needs. Note these
are account-level permissions; an Enterprise account can scope a role to
particular zones, and that would not show up here. If the dashboard lets you
save the record, the rights were real.

Because `wrangler` cannot reach DNS with an OAuth token, the record is made in
the dashboard — or with an API token carrying `Zone.DNS:Edit`, which is worth
creating only if this needs to be scripted.

### Option A — Custom Domain (one action, recommended)

**Workers & Pages → supy-expansion → Settings → Domains & Routes → Add →
Custom Domain → `expansion.supy.io`**

Creates the DNS record *and* the certificate together. Then swap the
`[[routes]]` block in `worker/wrangler.toml` for the `custom_domain = true`
version commented out beneath it, and redeploy.

### Option B — placeholder record, keep the existing route

**DNS → supy.io → Add record → `AAAA` · name `expansion` · content `100::` ·
Proxied**

`100::` is the IPv6 discard prefix; nothing is ever routed to it. The proxy
intercepts the request and hands it to the Worker first. The route is already
attached, so no redeploy is needed — it starts working the moment the record
saves.

Either way, `supy.io` and `www` stay on Webflow. This adds one subdomain and
changes nothing else on the zone.

---

## Cutover

Nothing below touches DNS. Steps 1–4 can be done before the record exists; the
Worker simply answers on `workers.dev` until it lands.

**1. Point wrangler at the right account.**

```bash
npx wrangler logout && npx wrangler login   # tick ALL accounts on the consent screen
npx wrangler whoami                          # expect: supy.io | f3adfa5ed42dea46fdeb8be255b1cd2b
```

**2. Recreate the KV namespaces.** Namespace ids are account-scoped, so the old
ones do not resolve here. `worker/wrangler.toml` has `REPLACE_ME_*` placeholders
waiting for the new ids.

```bash
cd worker
npx wrangler kv namespace create DRAFTS
npx wrangler kv namespace create LOGS
npx wrangler kv namespace create RATELIMIT
```

**3. Carry the live drafts across.** `DRAFTS` holds 30-day resume links that
clients may be halfway through. Skip this and those links 404.

Drafts carry a TTL, so the copy has to bring each key's existing expiry with it
— otherwise they either come back from the dead or all expire together.

**This cannot be done with `wrangler`.** `account_id` in `wrangler.toml` now
points at the org account and overrides `CLOUDFLARE_ACCOUNT_ID`, so any attempt
to read the old namespace looks for it on the wrong account:

```
get namespace: 'namespace not found' [code: 10013]
```

Go straight to the API, which can address both accounts in one script:

```bash
TOK=$(grep -m1 '^oauth_token' ~/.wrangler/config/default.toml | sed 's/.*= *"//; s/"//')
PERS=5d17e7b0e9e74f074adff38975282562   # old, personal
ORG=f3adfa5ed42dea46fdeb8be255b1cd2b    # new, supy.io
OLD=32de3d0e21bd4681b3a8d9c07dd6b4d8    # old DRAFTS
NEW=2848982e9a3142398c8ebf2a8efaffbf    # new DRAFTS
tmp=$(mktemp -d)

curl -s "https://api.cloudflare.com/client/v4/accounts/$PERS/storage/kv/namespaces/$OLD/keys?limit=1000" \
  -H "Authorization: Bearer $TOK" > "$tmp/keys.json"

python3 - "$tmp" <<'EOF'
import json,sys,urllib.parse
d=json.load(open(sys.argv[1]+'/keys.json'))
with open(sys.argv[1]+'/keys.tsv','w') as f:
    for k in d.get('result') or []:
        f.write('%s\t%s\t%s\n' % (k['name'], urllib.parse.quote(k['name'],safe=''), k.get('expiration') or ''))
EOF

while IFS=$'\t' read -r key enc exp; do
  curl -s -f "https://api.cloudflare.com/client/v4/accounts/$PERS/storage/kv/namespaces/$OLD/values/$enc" \
       -H "Authorization: Bearer $TOK" -o "$tmp/value" || { echo "READ FAILED: $key"; continue; }
  q=""; [ -n "$exp" ] && q="?expiration=$exp"
  curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$ORG/storage/kv/namespaces/$NEW/values/$enc$q" \
       -H "Authorization: Bearer $TOK" -F "value=<$tmp/value" -F 'metadata={}' > /dev/null \
    && echo "copied: $key (expiration: ${exp:-none})"
done < "$tmp/keys.tsv"

rm -rf "$tmp"
```

Writes overwrite, so this is safe to run as many times as you like. **Run it
again immediately before cutover** — anything saved between the last run and the
switch is otherwise stranded on the old namespace.

First pass, 2026-09-28: one key, `acct:14766d6a…`, expiring 2026-11-25. It is an
account-link record rather than a saved draft, so no client was mid-form.

`LOGS` is a rolling window of the last 200 submissions and `RATELIMIT` is
per-IP and short-lived — neither is worth copying.

**4. Re-set the secrets.** Secrets do not follow the Worker between accounts.

```bash
./setup-secrets.sh
```

**5. Deploy.** `npm run deploy` runs `sync-assets.sh` first, which copies
`index.html` and `sample.html` into `worker/public/`.

```bash
npm run deploy
```

Until the DNS record exists this deploy will report the route as unattached.
That is expected and not an error — the Worker is live on `workers.dev`
throughout.

**6. Once the record lands**, redeploy to bind the route, then check:

```bash
curl -si https://expansion.supy.io/health
curl -si https://expansion.supy.io/ | head -5     # should be the form's HTML
```

**7. Leave a forwarding address.** Put a redirect stub at the repo root so the
old GitHub Pages URL sends people to the new one, and keep it up for at least 30
days — the length of a draft's life.

```html
<!doctype html><meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=https://expansion.supy.io/">
<link rel="canonical" href="https://expansion.supy.io/">
<p>This form has moved to <a href="https://expansion.supy.io/">expansion.supy.io</a>.</p>
```

Note this replaces the real form at the repo root, so do it only after step 6
passes. `worker/sync-assets.sh` copies from that path — move the real
`index.html` into `worker/public/` permanently at the same time and drop the
sync script.

---

## What stays alive, and for how long

`supy-expansion.vaishnavi-5d1.workers.dev` must keep answering. Slack messages,
receipt emails and resume links already sitting in inboxes point at it:

- `/download?…` links in Slack and in internal notification emails
- `?draft=…` resume links, good for 30 days from when they were saved

The `workers.dev` subdomain coexists with a route, so nothing needs doing to
keep it — just don't disable it. Retire it after the last old draft has expired.

`ALLOWED_ORIGINS` keeps `https://vaishnavi-supy-io.github.io` on the list for
the same reason: someone may have the old page open when you cut over. Drop it
once the redirect stub is in place.

---

## Rollback

The old Worker on the personal account is untouched by any of this, still
deployed, still holding its own KV and secrets. If the new one misbehaves,
revert `index.html`'s `webhookUrl` to the absolute `workers.dev` URL and
redeploy GitHub Pages. That is the whole rollback.

---

## Code changes this needed

Three, all committed alongside this file:

- `index.html` — `webhookUrl` is origin-aware: relative on `expansion.supy.io`
  (same-origin, no CORS), absolute on GitHub Pages and `file://` where the
  Worker is elsewhere. So the one file is correct on both hosts during the
  transition.
- `worker/src/index.js` — the `FORM_URL` fallback no longer names GitHub Pages.
- `worker/wrangler.toml` — `account_id`, the `[assets]` block, the route, and
  updated vars.

Plus `worker/sync-assets.sh`, which copies the form into the Worker's asset
directory at deploy time. The form stays at the repo root as the single source
of truth while GitHub Pages is still serving it; `worker/public/` is generated
and gitignored. Both go away at step 7.
