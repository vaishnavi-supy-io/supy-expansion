/**
 * Supy Expansion Request — Cloudflare Worker
 *
 * Receives one submission from expansion-request-form.html and fans it out to
 * Cloudinary (documents), HubSpot (contact + note + associations) and Slack.
 * Nothing is provisioned automatically. The point is that the request arrives
 * complete, structured, and attached to the right CRM record.
 *
 * Env vars (Worker Secrets — never in wrangler.toml):
 *   CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN      HubSpot OAuth (private app refresh flow)
 *   SLACK_WEBHOOK_URL                            Slack incoming webhook
 *   CLOUDINARY_CLOUD_NAME/_API_KEY/_API_SECRET   Document storage
 *   ADMIN_TOKEN                                  Guards /debug
 *   FORM_SHARED_SECRET                           Optional. Matched against X-Supy-Signature.
 *                                                A speed bump against drive-by bots only —
 *                                                the form ships it to the browser, so it is
 *                                                not a secret. Use Turnstile for real gating.
 *   ALLOWED_ORIGINS                              Optional comma-separated CORS allowlist.
 *                                                Unset means "*".
 *   PUBLIC_BASE_URL                              Optional. This Worker's own origin, used to
 *                                                build /download links. Falls back to the
 *                                                request URL's origin.
 *
 *   GMAIL_CLIENT_ID/_SECRET/_REFRESH_TOKEN       Gmail OAuth, for the receipt emails
 *   GOOGLE_SCRIPT_URL                            Apps Script web app, for the Sheets mirror
 *   FORM_URL                                     Where the form is hosted, used to build
 *                                                draft and prefill links.
 *
 * KV bindings (the Worker degrades rather than failing when one is missing):
 *   DRAFTS       saved drafts and account prefill links
 *   LOGS         recent submissions, for GET /logs
 *   RATELIMIT    approximate per-IP throttle, and the idempotency record
 *
 * Routes:
 *   POST /webhook             main handler (multipart/form-data or application/json)
 *   POST /draft/save          save a draft, returns a resume link
 *   GET  /draft/load?key=     restore a draft
 *   POST /account/link        mint a prefill link for one account (x-admin-token)
 *   GET  /account/prefill?key= that account's outlets, for the picklists
 *   GET  /download?key=&name= document download proxy
 *   GET  /logs                recent submission log (x-admin-token)
 *   GET  /debug               which secrets are present (x-admin-token)
 *   GET  /                    health check
 */

const HUBSPOT_PORTAL_ID = "9423176";

// HubSpot's API origin. Overridable only so the CRM calls can be pointed at a
// local stub in tests; unset in every real environment. It carries the token,
// so nothing but a trusted env var may ever set it.
let HUBSPOT_API = `${HUBSPOT_API}`;

// Mirrors CONFIG in the form. Enforced again here because client-side limits
// are a courtesy to the user, not a control.
const LIMITS = {
  // Per entity, not per request: in Saudi Arabia three documents are required
  // for each entity, so a flat cap of 8 made a three-entity request impossible.
  maxFilesPerEntity: 6,
  maxFiles:     30,
  maxFileMB:    10,
  maxTotalMB:   25,
  maxJsonBytes: 512 * 1024,
  allowedExt:   ["pdf", "jpg", "jpeg", "png", "doc", "docx", "xls", "xlsx"],
};

const DEFAULT_ENTITY = "Our existing account entity";

// HubSpot's deal "country" property is an enumeration, and nine of the names in
// the form's list are not options in it. Writing an unlisted value silently
// drops the field, so the form's name is translated before it is sent.
// Israel is absent from HubSpot's list entirely — not a spelling difference —
// so it maps to null and is left unset rather than guessed at.
const HS_COUNTRY = {
  "Czechia":         "Czech Republic",
  "Eswatini":        "Swaziland",
  "Ivory Coast":     "Cote d'Ivoire",
  "Macao":           "Macau",
  "Myanmar":         "Myanmar (Burma)",
  "North Macedonia": "Macedonia (FYROM)",
  "Timor-Leste":     "East Timor",
  "United States":   "United States of America",
  "Israel":          null,
};
const hsCountry = name => {
  const n = str(name);
  if (!n) return null;
  return Object.prototype.hasOwnProperty.call(HS_COUNTRY, n) ? HS_COUNTRY[n] : n;
};

// Pipelines, stages and properties, read from the portal rather than guessed.
const HS = {
  onboardingPipeline: "21524094",
  salesPipeline:      "21726624",   // Sales Pipeline Supy 360
  proposalSentStage:  "51997768",
  handoffStage:       "1091553684",
  accountOwnerProp:   "account_owner",   // labelled "Account Manager"
  retailerIdProp:     "retailer_id",
};

// Country → Slack mention. Override via env COUNTRY_MANAGERS_JSON = JSON string
// e.g. {"United Arab Emirates":{"countryManager":"Jane Doe","slack":"<@U123>","accountManager":"John"},"Saudi Arabia":{...}}
// If not set, a minimal demo map is used so the feature is visible in logs.
const DEFAULT_COUNTRY_MANAGERS = {
  "United Arab Emirates": { countryManager: "UAE Country Manager", slack: "", accountManager: "" },
  "Saudi Arabia":         { countryManager: "KSA Country Manager", slack: "", accountManager: "" },
  "Qatar":                { countryManager: "Qatar Country Manager", slack: "", accountManager: "" },
  "Kuwait":               { countryManager: "Kuwait Country Manager", slack: "", accountManager: "" },
  "Bahrain":              { countryManager: "Bahrain Country Manager", slack: "", accountManager: "" },
  "Oman":                 { countryManager: "Oman Country Manager", slack: "", accountManager: "" },
  "Egypt":                { countryManager: "Egypt Country Manager", slack: "", accountManager: "" },
};
function countryManagers(env) {
  if (env.COUNTRY_MANAGERS_JSON) {
    try { const j = JSON.parse(env.COUNTRY_MANAGERS_JSON); if (j && typeof j === "object") return j; } catch {}
  }
  return DEFAULT_COUNTRY_MANAGERS;
}
function managersForCountry(country, env) {
  const map = countryManagers(env);
  return map[country] || null;
}

// The catalogue the form offers. Ids are validated against this, so a
// hand-rolled payload cannot invent a product that is not sold.
const CATALOGUE = {
  outlet:       "Outlet (Back of House License)",
  ck_addon:     "CK add on",
  wh_addon:     "WH add on",
  cost_center:  "Additional cost center",
  accounting:   "Accounting Integration",
  invoiceinbox: "AI Invoice Inbox",
};
const PRODUCT_IDS = ["outlet", "ck_addon", "wh_addon", "cost_center"];
const DOC_KINDS      = ["registration", "vat", "address"];
const DOC_LABELS     = { registration: "Registration", vat: "VAT / TRN", address: "Commercial address" };
const KSA            = "Saudi Arabia";

// Rate limit: submissions per IP per window. Overridable per environment via
// RATE_LIMIT, which also lets a test run raise it without editing source.
const RATE_LIMIT_DEFAULT = 5;
const RATE_WINDOW = 10 * 60; // seconds

// ─────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────
function corsHeaders(request, env) {
  const allowlist = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const origin    = request.headers.get("Origin") || "";
  let allow = "*";

  if (allowlist.length) {
    allow = allowlist.includes(origin) ? origin : allowlist[0];
  }

  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Supy-Signature, x-admin-token",
    "Access-Control-Max-Age":       "86400",
    ...(allowlist.length ? { Vary: "Origin" } : {}),
  };
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, env) },
  });
}

// ─────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────
export default {
  // Anything the sheet missed while Apps Script was down gets replayed here.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const r = await drainSheetsQueue(env, 100);
      if (r.sent || r.pending) console.log("sheets queue drained", JSON.stringify(r));
    })());
  },

  async fetch(request, env, ctx) {
    if (env.HUBSPOT_API_BASE) HUBSPOT_API = String(env.HUBSPOT_API_BASE).replace(/\/$/, "");
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (url.pathname === "/webhook" && request.method === "POST") {
        return await handleWebhook(request, env, ctx);
      }
      if (url.pathname === "/account/link" && request.method === "POST") {
        return await handleAccountLink(request, env);
      }
      if (url.pathname === "/account/prefill" && request.method === "GET") {
        return await handleAccountPrefill(request, env);
      }
      if (url.pathname === "/draft/save" && request.method === "POST") {
        return await handleDraftSave(request, env);
      }
      if (url.pathname === "/draft/load" && request.method === "GET") {
        return await handleDraftLoad(request, env);
      }
      if (url.pathname === "/download" && request.method === "GET") {
        return await handleDownload(request, env);
      }
      if (url.pathname === "/retailers" && request.method === "GET") {
        return await handleRetailers(request, env, ctx);
      }
      if (url.pathname === "/geo" && request.method === "GET") {
        return handleGeo(request, env);
      }
      if (url.pathname === "/sheets/retry") {
        if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
          return json({ error: "Unauthorized" }, 401, request, env);
        }
        return json(await drainSheetsQueue(env), 200, request, env);
      }
      if (url.pathname === "/logs" && request.method === "GET") {
        return await handleLogs(request, env);
      }
      if (url.pathname === "/debug" && request.method === "GET") {
        return handleDebug(request, env);
      }
      if (url.pathname === "/") {
        return new Response("Supy Expansion Request: Online", {
          status: 200, headers: corsHeaders(request, env),
        });
      }
      return json({ error: "Not found" }, 404, request, env);
    } catch (err) {
      // Never leak internals to the browser; the detail goes to Workers logs.
      console.error("Unhandled error", err && err.stack ? err.stack : String(err));
      return json({ status: "error", message: "Internal error" }, 500, request, env);
    }
  },
};

