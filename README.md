# supy-expansion

Self-service expansion request form for existing Supy clients, plus the Cloudflare
Worker that receives it. A client says what they want to add — outlets, cost
centers, features, in any combination — and the request arrives complete, attached
to the right CRM record, instead of as an email thread someone has to unpick.

**Nothing is provisioned automatically.** The Worker records and routes the
request. Scope and timing are still confirmed by a human.

```
index.html  (client fills it in)
     │
     │  POST /webhook        multipart: "payload" JSON + documents[i][kind] files
     ▼
Cloudflare Worker
     │
     ├─→ Cloudinary      documents, stored under supy-expansion/{date}_{account}/
     ├─→ HubSpot         contact upsert → HTML note → associations (company, deals)
     ├─→ Slack           Block Kit summary with document + HubSpot buttons
     └─→ KV              rolling log of the last 200 submissions
```

---

## Layout

| Path | What it is |
|---|---|
| `index.html` | The live form. Points at the deployed Worker. |
| `sample.html` | Same form pre-filled with a fictional client. Stays in preview mode — it never posts. |
| `worker/src/index.js` | The backend. |
| `worker/wrangler.toml` | Bindings and the secret checklist. |

---

## Deploy

```bash
cd worker
npm install

# HubSpot — the same OAuth app supy-onboarding uses
npx wrangler secret put CLIENT_ID
npx wrangler secret put CLIENT_SECRET
npx wrangler secret put REFRESH_TOKEN

# Slack incoming webhook for the channel that should receive these
npx wrangler secret put SLACK_WEBHOOK_URL

# Cloudinary — same account as supy-onboarding, different path prefix
npx wrangler secret put CLOUDINARY_CLOUD_NAME
npx wrangler secret put CLOUDINARY_API_SECRET
npx wrangler secret put CLOUDINARY_API_KEY

# Guards /debug and /logs. Any long random string.
npx wrangler secret put ADMIN_TOKEN

npx wrangler deploy
```

Then set `CONFIG.webhookUrl` in `index.html` to the deployed URL if it differs
from `https://supy-expansion.vaishnavi-5d1.workers.dev/webhook`, and uncomment
`ALLOWED_ORIGINS` and `PUBLIC_BASE_URL` in `wrangler.toml`.

Optional KV, for the submission log and the rate limiter. Without them the
Worker still runs; it just does not log or throttle.

```bash
npx wrangler kv namespace create LOGS
npx wrangler kv namespace create RATELIMIT
# paste the returned ids into wrangler.toml
```

### Local development

```bash
cd worker && npx wrangler dev
```

Then open `index.html?api=http://localhost:8787/webhook`. The override only
accepts localhost hostnames — otherwise a shared link could redirect a
customer's submission and their documents to someone else's server.

Setting `CONFIG.webhookUrl = null` puts the form back into preview mode, where
it validates and renders the payload instead of sending it.

---

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /webhook` | optional shared secret | Main handler. `multipart/form-data` or `application/json`. |
| `GET /download?key=&name=` | none | Streams a stored document. Keys outside `supy-expansion/` are refused. |
| `GET /logs` | `x-admin-token` | Last 200 submissions. |
| `GET /debug` | `x-admin-token` | Which secrets are present. Booleans only. |
| `GET /` | none | Health check. |

`POST /webhook` returns `200` with a `submissionId`, or `400` with a `problems`
array naming each field that failed, `401` on a bad shared secret, `429` when
rate limited.

---

## What the Worker validates

Client-side validation is a courtesy to the person filling the form. Everything
is checked again here, because the endpoint is public:

- Requester identity, a valid email, country, and the account-scope answer,
  including the conditional existing/new account name.
- Every row: name, type, and clone source. Address for outlets, central kitchens
  and warehouses; parent outlet for cost centers.
- Every feature allocation carries a quantity of at least 1.
- **Every `billsUnder` names a declared entity.** A row pointing at an entity
  that no longer exists is rejected rather than silently rebilled to the default.
- Entity names are unique, so rows can be matched to an entity at all.
- Each entity has a registration number, a TRN, a registration document and a
  VAT document — plus a commercial address document when the country is Saudi Arabia.
- Upload limits: 8 files, 10 MB each, 25 MB total, and the extension allowlist.

---

## Failure behaviour

Each downstream leg is independent and its outcome is reported in the `details`
array of the response — `hubspot:updated:note-ok`, `slack:ok`, `documents:2/2`.

A document that fails to upload does **not** fail the submission. The request
still reaches HubSpot and Slack, both carrying a visible warning naming the files
to chase. A request that arrives without its trade license is recoverable; one
that is silently dropped is not.

If HubSpot auth fails the submission still reaches Slack, so nothing is lost
while credentials are fixed.

---

## Notes on the shared secret

`FORM_SHARED_SECRET` is matched against the `X-Supy-Signature` header the form
sends. The form is a static page, so that value ships to every visitor's browser —
**it is not a secret**, and it should never be a value reused anywhere else. It
raises the cost of drive-by bot submissions and does nothing against anyone who
opens devtools. If the endpoint starts attracting real abuse, put Cloudflare
Turnstile in front of it; that is the control that actually holds.

The `RATELIMIT` KV throttle is likewise approximate — KV is eventually
consistent, so a burst of parallel requests can slip past. It stops repeat
submissions, not a determined flood.

---

## Known gaps in the form

Carried over from the HTML as delivered, not yet fixed:

1. **Renaming a billing entity clears every row pointing at it.** Entities are
   referenced by name string rather than id, so `refreshBillsOptions()` blanks
   any `billsUnder` it no longer recognises, with no message to the user. The
   Worker now rejects the resulting payload instead of misfiling it, so this
   fails loudly — but the fix belongs in the form.
2. **The documents banner says "All optional"** while every entity field is
   starred and enforced. `sample.html` has the corrected copy; `index.html` does not.
3. **`maxFiles: 8` is global, not per entity.** In Saudi Arabia three documents
   are required per entity, so a three-entity request cannot be submitted.
4. **Toggling a section off destroys typed rows** without confirmation.
