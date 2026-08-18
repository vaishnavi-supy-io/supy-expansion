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
 * KV bindings (both optional — the Worker degrades rather than failing):
 *   LOGS         recent submissions, for GET /logs
 *   RATELIMIT    approximate per-IP throttle
 *
 * Routes:
 *   POST /webhook            main handler (multipart/form-data or application/json)
 *   GET  /download?key=&name= document download proxy
 *   GET  /logs               recent submission log
 *   GET  /debug              which secrets are present (requires x-admin-token)
 *   GET  /                   health check
 */

const HUBSPOT_PORTAL_ID = "9423176";

// Mirrors CONFIG in the form. Enforced again here because client-side limits
// are a courtesy to the user, not a control.
const LIMITS = {
  maxFiles:     8,
  maxFileMB:    10,
  maxTotalMB:   25,
  maxJsonBytes: 512 * 1024,
  allowedExt:   ["pdf", "jpg", "jpeg", "png", "doc", "docx", "xls", "xlsx"],
};

const DEFAULT_ENTITY = "Our existing account entity";
const SITE_TYPES     = ["Outlet", "Central Kitchen", "Warehouse"];
const ALL_TYPES      = [...SITE_TYPES, "Cost center", "Not sure"];
const DOC_KINDS      = ["registration", "vat", "address"];
const DOC_LABELS     = { registration: "Registration", vat: "VAT / TRN", address: "Commercial address" };
const KSA            = "Saudi Arabia";