// ─────────────────────────────────────────────────────────────
// Webhook
// ─────────────────────────────────────────────────────────────
async function handleWebhook(request, env, ctx) {
  // 1. Shared-secret check, when configured.
  if (env.FORM_SHARED_SECRET) {
    const sent = request.headers.get("X-Supy-Signature") || "";
    if (!timingSafeEqual(sent, env.FORM_SHARED_SECRET)) {
      return json({ status: "error", message: "Unauthorized" }, 401, request, env);
    }
  }

  // 2. Refuse rather than swallow. A submission that reaches nobody is worse
  //    than one that is turned away: the client sees "Request submitted" and
  //    walks away while the request evaporates. That silent loss is the exact
  //    failure this whole form exists to prevent, so if no delivery channel is
  //    configured at all, say so instead of accepting it.
  const channels = deliveryChannels(env);
  if (!Object.values(channels).some(Boolean)) {
    return json({
      status: "error",
      message: "This form is not accepting submissions yet. Please contact your Supy "
             + "customer success manager directly so your request is not lost.",
    }, 503, request, env);
  }

  // 3. Approximate rate limit. KV is eventually consistent, so a burst of
  //    parallel requests can slip past; it stops repeat submissions, not a
  //    determined flood.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await isRateLimited(env, ip)) {
    return json({ status: "error", message: "Too many requests. Try again shortly." }, 429, request, env);
  }

  // 4. Parse.
  let parsed;
  try {
    parsed = await readSubmission(request);
  } catch (err) {
    return json({ status: "error", message: err.message }, 400, request, env);
  }
  const { payload, files } = parsed;

  // 5. Validate — the same rules the form enforces, re-checked here.
  const problems = validate(payload, files);
  if (problems.length) {
    return json({ status: "error", message: "Validation failed", problems }, 400, request, env);
  }

  // 5b. Idempotency. A double-click, a flaky connection retried by the browser,
  //     or an impatient second Submit must not become two CRM notes and two
  //     Slack messages. The client mints a nonce per attempt; a replay of one
  //     we have already finished returns the original outcome untouched.
  const nonce = str(payload.submissionNonce);
  const replay = await recallSubmission(env, nonce);
  if (replay) {
    return json({ ...replay, duplicate: true }, 200, request, env);
  }

  const submissionId = crypto.randomUUID();
  const receivedAt   = new Date().toISOString();
  const account      = payload.requester.account;
  const results      = [];

  // 6. Documents → Cloudinary. Failures are recorded but do not sink the
  //    submission: a request that reaches the team without its trade license
  //    is far better than one that is silently lost.
  let documents = [];
  let bundle = null;
  if (files.length) {
    const uploaded = await uploadDocuments(env, files, account, request);
    documents = uploaded.documents;
    bundle = uploaded.bundle;
    results.push(`documents:${uploaded.ok}/${files.length}`);
    if (bundle) results.push(`bundle:zip:${bundle.count}`);
    else if (files.length > 2) results.push(uploaded.storageConfigured ? "bundle:zip-fail" : "bundle:skipped:no-storage");
  }
  attachDocumentUrls(payload, documents);

  // 7. HubSpot.
  let contactId = null;
  let noteId = null;
  let companyMatched = null;   // null = not attempted, false = nothing matched
  let matchedCompanyId = null;
  const token = await getHubspotToken(env);
  if (token) {
    const { id, action } = await upsertContact(token, payload);
    contactId = id;
    if (contactId) {
      noteId = await createNote(token, payload, documents, receivedAt, submissionId, bundle);
      if (noteId) {
        const link = await linkEverything(token, noteId, contactId, crmCompanyName(payload));
        companyMatched = Boolean(link && link.matched);
        matchedCompanyId = (link && link.companyId) || null;
        if (!companyMatched) results.push("company:no-match");
        results.push(`hubspot:${action}:note-ok`);
      } else {
        results.push(`hubspot:${action}:note-fail`);
      }
    } else {
      results.push("hubspot:contact-fail");
    }
  } else {
    results.push("hubspot:auth-fail");
  }

  // 7b. Every submission gets a deal, associated to the contact, the company
  //     and the note. It used to be created only when a verified retailer id
  //     resolved an onboarding deal, so a new account — or a customer not yet
  //     on the access sheet — produced a note and nothing to work from. The
  //     onboarding deal still enriches it (owner, companies, retailer id) when
  //     it is found; its absence no longer means no deal.
  let salesDealId = null;
  let onboardingLinked = null;
  let onboardingDeal = null;
  let onboardingCompanyIds = [];
  if (token && contactId) {
    const scopeTarget  = str(payload.accountScope.target);
    const retailerId   = str(payload.accountScope.existingRetailerId) || "";
    const retailerName = str(payload.accountScope.existingAccountName) || "";

    // The retailer id from the access sheet is the only key used for the
    // onboarding lookup. Matching a display name against an id field never hit.
    if (scopeTarget === "Existing account" && retailerId) {
      try {
        onboardingDeal = await findOnboardingDealByRetailerId(token, retailerId);
        if (onboardingDeal) {
          onboardingCompanyIds = await getDealCompanyIds(token, onboardingDeal.id);
          if (!onboardingCompanyIds.length) {
            try {
              const compAssoc = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/${contactId}/associations/companies`, { headers: { Authorization: `Bearer ${token}` } });
              if (compAssoc.ok) {
                const j = await compAssoc.json().catch(()=> ({}));
                onboardingCompanyIds = (j.results || []).map(x => String(x.id));
              }
            } catch {}
          }
        } else {
          results.push("onboarding:no-match");
          console.error("No onboarding deal found for retailer id", retailerId);
        }
      } catch (e) {
        console.error("onboarding lookup failed", String(e));
        results.push("onboarding:error");
      }
    } else if (scopeTarget === "Existing account") {
      results.push("onboarding:skipped:no-retailer-id");
      console.error("No sheet-verified retailer id for", retailerName || "(no account name)");
    }

    // Owner comes from the onboarding deal when there is one: its account
    // manager once it has reached handoff, its own owner before that.
    const odProps        = (onboardingDeal && onboardingDeal.properties) || {};
    const accountOwnerId = str(odProps[HS.accountOwnerProp] || odProps.account_owner || "");
    const dealOwnerId    = str(odProps.hubspot_owner_id || "");
    const salesOwnerId   = (str(odProps.dealstage) === HS.handoffStage && accountOwnerId)
      ? accountOwnerId : (dealOwnerId || accountOwnerId || "");

    // The onboarding deal's companies when known, otherwise whatever the note
    // matched. Never a company we invented.
    const companyIds = onboardingCompanyIds.length
      ? onboardingCompanyIds
      : (matchedCompanyId ? [matchedCompanyId] : []);

    const countryForDeal = hsCountry(payload.requester.country) || str(payload.requester.country) || "";
    const dealName = `${str(payload.requester.account) || "Account"} — Expansion: ${buildSubject(payload).slice(0, 80)}`;

    try {
      const created = await createSalesDeal(token, {
        dealname: dealName,
        pipeline: HS.salesPipeline,
        dealstage: HS.proposalSentStage,
        hubspot_owner_id: salesOwnerId || undefined,
        amount: 0,
        deal_currency_code: "USD",
        // A separate new account is new business; anything else is an existing
        // customer buying more.
        dealtype: scopeTarget === "New account" ? "newbusiness" : "existingbusiness",
        country: countryForDeal || undefined,
        retailerId: retailerId || undefined,
        onboardingDealId: onboardingDeal ? String(onboardingDeal.id) : undefined,
      }, companyIds, contactId);

      salesDealId = created.id;
      onboardingLinked = created.onboardingLinked;

      if (salesDealId) {
        results.push(`salesDeal:created:${salesDealId}`);
        results.push(companyIds.length ? `salesDeal:linked:${companyIds.length}companies` : "salesDeal:no-company");
        if (onboardingDeal) {
          results.push(created.onboardingLinked
            ? `salesDeal:linked-onboarding:${onboardingDeal.id}`
            : "salesDeal:onboarding-link-fail");
        }
        // The note is written before the deal exists, so it has to be attached
        // here — otherwise the deal a CSM opens has no record of what was asked
        // for.
        if (noteId) {
          try {
            const r = await fetch(`${HUBSPOT_API}/crm/v3/associations/Notes/Deals/batch/create`, {
              method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ inputs: [{ from: { id: noteId }, to: { id: salesDealId }, type: "note_to_deal" }] }),
            });
            results.push(r.ok ? "note:linked:deal" : "note:deal-link-fail");
            if (!r.ok) console.error("note_to_deal failed", r.status, await r.text().catch(()=> ""));
          } catch (e) { console.error("note_to_deal threw", String(e)); results.push("note:deal-link-fail"); }
        }
      } else {
        results.push("salesDeal:fail");
      }
    } catch (e) {
      console.error("sales deal flow failed", String(e));
      results.push("salesDeal:error");
    }

    // Contact → the same companies the deal is on.
    if (companyIds.length) {
      try {
        for (const cid of companyIds) {
          const assocRes = await fetch(`${HUBSPOT_API}/crm/v3/associations/Contacts/Companies/batch/create`, {
            method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ inputs: [{ from: { id: contactId }, to: { id: cid }, type: "contact_to_company" }] }),
          });
          if (!assocRes.ok) console.error("contact_to_company assoc failed", cid, assocRes.status, await assocRes.text().catch(()=> ""));
        }
        results.push(`contact:linked:${companyIds.length}companies`);
      } catch (e) { console.error("contact link failed", String(e)); }
    }

    // The note reaches a company by name match; when that missed but the
    // onboarding deal named real companies, put it on those instead.
    if (noteId && !companyMatched && onboardingCompanyIds.length) {
      try {
        for (const cid of onboardingCompanyIds) {
          await fetch(`${HUBSPOT_API}/crm/v3/associations/Notes/Companies/batch/create`, {
            method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ inputs: [{ from: { id: noteId }, to: { id: cid }, type: "note_to_company" }] }),
          });
        }
        companyMatched = true;
        results.push(`note:linked:${onboardingCompanyIds.length}companies`);
      } catch (e) { console.error("note company link failed", String(e)); }
    }
  }

  // 8. Slack. Includes country manager + account manager, and onboarding/sales context.
  const slackCtx = { onboardingDeal, salesDealId, onboardingCompanyIds, companyMatched, onboardingLinked, bundle };
  const slackOk = await sendSlack(env, payload, documents, contactId, submissionId, slackCtx);
  results.push(slackOk ? "slack:ok" : "slack:fail");

  // 9. Email. The client receipt is gated on HubSpot having recognised the
  //    contact, so this endpoint cannot be used to send Supy-branded mail to
  //    an arbitrary address.
  const internalOk = await sendInternalEmail(env, payload, documents, receivedAt, submissionId, bundle);
  results.push(internalOk ? "email:ok" : "email:fail");
  if (contactId) {
    const receiptOk = await sendClientReceipt(env, payload, documents, receivedAt, submissionId, bundle);
    results.push(receiptOk ? "receipt:ok" : "receipt:fail");
  } else {
    results.push("receipt:skipped");
  }

  // 10. Google Sheets mirror.
  const sheetsOk = await logToSheets(env, payload, documents, receivedAt, submissionId, bundle, {
    contactId, noteId, salesDealId,
    onboardingDealId: onboardingDeal ? String(onboardingDeal.id) : "",
    companyIds: onboardingCompanyIds,
    results,
  });
  results.push(sheetsOk ? "sheets:ok" : "sheets:fail");

  // 11. Log, best-effort and off the response path.
  const logLine = `${receivedAt} | ${submissionId} | ${payload.requester.email} | ${account} | ${results.join(",")}`;
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(appendLog(env, logLine));
  } else {
    await appendLog(env, logLine);
  }

  const response = {
    status: "ok",
    submissionId,
    receivedAt,
    // Recomputed rather than echoed: the client's summary string is built before
    // its last edit lands, so it can disagree with the rows actually sent.
    summary: buildSubject(payload),
    counts: {
      outlets:      unitsOf(payload, "outlet"),
      centralKitchens: unitsOf(payload, "ck_addon"),
      warehouses:   unitsOf(payload, "wh_addon"),
      costCenters:  unitsOf(payload, "cost_center"),
      features:     payload.features.length,
      documents:   documents.length,
    },
    details: results,
  };

  await rememberSubmission(env, nonce, response);
  return json(response, 200, request, env);
}

// Which downstream legs are actually configured. Used to refuse a submission
// that could not reach anyone, and reported by /debug.
function deliveryChannels(env) {
  const hasHubspot = Boolean((env.HUBSPOT_ACCESS_TOKEN || env.HUBSPOT_PAT || env.PAT) || (env.CLIENT_ID && env.CLIENT_SECRET && env.REFRESH_TOKEN));
  return {
    hubspot: hasHubspot,
    slack:   Boolean(env.SLACK_WEBHOOK_URL),
    email:   Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN),
    sheets:  Boolean(env.GOOGLE_SCRIPT_URL),
  };
}

// ─────────────────────────────────────────────────────────────
// Idempotency
//
// Keyed on a nonce the client generates once per attempt, so a retry of the
// same attempt is recognised while a genuinely new request is not. Stored for
// long enough to cover a retry, not long enough to block someone legitimately
// submitting twice in a day.
// ─────────────────────────────────────────────────────────────
const NONCE_TTL = 60 * 60;   // seconds

const nonceOk = n => typeof n === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(n);

async function recallSubmission(env, nonce) {
  if (!env.RATELIMIT || !nonceOk(nonce)) return null;
  try {
    const seen = await env.RATELIMIT.get(`sub:${nonce}`);
    return seen ? JSON.parse(seen) : null;
  } catch (err) {
    // A KV read failure must not block a real submission; the worst case is a
    // duplicate, which is recoverable, whereas a rejection loses the request.
    console.error("idempotency read failed", String(err));
    return null;
  }
}

async function rememberSubmission(env, nonce, response) {
  if (!env.RATELIMIT || !nonceOk(nonce)) return;
  try {
    await env.RATELIMIT.put(`sub:${nonce}`, JSON.stringify(response), { expirationTtl: NONCE_TTL });
  } catch (err) {
    console.error("idempotency write failed", String(err));
  }
}

// ─────────────────────────────────────────────────────────────
// Parsing
//
// The form sends multipart when documents are attached: a "payload" field
// holding the JSON, plus one field per file named documents[i][kind], where i
// indexes the entity and kind is the document category. With no documents it
// sends plain JSON. Base64 mode embeds files in payload.documents[].
// ─────────────────────────────────────────────────────────────
async function readSubmission(request) {
  const contentType = request.headers.get("content-type") || "";
  let payload;
  const files = [];

  if (contentType.includes("multipart/form-data")) {
    let form;
    try {
      form = await request.formData();
    } catch {
      throw new Error("Malformed multipart body");
    }

    const raw = form.get("payload");
    if (typeof raw !== "string") throw new Error('Missing "payload" field');
    payload = parseJson(raw);

    const fieldRe = /^documents\[(\d+)\]\[([a-z]+)\]$/;
    for (const [name, value] of form.entries()) {
      if (name === "payload") continue;
      if (typeof value === "string") continue;
      const m = fieldRe.exec(name);
      if (!m) continue;                       // ignore fields we do not model
      const category = m[2];
      if (!DOC_KINDS.includes(category)) continue;
      files.push({ entityIndex: Number(m[1]), category, file: value, name: value.name, size: value.size });
    }
  } else if (contentType.includes("application/json")) {
    const raw = await request.text();
    if (raw.length > LIMITS.maxJsonBytes * 4) throw new Error("Body too large");
    payload = parseJson(raw);

    // base64 mode: lift the embedded files out into the same shape.
    if (Array.isArray(payload.documents)) {
      payload.documents.forEach(d => {
        if (!d || !d.contentBase64) return;
        const bytes = base64ToBytes(d.contentBase64);
        if (!bytes) return;
        const idx = indexOfEntity(payload, d.billingEntity);
        files.push({
          entityIndex: idx,
          category:    DOC_KINDS.includes(d.category) ? d.category : "registration",
          file:        new File([bytes], d.filename || "document", { type: d.type || "application/octet-stream" }),
          name:        d.filename || "document",
          size:        bytes.length,
        });
        delete d.contentBase64;   // keep it out of the CRM note and the logs
      });
    }
  } else {
    throw new Error("Unsupported Content-Type. Send multipart/form-data or application/json.");
  }

  normalise(payload);
  return { payload, files };
}

function parseJson(raw) {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new Error("Payload is not a JSON object");
  }
}

function base64ToBytes(b64) {
  try {
    const bin = atob(String(b64));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

function indexOfEntity(payload, name) {
  const list = (payload.billing && payload.billing.entities) || [];
  const i = list.findIndex(e => e && str(e.name) === str(name));
  return i < 0 ? 0 : i;
}

// Fill in the shape the rest of the Worker assumes, so a hand-rolled or
// partial payload cannot produce a TypeError three functions deep.
function normalise(p) {
  p.requester    = p.requester    || {};
  p.accountScope = p.accountScope || {};
  p.billing      = p.billing      || {};
  p.products = Array.isArray(p.products) ? p.products : [];
  p.features = Array.isArray(p.features) ? p.features : [];
  // Every line, product or feature, has the same shape: id, name, quantity,
  // and the entities that quantity is split across.
  p.lines = [...p.products, ...p.features];
  p.billing.entities = Array.isArray(p.billing.entities) ? p.billing.entities : [];
  p.documents = Array.isArray(p.documents) ? p.documents : [];
  // Retailer ID is optional in payload but normalized for downstream
  if (p.accountScope.existingRetailerId !== undefined) p.accountScope.existingRetailerId = str(p.accountScope.existingRetailerId) || null;
  else p.accountScope.existingRetailerId = null;
}

// Units ordered of one catalogue id, across every entity it is split over.
const unitsOf = (p, id) => {
  const line = p.lines.find(l => str(l.id) === id);
  if (!line) return 0;
  return (Array.isArray(line.allocations) ? line.allocations : [])
    .reduce((n, a) => n + (Number(a.quantity) || 0), 0);
};

const str  = v => (v === null || v === undefined ? "" : String(v)).trim();
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str(v));

// ─────────────────────────────────────────────────────────────
// Validation — mirrors validate() in the form
// ─────────────────────────────────────────────────────────────
function validate(p, files) {
  const problems = [];
  const r = p.requester;

  if (!str(r.account))  problems.push("requester.account is required");
  if (!str(r.name))     problems.push("requester.name is required");
  if (!str(r.phone))    problems.push("requester.phone is required");
  if (!str(r.country))  problems.push("requester.country is required");
  if (!isEmail(r.email)) problems.push("requester.email must be a valid email address");

  const target = str(p.accountScope.target);
  if (!target) {
    problems.push("accountScope.target is required");
  } else if (!["Existing account", "New account", "Not sure"].includes(target)) {
    problems.push(`accountScope.target "${target}" is not a recognised value`);
  }
  if (target === "New account" && !str(p.accountScope.newAccountName)) {
    problems.push("accountScope.newAccountName is required for a new account");
  }
  if (target === "Existing account" && !str(p.accountScope.existingAccountName)) {
    problems.push("accountScope.existingAccountName is required for an existing account");
  }

  if (!p.lines.length) {
    problems.push("the request is empty: nothing was selected");
  }

  // Declared billing entities. Lines may only point at one of these, or at the
  // account's existing entity.
  const entities    = p.billing.entities;
  const entityNames = entities.map(e => str(e.name)).filter(Boolean);
  const knownEntity = new Set([...entityNames, DEFAULT_ENTITY]);
  const billsRequired = entityNames.length > 0;

  if (new Set(entityNames).size !== entityNames.length) {
    problems.push("billing.entities contains duplicate names, so lines cannot be matched to an entity");
  }

  const seenIds = new Set();
  p.lines.forEach((line, i) => {
    const at = `lines[${i}]`;
    const id = str(line.id);

    if (!id) problems.push(`${at}.id is required`);
    else if (!CATALOGUE[id]) problems.push(`${at}.id "${id}" is not a product we offer`);
    else if (seenIds.has(id)) problems.push(`${at}.id "${id}" appears more than once`);
    seenIds.add(id);

    const allocs = Array.isArray(line.allocations) ? line.allocations : [];
    if (!allocs.length) problems.push(`${at}.allocations must have at least one line`);

    let sum = 0;
    allocs.forEach((a, j) => {
      const qty = Number(a && a.quantity);
      if (!Number.isFinite(qty) || qty < 1 || !Number.isInteger(qty)) {
        problems.push(`${at}.allocations[${j}].quantity must be a whole number of 1 or more`);
      } else {
        sum += qty;
      }
      if (billsRequired && !knownEntity.has(str(a && a.billsUnder))) {
        problems.push(`${at}.allocations[${j}].billsUnder is not one of the declared billing entities`);
      }
    });

    // The split must add up to the headline number, or the two disagree about
    // what was actually ordered.
    const total = Number(line.totalQuantity);
    if (Number.isFinite(total) && sum && total !== sum) {
      problems.push(`${at}.totalQuantity is ${total} but the allocations add up to ${sum}`);
    }
  });

  const same = str(p.billing.sameLegalEntity);
  if (!same) problems.push("billing.sameLegalEntity is required");
  if (same === "Different legal entity" && !entities.length) {
    problems.push("billing.entities is required when a different legal entity is involved");
  }

  const ksa = str(p.requester.country) === KSA;
  entities.forEach((e, i) => {
    const at = `billing.entities[${i}]`;
    if (!str(e.name))               problems.push(`${at}.name is required`);
    if (!str(e.registrationNumber)) problems.push(`${at}.registrationNumber is required`);
    if (!str(e.trn))                problems.push(`${at}.trn is required`);

    const needed = ksa ? DOC_KINDS : DOC_KINDS.filter(k => k !== "address");
    needed.forEach(kind => {
      const declared = e.documents && Array.isArray(e.documents[kind]) ? e.documents[kind].length : 0;
      const attached = files.filter(f => f.entityIndex === i && f.category === kind).length;
      if (!declared && !attached) {
        problems.push(`${at} is missing a ${DOC_LABELS[kind]} document`);
      }
    });
  });

  // Upload limits.
  if (files.length > LIMITS.maxFiles) {
    problems.push(`too many documents: ${files.length}, limit is ${LIMITS.maxFiles}`);
  }
  const perEntity = {};
  files.forEach(f => { perEntity[f.entityIndex] = (perEntity[f.entityIndex] || 0) + 1; });
  Object.entries(perEntity).forEach(([i, n]) => {
    if (n > LIMITS.maxFilesPerEntity) {
      problems.push(`billing.entities[${i}] has ${n} documents, limit is ${LIMITS.maxFilesPerEntity}`);
    }
  });
  let total = 0;
  files.forEach(f => {
    total += f.size || 0;
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (!LIMITS.allowedExt.includes(ext)) problems.push(`${f.name} is not a supported file type`);
    if ((f.size || 0) > LIMITS.maxFileMB * 1024 * 1024) problems.push(`${f.name} is over ${LIMITS.maxFileMB} MB`);
  });
  if (total > LIMITS.maxTotalMB * 1024 * 1024) {
    problems.push(`documents total over ${LIMITS.maxTotalMB} MB`);
  }

  return problems;
}

// ─────────────────────────────────────────────────────────────
// Documents → Cloudinary
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// ZIP bundling
// A request with more than two documents is stored as one archive as well as
// the individual files, so the whole set travels as a single download.
// Workers has no zip library, so this writes the format directly: STORE (no
// compression), which is right for PDFs and JPEGs that are already compressed,
// and costs no CPU beyond the CRC.
// ─────────────────────────────────────────────────────────────
// Cloudinary's API origin. Overridable only so the upload path can be pointed
// at a local stub in tests; unset in every real environment.
const cloudinaryBase = env => (env.CLOUDINARY_API_BASE || "https://api.cloudinary.com").replace(/\/$/, "");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// entries: [{ name, bytes }] — returns a Uint8Array holding the archive.
function buildZip(entries, when = new Date()) {
  const enc = new TextEncoder();
  // DOS timestamp: seconds have 2-second resolution, hence the >>> 1.
  const dosTime = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >>> 1)) & 0xFFFF;
  const dosDate = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xFFFF;

  const locals = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc  = crc32(e.bytes);
    const size = e.bytes.length;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0,  0x04034b50, true);   // local file header
    lh.setUint16(4,  20, true);           // version needed
    lh.setUint16(6,  0x0800, true);       // UTF-8 filenames
    lh.setUint16(8,  0, true);            // STORE
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);         // compressed == uncompressed
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);            // no extra field
    locals.push(new Uint8Array(lh.buffer), name, e.bytes);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0,  0x02014b50, true);   // central directory header
    ch.setUint16(4,  20, true);           // version made by
    ch.setUint16(6,  20, true);           // version needed
    ch.setUint16(8,  0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint16(30, 0, true);            // extra
    ch.setUint16(32, 0, true);            // comment
    ch.setUint16(34, 0, true);            // disk number
    ch.setUint16(36, 0, true);            // internal attrs
    ch.setUint32(38, 0, true);            // external attrs
    ch.setUint32(42, offset, true);       // offset of local header
    central.push(new Uint8Array(ch.buffer), name);

    offset += 30 + name.length + size;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0,  0x06054b50, true);   // end of central directory
  eocd.setUint16(4,  0, true);
  eocd.setUint16(6,  0, true);
  eocd.setUint16(8,  entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, 0, true);            // no comment

  const parts = [...locals, ...central, new Uint8Array(eocd.buffer)];
  const total = parts.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

// Documents inside the archive are named by entity and category, so two
// entities that both uploaded "licence.pdf" do not collide.
function zipEntryName(f, i) {
  const safe = String(f.name || "document").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const ent  = Number.isInteger(f.entityIndex) ? `entity-${f.entityIndex + 1}` : "entity";
  return `${ent}/${String(i + 1).padStart(2, "0")}_${f.category || "document"}_${safe}`;
}

async function uploadDocuments(env, files, account, request) {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    console.error("Cloudinary not configured — documents were received but not stored");
    return {
      ok: 0,
      bundle: null,
      storageConfigured: false,
      documents: files.map(f => ({
        filename: f.name, sizeBytes: f.size, category: f.category,
        entityIndex: f.entityIndex, url: null, error: "storage not configured",
      })),
    };
  }

  const slug = account.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "unknown";
  const date = new Date().toISOString().slice(0, 10);
  const base = (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");

  const documents = await Promise.all(files.map(async f => {
    const meta = { filename: f.name, sizeBytes: f.size, category: f.category, entityIndex: f.entityIndex };
    try {
      const uid      = crypto.randomUUID().slice(0, 8);
      // Extension is stripped from public_id: Cloudinary blocks CDN delivery for
      // some extensions. The real filename rides along in the ?name= parameter.
      const baseName = f.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "document";
      const publicId = `supy-expansion/${date}_${slug}/${uid}_${f.category}_${baseName}`;
      const ts       = Math.floor(Date.now() / 1000).toString();
      const sig      = await sha1Hex(`public_id=${publicId}&timestamp=${ts}${env.CLOUDINARY_API_SECRET}`);

      const body = new FormData();
      body.append("file", f.file, f.name);
      body.append("api_key",   env.CLOUDINARY_API_KEY);
      body.append("timestamp", ts);
      body.append("signature", sig);
      body.append("public_id", publicId);

      // raw/upload keeps every type in one bucket; auto/upload reclassifies PDFs
      // as images and breaks the raw download path.
      const res = await fetch(
        `${cloudinaryBase(env)}/v1_1/${env.CLOUDINARY_CLOUD_NAME}/raw/upload`,
        { method: "POST", body }
      );
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error("Cloudinary upload failed", res.status, JSON.stringify(out));
        return { ...meta, url: null, error: `upload failed (${res.status})` };
      }
      return {
        ...meta,
        key: out.public_id,
        url: `${base}/download?key=${encodeURIComponent(out.public_id)}&name=${encodeURIComponent(f.name)}`,
      };
    } catch (err) {
      console.error("Cloudinary upload threw", f.name, String(err));
      return { ...meta, url: null, error: "upload error" };
    }
  }));

  const ok = documents.filter(d => d.url).length;

  // More than two documents: bundle the set into one archive as well, so the
  // whole request travels as a single download. The individual files stay
  // uploaded — the HubSpot note lists them per entity, and those links are how
  // a CSM opens one document without fetching everything.
  let bundle = null;
  if (files.length > 2) {
    try {
      const entries = await Promise.all(files.map(async (f, i) => ({
        name: zipEntryName(f, i),
        bytes: new Uint8Array(await f.file.arrayBuffer()),
      })));
      const zipBytes = buildZip(entries);
      const zipName  = `${slug}-${date}-${files.length}-documents.zip`;
      const uploaded = await uploadRaw(env, zipBytes, zipName,
        `supy-expansion/${date}_${slug}/${crypto.randomUUID().slice(0, 8)}_all-documents`, base);
      if (uploaded) {
        bundle = { ...uploaded, filename: zipName, count: files.length, sizeBytes: zipBytes.length };
      }
    } catch (err) {
      console.error("zip bundle failed", String(err));   // never sinks the submission
    }
  }

  return { ok, documents, bundle, storageConfigured: true };
}

// Shared Cloudinary raw upload. raw/upload keeps every type in one bucket;
// auto/upload reclassifies PDFs as images and breaks the raw download path.
async function uploadRaw(env, bytes, filename, publicId, base) {
  try {
    const ts  = Math.floor(Date.now() / 1000).toString();
    const sig = await sha1Hex(`public_id=${publicId}&timestamp=${ts}${env.CLOUDINARY_API_SECRET}`);
    const body = new FormData();
    body.append("file", new Blob([bytes]), filename);
    body.append("api_key",   env.CLOUDINARY_API_KEY);
    body.append("timestamp", ts);
    body.append("signature", sig);
    body.append("public_id", publicId);
    const res = await fetch(`${cloudinaryBase(env)}/v1_1/${env.CLOUDINARY_CLOUD_NAME}/raw/upload`,
      { method: "POST", body });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { console.error("Cloudinary raw upload failed", res.status, JSON.stringify(out)); return null; }
    return {
      key: out.public_id,
      url: `${base}/download?key=${encodeURIComponent(out.public_id)}&name=${encodeURIComponent(filename)}`,
    };
  } catch (err) {
    console.error("Cloudinary raw upload threw", String(err));
    return null;
  }
}

// Put each stored URL back on the entity it belongs to, so the note and the
// Slack message can link straight to the paperwork.
function attachDocumentUrls(payload, documents) {
  payload.documents = documents.map(d => ({
    filename: d.filename, sizeBytes: d.sizeBytes, category: d.category,
    billingEntity: entityNameAt(payload, d.entityIndex), url: d.url || null,
  }));

  payload.billing.entities.forEach((e, i) => {
    e.documentLinks = documents
      .filter(d => d.entityIndex === i)
      .map(d => ({ filename: d.filename, category: d.category, url: d.url || null }));
  });
}

function entityNameAt(payload, i) {
  const e = payload.billing.entities[i];
  return e ? str(e.name) || null : null;
}

// The CRM record to attach to: the account they named in Supy when it exists,
// otherwise whatever they typed as their company.
function crmCompanyName(p) {
  return str(p.accountScope.existingAccountName) || str(p.requester.account);
}

// ─────────────────────────────────────────────────────────────
// HubSpot — supports both OAuth (CLIENT_ID/SECRET/REFRESH_TOKEN) and Private App PAT (HUBSPOT_ACCESS_TOKEN)
 // PAT is sent as Bearer token directly, no refresh needed.
// ─────────────────────────────────────────────────────────────
async function getHubspotToken(env) {
  const pat = env.HUBSPOT_ACCESS_TOKEN || env.HUBSPOT_PAT || env.PAT || env.HS_ACCESS_TOKEN;
  if (pat && pat.startsWith("pat-")) return pat.trim();
  if (!env.CLIENT_ID || !env.CLIENT_SECRET || !env.REFRESH_TOKEN) {
    console.error("HubSpot credentials not configured");
    return null;
  }
  const r = await fetch(`${HUBSPOT_API}/oauth/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      refresh_token: env.REFRESH_TOKEN,
    }),
  });
  if (r.status !== 200) {
    console.error("HubSpot token refresh failed", r.status, await r.text().catch(() => "(unreadable)"));
    return null;
  }
  return (await r.json()).access_token || null;
}

async function upsertContact(token, p) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const email   = str(p.requester.email);

  const parts     = str(p.requester.name).split(/\s+/);
  const firstname = parts.shift() || "";
  const lastname  = parts.join(" ");

  const props = { email, firstname, lastname, company: str(p.requester.account) };
  const phone = str(p.requester.phone);
  if (phone.startsWith("+")) props.phone = phone;   // HubSpot rejects unqualified numbers
  if (str(p.requester.country)) props.country = str(p.requester.country);

  const search = () => fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/search`, {
    method: "POST", headers,
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }] }),
  });

  const searchJson = await search().then(r => r.json()).catch(() => ({}));
  const existing   = (searchJson.results || [])[0];

  if (existing) {
    const patch = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/${existing.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ properties: props }),
    });
    if (!patch.ok) console.error("HubSpot contact PATCH failed", patch.status, await patch.text().catch(() => ""));
    return { id: existing.id, action: "updated" };
  }

  const create     = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts`, {
    method: "POST", headers, body: JSON.stringify({ properties: props }),
  });
  const createJson = await create.json().catch(() => ({}));
  if (create.status === 201 && createJson.id) return { id: createJson.id, action: "created" };

  // HubSpot's own duplicate detection can 409 a create that our search missed.
  if (create.status === 409) {
    const retry = await search().then(r => r.json()).catch(() => ({}));
    const found = (retry.results || [])[0];
    if (found) return { id: found.id, action: "updated" };
  }

  console.error("HubSpot contact create failed", create.status, JSON.stringify(createJson));
  return { id: null, action: "failed" };
}

