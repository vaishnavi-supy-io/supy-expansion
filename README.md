# supy-expansion — Self-service expansion requests for Supy clients

> **In one sentence:** A client opens a link, ticks what they want to add (outlets, add-ons, features), says how many and which billing entity each quantity sits under, attaches the required trade documents, and clicks Submit. The request lands — structured, with files — in HubSpot, Slack, email, Google Sheets and Cloudinary so ops can act on it. Nothing is provisioned automatically.

Self-service expansion request form for existing Supy clients, plus the Cloudflare Worker that receives it. A client picks what they want to add from a catalogue — outlet licenses, CK and WH add-ons, extra cost centers, and features — sets a quantity for each, and splits any line across billing entities. The request arrives structured and attached to the right CRM record, instead of as an email thread someone has to unpick.

**Catalogue**

| Products | Features |
|---|---|
| Outlet (Back of House License) | Accounting Integration |
| CK add on | AI Invoice Inbox |
| WH add on | |
| Additional cost center | |

Every line carries a quantity and one or more billing allocations, so "5 AI
Invoice Inbox under entity A and 3 under entity B" arrives as data rather than a
sentence to interpret.

**Nothing is provisioned automatically.** The Worker records and routes the
request. Scope and timing are still confirmed by a human.

| | |
|---|---|
| Live form | https://vaishnavi-supy-io.github.io/supy-expansion/ |
| Filled-in sample | https://vaishnavi-supy-io.github.io/supy-expansion/sample.html |
| Endpoint | `https://supy-expansion.vaishnavi-5d1.workers.dev/webhook` |
| New home | https://expansion.supy.io — **live**, form and endpoint on one origin. Not yet accepting submissions: secrets unset. See [MIGRATION.md](MIGRATION.md) |

The form and the Worker are both **deployed and live**. Drafts, prefill links
and validation work now. Submissions are refused with a clear message until at
least one delivery channel (HubSpot or Slack) has credentials — a request that
reaches nobody is worse than one that is turned away. Run
`worker/setup-secrets.sh` to fill them in.

```
index.html  (client fills it in)
     │
     │  POST /webhook        multipart: "payload" JSON + documents[i][kind] files
     ▼
Cloudflare Worker
     │
     ├─→ Cloudinary      documents, stored under supy-expansion/{date}_{account}/
     ├─→ HubSpot         contact upsert → HTML note → associations (company, deals)
     │                   Companies are matched, never created — see below
     ├─→ Slack           Block Kit summary with document + HubSpot buttons
     ├─→ Gmail           internal notification + client receipt
     ├─→ Sheets          Requests + Items + Entities + Documents - the whole record
     └─→ KV              draft storage, submission log, idempotency record
```

---

## How it works — in plain English

You don't need to know Cloudflare or HubSpot to follow this. There are only three actors: **the form** (a static page on GitHub Pages), **the Worker** (a small backend on Cloudflare that runs only when someone submits), and **the downstream systems** it delivers to.

**Step by step, what happens when a client clicks Submit:**

1. **Client fills the form at `index.html`.** The page runs entirely in the browser. It validates as you type, remembers progress in `localStorage` so a refresh doesn't lose work, and lets you save a 30-day resume link (`POST /draft/save` → KV). Nothing leaves the browser until Submit.

2. **The browser POSTs one request to `POST /webhook`.** The body is `multipart/form-data`: one field called `payload` (JSON) plus one file field per document (`documents[entityIndex][kind]`). The form also sends a `submissionNonce` (a random id for this click) so a double-click or retry doesn't create two requests.

3. **The Worker validates everything again on the server** (`worker/src/index.js:validate:763`). Browser checks can be bypassed, so the Worker re-checks: required fields, valid email/phone/country, catalogue ids are real, quantities are integers ≥1, `totalQuantity == sum(allocations)`, every `billsUnder` names a declared billing entity (or the default "Existing billing entity"), documents per entity / per request caps, file type and size. If anything fails it returns `400` with a `problems[]` array naming each field.

4. **The Worker fans the same submission out to every configured destination, independently.** If one leg fails the others still succeed and the response tells you which did (`details[]` like `hubspot:updated:note-ok`, `slack:ok`, `documents:2/2`). A failed document upload never sinks the whole submission — Slack and HubSpot carry a warning naming the files to chase.

5. **A human confirms scope and timing.** Nothing is provisioned automatically. The CSM reviews the HubSpot note / Slack message / Sheet row and confirms with the client.

### Where does each piece of data live?