// Rate limit: submissions per IP per window.
const RATE_LIMIT  = 5;
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (url.pathname === "/webhook" && request.method === "POST") {
        return await handleWebhook(request, env, ctx);
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

  // 2. Approximate rate limit. KV is eventually consistent, so a burst of
  //    parallel requests can slip past; it stops repeat submissions, not a
  //    determined flood.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await isRateLimited(env, ip)) {
    return json({ status: "error", message: "Too many requests. Try again shortly." }, 429, request, env);
  }

  // 3. Parse.
  let parsed;
  try {
    parsed = await readSubmission(request);
  } catch (err) {
    return json({ status: "error", message: err.message }, 400, request, env);
  }
  const { payload, files } = parsed;

  // 4. Validate — the same rules the form enforces, re-checked here.
  const problems = validate(payload, files);
  if (problems.length) {
    return json({ status: "error", message: "Validation failed", problems }, 400, request, env);
  }

  const submissionId = crypto.randomUUID();
  const receivedAt   = new Date().toISOString();
  const account      = payload.requester.account;
  const results      = [];

  // 5. Documents → Cloudinary. Failures are recorded but do not sink the
  //    submission: a request that reaches the team without its trade license
  //    is far better than one that is silently lost.
  let documents = [];
  if (files.length) {
    const uploaded = await uploadDocuments(env, files, account, request);
    documents = uploaded.documents;
    results.push(`documents:${uploaded.ok}/${files.length}`);
  }
  attachDocumentUrls(payload, documents);

  // 6. HubSpot.
  let contactId = null;
  const token = await getHubspotToken(env);
  if (token) {
    const { id, action } = await upsertContact(token, payload);
    contactId = id;
    if (contactId) {
      const noteId = await createNote(token, payload, documents, receivedAt, submissionId);
      if (noteId) {
        await linkEverything(token, noteId, contactId, crmCompanyName(payload));
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

  // 7. Slack.
  const slackOk = await sendSlack(env, payload, documents, contactId, submissionId);
  results.push(slackOk ? "slack:ok" : "slack:fail");

  // 8. Email. The client receipt is gated on HubSpot having recognised the
  //    contact, so this endpoint cannot be used to send Supy-branded mail to
  //    an arbitrary address.
  const internalOk = await sendInternalEmail(env, payload, documents, receivedAt, submissionId);
  results.push(internalOk ? "email:ok" : "email:fail");
  if (contactId) {
    const receiptOk = await sendClientReceipt(env, payload, documents, receivedAt, submissionId);
    results.push(receiptOk ? "receipt:ok" : "receipt:fail");
  } else {
    results.push("receipt:skipped");
  }

  // 9. Google Sheets mirror.
  const sheetsOk = await logToSheets(env, payload, documents, receivedAt, submissionId);
  results.push(sheetsOk ? "sheets:ok" : "sheets:fail");

  // 10. Log, best-effort and off the response path.
  const logLine = `${receivedAt} | ${submissionId} | ${payload.requester.email} | ${account} | ${results.join(",")}`;
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(appendLog(env, logLine));
  } else {
    await appendLog(env, logLine);
  }

  return json({
    status: "ok",
    submissionId,
    receivedAt,
    // Recomputed rather than echoed: the client's summary string is built before
    // its last edit lands, so it can disagree with the rows actually sent.
    summary: buildSubject(payload),
    counts: {
      outlets:     payload.items.filter(i => i.type !== "Cost center").length,
      costCenters: payload.items.filter(i => i.type === "Cost center").length,
      features:    payload.features.length,
      documents:   documents.length,
    },
    details: results,
  }, 200, request, env);
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
  p.items    = Array.isArray(p.items)    ? p.items    : [];
  p.features = Array.isArray(p.features) ? p.features : [];
  p.adding   = Array.isArray(p.adding)   ? p.adding   : [];
  p.billing.entities = Array.isArray(p.billing.entities) ? p.billing.entities : [];
  p.documents = Array.isArray(p.documents) ? p.documents : [];
}

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

  if (!p.adding.length) problems.push("adding must name at least one of branch, costcenter, service");
  if (!p.items.length && !p.features.length) {
    problems.push("the request is empty: no outlets, cost centers or features");
  }

  // Declared billing entities. Rows and feature lines may only point at one of
  // these, or at the account's existing entity.
  const entities    = p.billing.entities;
  const entityNames = entities.map(e => str(e.name)).filter(Boolean);
  const knownEntity = new Set([...entityNames, DEFAULT_ENTITY]);
  const billsRequired = entityNames.length > 0;

  if (new Set(entityNames).size !== entityNames.length) {
    problems.push("billing.entities contains duplicate names, so rows cannot be matched to an entity");
  }

  p.items.forEach((it, i) => {
    const at   = `items[${i}]`;
    const type = str(it.type);
    if (!str(it.name))      problems.push(`${at}.name is required`);
    if (!type)              problems.push(`${at}.type is required`);
    else if (!ALL_TYPES.includes(type)) problems.push(`${at}.type "${type}" is not a recognised type`);
    if (!str(it.cloneFrom)) problems.push(`${at}.cloneFrom is required (use "none" to set up fresh)`);

    if (SITE_TYPES.includes(type) && !str(it.address)) {
      problems.push(`${at}.address is required for a ${type}`);
    }
    if (type === "Cost center" && !str(it.parentOutlet)) {
      problems.push(`${at}.parentOutlet is required for a cost center`);
    }
    if (billsRequired && !knownEntity.has(str(it.billsUnder))) {
      problems.push(`${at}.billsUnder "${str(it.billsUnder) || "(blank)"}" is not one of the declared billing entities`);
    }
  });

  p.features.forEach((f, i) => {
    const at = `features[${i}]`;
    if (!str(f.name)) problems.push(`${at}.name is required`);
    const allocs = Array.isArray(f.allocations) ? f.allocations : [];
    if (!allocs.length) problems.push(`${at}.allocations must have at least one line`);
    allocs.forEach((a, j) => {
      const qty = Number(a && a.quantity);
      if (!Number.isFinite(qty) || qty < 1) {
        problems.push(`${at}.allocations[${j}].quantity must be 1 or more`);
      }
      if (billsRequired && !knownEntity.has(str(a && a.billsUnder))) {
        problems.push(`${at}.allocations[${j}].billsUnder is not one of the declared billing entities`);
      }
    });
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
async function uploadDocuments(env, files, account, request) {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    console.error("Cloudinary not configured — documents were received but not stored");
    return {
      ok: 0,
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
        `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/raw/upload`,
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

  return { ok: documents.filter(d => d.url).length, documents };
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
// HubSpot
// ─────────────────────────────────────────────────────────────
async function getHubspotToken(env) {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET || !env.REFRESH_TOKEN) {
    console.error("HubSpot credentials not configured");
    return null;
  }
  const r = await fetch("https://api.hubapi.com/oauth/v1/token", {
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

  const search = () => fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST", headers,
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }] }),
  });

  const searchJson = await search().then(r => r.json()).catch(() => ({}));
  const existing   = (searchJson.results || [])[0];

  if (existing) {
    const patch = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${existing.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ properties: props }),
    });
    if (!patch.ok) console.error("HubSpot contact PATCH failed", patch.status, await patch.text().catch(() => ""));
    return { id: existing.id, action: "updated" };
  }

  const create     = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
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