async function createNote(token, payload, documents, receivedAt, submissionId, bundle) {
  const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/notes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: {
        hs_note_body: buildNote(payload, documents, receivedAt, submissionId, bundle),
        hs_timestamp: new Date().toISOString(),
      },
    }),
  });
  if (res.status !== 201) {
    console.error("HubSpot note create failed", res.status, await res.text().catch(() => ""));
    return null;
  }
  return (await res.json()).id || null;
}

async function linkEverything(token, noteId, contactId, companyName) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const assoc = (from, fromId, to, toId, type) =>
    fetch(`${HUBSPOT_API}/crm/v3/associations/${from}/${to}/batch/create`, {
      method: "POST", headers,
      body: JSON.stringify({ inputs: [{ from: { id: fromId }, to: { id: toId }, type }] }),
    }).catch(err => console.error("association failed", type, String(err)));

  await assoc("Notes", noteId, "Contacts", contactId, "note_to_contact");

  // Any deals already on the contact.
  try {
    const r = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/${contactId}/associations/deals`, { headers });
    if (r.ok) {
      for (const deal of (await r.json()).results || []) {
        await assoc("Notes", noteId, "Deals", deal.id, "note_to_deal");
      }
    }
  } catch (err) { console.error("contact deal lookup failed", String(err)); }

  if (!companyName || companyName.toLowerCase() === "unknown") return { matched: false, reason: "no-name" };

  // Match an existing company only. This never creates one: the name here is
  // the customer's Supy retailer name, which routinely differs from the name
  // on their HubSpot company ("Iris Abu Dhabi - Addmind" vs "Addmind
  // Hospitality"), so a create-on-miss silently forked a duplicate company off
  // every such account and hung the request on the duplicate instead of the
  // real record. No match is reported to Slack for a human to route.
  try {
    const comps = await fetch(`${HUBSPOT_API}/crm/v3/objects/companies/search`, {
      method: "POST", headers,
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: companyName }] }] }),
    });
    const found = (await comps.json()).results || [];
    const companyId = found[0] && found[0].id;
    if (!companyId) {
      console.error("no HubSpot company matched", companyName, "- note left unassociated, nothing created");
      return { matched: false, reason: "no-match" };
    }

    await assoc("Contacts", contactId, "Companies", companyId, "contact_to_company");
    await assoc("Notes",    noteId,    "Companies", companyId, "note_to_company");
    const deals = await fetch(`${HUBSPOT_API}/crm/v3/objects/companies/${companyId}/associations/deals`, { headers });
    if (deals.ok) {
      for (const deal of (await deals.json()).results || []) {
        await assoc("Notes", noteId, "Deals", deal.id, "note_to_deal");
      }
    }
    return { matched: true, companyId: String(companyId) };
  } catch (err) {
    console.error("company association failed", String(err));
    return { matched: false, reason: "error" };
  }
}

// ─────────────────────────────────────────────────────────────
// CRM note
// ─────────────────────────────────────────────────────────────
function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// One type stack and one set of cell metrics for every table in the note, so
// the sections line up with each other instead of each looking hand-made.
const FONT  = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const TABLE = `border-collapse:collapse;width:100%;font-size:13px;margin:0 0 4px;${FONT}`;
const TD    = "padding:7px 10px;border-bottom:1px solid #ecebf1;vertical-align:top;line-height:1.5";
const TH    = "padding:7px 10px;text-align:left;font-weight:600;font-size:11px;letter-spacing:.4px;text-transform:uppercase";

// headers may carry an alignment: "Qty|right". Numbers right, words left, so
// quantities stack under each other and can be read down the column.
function table(headers, rows) {
  if (!rows.length) return "<p style='color:#8b8b9a;font-size:13px;margin:0 0 4px'>None.</p>";
  const align = headers.map(h => (String(h).split("|")[1] || "left"));
  const head  = headers.map((h, i) =>
    `<th style='${TH};text-align:${align[i]}'>${esc(String(h).split("|")[0])}</th>`).join("");
  const body  = rows.map((cells, n) =>
    `<tr style='background:${n % 2 ? "#faf9fc" : "#fff"}'>` +
    cells.map((c, i) => `<td style='${TD};text-align:${align[i]}'>${c}</td>`).join("") +
    `</tr>`).join("");
  return `<table style='${TABLE}'><tr style='background:#321e57;color:#fff'>${head}</tr>${body}</table>`;
}

// Label/value pairs as a table too, so every left edge in the note is the same
// left edge.
function kv(pairs) {
  const rows = pairs.filter(Boolean).map(([k, v]) =>
    `<tr>` +
    `<td style='${TD};width:170px;color:#6b6b7b;border-bottom:1px solid #f4f3f7'>${esc(k)}</td>` +
    `<td style='${TD};border-bottom:1px solid #f4f3f7'>${v}</td>` +
    `</tr>`).join("");
  return `<table style='${TABLE}'>${rows}</table>`;
}

function buildNote(p, documents, receivedAt, submissionId, bundle) {
  const r     = p.requester;
  const scope = p.accountScope;
  const dash  = "&mdash;";

  const lineRows = p.lines.map(l => {
    const allocs = Array.isArray(l.allocations) ? l.allocations : [];
    const qty = allocs.reduce((n, a) => n + (Number(a.quantity) || 0), 0);
    const split = allocs.length
      ? allocs.map(a => `${esc(a.quantity)} &times; ${esc(a.billsUnder || DEFAULT_ENTITY)}`).join("<br>")
      : dash;
    return [
      esc(CATALOGUE[str(l.id)] || l.name || l.id),
      `<b>${esc(qty)}</b>`,
      split,
    ];
  });

  const entityRows = p.billing.entities.map(e => [
    `<b>${esc(e.name)}</b>`,
    esc(e.registrationNumber || dash),
    esc(e.trn || dash),
  ]);

  // Documents get their own table rather than being crammed into the entity
  // rows, so filename, size and state line up down the page.
  const entityNameFor = i => (Number.isInteger(i) && p.billing.entities[i] ? p.billing.entities[i].name : "");
  const docRows = documents.map(d => [
    esc(entityNameFor(d.entityIndex) || dash),
    esc(DOC_LABELS[d.category] || d.category || dash),
    esc(d.filename || dash),
    d.sizeBytes ? esc(Math.max(1, Math.round(d.sizeBytes / 1024)) + " KB") : dash,
    d.url
      ? `<a href='${esc(d.url)}' style='color:#503390;font-weight:600;text-decoration:none'>Download</a>`
      : `<span style='color:#c0392b'>not stored</span>`,
  ]);

  const failed = documents.filter(d => !d.url).length;
  const stored = documents.length - failed;

  const heading = t =>
    `<h4 style='${FONT};color:#503390;font-size:12px;letter-spacing:.6px;text-transform:uppercase;` +
    `border-bottom:1px solid #e0d8f0;padding-bottom:5px;margin:22px 0 10px'>${esc(t)}</h4>`;

  return [
    `<div style="${FONT};font-size:13px;color:#1f1f2b">`,

    `<h3 style='${FONT};color:#321e57;font-size:16px;margin:0 0 3px'>Supy expansion request</h3>`,
    `<p style='${FONT};color:#8b8b9a;font-size:11px;margin:0 0 6px'>` +
      `${esc(receivedAt)} &middot; Ref ${esc(submissionId)}</p>`,

    heading("Request"),
    kv([
      ["Account",        esc(r.account)],
      ["Requested by",   `${esc(r.name)} &middot; ${esc(r.email)}${r.phone ? " &middot; " + esc(r.phone) : ""}`],
      ["Country",        esc(r.country || dash)],
      ["Sits under",     `<b>${esc(scope.target || dash)}</b>`],
      scope.existingAccountName
        ? ["Existing account", `${esc(scope.existingAccountName)}${scope.existingRetailerId
            ? ` <span style='color:#8b8b9a'>(retailer ${esc(scope.existingRetailerId)})</span>`
            : ` <span style='color:#c0392b'>(typed, not verified)</span>`}`]
        : null,
      scope.newAccountName ? ["New account", esc(scope.newAccountName)] : null,
    ]),

    heading("What they are adding"),
    table(["Item", "Qty|right", "Bills under"], lineRows),

    heading("Billing"),
    kv([["Same legal entity", `<b>${esc(p.billing.sameLegalEntity || dash)}</b>`]]),
    p.billing.entities.length ? table(["Legal entity", "CRN / license", "TRN / VAT"], entityRows) : "",

    heading("Documents"),
    kv([
      ["Uploaded", documents.length
        ? `<b>${esc(documents.length)}</b>` + (failed
            ? ` &middot; <span style='color:#c0392b'>${esc(stored)} stored, ${esc(failed)} failed &mdash; ask the client to resend</span>`
            : " &middot; all stored")
        : "None"],
      bundle && bundle.url
        ? ["All documents", `<a href='${esc(bundle.url)}' style='color:#503390;font-weight:600;text-decoration:none'>${esc(bundle.filename)}</a>`]
        : null,
    ]),
    documents.length ? table(["Entity", "Type", "File", "Size|right", ""], docRows) : "",

    heading("Customer note"),
    `<p style='${FONT};font-size:13px;margin:0;line-height:1.6'>${esc(p.notes || dash).replace(/\n/g, "<br>")}</p>`,

    `</div>`,
  ].filter(Boolean).join("");
}

