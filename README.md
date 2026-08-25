# supy-expansion

Self-service expansion request form for existing Supy clients, plus the Cloudflare
Worker that receives it. A client picks what they want to add from a catalogue —
outlet licences, CK and WH add-ons, extra cost centers, and features — sets a
quantity for each, and splits any line across billing entities. The request
arrives structured and attached to the right CRM record, instead of as an email
thread someone has to unpick.

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
     ├─→ Sheets          Requests row + one Items row per outlet/feature line
     └─→ KV              draft storage, submission log, idempotency record
```

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