async function createNote(token, payload, documents, receivedAt, submissionId) {
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: {
        hs_note_body: buildNote(payload, documents, receivedAt, submissionId),
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
    fetch(`https://api.hubapi.com/crm/v3/associations/${from}/${to}/batch/create`, {
      method: "POST", headers,
      body: JSON.stringify({ inputs: [{ from: { id: fromId }, to: { id: toId }, type }] }),
    }).catch(err => console.error("association failed", type, String(err)));

  await assoc("Notes", noteId, "Contacts", contactId, "note_to_contact");

  // Any deals already on the contact.
  try {
    const r = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}/associations/deals`, { headers });
    if (r.ok) {
      for (const deal of (await r.json()).results || []) {
        await assoc("Notes", noteId, "Deals", deal.id, "note_to_deal");
      }
    }
  } catch (err) { console.error("contact deal lookup failed", String(err)); }

  if (!companyName || companyName.toLowerCase() === "unknown") return;

  // The company record, created if this is genuinely new.
  try {
    const comps = await fetch("https://api.hubapi.com/crm/v3/objects/companies/search", {
      method: "POST", headers,
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: companyName }] }] }),
    });
    const found = (await comps.json()).results || [];

    let companyId = found[0] && found[0].id;
    if (!companyId) {
      const create = await fetch("https://api.hubapi.com/crm/v3/objects/companies", {
        method: "POST", headers, body: JSON.stringify({ properties: { name: companyName } }),
      });
      if (create.status === 201) companyId = (await create.json()).id;
      else console.error("HubSpot company create failed", create.status, await create.text().catch(() => ""));
    }

    if (companyId) {
      await assoc("Contacts", contactId, "Companies", companyId, "contact_to_company");
      await assoc("Notes",    noteId,    "Companies", companyId, "note_to_company");
      const deals = await fetch(`https://api.hubapi.com/crm/v3/objects/companies/${companyId}/associations/deals`, { headers });
      if (deals.ok) {
        for (const deal of (await deals.json()).results || []) {
          await assoc("Notes", noteId, "Deals", deal.id, "note_to_deal");
        }
      }
    }
  } catch (err) { console.error("company association failed", String(err)); }
}

// ─────────────────────────────────────────────────────────────
// CRM note
// ─────────────────────────────────────────────────────────────
function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const H4 = "color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px";
const TD = "padding:5px 8px;border-bottom:1px solid #eee;vertical-align:top";
const TH = "padding:6px 8px;text-align:left";

function table(headers, rows) {
  if (!rows.length) return "<i>None.</i>";
  const head = headers.map(h => `<th style='${TH}'>${esc(h)}</th>`).join("");
  const body = rows.map(cells =>
    `<tr>${cells.map(c => `<td style='${TD}'>${c}</td>`).join("")}</tr>`
  ).join("");
  return `<table style='border-collapse:collapse;width:100%;font-size:12px'>` +
         `<tr style='background:#321e57;color:#fff'>${head}</tr>${body}</table>`;
}