const EMAIL_FROM       = "vaishnavi@supy.io";
const EMAIL_REPLY_TO   = "csms@supy.io";
const EMAIL_RECIPIENTS = ["vaishnavi@supy.io"];

async function getGmailToken(env) {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) return null;
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        client_id:     env.GMAIL_CLIENT_ID,
        client_secret: env.GMAIL_CLIENT_SECRET,
        refresh_token: env.GMAIL_REFRESH_TOKEN,
      }),
    });
    if (!r.ok) {
      console.error("Gmail token refresh failed", r.status);
      return null;
    }
    return (await r.json()).access_token || null;
  } catch (err) {
    console.error("Gmail token refresh threw", String(err));
    return null;
  }
}

// A header value containing CR or LF can inject extra headers, so anything
// interpolated into the MIME block is stripped first.
const hdr = s => String(s === null || s === undefined ? "" : s).replace(/[\r\n]+/g, " ").slice(0, 200);

async function sendGmail(token, { to, subject, html, replyTo }) {
  const mime = [
    `From: Supy <${EMAIL_FROM}>`,
    `To: ${hdr(to)}`,
    replyTo ? `Reply-To: ${hdr(replyTo)}` : null,
    `Subject: ${hdr(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
    ``,
    html,
  ].filter(v => v !== null).join("\r\n");

  const raw = btoa(unescape(encodeURIComponent(mime)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!r.ok) console.error("Gmail send failed", r.status, await r.text().catch(() => ""));
  return r.ok;
}

function shell(inner) {
  return `<div style="font-family:Arial,sans-serif;max-width:700px;margin:auto;color:#1a1a2e">
  <div style="background:#321e57;padding:22px 26px;border-radius:8px 8px 0 0">
    <span style="color:#fff;font-size:18px;font-weight:700">Supy</span>
  </div>
  <div style="background:#fff;padding:26px;border:1px solid #e0d8f0;border-top:none;border-radius:0 0 8px 8px">
    ${inner}
  </div>
</div>`;
}

async function sendInternalEmail(env, payload, documents, receivedAt, submissionId, bundle) {
  const token = await getGmailToken(env);
  if (!token) return false;
  return sendGmail(token, {
    to:      EMAIL_RECIPIENTS.join(", "),
    replyTo: str(payload.requester.email) || undefined,
    subject: buildSubject(payload),
    html:    shell(buildNote(payload, documents, receivedAt, submissionId, bundle)),
  });
}

async function sendClientReceipt(env, payload, documents, receivedAt, submissionId, bundle) {
  const token = await getGmailToken(env);
  if (!token) return false;

  const to = str(payload.requester.email);
  if (!isEmail(to)) return false;

  const firstName = esc(str(payload.requester.name).split(/\s+/)[0] || "there");

  return sendGmail(token, {
    to,
    replyTo: EMAIL_REPLY_TO,
    subject: `We have your expansion request — ${hdr(str(payload.requester.account))}`,
    html: shell(`
      <h2 style="color:#321e57;margin:0 0 8px">Thanks, ${firstName} — we have it.</h2>
      <p style="color:#555;margin:0 0 18px;font-size:15px">
        Your expansion request is with your Supy team. They will confirm scope and
        timing with you, and flag anything else they need, within one business day.
      </p>
      <div style="background:#f5f2ff;border-left:4px solid #503390;padding:12px 16px;border-radius:4px;margin-bottom:22px">
        <p style="margin:0;font-size:14px;color:#321e57">
          <strong>Nothing has been set up yet.</strong> This is a request, not a change to
          your account. Nothing will be added until your team confirms it with you.
          Need to correct something? Just reply to this email.
        </p>
      </div>
      <h3 style="color:#503390;font-size:14px;border-bottom:1px solid #e0d8f0;padding-bottom:6px;margin:0 0 14px">
        What you sent us
      </h3>
      ${buildNote(payload, documents, receivedAt, submissionId, bundle)}
      <hr style="border:none;border-top:1px solid #e0d8f0;margin:22px 0">
      <p style="color:#aaa;font-size:11px;margin:0">
        Sent to ${esc(to)} because this request was submitted with that address.
        Reply any time — it reaches your Customer Success Manager directly.
      </p>`),
  });
}

// ─────────────────────────────────────────────────────────────
// Slack
// ─────────────────────────────────────────────────────────────
const smk = s => String(s === null || s === undefined ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Slack rejects a section over 3000 characters, and a 15-row request can pass
// that. Cut on a line boundary and say how much was left out.
function clip(text, max = 2800) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at  = cut.lastIndexOf("\n");
  const kept = at > 0 ? cut.slice(0, at) : cut;
  const dropped = text.slice(kept.length).split("\n").filter(Boolean).length;
  return `${kept}\n_…and ${dropped} more — see the full request in HubSpot._`;
}

// Slack has no tables, so the line items are laid out in a monospace block
// where columns actually align. Everything else is a short label/value pair -
// the full detail lives on the deal and in the sheet, and repeating it here
// just makes the message something people scroll past.
const pad = (v, n) => { const t = String(v); return t.length > n ? t.slice(0, n - 1) + "\u2026" : t.padEnd(n); };

// The catalogue names are written for the form, where there is room. In a
// Slack table they only need to be recognisable.
const SHORT_ITEM = {
  outlet:       "Outlet licence",
  ck_addon:     "CK add-on",
  wh_addon:     "WH add-on",
  cost_center:  "Cost center",
  accounting:   "Accounting integration",
  invoiceinbox: "AI Invoice Inbox",
};

async function sendSlack(env, p, documents, contactId, submissionId, ctx = {}) {
  if (!env.SLACK_WEBHOOK_URL) {
    console.error("SLACK_WEBHOOK_URL not configured");
    return false;
  }

  const hsContactLink = (id) => `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${id}`;
  const hsDealLink    = (id) => `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${id}`;
  const hsPipeline    = `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/objects/0-3/views/all/board?pipeline=${HS.salesPipeline}`;

  const mgr        = managersForCountry(str(p.requester.country), env);
  const retailer   = str(p.accountScope.existingAccountName) || "";
  const retailerId = str(p.accountScope.existingRetailerId) || "";
  const scope      = str(p.accountScope.target) || "";
  const account    = str(p.requester.account) || "Account";
  const when       = new Date().toLocaleString("en-AE", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dubai" });

  const totalUnits = p.lines.reduce((n, l) =>
    n + (Array.isArray(l.allocations) ? l.allocations : []).reduce((m, a) => m + (Number(a.quantity) || 0), 0), 0);
  const entityNames = p.billing.entities.map(e => str(e.name)).filter(Boolean);

  const accountLine = scope === "Existing account" && retailer
    ? `${smk(retailer)}${retailerId ? "" : "  ·  _unverified_"}`
    : scope === "New account" ? `${smk(str(p.accountScope.newAccountName) || account)}  ·  _new_`
    : smk(scope || "scope not given");

  // Line items, as a table.
  const table = p.lines.map(l => {
    const allocs = Array.isArray(l.allocations) ? l.allocations : [];
    const qty = allocs.reduce((n, a) => n + (Number(a.quantity) || 0), 0);
    const name = SHORT_ITEM[str(l.id)] || CATALOGUE[str(l.id)] || l.name || l.id;
    const split = allocs.length > 1
      ? allocs.map(a => `${a.quantity} ${shortEntity(a.billsUnder)}`).join(", ")
      : (allocs[0] && allocs[0].billsUnder && allocs[0].billsUnder !== DEFAULT_ENTITY
          ? shortEntity(allocs[0].billsUnder) : "account entity");
    return `${String(qty).padStart(3)}   ${pad(name, 22)}  ${split}`;
  }).join("\n");

  const stored = documents.filter(d => d.url).length;
  const docsValue = documents.length
    ? `${stored}/${documents.length} stored${ctx.bundle ? "  ·  <" + ctx.bundle.url + "|.zip>" : ""}`
    : "none";

  const blocks = [
    { type: "header", text: { type: "plain_text", text: `Expansion request - ${account}`.slice(0, 150), emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text:
      `${accountLine}  ·  ${smk(p.requester.country || "-")}  ·  ${smk(when)}  ·  \`${smk(submissionId).slice(0, 8)}\`  ·  _a request, nothing provisioned_` }] },
    { type: "section", text: { type: "mrkdwn", text:
      `*${totalUnits} unit${totalUnits === 1 ? "" : "s"}*  ·  ${p.lines.length} item${p.lines.length === 1 ? "" : "s"}`
      + (entityNames.length ? `  ·  ${entityNames.length} ${entityNames.length === 1 ? "entity" : "entities"}` : "")
      + `  ·  ${smk(p.billing.sameLegalEntity || "-").toLowerCase()}` } },
  ];

  if (p.lines.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: clip("```\n" + table + "\n```") } });
  } else {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No line items - check form validation_" } });
  }

  // Two columns of label/value. Slack renders these side by side.
  const dealValue = ctx.salesDealId
    ? `<${hsDealLink(ctx.salesDealId)}|${ctx.salesDealId}>`
      + (ctx.onboardingDeal ? `  ·  from <${hsDealLink(ctx.onboardingDeal.id)}|onboarding>` : "  ·  _no onboarding match_")
    : "_not created_";
  blocks.push({ type: "section", fields: [
    { type: "mrkdwn", text: `*From*\n${smk(p.requester.name)}  ·  ${smk(p.requester.email)}` },
    { type: "mrkdwn", text: `*Owner*\n${mgr && mgr.countryManager ? smk(mgr.countryManager) + (mgr.slack ? ` ${mgr.slack}` : "") : "_unassigned_"}` },
    { type: "mrkdwn", text: `*Deal*\n${dealValue}` },
    { type: "mrkdwn", text: `*Documents*\n${docsValue}` },
  ] });

  // Their note, trimmed - the whole thing is on the deal.
  if (p.notes && str(p.notes)) {
    const n = str(p.notes).replace(/\s+/g, " ");
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text:
      `:speech_balloon: ${smk(n.length > 140 ? n.slice(0, 139) + "\u2026" : n)}` }] });
  }

  // Only what needs a decision.
  const flags = [];
  const failed = documents.filter(d => !d.url);
  if (failed.length) flags.push(`${failed.length} document${failed.length === 1 ? "" : "s"} failed to store - ask the client to resend`);
  if (scope === "Existing account" && retailer && !retailerId) flags.push("account was typed, not picked - not on the access sheet, nothing verified");
  else if (scope === "Existing account" && retailerId && !ctx.onboardingDeal) flags.push(`no onboarding deal matched \`${smk(retailerId)}\``);
  if (!ctx.salesDealId) flags.push("*no deal was created* - raise it by hand");
  else if (!ctx.onboardingDeal) flags.push("deal has *no owner* - assign it");
  else if (ctx.onboardingLinked === false) flags.push("deal is not linked to the onboarding deal");
  if (ctx.companyMatched === false) flags.push(`no company matched *${smk(crmCompanyName(p))}* - attach it`);
  if (flags.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(`:warning: ${flags.join("\n:warning: ")}`) } });
  }

  const buttons = [{
    type: "button", style: "primary",
    text: { type: "plain_text", text: ctx.salesDealId ? "Open deal" : (contactId ? "Open contact" : "Open Sales 360"), emoji: true },
    url: ctx.salesDealId ? hsDealLink(ctx.salesDealId) : (contactId ? hsContactLink(contactId) : hsPipeline),
  }];
  if (ctx.salesDealId && contactId) {
    buttons.push({ type: "button", text: { type: "plain_text", text: "Contact", emoji: true }, url: hsContactLink(contactId) });
  }
  if (ctx.bundle) {
    buttons.push({ type: "button", text: { type: "plain_text", text: "Documents (.zip)", emoji: true }, url: ctx.bundle.url });
  } else {
    documents.filter(d => d.url).slice(0, 2).forEach(d => {
      buttons.push({ type: "button",
        text: { type: "plain_text", text: (DOC_LABELS[d.category] || d.category).slice(0, 24), emoji: true },
        url: d.url });
    });
  }
  blocks.push({ type: "actions", elements: buttons.slice(0, 5) });

  try {
    const r = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: buildSubject(p), blocks }),
    });
    if (!r.ok) console.error("Slack post failed", r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (err) {
    console.error("Slack post threw", String(err));
    return false;
  }
}

