-- Durable record of every submission, on Cloudflare's own storage.
--
-- This exists because the Google Sheets mirror depends on an Apps Script
-- deployment that Supy's Workspace policy will not let us share publicly, so
-- the Worker cannot reach it. D1 needs no external account, no sharing and no
-- admin change: it lives on the same Cloudflare account as the Worker.
--
-- The scalar columns are the ones worth querying and exporting. `payload`
-- keeps the whole mirror row as JSON so nothing is lost to a schema that was
-- designed before someone needed a field.

CREATE TABLE IF NOT EXISTS submissions (
  submission_id        TEXT PRIMARY KEY,
  received_at          TEXT NOT NULL,
  summary              TEXT,
  account              TEXT,
  contact_name         TEXT,
  contact_email        TEXT,
  contact_phone        TEXT,
  country              TEXT,
  country_manager      TEXT,
  scope                TEXT,
  existing_account     TEXT,
  existing_retailer_id TEXT,
  new_account          TEXT,
  outlet_count         INTEGER DEFAULT 0,
  ck_addon_count       INTEGER DEFAULT 0,
  wh_addon_count       INTEGER DEFAULT 0,
  cost_center_count    INTEGER DEFAULT 0,
  feature_count        INTEGER DEFAULT 0,
  document_count       INTEGER DEFAULT 0,
  documents_stored     INTEGER DEFAULT 0,
  bundle_url           TEXT,
  hubspot_contact_id   TEXT,
  hubspot_deal_id      TEXT,
  hubspot_note_id      TEXT,
  onboarding_deal_id   TEXT,
  delivery_results     TEXT,
  notes                TEXT,
  payload              TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_received  ON submissions (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_email     ON submissions (contact_email);
CREATE INDEX IF NOT EXISTS idx_submissions_country   ON submissions (country);
CREATE INDEX IF NOT EXISTS idx_submissions_account   ON submissions (account);

-- One row per allocated line, so "what did they actually ask for" is a query
-- rather than a JSON walk. Mirrors the Items tab the sheet had.
CREATE TABLE IF NOT EXISTS submission_items (
  submission_id TEXT NOT NULL,
  line_no       INTEGER NOT NULL,
  item_id       TEXT,
  name          TEXT,
  kind          TEXT,
  quantity      INTEGER DEFAULT 0,
  bills_under   TEXT,
  PRIMARY KEY (submission_id, line_no),
  FOREIGN KEY (submission_id) REFERENCES submissions (submission_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_submission ON submission_items (submission_id);