function buildNote(p, documents, receivedAt, submissionId) {
  const r     = p.requester;
  const scope = p.accountScope;

  const itemRows = p.items.map((it, i) => [
    String(i + 1),
    `<b>${esc(it.name)}</b>`,
    esc(it.type),
    esc(it.parentOutlet || "—"),
    esc(it.address || "—"),
    esc(it.cloneFrom),
    esc(it.billsUnder || DEFAULT_ENTITY),
    esc(it.details || "—"),
  ]);

  const featureRows = p.features.map(f => [
    `<b>${esc(f.name)}</b>`,
    esc(f.totalQuantity),
    (Array.isArray(f.allocations) ? f.allocations : [])
      .map(a => `${esc(a.quantity)} &times; ${esc(a.billsUnder || DEFAULT_ENTITY)}`).join("<br>") || "—",
  ]);

  const entityRows = p.billing.entities.map(e => [
    `<b>${esc(e.name)}</b>`,
    esc(e.registrationNumber || "—"),
    esc(e.trn || "—"),
    (e.documentLinks || []).length
      ? e.documentLinks.map(d => d.url
          ? `<a href='${esc(d.url)}' style='color:#503390;font-weight:600;text-decoration:none'>⬇ ${esc(DOC_LABELS[d.category] || d.category)}</a>`
          : `${esc(DOC_LABELS[d.category] || d.category)} <span style='color:#c00'>(upload failed)</span>`
        ).join("<br>")
      : "—",
  ]);

  const failed = documents.filter(d => !d.url).length;

  return [
    `<h3 style='color:#321e57;margin:0 0 4px'>SUPY EXPANSION REQUEST</h3>`,
    `<p style='color:#888;font-size:11px;margin:0 0 16px'>Received: ${esc(receivedAt)} &middot; Ref: ${esc(submissionId)}</p>`,

    `<h4 style='${H4}'>REQUESTER</h4>`,
    `Company / group: ${esc(r.account)}<br>Contact: ${esc(r.name)}<br>Email: ${esc(r.email)}<br>` +
    `Phone: ${esc(r.phone || "—")}<br>Country: ${esc(r.country || "—")}`,

    `<h4 style='${H4}'>ACCOUNT SCOPE</h4>`,
    `Sits under: <b>${esc(scope.target || "—")}</b><br>` +
    `Existing account: ${esc(scope.existingAccountName || "—")}<br>` +
    `New account name: ${esc(scope.newAccountName || "—")}<br>` +
    `Adding: ${esc(p.adding.join(", ") || "—")}`,

    `<h4 style='${H4}'>OUTLETS &amp; COST CENTERS (${p.items.length})</h4>`,
    table(["#", "Name", "Type", "Belongs to", "Address", "Clone from", "Bills under", "Details"], itemRows),

    `<h4 style='${H4}'>SERVICES / FEATURES (${p.features.length})</h4>`,
    table(["Feature", "Qty", "Billing split"], featureRows),

    `<h4 style='${H4}'>BILLING</h4>`,
    `Same legal entity as existing: <b>${esc(p.billing.sameLegalEntity || "—")}</b>`,
    p.billing.entities.length
      ? table(["Legal entity", "CRN / license", "TRN / VAT", "Documents"], entityRows)
      : "",
    failed ? `<p style='color:#c00;font-size:12px'><b>${failed} document(s) could not be stored.</b> Ask the client to resend them.</p>` : "",

    `<h4 style='${H4}'>NOTES</h4>`,
    esc(p.notes || "—").replace(/\n/g, "<br>"),
  ].filter(Boolean).join("");
}