// "Marina Hospitality LLC" -> "Marina Hospitality", so the table column holds.
function shortEntity(name) {
  const n = str(name);
  if (!n || n === DEFAULT_ENTITY) return "account entity";
  return n.replace(/\s+(LLC|L\.L\.C\.?|FZE|FZ-?LLC|WLL|Ltd\.?|Limited|Co\.?|Company|Trading|Holdings?)$/i, "").slice(0, 24);
}

function buildSubject(p) {
  const bits = p.lines.map(l => {
    const qty = (Array.isArray(l.allocations) ? l.allocations : [])
      .reduce((n, a) => n + (Number(a.quantity) || 0), 0);
    return `${qty} ${CATALOGUE[str(l.id)] || str(l.name) || str(l.id)}`;
  });
  return `Expansion request: ${str(p.requester.account) || "account"} (${bits.join(", ") || "no items"})`;
}

// ─────────────────────────────────────────────────────────────
// Drafts
//
// A fifteen-row request is a lot of typing to lose to a closed tab, so the form
// autosaves and hands back a link that resumes it. The key is the only thing
// guarding a draft, and a draft holds contact details, addresses and TRNs — so
// keys are long and random, and the link should be treated as sensitive.
//
// Uploaded documents are deliberately NOT part of a draft: File contents never
// leave the browser until submit, and re-attaching two PDFs is cheaper than
// storing customer paperwork against an unauthenticated key.
// ─────────────────────────────────────────────────────────────
const DRAFT_TTL_DAYS  = 30;
const MAX_DRAFT_BYTES = 256 * 1024;

