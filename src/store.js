'use strict';
// Persistent application storage (SQLite). The source CSV is never written to.
//
// Layers:
//   imported  : rows copied from the CSV once (source='imported'); never overwritten by a refresh
//   derived   : md_customer_items (rebuilt from md_purchase_orders on every import)
//   app       : everything created through the application (source='app')
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { seedConfig } = require('./seed');

const DB_PATH = process.env.MDM_DB || path.join(__dirname, '..', 'data', 'app.db');
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, csv_hash TEXT NOT NULL, csv_file TEXT, at TEXT NOT NULL,
  requests_added INTEGER, audit_added INTEGER, requests_seen INTEGER, audit_seen INTEGER, note TEXT, detail_json TEXT);

-- configuration (editable in the app; no code change needed to add a field, rule or domain)
CREATE TABLE IF NOT EXISTS domains (
  key TEXT PRIMARY KEY, label TEXT NOT NULL, sap_object TEXT, id_field TEXT, id_prefix TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'app', sort INTEGER DEFAULT 100);
CREATE TABLE IF NOT EXISTS domain_fields (
  domain TEXT NOT NULL, name TEXT NOT NULL, label TEXT, data_type TEXT NOT NULL DEFAULT 'string',
  required INTEGER NOT NULL DEFAULT 0, validation TEXT, sensitive INTEGER NOT NULL DEFAULT 0, match_role TEXT,
  editable INTEGER NOT NULL DEFAULT 1, sap_field TEXT, description TEXT, source TEXT NOT NULL DEFAULT 'app', sort INTEGER DEFAULT 100,
  PRIMARY KEY (domain, name));
CREATE TABLE IF NOT EXISTS approval_rules (
  rule_id TEXT PRIMARY KEY, domain TEXT NOT NULL DEFAULT 'customer', country TEXT NOT NULL DEFAULT '*', request_type TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT '*', step INTEGER NOT NULL, approver_role TEXT NOT NULL, sla_hours INTEGER NOT NULL DEFAULT 24,
  notes TEXT, source TEXT NOT NULL DEFAULT 'app', enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

-- master data
CREATE TABLE IF NOT EXISTS md_customers (
  customer_id TEXT PRIMARY KEY, name TEXT NOT NULL, entity TEXT, country TEXT, uen TEXT, address TEXT,
  golden_id TEXT, is_survivor INTEGER DEFAULT 0, match_reason TEXT, active INTEGER NOT NULL DEFAULT 1, extra_json TEXT,
  source TEXT NOT NULL, orig_name TEXT, orig_uen TEXT, orig_address TEXT, request_id TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS ix_cust_golden ON md_customers(golden_id);
CREATE TABLE IF NOT EXISTS md_records (
  domain TEXT NOT NULL, record_id TEXT NOT NULL, name TEXT, entity TEXT, country TEXT, data_json TEXT,
  active INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL, request_id TEXT, created_at TEXT, updated_at TEXT,
  PRIMARY KEY (domain, record_id));
CREATE TABLE IF NOT EXISTS md_purchase_orders (
  po_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, country TEXT, date TEXT NOT NULL, product TEXT, qty INTEGER, value REAL, source TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_po_cust ON md_purchase_orders(customer_id);
CREATE TABLE IF NOT EXISTS md_customer_items (
  customer_id TEXT NOT NULL, item_code TEXT NOT NULL, po_count INTEGER, qty INTEGER, value REAL, first_po TEXT, last_po TEXT,
  PRIMARY KEY (customer_id, item_code));
CREATE TABLE IF NOT EXISTS md_inbox (
  msg_id TEXT PRIMARY KEY, received_at TEXT, from_email TEXT, text TEXT, true_label TEXT, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, domain TEXT, record_id TEXT, field TEXT, old_value TEXT, new_value TEXT, request_id TEXT);
CREATE TABLE IF NOT EXISTS sensitive_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, role TEXT, domain TEXT, record_id TEXT, field TEXT, context TEXT);

-- workflow
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('imported','app')),
  domain TEXT NOT NULL DEFAULT 'customer',
  request_type TEXT NOT NULL, entity TEXT, country TEXT, target_customer_id TEXT, requested_by TEXT,
  created_at TEXT NOT NULL, status TEXT NOT NULL, current_step TEXT, approval_path TEXT,
  step_index INTEGER NOT NULL DEFAULT 0, payload_json TEXT, duplicate_check_json TEXT, updated_at TEXT, requested_role TEXT);
CREATE TABLE IF NOT EXISTS audit_log (
  log_id TEXT PRIMARY KEY, source TEXT NOT NULL, request_id TEXT NOT NULL, ts TEXT NOT NULL, actor TEXT,
  action TEXT, from_status TEXT, to_status TEXT, comment TEXT);