// ─────────────────────────────────────────────────────────────
// Email (Gmail OAuth refresh-token flow)
//
// Two messages: an internal notification to the team, and a receipt to the
// client showing exactly what they submitted. The receipt only goes out when
// HubSpot recognised the contact — otherwise anyone could use this endpoint to
// send Supy-branded mail to an address of their choosing.
// ─────────────────────────────────────────────────────────────
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

async function sendInternalEmail(env, payload, documents, receivedAt, submissionId) {
  const token = await getGmailToken(env);
  if (!token) return false;
  return sendGmail(token, {
    to:      EMAIL_RECIPIENTS.join(", "),
    replyTo: str(payload.requester.email) || undefined,
    subject: buildSubject(payload),
    html:    shell(buildNote(payload, documents, receivedAt, submissionId)),
  });
}

async function sendClientReceipt(env, payload, documents, receivedAt, submissionId) {
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
      ${buildNote(payload, documents, receivedAt, submissionId)}
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

async function sendSlack(env, p, documents, contactId, submissionId) {
  if (!env.SLACK_WEBHOOK_URL) {
    console.error("SLACK_WEBHOOK_URL not configured");
    return false;
  }

  const outlets = p.items.filter(i => i.type !== "Cost center");
  const centers = p.items.filter(i => i.type === "Cost center");
  const hsLink  = contactId
    ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${contactId}`
    : "https://app.hubspot.com/contacts/";

  const blocks = [
    { type: "header", text: { type: "plain_text", text: "🏗️ New Expansion Request", emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Account:*\n${smk(p.requester.account)}` },
        { type: "mrkdwn", text: `*Contact:*\n${smk(p.requester.name)} (${smk(p.requester.email)})` },
        { type: "mrkdwn", text: `*Sits under:*\n${smk(p.accountScope.target || "—")}${p.accountScope.existingAccountName ? `\n${smk(p.accountScope.existingAccountName)}` : ""}` },
        { type: "mrkdwn", text: `*Country:*\n${smk(p.requester.country || "—")}` },
        { type: "mrkdwn", text: `*Adding:*\n${outlets.length} outlet(s), ${centers.length} cost center(s), ${p.features.length} feature(s)` },
        { type: "mrkdwn", text: `*Billing:*\n${smk(p.billing.sameLegalEntity || "—")}` },
      ],
    },
  ];

  if (p.items.length) {
    const lines = p.items.map(i => {
      const where = i.type === "Cost center" ? `inside ${i.parentOutlet}` : (i.address || "no address");
      const bills = i.billsUnder && i.billsUnder !== DEFAULT_ENTITY ? ` · bills: ${i.billsUnder}` : "";
      return `• *${smk(i.name)}* — ${smk(i.type)} · ${smk(where)} · clone: ${smk(i.cloneFrom)}${smk(bills)}`;
    }).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(`*Outlets & cost centers*\n${lines}`) } });
  }

  if (p.features.length) {
    const lines = p.features.map(f => {
      const allocs = (Array.isArray(f.allocations) ? f.allocations : [])
        .map(a => `${a.quantity} × ${smk(a.billsUnder || DEFAULT_ENTITY)}`).join(", ");
      return `• *${smk(f.name)}* — ${smk(f.totalQuantity)} total${allocs ? ` (${allocs})` : ""}`;
    }).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(`*Services / features*\n${lines}`) } });
  }

  if (p.billing.entities.length) {
    const lines = p.billing.entities.map(e =>
      `• *${smk(e.name)}* — CRN ${smk(e.registrationNumber || "—")} · TRN ${smk(e.trn || "—")}`
    ).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(`*Billing entities*\n${lines}`) } });
  }

  if (p.notes) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(`*Notes*\n${smk(p.notes)}`, 1200) } });
  }

  const failed = documents.filter(d => !d.url);
  if (failed.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:warning: *${failed.length} document(s) could not be stored* — ask the client to resend: ${failed.map(d => smk(d.filename)).join(", ")}` },
    });
  }

  // Slack allows at most 5 elements in an actions block.
  const buttons = [{ type: "button", text: { type: "plain_text", text: "View in HubSpot", emoji: true }, style: "primary", url: hsLink }];
  documents.filter(d => d.url).slice(0, 4).forEach(d => {
    buttons.push({
      type: "button",
      text: { type: "plain_text", text: `📎 ${(DOC_LABELS[d.category] || d.category).slice(0, 20)}`, emoji: true },
      url: d.url,
    });
  });
  blocks.push({ type: "actions", elements: buttons });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Ref \`${submissionId}\` · nothing has been provisioned — this is a request` }] });

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