async function handleDraftSave(request, env) {
  if (!env.DRAFTS) return json({ error: "Drafts are not configured" }, 501, request, env);

  const raw = await request.text();
  if (raw.length > MAX_DRAFT_BYTES) {
    return json({ error: "Draft too large" }, 413, request, env);
  }

  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400, request, env); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Draft must be a JSON object" }, 400, request, env);
  }

  // Reuse the caller's key when resuming, so one draft does not sprout a new
  // URL on every keystroke. Anything that is not a key we issued is ignored.
  const key = isDraftKey(body._draft_key) ? body._draft_key : newDraftKey();
  const savedAt = new Date().toISOString();

  await env.DRAFTS.put(
    `draft:${key}`,
    JSON.stringify({ ...body, _draft_key: key, _saved_at: savedAt }),
    { expirationTtl: 60 * 60 * 24 * DRAFT_TTL_DAYS }
  );

  return json({
    key,
    savedAt,
    expiresInDays: DRAFT_TTL_DAYS,
    draft_url: `${formBaseUrl(env)}?draft=${key}`,
  }, 200, request, env);
}

async function handleDraftLoad(request, env) {
  if (!env.DRAFTS) return json({ error: "Drafts are not configured" }, 501, request, env);

  const key = new URL(request.url).searchParams.get("key");
  if (!isDraftKey(key)) return json({ error: "Invalid draft key" }, 400, request, env);

  const data = await env.DRAFTS.get(`draft:${key}`);
  if (!data) return json({ error: "Draft not found or expired" }, 404, request, env);

  return json({ data: JSON.parse(data) }, 200, request, env);
}

// ─────────────────────────────────────────────────────────────
// Account prefill
//
// "Clone setup from" and "Belongs to outlet" are free text because the form
// cannot know a client's existing outlets. The obvious fix — a public lookup
// keyed on company name — would let anyone enumerate any client's locations,
// so prefill is issued deliberately instead: a CSM mints a link scoped to one
// account and sends it to that client. The key is unguessable and is the only
// thing that resolves, so there is nothing to enumerate.
// ─────────────────────────────────────────────────────────────
const PREFILL_TTL_DAYS = 90;
const MAX_PREFILL_OUTLETS = 500;

async function handleAccountLink(request, env) {
  if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
    return json({ error: "Unauthorized" }, 401, request, env);
  }
  if (!env.DRAFTS) return json({ error: "Prefill storage is not configured" }, 501, request, env);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Invalid JSON" }, 400, request, env);

  const account = str(body.account);
  if (!account) return json({ error: "account is required" }, 400, request, env);

  const outlets = (Array.isArray(body.outlets) ? body.outlets : [])
    .map(str).filter(Boolean).slice(0, MAX_PREFILL_OUTLETS);
  const seen = new Set();
  const unique = outlets.filter(o => (seen.has(o.toLowerCase()) ? false : seen.add(o.toLowerCase())));

  const key = newDraftKey();
  await env.DRAFTS.put(`acct:${key}`, JSON.stringify({
    account,
    existingAccountName: str(body.existingAccountName) || account,
    country:  str(body.country) || null,
    outlets:  unique,
    createdAt: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * PREFILL_TTL_DAYS });

  return json({
    key,
    account,
    outlets: unique.length,
    expiresInDays: PREFILL_TTL_DAYS,
    url: `${formBaseUrl(env)}?acct=${key}`,
  }, 200, request, env);
}

