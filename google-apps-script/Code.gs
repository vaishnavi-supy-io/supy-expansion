/**
 * Supy Expansion Request - Google Sheets receiver
 *
 * Setup:
 *   1. Create a spreadsheet.
 *   2. Extensions -> Apps Script, paste this in, save.
 *   3. Deploy -> New deployment -> Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      "Anyone" is what lets the Worker POST without a Google login. The URL is
 *      the only thing guarding it, so treat it as a secret and set it with
 *      `wrangler secret put GOOGLE_SCRIPT_URL` rather than committing it.
 *   4. Copy the deployment URL into the Worker secret above.
 *
 * Writes four sheets:
 *   Requests  - one row per submission, for tracking
 *   Items     - one row per allocation line, so a product split across two
 *               entities becomes two rows, for whoever provisions it
 *   Entities  - one row per billing entity
 *   Documents - one row per uploaded document
 *
 * Rows are written to LOG_SPREADSHEET_ID below, not to whatever spreadsheet
 * this script happens to be bound to. After editing this file, Deploy ->
 * Manage deployments -> edit -> New version, or the running web app keeps
 * serving the old code.
 */

var REQUEST_HEADERS = [
  "Received", "Ref", "Account", "Contact", "Email", "Phone", "Country",
  "Sits under", "Existing account", "Retailer ID", "New account",
  "Outlets", "CK add-ons", "WH add-ons", "Cost centers", "Features",
  "Same legal entity", "Billing entities",
  "Documents", "Docs uploaded", "Docs stored", "Zip bundle",
  "Country manager", "HubSpot contact", "HubSpot deal", "Onboarding deal",
  "HubSpot companies", "HubSpot note", "Delivery", "Notes", "Summary"
];

var ITEM_HEADERS = [
  "Received", "Ref", "Account", "Kind", "Item", "Item ID", "Qty", "Bills under"
];

var ENTITY_HEADERS = [
  "Received", "Ref", "Account", "Legal entity", "CRN / license", "TRN / VAT", "Documents"
];

var DOCUMENT_HEADERS = [
  "Received", "Ref", "Account", "Legal entity", "Category", "Filename",
  "Size (bytes)", "Stored", "Link", "Error"
];

function doPost(e) {
  try {
    var d = parseBody(e);
    if (!d || !d.submissionId) {
      return reply({ status: "error", message: "Missing submissionId" });
    }

    var ss = getLogSpreadsheet();
    var requests = sheetFor(ss, "Requests",  REQUEST_HEADERS);
    var items    = sheetFor(ss, "Items",     ITEM_HEADERS);
    var entitiesSheet  = sheetFor(ss, "Entities",  ENTITY_HEADERS);
    var documentsSheet = sheetFor(ss, "Documents", DOCUMENT_HEADERS);

    // Re-posting the same submission must not double the rows. The Worker
    // retries on transient failure, and a duplicate row reads as a duplicate
    // request to whoever is working the sheet.
    if (alreadyLogged(requests, d.submissionId)) {
      return reply({ status: "ok", duplicate: true, spreadsheetId: ss.getId() });
    }

    var entities = (d.entities || []).map(function (x) {
      return x.name + " (CRN " + (x.registrationNumber || "-") + ", TRN " + (x.trn || "-") + ")";
    }).join("\n");

    var docs = (d.documents || []).map(function (x) {
      return x.category + ": " + x.filename + (x.url ? " " + x.url : " (not stored)");
    }).join("\n");

    requests.appendRow([
      d.receivedAt || "", d.submissionId, d.account || "", d.contactName || "",
      d.contactEmail || "", d.contactPhone || "", d.country || "",
      d.scope || "", d.existingAccount || "", d.existingRetailerId || "", d.newAccount || "",
      d.outletCount || 0, d.ckAddonCount || 0, d.whAddonCount || 0,
      d.costCenterCount || 0, d.featureCount || 0,
      d.sameLegalEntity || "", entities,
      docs, d.documentCount || 0, d.documentsStored || 0,
      d.bundleUrl ? (d.bundleFilename || "bundle") + " " + d.bundleUrl : "",
      d.countryManager || "",
      d.hubspotContactUrl || d.hubspotContactId || "",
      d.hubspotDealUrl || d.hubspotDealId || "",
      d.onboardingDealId || "",
      d.hubspotCompanyIds || "",
      d.hubspotNoteId || "",
      d.deliveryResults || "",
      d.notes || "", d.summary || ""
    ]);

    (d.rows || []).forEach(function (r) {
      items.appendRow([
        d.receivedAt || "", d.submissionId, d.account || "",
        r.kind || "", r.name || "", r.itemId || "", r.quantity || "", r.billsUnder || ""
      ]);
    });

    // One row per billing entity, and one per document, so nothing is squashed
    // into a cell that has to be read by eye.
    (d.entities || []).forEach(function (x) {
      entitiesSheet.appendRow([
        d.receivedAt || "", d.submissionId, d.account || "",
        x.name || "", x.registrationNumber || "", x.trn || "", x.documents || ""
      ]);
    });

    (d.documents || []).forEach(function (x) {
      documentsSheet.appendRow([
        d.receivedAt || "", d.submissionId, d.account || "",
        x.entity || "", x.category || "", x.filename || "",
        x.sizeBytes || 0, x.stored || "", x.url || "", x.error || ""
      ]);
    });

    // The Worker records this id alongside sheets:ok, so a request that was
    // written to the wrong spreadsheet says so in the response instead of
    // looking identical to a healthy one.
    return reply({
      status: "ok",
      spreadsheetId: ss.getId(),
      itemsAppended: (d.rows || []).length,
      entitiesAppended: (d.entities || []).length,
      documentsAppended: (d.documents || []).length
    });
  } catch (err) {
    return reply({ status: "error", message: String(err) });
  }
}

