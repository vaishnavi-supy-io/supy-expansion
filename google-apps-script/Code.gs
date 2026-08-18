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
 *   Items    — one row per outlet, cost center or feature allocation, for the
 *              person actually working through what needs setting up
 */

var REQUEST_HEADERS = [
  "Received", "Ref", "Account", "Contact", "Email", "Phone", "Country",
  "Sits under", "Existing account", "New account",
  "Outlets", "Cost centers", "Features",
  "Same legal entity", "Billing entities", "Documents", "Notes", "Summary"
];

var ITEM_HEADERS = [
  "Received", "Ref", "Account", "Kind", "Name", "Type",
  "Belongs to", "Address", "Clone from", "Qty", "Bills under", "Details"
];

function doPost(e) {
  try {
    var d = parseBody(e);
    if (!d || !d.submissionId) {
      return reply({ status: "error", message: "Missing submissionId" });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
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
      d.scope || "", d.existingAccount || "", d.newAccount || "",
      d.outletCount || 0, d.costCenterCount || 0, d.featureCount || 0,
      d.sameLegalEntity || "", entities, docs, d.notes || "", d.summary || ""
    ]);

    (d.rows || []).forEach(function (r) {
      items.appendRow([
        d.receivedAt || "", d.submissionId, d.account || "",
        r.kind || "", r.name || "", r.type || "", r.parent || "", r.address || "",
        r.cloneFrom || "", r.quantity || "", r.billsUnder || "", r.details || ""
      ]);
    });

    return reply({ status: "ok", itemsAppended: (d.rows || []).length });
  } catch (err) {
    return reply({ status: "error", message: String(err) });
  }
}

function doGet() {
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
