/**
 * Pulls the expansion record out of the Worker and into this spreadsheet.
 *
 * WHY IT PULLS RATHER THAN RECEIVING A PUSH
 *
 * The original design had the Worker POST to a web app deployment here. That
 * cannot work on this Workspace: sharing a deployment with "Anyone" is blocked
 * by policy, so the only option is "Anyone within Supy", which refuses
 * anonymous callers. A Cloudflare Worker is anonymous, so Google answered every
 * POST with a sign-in page and the mirror recorded nothing.
 *
 * The restriction is on INBOUND anonymous requests. A time-driven trigger runs
 * as you and makes OUTBOUND requests, so it needs no deployment, no sharing and
 * no admin change. Same rows, opposite direction.
 *
 * WHERE IT WRITES
 *
 * LOG_SPREADSHEET_ID below, falling back to the bound spreadsheet. It refuses
 * to write to the retailer directory, the same guard Code.gs carries: that
 * sheet is read-only source data, and appending Requests/Items into it would
 * corrupt the thing every lookup depends on.
 *
 * SETUP (once)
 *   1. Extensions -> Apps Script, add this as a NEW file alongside Code.gs.
 *      Do not replace Code.gs; the two are unrelated and both are wanted.
 *   2. Project Settings -> Script Properties -> add:
 *        ADMIN_TOKEN   the contents of worker/.admin-token
 *      (A property, not a constant: the token must not live in source.)
 *   3. Run backfill() once and authorise when prompted. It loads everything
 *      already recorded.
 *   4. Run installTrigger() once. It then updates itself every 15 minutes.
 *
 * Rows are keyed on submission_id and line_no, so a pull that overlaps an
 * earlier one updates rows rather than duplicating them. Re-run any of this as
 * often as you like.
 */

var BASE = 'https://expansion.supy.io/export.csv';

// Where the rows land. Same ids Code.gs uses.
var LOG_SPREADSHEET_ID  = '1f0pRoEUI9XFWscSQ9uo5tboFGmMy68PBGi5ZFFBQuHQ';
var DATA_SPREADSHEET_ID = '1raBGqWqxVaUcraY0gjR-CFQT3T2_TheemPfOpihmmFE';  // never write here
var TABS = {
  requests: { name: 'Requests', url: BASE,                  key: ['submission_id'] },
  items:    { name: 'Items',    url: BASE + '?table=items', key: ['submission_id', 'line_no'] }
};

function backfill()      { TABS_forEach_(function (t) { sync_(t, null); }); }
function syncRecent()    { TABS_forEach_(function (t) { sync_(t, daysAgoIso_(7)); }); }
function TABS_forEach_(fn) { fn(TABS.requests); fn(TABS.items); }

/** Every 15 minutes, catching anything the previous run missed. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncRecent') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncRecent').timeBased().everyMinutes(15).create();
  Logger.log('Trigger installed: syncRecent every 15 minutes.');
}

function sync_(tab, sinceIso) {
  var token = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
  if (!token) throw new Error('Set ADMIN_TOKEN in Project Settings -> Script Properties first.');

  var url = tab.url + (sinceIso ? (tab.url.indexOf('?') === -1 ? '?' : '&') + 'since=' + encodeURIComponent(sinceIso) : '');
  var res = UrlFetchApp.fetch(url, {
    headers: { 'x-admin-token': token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(tab.name + ': worker returned ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  }

  var rows = Utilities.parseCsv(res.getContentText());
  if (rows.length < 2) { Logger.log(tab.name + ': nothing to write.'); return; }

  var header = rows[0];
  var sheet  = sheetFor_(tab.name, header);
  // Rewrite the header if the export gained a column, so old sheets keep up.
  if (sheet.getLastColumn() !== header.length) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }

  var keyCols = tab.key.map(function (k) { return header.indexOf(k); });
  if (keyCols.some(function (i) { return i < 0; })) throw new Error(tab.name + ': key column missing from export');

  // Existing keys -> row number, so a re-pull updates in place.
  var index = {};
  var last  = sheet.getLastRow();
  if (last > 1) {
    var existing = sheet.getRange(2, 1, last - 1, header.length).getValues();
    for (var i = 0; i < existing.length; i++) {
      index[keyCols.map(function (c) { return existing[i][c]; }).join('\u0000')] = i + 2;
    }
  }

  var appends = 0, updates = 0;
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r];
    while (row.length < header.length) row.push('');
    var k = keyCols.map(function (c) { return row[c]; }).join('\u0000');
    if (index[k]) {
      sheet.getRange(index[k], 1, 1, header.length).setValues([row]);
      updates++;
    } else {
      sheet.appendRow(row);
      index[k] = sheet.getLastRow();
      appends++;
    }
  }
  Logger.log(tab.name + ': ' + appends + ' added, ' + updates + ' updated.');
}

/** The log spreadsheet, never the retailer directory. */
function logSpreadsheet_() {
  var ss = null;
  if (LOG_SPREADSHEET_ID) {
    try { ss = SpreadsheetApp.openById(LOG_SPREADSHEET_ID); }
    catch (err) { throw new Error('Cannot open LOG_SPREADSHEET_ID ' + LOG_SPREADSHEET_ID + ': ' + err); }
  }
  if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No spreadsheet to write to. Set LOG_SPREADSHEET_ID.');
  if (ss.getId() === DATA_SPREADSHEET_ID) {
    throw new Error('Refusing to write to the retailer directory. Point LOG_SPREADSHEET_ID at a spreadsheet of our own.');
  }
  return ss;
}

function sheetFor_(name, header) {
  var ss = logSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
  }
  return sheet;
}

function daysAgoIso_(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}