var DATA_SPREADSHEET_ID = "1raBGqWqxVaUcraY0gjR-CFQT3T2_TheemPfOpihmmFE";
var DATA_SHEET_GID = 599203487;
// Where Requests/Items are written - a spreadsheet of our own, never the
// directory above: that one refreshes daily and would wipe every row.
var LOG_SPREADSHEET_ID = "1f0pRoEUI9XFWscSQ9uo5tboFGmMy68PBGi5ZFFBQuHQ";
var ACCESS_SPREADSHEET_ID = DATA_SPREADSHEET_ID;
var ACCESS_SHEET_GID = DATA_SHEET_GID;

function getLogSpreadsheet() {
  var ss = null;
  if (LOG_SPREADSHEET_ID) {
    // Falling back to the bound spreadsheet here is what hid the problem for
    // two days: rows kept appending to whatever this script happens to live
    // in, while LOG_SPREADSHEET_ID sat empty and every submission still
    // reported the mirror as healthy. If the named spreadsheet cannot be
    // opened, say so.
    try {
      ss = SpreadsheetApp.openById(LOG_SPREADSHEET_ID);
    } catch (err) {
      throw new Error("Cannot open LOG_SPREADSHEET_ID " + LOG_SPREADSHEET_ID + ": " + String(err));
    }
  } else {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }
  // The directory refreshes daily and would wipe anything written into it.
  if (ss.getId() === DATA_SPREADSHEET_ID) {
    throw new Error("Refusing to write to the retailer directory. Point LOG_SPREADSHEET_ID at a spreadsheet of our own.");
  }
  return ss;
}

