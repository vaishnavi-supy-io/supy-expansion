# Moving the form to `expansion.supy.io`

The form and the Worker were built on personal infrastructure — a GitHub Pages
site under a personal org, and a Worker on a personal Cloudflare account. Both
work. Neither is somewhere Supy can maintain long-term, and neither is a URL you
would want to paste into an email to a client.

This is the move to `expansion.supy.io`, with the Worker on Supy's own
Cloudflare account.

---

## Status — 2026-09-28

Deployed to the supy.io account. Not reachable, and not yet functional.

| | |
|---|---|
| Worker deployed to `supy.io` account | ✅ version `375c5dcc` |
| KV namespaces created | ✅ DRAFTS / LOGS / RATELIMIT, ids in `wrangler.toml` |
| Route attached | ✅ `expansion.supy.io/*` → `supy-expansion` |
| DNS record | ❌ **blocked** — `dig expansion.supy.io` returns nothing |
| Secrets | ❌ **not set** — `wrangler secret list` returns `[]` |
| Drafts copied from the old namespace | ⚠️ first pass done (1 key) — **re-run at cutover** |

`https://expansion.supy.io/health` returns nothing at all: the route is attached
but the hostname does not resolve, so no request ever reaches Cloudflare's edge
for it. The form on GitHub Pages and the Worker on the personal account are
untouched and still serving every client.

Two things left, in this order:

1. **Get the DNS record.** The message to send is below. Nothing works until this
   lands.
2. **Set the secrets** — `cd worker && ./setup-secrets.sh`. This has to be run by
   someone who holds the HubSpot, Cloudinary and Slack credentials. Until it is,
   the Worker refuses submissions by design, which is the correct behaviour for a
   form that cannot deliver anywhere.

Then copy the drafts, and only then put the redirect stub up.

**Before cutover, disable the cron on the old Worker.** Both Workers now run the
`*/15` Sheets replay. The new one replays from its own empty `LOGS`, so today it
is a no-op — but once secrets are set and drafts are copied, two Workers
replaying against the same sheet is a duplicate-row problem.

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

## The one thing we cannot do ourselves

Our role on the `supy.io` account is `Workers Admin` + `Workers Platform Admin`
+ `Developer Platform Admin`. That is enough to deploy the Worker and attach the
route. It does not include DNS:

```
GET /zones/{supy.io}/workers/routes  → 200  ✅
GET /zones/{supy.io}/dns_records     → 403  Authentication error  ❌
```

So someone with DNS rights on the `supy.io` zone has to create one record. This
is the same arrangement as the `oculus.ops.supy.io/api/*` route already on the
zone — that record was created by someone else too, and the Worker route
attached to it afterwards.

### Message to send

> Could I get one DNS record added on the `supy.io` zone?
>
> **Record:** `AAAA` · name `expansion` · content `100::` · **proxied**
>
> It's the standard placeholder for a Cloudflare Worker route — `100::` is the
> IPv6 discard prefix, so nothing is ever actually routed to it. The proxy
> intercepts the request and hands it to the Worker before it goes anywhere.
>
> It's for the client expansion-request form, which currently lives on a
> personal GitHub Pages URL. No change to `supy.io` or `www` — the Webflow site
> is untouched. I have Workers Admin on the account and will attach the route
> myself once the record exists.
>
> If you'd rather do it in one step: **Workers & Pages → supy-expansion →
> Settings → Domains & Routes → Add Custom Domain → `expansion.supy.io`**
> creates the DNS record *and* the certificate automatically. Tell me if you go
> that way and I'll adjust the config.

If they take the Custom Domain route, swap the `[[routes]]` block in
`worker/wrangler.toml` for the commented-out `custom_domain` version below it.

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