async function handleAccountPrefill(request, env) {
  if (!env.DRAFTS) return json({ error: "Prefill storage is not configured" }, 501, request, env);

  const key = new URL(request.url).searchParams.get("key");
  if (!isDraftKey(key)) return json({ error: "Invalid key" }, 400, request, env);

  const data = await env.DRAFTS.get(`acct:${key}`);
  if (!data) return json({ error: "Link not found or expired" }, 404, request, env);

  return json(JSON.parse(data), 200, request, env);
}

const newDraftKey = () => crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const isDraftKey  = k => typeof k === "string" && /^[a-f0-9]{40}$/.test(k);

// ─────────────────────────────────────────────────────────────
// Retailers by email (Existing Account filtering)
// ─────────────────────────────────────────────────────────────
// How long a customer waits on the access sheet before the form moves on, and
// how long the background pass gets to warm the cache afterwards.
const SHEET_TIMEOUT_MS = 6000;
const SHEET_BACKGROUND_TIMEOUT_MS = 25000;

async function readAccessSheet(sheetUrl, email, timeoutMs) {
  const sep = sheetUrl.includes("?") ? "&" : "?";
  try {
    const r = await fetch(`${sheetUrl}${sep}email=${encodeURIComponent(email)}`,
      { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) { console.error("access sheet returned", r.status); return { list: null }; }
    const j = await r.json().catch(() => null);
    if (!j)       { console.error("access sheet returned unparseable body"); return { list: null }; }
    if (j.error)  { console.error("access sheet error", String(j.error));    return { list: null }; }
    const rows = Array.isArray(j.retailers) ? j.retailers : Array.isArray(j) ? j : null;
    if (!rows) return { list: null };            // not the access sheet
    if (j.missingId) console.error("access sheet rows skipped for a missing retailer id:", j.missingId, email);
    // Only rows carrying a retailer id can route anything.
    return { list: rows.map(x => ({
      name:       str(x.name || x.retailerName || x.retailer || x.account || ""),
      retailerId: str(x.retailerId || x.retailer_id || x.id || x.retailerID || ""),
    })).filter(x => x.name && x.retailerId) };
  } catch (e) {
    const timedOut = String(e).includes("aborted") || String(e).includes("timed out") || (e && e.name === "TimeoutError");
    console.error("access sheet fetch failed", timedOut ? `timed out after ${timeoutMs}ms` : String(e));
    return { list: null, timedOut };
  }
}

async function handleRetailers(request, env, ctx) {
  const email = str(new URL(request.url).searchParams.get("email"));
  if (!email || !isEmail(email)) return json({ error: "Valid email required" }, 400, request, env);

  const started = Date.now();
  const cacheKey = `ret:${email.toLowerCase()}`;

  // A cached answer, so the second render of the form is instant. Hits are held
  // longer than misses: a miss usually means a source is misconfigured, and a
  // short TTL lets the fix show up without waiting the cache out.
  if (env.DRAFTS) {
    try {
      const hit = await env.DRAFTS.get(cacheKey);
      if (hit) {
        const j = JSON.parse(hit);
        return json({ ...j, cached: true, ms: Date.now() - started }, 200, request, env);
      }
    } catch { /* cache is an optimisation, never a dependency */ }
  }

  let retailers = [];
  let source = "sheet-unavailable";

  // The access sheet is the only source of retailer identity. Everything
  // downstream — the onboarding deal, its owner, its companies, the Sales 360
  // deal — is keyed off the retailer id this returns, so inferring identity
  // anywhere else would mean two different answers to "which account is this".
  // No sheet match means no verified account, said plainly, not guessed at.
  //
  // Sheet: docs.google.com/spreadsheets/d/1raBGqWqxVaUcraY0gjR-CFQT3T2_TheemPfOpihmmFE
  //        gid 599203487, served by google-apps-script/Code.gs doGet.
  //
  // No `cache` field on this fetch: Workers does not implement it and throws on
  // sight, which silently killed this source in production.
  // Someone is waiting on this with a half-filled form in front of them, so the
  // sheet gets a few seconds and no more. Apps Script can take far longer than
  // that on a cold start; when it does, the answer comes back empty and the
  // lookup continues in the background so the cache is warm for the retry.
  const sheetUrls = [env.RETAILER_SHEET_URL, env.USER_ACCESS_SHEET_URL, env.GOOGLE_SCRIPT_URL].filter(Boolean);
  let timedOut = false;
  for (const sheetUrl of sheetUrls) {
    const got = await readAccessSheet(sheetUrl, email, SHEET_TIMEOUT_MS);
    if (got.timedOut) { timedOut = true; continue; }
    if (!got.list) continue;                 // unreachable, or not the access sheet
    retailers = got.list;
    source = retailers.length ? "sheet" : "sheet-no-match";
    break;
  }
  if (!retailers.length && timedOut) {
    source = "sheet-timeout";
    // Finish the lookup after the response goes out, and cache what it finds.
    if (ctx && typeof ctx.waitUntil === "function" && env.DRAFTS) {
      ctx.waitUntil((async () => {
        for (const sheetUrl of sheetUrls) {
          const late = await readAccessSheet(sheetUrl, email, SHEET_BACKGROUND_TIMEOUT_MS);
          if (!late.list) continue;
          const body = { retailers: late.list, source: late.list.length ? "sheet" : "sheet-no-match" };
          try { await env.DRAFTS.put(cacheKey, JSON.stringify(body), { expirationTtl: late.list.length ? 600 : 60 }); } catch {}
          return;
        }
      })());
    }
  }

  const body = { retailers, source };
  if (env.DRAFTS && source !== "sheet-timeout") {
    try {
      await env.DRAFTS.put(cacheKey, JSON.stringify(body), { expirationTtl: retailers.length ? 600 : 60 });
    } catch { /* not fatal */ }
  }

  // Always return an array; empty means frontend stays in free-text mode.
  return json({ ...body, ms: Date.now() - started }, 200, request, env);
}

function handleGeo(request, env) {
  const cfCountry = request.cf && request.cf.country ? String(request.cf.country) : "";
  const hdrCountry = request.headers.get("CF-IPCountry") || request.headers.get("cf-ipcountry") || "";
  const country = cfCountry || hdrCountry || null;
  // Also try to map via request.cf if available, else via header
  return json({ country, cfCountry: cfCountry || null, headerCountry: hdrCountry || null }, 200, request, env);
}

async function findOnboardingDealByRetailerId(token, retailerId) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const body = {
    filterGroups: [{ filters: [
      { propertyName: HS.retailerIdProp, operator: "EQ", value: str(retailerId) },
      { propertyName: "pipeline", operator: "EQ", value: HS.onboardingPipeline },
    ]}],
    properties: ["dealname","dealstage","pipeline", HS.retailerIdProp, "hubspot_owner_id", HS.accountOwnerProp, "amount", "deal_currency_code", "country", "dealtype"],
    limit: 1,
  };
  const r = await fetch(`${HUBSPOT_API}/crm/v3/objects/deals/search`, { method:"POST", headers, body: JSON.stringify(body) });
  if (!r.ok) { console.error("onboarding deal search failed", r.status, await r.text().catch(()=> "")); return null; }
  const j = await r.json().catch(()=> ({}));
  const hit = (j.results || [])[0];
  return hit || null;
}

async function getDealCompanyIds(token, dealId) {
  const headers = { Authorization: `Bearer ${token}` };
  const r = await fetch(`${HUBSPOT_API}/crm/v3/objects/deals/${dealId}/associations/companies`, { headers });
  if (!r.ok) return [];
  const j = await r.json().catch(()=> ({}));
  return (j.results || []).map(x => String(x.id));
}

async function createSalesDeal(token, props, companyIds, contactId) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  // HubSpot: dealtype existingbusiness = Live/Existing Customer (spec's Deal Source). No separate deal_source property exists in this portal (checked via API), so we set dealtype only. hs_analytics_source is read-only and would fail.
  const hsProps = {
    dealname: props.dealname,
    pipeline: props.pipeline,
    dealstage: props.dealstage,
    hubspot_owner_id: props.hubspot_owner_id,
    amount: String(props.amount || 0),
    deal_currency_code: props.deal_currency_code || "USD",
    dealtype: props.dealtype || "existingbusiness",
    country: props.country || undefined,
    [HS.retailerIdProp]: props.retailerId || undefined,
  };
  // Strip undefined
  Object.keys(hsProps).forEach(k => hsProps[k] === undefined && delete hsProps[k]);

  const r = await fetch(`${HUBSPOT_API}/crm/v3/objects/deals`, {
    method:"POST", headers, body: JSON.stringify({ properties: hsProps }),
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    console.error("sales deal create failed", r.status, t);
    return { id: null, onboardingLinked: false };
  }
  const j = await r.json().catch(()=> ({}));
  const dealId = j.id ? String(j.id) : null;
  if (!dealId) return { id: null, onboardingLinked: false };
  const onboardingLinked = await associateSalesDeal(token, dealId, companyIds, contactId, props.onboardingDealId);
  return { id: dealId, onboardingLinked };
}

async function associateSalesDeal(token, dealId, companyIds, contactId, onboardingDealId) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const assoc = (from, fromId, to, toId, type) =>
    fetch(`${HUBSPOT_API}/crm/v3/associations/${from}/${to}/batch/create`, {
      method:"POST", headers, body: JSON.stringify({ inputs: [{ from:{id: fromId}, to:{id: toId}, type }] }),
    }).catch(e => console.error("sales assoc failed", type, String(e)));
  if (companyIds && companyIds.length) {
    for (const cid of companyIds) {
      await assoc("Deals", dealId, "Companies", cid, "deal_to_company");
    }
  }
  if (contactId) {
    await assoc("Deals", dealId, "Contacts", contactId, "deal_to_contact");
  }
  // The expansion deal belongs to the onboarding deal it came out of: same
  // retailer, same companies, and the onboarding deal is where its owner and
  // account manager were read from. Without the link a CSM opening either one
  // cannot see the other. Deal-to-deal is a same-object association, so it goes
  // through the v4 default endpoint rather than the v3 named types above.
  if (onboardingDealId) {
    try {
      const r = await fetch(
        `${HUBSPOT_API}/crm/v4/objects/deals/${dealId}/associations/default/deals/${onboardingDealId}`,
        { method: "PUT", headers });
      if (!r.ok) console.error("deal_to_deal link failed", r.status, await r.text().catch(()=> ""));
      return r.ok;
    } catch (e) { console.error("deal_to_deal link threw", String(e)); return false; }
  }
  return null;
}

function formBaseUrl(env) {
  return (env.FORM_URL || "https://vaishnavi-supy-io.github.io/supy-expansion/").replace(/\?.*$/, "");
}