function doGet(e) {
  try {
    var email = e && e.parameter && e.parameter.email;
    if (email) {
      var ss = null;
      try { ss = SpreadsheetApp.openById(ACCESS_SPREADSHEET_ID); } catch (err) { ss = SpreadsheetApp.getActiveSpreadsheet(); }
      var sh = null;
      // Prefer the gid the user linked, then name fallback
      if (ACCESS_SHEET_GID) {
        try { sh = ss.getSheets().filter(function(s){ return s.getSheetId() === ACCESS_SHEET_GID; })[0] || null; } catch (err) {}
      }
      if (!sh) sh = ss.getSheetByName("Access");
      if (!sh) sh = ss.getSheets()[0];
      if (!sh) return reply({ retailers: [] });
      // The directory is one row per user x outlet x location and runs to
      // several megabytes, so getDataRange().getValues() pulls hundreds of
      // thousands of cells on every keystroke's worth of lookup - that is what
      // was timing the Worker out. TextFinder searches server-side and returns
      // only the matching cells, and the answer is cached per email.
      var want = String(email).trim().toLowerCase();
      var cache = null;
      try { cache = CacheService.getScriptCache(); } catch (err) {}
      if (cache) {
        var hit = cache.get("acc:" + want);
        if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
      }

      var lastCol  = sh.getLastColumn();
      var headers  = sh.getRange(1, 1, 1, lastCol).getValues()[0]
                       .map(function(h){ return String(h).trim().toLowerCase(); });
      // The directory calls it "User Email"; older copies just "Email".
      var emailIdx = headers.indexOf("user email");
      if (emailIdx === -1) emailIdx = headers.indexOf("email");
      var nameIdx  = headers.indexOf("retailer name");
      if (nameIdx === -1) nameIdx = headers.indexOf("retailer");
      if (nameIdx === -1) nameIdx = headers.indexOf("account");
      var idIdx    = headers.indexOf("retailer id");
      if (idIdx === -1) idIdx = headers.indexOf("retailer_id");
      if (emailIdx === -1) return reply({ retailers: [], error: "No email column in " + sh.getName() });
      if (nameIdx === -1 || idIdx === -1) return reply({ retailers: [], error: "No retailer name/id column in " + sh.getName() });

      var rows = [];
      var found = sh.createTextFinder(want).matchEntireCell(true).matchCase(false).findAll();
      for (var f = 0; f < found.length && rows.length < 500; f++) {
        if (found[f].getColumn() === emailIdx + 1 && found[f].getRow() > 1) rows.push(found[f].getRow());
      }
      if (!rows.length) {
        var emptyBody = JSON.stringify({ retailers: [], missingId: 0 });
        if (cache) { try { cache.put("acc:" + want, emptyBody, 300); } catch (err) {} }
        return ContentService.createTextOutput(emptyBody).setMimeType(ContentService.MimeType.JSON);
      }

      // Rows for one user are contiguous in a directory sorted by email, so one
      // ranged read usually covers them; scattered rows fall back to per-row.
      rows.sort(function(a,b){ return a - b; });
      var lo = rows[0], hi = rows[rows.length - 1];
      var block = null, blockStart = lo;
      if (hi - lo + 1 <= 1000) block = sh.getRange(lo, 1, hi - lo + 1, lastCol).getValues();
      function rowValues(r){
        if (block) return block[r - blockStart];
        return sh.getRange(r, 1, 1, lastCol).getValues()[0];
      }

      var out = [];
      var seen = {};
      var missingId = 0;
      for (var i = 0; i < rows.length; i++) {
        var v = rowValues(rows[i]);
        if (!v) continue;
        var name = String(v[nameIdx] || "").trim();
        if (!name) continue;
        // The retailer id is the identity everything downstream keys off. A row
        // without one cannot route a request, so it is counted and skipped
        // rather than offered as a choice that quietly resolves to nothing.
        var rid = String(v[idIdx] || "").trim();
        if (!rid) { missingId++; continue; }
        if (seen[rid]) continue;
        seen[rid] = true;
        out.push({ name: name, retailerId: rid });
      }

      var body = JSON.stringify({ retailers: out, missingId: missingId });
      if (cache) { try { cache.put("acc:" + want, body, 600); } catch (err) {} }
      return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
    }
  } catch (err) {
    return reply({ retailers: [], error: String(err) });
  }
  return reply({ status: "ok", service: "supy-expansion sheets receiver" });
}

function parseBody(e) {
  if (e && e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (err) { /* fall through */ }
  }
  return (e && e.parameter) || null;
}

function sheetFor(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  // A new sheet is 26 columns wide and Requests is 31, and appendRow throws
  // when the row is wider than the grid. Left unwidened, every append fails -
  // and because Apps Script returns 200 with the error in the body, the Worker
  // would report the mirror healthy while nothing was ever written.
  var grid = sheet.getMaxColumns();
  if (grid < headers.length) sheet.insertColumnsAfter(grid, headers.length - grid);

  // A tab left by an earlier version of this script carries a shorter header.
  // Rewriting it labels the new columns; the rows already there keep the
  // columns they were written with.
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() < headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
         .setFontWeight("bold").setBackground("#321e57").setFontColor("#ffffff");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function alreadyLogged(sheet, ref) {
  var last = sheet.getLastRow();
  if (last < 2) return false;
  // Only the recent tail is checked: retries arrive within seconds, and reading
  // thousands of rows on every submission is a needless cost.
  var start = Math.max(2, last - 200);
  var refs  = sheet.getRange(start, 2, last - start + 1, 1).getValues();
  for (var i = 0; i < refs.length; i++) {
    if (refs[i][0] === ref) return true;
  }
  return false;
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}