CREATE INDEX IF NOT EXISTS ix_audit_req ON audit_log(request_id);
CREATE TABLE IF NOT EXISTS export_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, file_name TEXT, row_count INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS export_items (batch_id INTEGER, request_id TEXT, PRIMARY KEY (batch_id, request_id));

-- positions: what each "Acting as" role can see and do. No individuals are stored.
CREATE TABLE IF NOT EXISTS role_profiles (
  role TEXT PRIMARY KEY, kind TEXT NOT NULL, description TEXT, views_json TEXT NOT NULL,
  can_request INTEGER NOT NULL DEFAULT 0, can_apply INTEGER NOT NULL DEFAULT 0, can_export INTEGER NOT NULL DEFAULT 0,
  can_triage INTEGER NOT NULL DEFAULT 0, can_config INTEGER NOT NULL DEFAULT 0, sees_all_requests INTEGER NOT NULL DEFAULT 0);
-- which position performs each approval-rule role (the CSV rules name roles that are not all in the brief's list)
CREATE TABLE IF NOT EXISTS role_aliases (rule_role TEXT PRIMARY KEY, position TEXT NOT NULL, basis TEXT);
-- CSV handles (audit_log.actor, requests.requested_by) translated to a position, so screens can show roles instead of names
CREATE TABLE IF NOT EXISTS actor_positions (actor TEXT PRIMARY KEY, position TEXT, label TEXT NOT NULL);
`;

const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const hasColumn = (db, t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);

function openDb(file = DB_PATH) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  // v1 databases already have a `requests` table without `domain`
  if (hasTable(db, 'requests') && !hasColumn(db, 'requests', 'domain')) db.exec("ALTER TABLE requests ADD COLUMN domain TEXT NOT NULL DEFAULT 'customer'");
  if (hasTable(db, 'import_runs') && !hasColumn(db, 'import_runs', 'detail_json')) db.exec('ALTER TABLE import_runs ADD COLUMN detail_json TEXT');
  if (hasTable(db, 'requests') && !hasColumn(db, 'requests', 'requested_role')) db.exec('ALTER TABLE requests ADD COLUMN requested_role TEXT');
  db.exec('DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users;'); // named-person sign-in was removed: positions only
  db.exec(SCHEMA);
  return db;
}

const pathOf = s => (s ? s.split('>').map(x => x.trim()).filter(Boolean) : []);
const tx = (db, fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

/** Idempotent import of the CSV's own workflow rows. INSERT OR IGNORE: existing requests and decisions are never overwritten. */
function importWorkflow(db, source) {
  const reqs = source.tables.requests || [], logs = source.tables.audit_log || [];
  const insR = db.prepare(`INSERT OR IGNORE INTO requests
    (request_id, source, domain, request_type, entity, country, target_customer_id, requested_by, created_at, status,
     current_step, approval_path, step_index, payload_json, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insL = db.prepare(`INSERT OR IGNORE INTO audit_log
    (log_id, source, request_id, ts, actor, action, from_status, to_status, comment) VALUES (?,?,?,?,?,?,?,?,?)`);
  let ra = 0, la = 0;
  tx(db, () => {
    for (const r of reqs) {
      const p = pathOf(r.approval_path);
      const idx = r.status === 'pending_approval' ? Math.max(0, p.indexOf(r.current_step)) : 0;
      ra += Number(insR.run(r.request_id, 'imported', 'customer', r.request_type, r.entity, r.country, r.target_customer_id || null,
        r.requested_by, r.created_at, r.status, r.current_step || null, r.approval_path, idx, r.payload_json, r.created_at).changes);
    }
    for (const l of logs)
      la += Number(insL.run(l.log_id, 'imported', l.request_id, l.ts, l.actor, l.action, l.from_status || null, l.to_status, l.comment || null).changes);
  });
  return { requestsAdded: ra, auditAdded: la, requestsSeen: reqs.length, auditSeen: logs.length };
}

/**
 * Copy master data from the CSV into the app database (idempotent).
 * New CSV rows are added; rows already in the DB are left alone so edits made in the app survive a refresh.
 * Rows whose CSV values have since changed are counted in `upstreamChanged` and reported, not applied.
 */
function importMaster(db, source) {
  const T = source.tables, now = new Date().toISOString();
  const golden = new Map((T.golden_map || []).map(g => [g.customer_id, g]));
  const out = { customers: 0, purchaseOrders: 0, items: 0, inbox: 0, upstreamChanged: 0 };
  const insC = db.prepare(`INSERT OR IGNORE INTO md_customers (customer_id, name, entity, country, uen, address, golden_id, is_survivor, match_reason,
    active, source, orig_name, orig_uen, orig_address, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,'imported',?,?,?,?,?)`);
  const insP = db.prepare('INSERT OR IGNORE INTO md_purchase_orders (po_id, customer_id, country, date, product, qty, value, source) VALUES (?,?,?,?,?,?,?,\'imported\')');
  const insM = db.prepare("INSERT OR IGNORE INTO md_inbox (msg_id, received_at, from_email, text, true_label, source) VALUES (?,?,?,?,?,'imported')");
  const insI = db.prepare(`INSERT OR IGNORE INTO md_records (domain, record_id, name, entity, country, data_json, active, source, created_at, updated_at)
    VALUES ('item', ?, ?, NULL, NULL, ?, 1, 'imported', ?, ?)`);
  tx(db, () => {
    for (const c of T.customers || []) {
      const g = golden.get(c.customer_id);
      const r = insC.run(c.customer_id, c.name, c.entity, c.country, c.uen || null, c.address, g?.golden_id ?? 'GN-' + c.customer_id,
        g?.is_survivor === 'Y' ? 1 : g ? 0 : 1, g?.match_reason ?? null, c.name, c.uen || null, c.address, now, now);
      out.customers += Number(r.changes);
      if (!Number(r.changes)) {
        const cur = db.prepare('SELECT orig_name, orig_uen, orig_address FROM md_customers WHERE customer_id = ?').get(c.customer_id);
        if (cur && (cur.orig_name !== c.name || (cur.orig_uen || '') !== (c.uen || '') || cur.orig_address !== c.address)) out.upstreamChanged++;
      }
    }
    for (const p of T.purchase_orders || []) out.purchaseOrders += Number(insP.run(p.po_id, p.customer_id, p.country, p.date, p.product, Number(p.qty), Number(p.value)).changes);
    for (const m of T.inbox_messages || []) out.inbox += Number(insM.run(m.msg_id, m.received_at, m.from_email, m.text, m.true_label).changes);
    // Items: the CSV has no item table. The only item identity in the data is the product code on POs.
    for (const code of [...new Set((T.purchase_orders || []).map(p => p.product))].sort())
      out.items += Number(insI.run(code, 'Product ' + code, JSON.stringify({ item_code: code, product_line: code }), now, now).changes);
    // derived: what each customer buys
    db.exec('DELETE FROM md_customer_items');
    db.exec(`INSERT INTO md_customer_items (customer_id, item_code, po_count, qty, value, first_po, last_po)
      SELECT customer_id, product, COUNT(*), SUM(qty), ROUND(SUM(value), 2), MIN(date), MAX(date) FROM md_purchase_orders GROUP BY customer_id, product`);
    seedConfig(db, T);
    // imported requests carry a CSV handle; translate it to the position that raised it (where the handle's department maps to one)
    db.exec('UPDATE requests SET requested_role = (SELECT position FROM actor_positions p WHERE p.actor = requests.requested_by) WHERE requested_role IS NULL');
    migrateV1(db);
  });
  return out;
}

/** One-time move of v1 overlay tables (app_customers, customer_overrides, ...) into md_customers. */
function migrateV1(db) {
  if (hasTable(db, 'app_customers')) {
    for (const a of db.prepare('SELECT * FROM app_customers').all())
      db.prepare(`INSERT OR IGNORE INTO md_customers (customer_id, name, entity, country, uen, address, golden_id, is_survivor, active, source, request_id, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,1,1,'app',?,?,?)`).run(a.customer_id, a.name, a.entity, a.country, a.uen, a.address, 'GN-' + a.customer_id, a.request_id, a.created_at, a.created_at);
    db.exec('DROP TABLE app_customers');
  }
  if (hasTable(db, 'customer_overrides')) {
    for (const o of db.prepare('SELECT * FROM customer_overrides ORDER BY id').all())
      if (['name', 'uen', 'address'].includes(o.field)) db.prepare(`UPDATE md_customers SET ${o.field} = ? WHERE customer_id = ?`).run(o.value, o.customer_id);
    db.exec('DROP TABLE customer_overrides');
  }
  if (hasTable(db, 'canonical_overrides')) {
    for (const o of db.prepare('SELECT * FROM canonical_overrides').all()) db.prepare('UPDATE md_customers SET golden_id = ? WHERE customer_id = ?').run(o.golden_id, o.customer_id);
    db.exec('DROP TABLE canonical_overrides');
  }
  if (hasTable(db, 'inactive_customers')) {
    for (const o of db.prepare('SELECT * FROM inactive_customers').all()) db.prepare('UPDATE md_customers SET active = 0 WHERE customer_id = ?').run(o.customer_id);
    db.exec('DROP TABLE inactive_customers');
  }
}

module.exports = { openDb, importWorkflow, importMaster, pathOf, tx, DB_PATH, SCHEMA_VERSION };