function buildSubject(p) {
  const outlets = p.items.filter(i => i.type !== "Cost center").length;
  const centers = p.items.filter(i => i.type === "Cost center").length;
  const bits = [];
  if (outlets) bits.push(`${outlets} outlet${outlets === 1 ? "" : "s"}`);
  if (centers) bits.push(`${centers} cost center${centers === 1 ? "" : "s"}`);
  if (p.features.length) bits.push(`${p.features.length} feature${p.features.length === 1 ? "" : "s"}`);
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

const newDraftKey = () => crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const isDraftKey  = k => typeof k === "string" && /^[a-f0-9]{40}$/.test(k);

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
async function logToSheets(env, p, documents, receivedAt, submissionId) {
  if (!env.GOOGLE_SCRIPT_URL) return false;

  const entityOf = name => (name && name !== DEFAULT_ENTITY ? name : "Existing account entity");

  const rows = [
    ...p.items.map(i => ({
      kind:       i.type === "Cost center" ? "Cost center" : "Outlet",
      name:       i.name,
      type:       i.type,
      parent:     i.parentOutlet || "",
      address:    i.address || "",
      cloneFrom:  i.cloneFrom || "",
      quantity:   1,
      billsUnder: entityOf(i.billsUnder),
      details:    i.details || "",
    })),
    ...p.features.flatMap(f =>
      (Array.isArray(f.allocations) ? f.allocations : []).map(a => ({
        kind:       "Feature",
        name:       f.name,
        type:       "Feature",
        parent:     "", address: "", cloneFrom: "",
        quantity:   Number(a.quantity) || 0,
        billsUnder: entityOf(a.billsUnder),
        details:    "",
      }))),
  ];

  try {
    const res = await fetch(env.GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
        newAccount:      p.accountScope.newAccountName || "",
        outletCount:     p.items.filter(i => i.type !== "Cost center").length,
        costCenterCount: p.items.filter(i => i.type === "Cost center").length,
        featureCount:    p.features.length,
        sameLegalEntity: p.billing.sameLegalEntity || "",
        entities: p.billing.entities.map(e => ({
          name: e.name, registrationNumber: e.registrationNumber || "", trn: e.trn || "",
        })),
        documents: documents.map(d => ({ filename: d.filename, category: d.category, url: d.url || "" })),
        notes: p.notes || "",
        rows,
      }),
    });
    if (!res.ok) console.error("Sheets append failed", res.status);
    return res.ok;
  } catch (err) {
    console.error("Sheets append threw", String(err));
    return false;
  }
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
    ALLOWED_ORIGINS:       env.ALLOWED_ORIGINS || "(any)",
    PUBLIC_BASE_URL:       env.PUBLIC_BASE_URL || "(request origin)",
    LOGS_bound:            Boolean(env.LOGS),
    RATELIMIT_bound:       Boolean(env.RATELIMIT),
    DRAFTS_bound:          Boolean(env.DRAFTS),
  }, 200, request, env);
}

async function isRateLimited(env, ip) {
  if (!env.RATELIMIT || ip === "unknown") return false;
  try {
    const key = `rl:${ip}`;
    const n   = Number(await env.RATELIMIT.get(key)) || 0;
    if (n >= RATE_LIMIT) return true;
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