// ─────────────────────────────────────────────────────────────
// Google Sheets mirror
//
// Two sheets: one row per request for tracking, and one row per line item for
// the team working through what actually needs setting up. Both carry the same
// submission ref so a row can be traced back to the CRM note.
// ─────────────────────────────────────────────────────────────
async function logToSheets(env, p, documents, receivedAt, submissionId, bundle, crm = {}) {
  if (!env.GOOGLE_SCRIPT_URL) return false;


  // One row per allocation, so a line split across two entities becomes two
  // rows. That is the form someone provisioning actually works from.
  const rows = p.lines.flatMap(l =>
    (Array.isArray(l.allocations) ? l.allocations : []).map(a => ({
      itemId:     str(l.id),
      name:       CATALOGUE[str(l.id)] || str(l.name) || str(l.id),
      kind:       PRODUCT_IDS.includes(str(l.id)) ? "Product" : "Feature",
      quantity:   Number(a.quantity) || 0,
      billsUnder: a.billsUnder && a.billsUnder !== DEFAULT_ENTITY ? a.billsUnder : "Existing account entity",
    })));

  const body = {
        submissionId,
        receivedAt,
        summary:      buildSubject(p),
        account:      p.requester.account,
        contactName:  p.requester.name,
        contactEmail: p.requester.email,
        contactPhone: p.requester.phone || "",
        country:      p.requester.country || "",
        scope:        p.accountScope.target || "",
        existingAccount: p.accountScope.existingAccountName || "",
        existingRetailerId: p.accountScope.existingRetailerId || "",
        newAccount:      p.accountScope.newAccountName || "",
        outletCount:      unitsOf(p, "outlet"),
        ckAddonCount:     unitsOf(p, "ck_addon"),
        whAddonCount:     unitsOf(p, "wh_addon"),
        costCenterCount:  unitsOf(p, "cost_center"),
        featureCount:     p.features.length,
        sameLegalEntity: p.billing.sameLegalEntity || "",
        entities: p.billing.entities.map((e, i) => ({
          name: e.name, registrationNumber: e.registrationNumber || "", trn: e.trn || "",
          // Every document this entity sent, so the Entities tab is readable on
          // its own without cross-referencing.
          documents: documents.filter(d => d.entityIndex === i)
                              .map(d => `${d.category}: ${d.filename}${d.url ? " " + d.url : " (not stored)"}`)
                              .join("\n"),
        })),
        documentCount:  documents.length,
        documentsStored: documents.filter(d => d.url).length,
        bundleUrl:      bundle && bundle.url ? bundle.url : "",
        bundleFilename: bundle ? bundle.filename : "",
        documents: documents.map(d => ({
          filename: d.filename, category: d.category, url: d.url || "",
          sizeBytes: d.sizeBytes || 0,
          entity: Number.isInteger(d.entityIndex) && p.billing.entities[d.entityIndex]
            ? p.billing.entities[d.entityIndex].name : "",
          stored: d.url ? "yes" : "no",
          error: d.error || "",
        })),
        notes: p.notes || "",
        // Where the request ended up, so the sheet answers "was this actioned"
        // without opening HubSpot.
        countryManager: (managersForCountry(str(p.requester.country), env) || {}).countryManager || "",
        hubspotContactId: crm.contactId || "",
        hubspotContactUrl: crm.contactId ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${crm.contactId}` : "",
        hubspotDealId:  crm.salesDealId || "",
        hubspotDealUrl: crm.salesDealId ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${crm.salesDealId}` : "",
        onboardingDealId: crm.onboardingDealId || "",
        hubspotNoteId: crm.noteId || "",
        hubspotCompanyIds: (crm.companyIds || []).join(", "),
        deliveryResults: (crm.results || []).join(", "),
        rows,
  };

  const sent = await postToSheets(env, body);
  if (!sent) await queueForSheets(env, body);
  return sent;
}

// ─────────────────────────────────────────────────────────────
// The sheet is meant to hold every response, so a failed append is a queued
// one, not a lost one. Apps Script goes down, times out and hits quotas; none
// of that should leave a hole in the record.
// ─────────────────────────────────────────────────────────────
const SHEETS_TIMEOUT_MS = 15000;
const SHEETS_QUEUE_PREFIX = "sheetq:";

async function postToSheets(env, body, attempts = 2) {
  if (!env.GOOGLE_SCRIPT_URL) return false;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(env.GOOGLE_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SHEETS_TIMEOUT_MS),
      });
      if (res.ok) return true;
      console.error("Sheets append failed", res.status);
    } catch (err) {
      console.error("Sheets append threw", String(err));
    }
  }
  return false;
}

async function queueForSheets(env, body) {
  if (!env.LOGS) return;
  try {
    await env.LOGS.put(`${SHEETS_QUEUE_PREFIX}${body.receivedAt}:${body.submissionId}`,
      JSON.stringify(body), { expirationTtl: 60 * 60 * 24 * 30 });
    console.error("queued for the sheet", body.submissionId);
  } catch (err) { console.error("could not queue for the sheet", String(err)); }
}

// Replays what is queued. Runs on a schedule, and on demand via /sheets/retry.
// Apps Script's own idempotency guard makes a double send harmless.
async function drainSheetsQueue(env, limit = 50) {
  if (!env.LOGS || !env.GOOGLE_SCRIPT_URL) return { sent: 0, failed: 0, pending: 0 };
  let sent = 0, failed = 0;
  const list = await env.LOGS.list({ prefix: SHEETS_QUEUE_PREFIX, limit });
  for (const key of list.keys) {
    const raw = await env.LOGS.get(key.name);
    if (!raw) continue;
    let body;
    try { body = JSON.parse(raw); } catch { await env.LOGS.delete(key.name); continue; }
    if (await postToSheets(env, body, 1)) {
      await env.LOGS.delete(key.name);
      sent++;
    } else {
      failed++;
      break;   // still down: stop hammering, the rest keeps until next time
    }
  }
  const rest = await env.LOGS.list({ prefix: SHEETS_QUEUE_PREFIX, limit: 1000 });
  return { sent, failed, pending: rest.keys.length };
}

// ─────────────────────────────────────────────────────────────
// Download proxy  (GET /download?key=&name=)
// ─────────────────────────────────────────────────────────────
function sanitizeFilename(name) {
  return (name || "download")
    .replace(/[\x00-\x1f\x7f"\\]/g, "").replace(/\r|\n/g, "").slice(0, 200) || "download";
}

async function handleDownload(request, env) {
  const params = new URL(request.url).searchParams;
  const key    = params.get("key");
  if (!key) return json({ error: "Missing ?key= parameter" }, 400, request, env);

  // Only ever serve this Worker's own prefix, so the endpoint cannot be turned
  // into a reader for the rest of the Cloudinary account.
  if (!key.startsWith("supy-expansion/")) {
    return json({ error: "Unknown key" }, 404, request, env);
  }
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_SECRET) {
    return json({ error: "Storage not configured" }, 500, request, env);
  }

  const filename = sanitizeFilename(params.get("name") || key.split("/").pop());
  const deliver  = upstream => new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type":        upstream.headers.get("Content-Type") || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control":       "no-store",
    },
  });

  // Signed CDN delivery: base64url(SHA-1(public_id + secret)) truncated to 8 chars.
  const sigBytes = new Uint8Array(await sha1Bytes(key + env.CLOUDINARY_API_SECRET)).slice(0, 6);
  const sig = btoa(String.fromCharCode(...sigBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const cdn = await fetch(
    `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/raw/upload/s--${sig}--/${key}`,
    { redirect: "manual" }
  );
  if (cdn.status === 301 || cdn.status === 302) return Response.redirect(cdn.headers.get("location"), 302);
  if (cdn.ok) return deliver(cdn);

  // Fallback: the signed download API, for anything the CDN declines to serve.
  const ts    = Math.floor(Date.now() / 1000).toString();
  const parts = [`attachment=${filename}`, `public_id=${key}`, `timestamp=${ts}`, `type=upload`].sort();
  const apiSig = await sha1Hex(parts.join("&") + env.CLOUDINARY_API_SECRET);
  const q = new URLSearchParams({
    public_id: key, timestamp: ts, api_key: env.CLOUDINARY_API_KEY,
    signature: apiSig, attachment: filename, type: "upload",
  });
  const api = await fetch(
    `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/raw/download?${q}`,
    { redirect: "manual" }
  );
  if (api.status === 302) return Response.redirect(api.headers.get("location"), 302);
  if (api.ok) return deliver(api);

  return json({ error: "File not found" }, 404, request, env);
}

// ─────────────────────────────────────────────────────────────
// Logs, debug, rate limit
// ─────────────────────────────────────────────────────────────
async function appendLog(env, line) {
  if (!env.LOGS) return;
  try {
    const existing = (await env.LOGS.get("submissions")) || "";
    const lines    = (existing + line + "\n").split("\n").filter(Boolean);
    await env.LOGS.put("submissions", lines.slice(-200).join("\n") + "\n");
  } catch (err) {
    console.error("log append failed", String(err));
  }
}

async function handleLogs(request, env) {
  if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
    return json({ error: "Unauthorized" }, 401, request, env);
  }
  if (!env.LOGS) return json({ logs: [], note: "LOGS KV not bound" }, 200, request, env);
  const log = (await env.LOGS.get("submissions")) || "";
  return json({ logs: log.split("\n").filter(Boolean) }, 200, request, env);
}

function handleDebug(request, env) {
  if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
    return json({ error: "Unauthorized" }, 401, request, env);
  }
  return json({
    HUBSPOT_ACCESS_TOKEN:  Boolean(env.HUBSPOT_ACCESS_TOKEN || env.HUBSPOT_PAT || env.PAT),
    CLIENT_ID:             Boolean(env.CLIENT_ID),
    CLIENT_SECRET:         Boolean(env.CLIENT_SECRET),
    REFRESH_TOKEN:         Boolean(env.REFRESH_TOKEN),
    SLACK_WEBHOOK_URL:     Boolean(env.SLACK_WEBHOOK_URL),
    GMAIL_CLIENT_ID:       Boolean(env.GMAIL_CLIENT_ID),
    GMAIL_CLIENT_SECRET:   Boolean(env.GMAIL_CLIENT_SECRET),
    GMAIL_REFRESH_TOKEN:   Boolean(env.GMAIL_REFRESH_TOKEN),
    GOOGLE_SCRIPT_URL:     Boolean(env.GOOGLE_SCRIPT_URL),
    CLOUDINARY_CLOUD_NAME: Boolean(env.CLOUDINARY_CLOUD_NAME),
    CLOUDINARY_API_KEY:    Boolean(env.CLOUDINARY_API_KEY),
    CLOUDINARY_API_SECRET: Boolean(env.CLOUDINARY_API_SECRET),
    FORM_SHARED_SECRET:    Boolean(env.FORM_SHARED_SECRET),
    RETAILER_SHEET_URL:    Boolean(env.RETAILER_SHEET_URL || env.USER_ACCESS_SHEET_URL),
    COUNTRY_MANAGERS_JSON: Boolean(env.COUNTRY_MANAGERS_JSON),
    ALLOWED_ORIGINS:       env.ALLOWED_ORIGINS || "(any)",
    PUBLIC_BASE_URL:       env.PUBLIC_BASE_URL || "(request origin)",
    LOGS_bound:            Boolean(env.LOGS),
    RATELIMIT_bound:       Boolean(env.RATELIMIT),
    DRAFTS_bound:          Boolean(env.DRAFTS),
    deliveryChannels:      deliveryChannels(env),
    acceptingSubmissions:  Object.values(deliveryChannels(env)).some(Boolean),
  }, 200, request, env);
}

async function isRateLimited(env, ip) {
  if (!env.RATELIMIT || ip === "unknown") return false;
  const limit = Number(env.RATE_LIMIT) > 0 ? Number(env.RATE_LIMIT) : RATE_LIMIT_DEFAULT;
  try {
    const key = `rl:${ip}`;
    const n   = Number(await env.RATELIMIT.get(key)) || 0;
    if (n >= limit) return true;
    await env.RATELIMIT.put(key, String(n + 1), { expirationTtl: RATE_WINDOW });
    return false;
  } catch (err) {
    console.error("rate limit check failed", String(err));
    return false;   // never block a real submission because KV hiccuped
  }
}

// ─────────────────────────────────────────────────────────────
// Crypto helpers
// ─────────────────────────────────────────────────────────────
async function sha1Bytes(input) {
  return crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
}
async function sha1Hex(input) {
  const buf = await sha1Bytes(input);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish compare, so a wrong secret cannot be probed byte by byte.
function timingSafeEqual(a, b) {
  const A = new TextEncoder().encode(String(a));
  const B = new TextEncoder().encode(String(b));
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}