| What | Where it is saved | Why there | How long / who can see it |
|---|---|---|---|
| **Drafts + prefill links** | Cloudflare KV `DRAFTS` (`worker/wrangler.toml:19`) — key is a random 32-char token | So a client can save and resume for 30 days without an account. The key *is* the credential — anyone with the link can open it. | `expirationTtl: 30 days`. No documents are stored in drafts — files stay in the browser until Submit. `GET /draft/load?key=` restores. |
| **Documents** | Cloudinary — `supy-expansion/{YYYY-MM-DD}_{account-slug}/` (`worker/src/index.js:1018`) as `raw/upload`, plus a ZIP bundle when >2 files (`worker/src/index.js:1059`) | Cheap, durable file storage the Worker can write to without a Google login. Each file gets a public_id and a `/download?key=&name=` link via `worker/src/index.js:224`. | Permanent until deleted in Cloudinary. Links are unlisted but not authenticated — validity is obscurity. |
| **Submission log** | KV `LOGS` — last 200 lines (`worker/src/index.js:566`) + `GET /logs` (admin token) | Quick audit of "did this submission arrive?" without opening HubSpot. | Rolling buffer. `GET /sheets/retry` + cron `*/15 * * * *` also replays anything Sheets missed. |
| **Rate limit + idempotency** | KV `RATELIMIT` — per-IP counter (5 per 10 min) + `sub:{nonce}` record (`worker/src/index.js:615`) | Stops repeat clicks / double submits. Same `submissionNonce` returns the original response with `duplicate:true`. | Counter = 10 min, nonce = 1 hour. |
| **CRM record** | HubSpot — `contact` upsert by email → `note` with HTML body → associations to `company` + `deals` + `note→deal` (`worker/src/index.js:362`) | So the request lives where the CSM already works. Companies are **matched, never created** — a name mismatch like "Iris Abu Dhabi - Addmind" vs "Addmind Hospitality" used to fork duplicates (`README:222`). On miss it falls back to the onboarding deal's companies; otherwise `company:no-match` and Slack asks a CSM to attach it manually. | Permanent in HubSpot. Every submission also creates a **Sales 360 deal** in pipeline `21726624` (stage `Proposal Sent`), linked to contact + company, for pipeline tracking. |
| **Retailer identity / who can request for which account** | Google Sheet `1raBGqWqxVaUcraY0gjR-CFQT3T2_TheemPfOpihmmFE` (gid `599203487`), served by `google-apps-script/Code.gs:doGet` via `GET /retailers?email=` (`worker/src/index.js:226`) | Single source of truth: "this email may request for these retailers". The directory is refreshed daily elsewhere. | Sheet is read-only from this repo. Worker caches hits 10 min / misses 60s. Rows without a `retailer_id` are skipped and counted as `missingId`. |
| **Spreadsheet mirror** | Google Sheets — `google-apps-script/Code.gs:doPost` writes 4 tabs in `LOG_SPREADSHEET_ID = 1f0pRoEUI9XFWscSQ9uo5tboFGmMy68PBGi5ZFFBQuHQ` (never the directory above — `getLogSpreadsheet:145`) | Ops-friendly view without HubSpot access: `Requests` (one row per submission), `Items` (one row per allocation — a product split across 2 entities = 2 rows), `Entities` (billing entity), `Documents` (per file + stored/error). | Permanent. De-duplicated by `submissionId` (`alreadyLogged:288` checks last 200 rows). Cron retries on failure. |
| **Notifications** | Slack Block Kit message (webhook or `SLACK_BOT_TOKEN` threaded) + Gmail (internal notification + client receipt, gated on `contactId` so the endpoint can't be used to send branded mail to an arbitrary address) | Instant visibility for CS + confirmation for client. Slack shows retailer pick vs typed warning, deal/company links, document + ZIP buttons, country/account manager mentions. | Slack/Gmail retention per those products. |
| **Country / account manager routing** | In-code map `DEFAULT_COUNTRY_MANAGERS` (`worker/src/index.js:110`), overridable via `COUNTRY_MANAGERS_JSON` env | Tags the right owner in Slack by `requester.country`. | Config, not data. |

### Data sources — where the Worker reads from

1. **Retailer access sheet** (above) — the *only* lookup for "which retailer does this email belong to". The chosen row's `retailer_id` travels as `accountScope.existingRetailerId` and is used to find the onboarding deal (`retailer_id EQ <id>` in pipeline `21524094`). No fallback to HubSpot companies or name search — those caused wrong-account routing and were removed.
2. **HubSpot CRM** — contact search by email, company search by name (exact match), deal search by `retailer_id`. Read via `HUBSPOT_API` with OAuth refresh (`CLIENT_ID/SECRET/REFRESH_TOKEN`).
3. **Worker env / secrets** — `wrangler.toml:vars` + `wrangler secret put` values. `/debug` and `/health` report only booleans/hosts, never secret values.

### What is never stored or created

- No company is ever created from a form submission (even though HubSpot has a portal setting that can — turn off *Create and associate companies with contacts* in HubSpot → Settings → Objects → Companies if you want zero auto-creation).
- Drafts never contain document file contents.
- The Worker never writes to the retailer directory sheet.

---

## Layout

| Path | What it is |
|---|---|
| `index.html` | The live form. Points at the deployed Worker. |
| `sample.html` | Same form pre-filled with a fictional client. Stays in preview mode — it never posts. |
| `worker/src/index.js` | The backend. |
| `worker/wrangler.toml` | Bindings and the secret checklist. |
| `google-apps-script/Code.gs` | The Sheets receiver. Deploy as a web app. |
| `test/form.test.mjs` | Form regression tests, driven in jsdom. `npm test`. |
| `test/e2e.sh` | End-to-end tests against a local `wrangler dev`. |

---

## Deploy

```bash
cd worker && npm install
./setup-secrets.sh
```

The script prompts for each secret, pipes it straight into `wrangler secret put`,
and redeploys. Values are never echoed, logged or written to disk, and any one
can be skipped and filled in on a later run. To do it by hand instead:

```bash
npx wrangler secret put CLIENT_ID              # HubSpot, same as supy-onboarding
npx wrangler secret put CLIENT_SECRET
npx wrangler secret put REFRESH_TOKEN
npx wrangler secret put SLACK_WEBHOOK_URL      # channel for new requests
npx wrangler secret put CLOUDINARY_CLOUD_NAME  # document storage
npx wrangler secret put CLOUDINARY_API_KEY
npx wrangler secret put CLOUDINARY_API_SECRET
npx wrangler secret put ADMIN_TOKEN            # new random string, guards /debug
npx wrangler deploy
```

If the deployed Worker URL differs from the one above, update both
`CONFIG.webhookUrl` in `index.html` and `PUBLIC_BASE_URL` in `wrangler.toml`.
`ALLOWED_ORIGINS` is already set to the GitHub Pages origin — add to it if the
form is ever embedded somewhere else, since a missing origin fails CORS.

The KV namespaces (`DRAFTS`, `LOGS`, `RATELIMIT`) are already created and bound
in `wrangler.toml`. Two more secrets are optional:

```bash
# Client receipt + internal notification emails
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN

# Sheets mirror — the Apps Script web app URL
npx wrangler secret put GOOGLE_SCRIPT_URL
```

Leave either out and that leg reports `email:fail` or `sheets:fail` in the
response while the submission still lands everywhere else.

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
| `POST /draft/save` | none | Save a draft, returns a 30-day resume link. |
| `GET /draft/load?key=` | draft key | Restore a draft. |
| `POST /account/link` | `x-admin-token` | Mint a prefill link scoped to one account. |
| `GET /account/prefill?key=` | prefill key | That account's outlets, for the picklists. |
| `GET /download?key=&name=` | none | Streams a stored document. Keys outside `supy-expansion/` are refused. |
| `GET /logs` | `x-admin-token` | Last 200 submissions. |
| `GET /sheets/retry` | `x-admin-token` | Replays anything the Sheets mirror missed. Also runs every 15 minutes. |
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
- Every line's `id` is a real catalogue item, and appears only once.
- Every allocation quantity is a whole number of 1 or more.
- **A line's `totalQuantity` equals the sum of its allocations**, so the headline
  number and the split cannot disagree about what was ordered.
- **Every `billsUnder` names a declared entity.** A line pointing at an entity
  that no longer exists is rejected rather than silently rebilled to the default.
- Entity names are unique, so rows can be matched to an entity at all.
- Each entity has a registration number, a TRN, a registration document and a
  VAT document — plus a commercial address document when the country is Saudi Arabia.
- Upload limits: 6 documents per billing entity, 30 per request, 10 MB each,
  25 MB total, and the extension allowlist.

---

## Retailer identity comes from the access sheet

One principle governs the whole chain: **the retailer id in the access sheet is
the identity, and nothing else is.**

| | |
|---|---|
| Sheet | `1raBGqWqxVaUcraY0gjR-CFQT3T2_TheemPfOpihmmFE`, gid `599203487` |
| Served by | `google-apps-script/Code.gs` → `doGet(?email=)` |
| Read-only | The directory is owned elsewhere and refreshed daily. Requests and Items rows are written to a separate spreadsheet, `1f0pRoEUI9XFWscSQ9uo5tboFGmMy68PBGi5ZFFBQuHQ`, set as `LOG_SPREADSHEET_ID`. `getLogSpreadsheet()` refuses to write to the directory. |
| Read by | `GET /retailers?email=` → `{retailers:[{name, retailerId}], source}` |

The sheet is keyed by email and answers one question: which retailers may this
person raise a request for. Rows without a retailer id are skipped — an id-less
row cannot route anything, so offering it would produce a choice that quietly
resolves to nothing. The chosen row's id travels in the payload as
`accountScope.existingRetailerId`, and the Worker finds the onboarding deal with
`retailer_id EQ <that id>` in pipeline `21524094`. Owner, companies and the new
Sales 360 deal all follow from the deal that lookup returns.

Nothing else infers identity. The Worker used to fall back to reading the
contact's companies out of HubSpot, and to searching `retailer_id EQ "<account
name>"` — a display name matched against an id field, which never hit. Both are
gone: two sources of truth for "which account is this" is worse than one source
and an honest gap.

When the sheet has no row for an email the form still accepts a typed account
name, because blocking a customer is worse than routing one by hand. That
request carries no retailer id, creates no Sales 360 deal, and Slack says so:
*"typed, not picked — this email is not on the retailer access sheet."* The fix
is to add the row.

`source` in the response names what happened: `sheet`, `sheet-no-match`,
`sheet-unavailable`. Repeat lookups are cached in KV for 10 minutes on a hit and
60 seconds on a miss, so a corrected sheet shows up quickly.

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

**The Worker never creates a company.** It matches the customer's retailer name
against existing HubSpot companies and associates the note and contact to what
it finds. It used to create one on a miss, which was wrong: a Supy retailer name
routinely differs from the name on the HubSpot company — "Iris Abu Dhabi -
Addmind" against "Addmind Hospitality" — so every such account got a duplicate
company forked off it, and the request landed on the duplicate rather than the
real record. On a miss now, the note falls back to the companies named by the
retailer's onboarding deal; failing that the request reports `company:no-match`
and Slack asks a CSM to attach it. Contacts, notes and deals are still created.

One more source sits outside this code: HubSpot's own **"Create and associate
companies with contacts"** portal setting mints a company from a new contact's
email domain, independently of what the Worker does. Turn it off in Settings →
Objects → Companies if no automatic company creation is wanted at all.

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

## Form defects, fixed

All four defects the form originally shipped with are fixed and covered by
`test/form.test.mjs`:

1. **Billing entities are referenced by id, not name.** A rename used to blank
   every row pointing at that entity, silently. This was the important one:
   split billing is the form's whole reason for existing.
2. The documents banner no longer claims "All optional" while validation
   enforces every field.
3. The upload cap is per entity, so a Saudi client with three entities and nine
   required documents can actually submit.
4. Turning a section off asks before discarding typed rows.

---

## Tests

```bash
npm install && npm test          # form regressions in jsdom, no server needed

cd worker && cp .dev.vars.example .dev.vars
npx wrangler dev --port 8787 --local &
bash ../test/e2e.sh              # 21 checks against the running Worker
```

`npm test` drives the real `index.html` in jsdom and asserts on the DOM rather
than on internals, so it checks what the user actually sees. It covers the four
defects the form shipped with — most importantly that renaming a billing entity
no longer silently clears the rows pointing at it.

`e2e.sh` covers auth on every guarded route, validation rejections, draft
round-trips including traversal and forged keys, prefill minting and dedupe,
idempotent replay, and the per-entity upload cap.

Raise `RATE_LIMIT` in `.dev.vars` before running `e2e.sh` — the default of 5
submissions per IP per 10 minutes will otherwise fire partway through the run.

---

## Drafts, prefill links and what they expose

A draft link and a prefill link are both **bearer credentials**: the key is the
only thing guarding what it opens. A draft holds contact details, addresses and
TRNs. Treat both as sensitive, and prefer sending them directly to the client
rather than into a shared channel.

Drafts deliberately exclude uploaded documents. File contents never leave the
browser until submit, and storing a customer's trade license against a key that
is itself the only credential is a worse trade than asking for the file again.
