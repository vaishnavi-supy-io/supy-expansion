/**
 * Supy Expansion Request — Google Sheets receiver
 *
 * Setup:
 *   1. Create a spreadsheet.
 *   2. Extensions → Apps Script, paste this in, save.
 *   3. Deploy → New deployment → Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      "Anyone" is what lets the Worker POST without a Google login. The URL is
 *      the only thing guarding it, so treat it as a secret and set it with
 *      `wrangler secret put GOOGLE_SCRIPT_URL` rather than committing it.
 *   4. Copy the deployment URL into the Worker secret above.
 *
 * Writes two sheets:
 *   Requests — one row per submission, for tracking
 *   Items    — one row per allocation line, so a product split across two
 *              entities becomes two rows, for whoever provisions it
 */

var REQUEST_HEADERS = [
  "Received", "Ref", "Account", "Contact", "Email", "Phone", "Country",
  "Sits under", "Existing account", "Retailer ID", "New account",
  "Outlets", "CK add-ons", "WH add-ons", "Cost centers", "Features",
  "Same legal entity", "Billing entities", "Documents", "Notes", "Summary"
];

var ITEM_HEADERS = [
  "Received", "Ref", "Account", "Kind", "Item", "Item ID", "Qty", "Bills under"
];

function doPost(e) {
  try {
    var d = parseBody(e);
    if (!d || !d.submissionId) {
      return reply({ status: "error", message: "Missing submissionId" });
    }

    var ss = getLogSpreadsheet();
    var requests = sheetFor(ss, "Requests", REQUEST_HEADERS);
    var items    = sheetFor(ss, "Items",    ITEM_HEADERS);

    // Re-posting the same submission must not double the rows. The Worker
    // retries on transient failure, and a duplicate row reads as a duplicate
    // request to whoever is working the sheet.
    if (alreadyLogged(requests, d.submissionId)) {
      return reply({ status: "ok", duplicate: true });
    }

    var entities = (d.entities || []).map(function (x) {
      return x.name + " (CRN " + (x.registrationNumber || "—") + ", TRN " + (x.trn || "—") + ")";
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
      d.sameLegalEntity || "", entities, docs, d.notes || "", d.summary || ""
    ]);

    (d.rows || []).forEach(function (r) {
      items.appendRow([
        d.receivedAt || "", d.submissionId, d.account || "",
        r.kind || "", r.name || "", r.itemId || "", r.quantity || "", r.billsUnder || ""
      ]);
    });

    return reply({ status: "ok", itemsAppended: (d.rows || []).length });
  } catch (err) {
    return reply({ status: "error", message: String(err) });
  }
}

var DATA_SPREADSHEET_ID = "1raBGqWqxVaUcraY0gjR-CFQT3T2_TheemPfOpihmmFE";
var DATA_SHEET_GID = 599203487;
// Where Requests/Items are written. Leave null to use the spreadsheet this script is bound to.
// IMPORTANT: Do NOT set this to the Data sheet — it refreshes daily and wipes your writes.
var LOG_SPREADSHEET_ID = null; // e.g. "1AbC...logSheetId"
var ACCESS_SPREADSHEET_ID = DATA_SPREADSHEET_ID;
var ACCESS_SHEET_GID = DATA_SHEET_GID;

function getLogSpreadsheet() {
  var ss = null;
  if (LOG_SPREADSHEET_ID) {
    try { ss = SpreadsheetApp.openById(LOG_SPREADSHEET_ID); } catch (err) {}
  }
  if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
  // Guard: never write to the Data codebase sheet
  try { if (ss.getId() === DATA_SPREADSHEET_ID) throw new Error("Refusing to write to Data sheet"); } catch (err) {
    throw new Error("LOG_SPREADSHEET_ID must be a different spreadsheet than the Data codebase sheet. Create a new spreadsheet for Requests/Items and set its ID in LOG_SPREADSHEET_ID, or bind this script to that log spreadsheet.");
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
      var data = sh.getDataRange().getValues();
      var headers = data[0].map(function(h){ return String(h).trim().toLowerCase(); });
      var emailIdx = headers.indexOf("email");
      var nameIdx = headers.indexOf("retailer name");
      if (nameIdx === -1) nameIdx = headers.indexOf("retailer");
      if (nameIdx === -1) nameIdx = headers.indexOf("account");
      var idIdx = headers.indexOf("retailer id");
      if (idIdx === -1) idIdx = headers.indexOf("retailer_id");
      if (emailIdx === -1 || nameIdx === -1) return reply({ retailers: [] });
      if (idIdx === -1) return reply({ retailers: [], error: "Access sheet has no 'retailer id' column" });
      var want = String(email).trim().toLowerCase();
      var out = [];
      var seen = {};
      var missingId = 0;
      for (var i=1;i<data.length;i++){
        var rowEmail = String(data[i][emailIdx] || "").trim().toLowerCase();
        if (rowEmail !== want) continue;
        var name = String(data[i][nameIdx] || "").trim();
        if (!name) continue;
        var rid = String(data[i][idIdx] || "").trim();
        // The retailer id is the identity everything downstream keys off. A row
        // without one cannot route a request, so it is counted and skipped
        // rather than offered as a choice that quietly resolves to nothing.
        if (!rid) { missingId++; continue; }
        if (seen[rid]) continue;
        seen[rid] = true;
        out.push({ name: name, retailerId: rid });
      }
      return reply({ retailers: out, missingId: missingId });
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
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length)
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
