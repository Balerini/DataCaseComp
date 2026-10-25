'use strict';
// Persistent application storage (SQLite). The source CSV is never written to.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.MDM_DB || path.join(__dirname, '..', 'data', 'app.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, csv_hash TEXT NOT NULL, csv_file TEXT, at TEXT NOT NULL,
  requests_added INTEGER, audit_added INTEGER, requests_seen INTEGER, audit_seen INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('imported','app')),
  request_type TEXT NOT NULL, entity TEXT, country TEXT, target_customer_id TEXT, requested_by TEXT,
  created_at TEXT NOT NULL, status TEXT NOT NULL, current_step TEXT, approval_path TEXT,
  step_index INTEGER NOT NULL DEFAULT 0, payload_json TEXT, duplicate_check_json TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS audit_log (
  log_id TEXT PRIMARY KEY, source TEXT NOT NULL, request_id TEXT NOT NULL, ts TEXT NOT NULL, actor TEXT,
  action TEXT, from_status TEXT, to_status TEXT, comment TEXT);
CREATE INDEX IF NOT EXISTS ix_audit_req ON audit_log(request_id);
CREATE TABLE IF NOT EXISTS app_customers (
  customer_id TEXT PRIMARY KEY, name TEXT, entity TEXT, country TEXT, uen TEXT, address TEXT,
  request_id TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS customer_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL, field TEXT NOT NULL, value TEXT,
  request_id TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS canonical_overrides (
  customer_id TEXT PRIMARY KEY, golden_id TEXT NOT NULL, request_id TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS inactive_customers (customer_id TEXT PRIMARY KEY, request_id TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS export_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, file_name TEXT, row_count INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS export_items (batch_id INTEGER, request_id TEXT, PRIMARY KEY (batch_id, request_id));
`;

function openDb(file = DB_PATH) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

const pathOf = s => (s ? s.split('>').map(x => x.trim()).filter(Boolean) : []);

/**
 * Idempotent import of the CSV's own workflow rows (requests, audit_log).
 * INSERT OR IGNORE on the natural key: re-running, or running against a refreshed CSV,
 * adds only genuinely new request_id / log_id values and never overwrites decisions made in the app.
 */
function importWorkflow(db, source) {
  const reqs = source.tables.requests || [], logs = source.tables.audit_log || [];
  const insR = db.prepare(`INSERT OR IGNORE INTO requests
    (request_id, source, request_type, entity, country, target_customer_id, requested_by, created_at, status,
     current_step, approval_path, step_index, payload_json, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insL = db.prepare(`INSERT OR IGNORE INTO audit_log
    (log_id, source, request_id, ts, actor, action, from_status, to_status, comment) VALUES (?,?,?,?,?,?,?,?,?)`);
  let ra = 0, la = 0;
  db.exec('BEGIN');
  try {
    for (const r of reqs) {
      const p = pathOf(r.approval_path);
      const idx = r.status === 'pending_approval' ? Math.max(0, p.indexOf(r.current_step)) : 0;
      ra += Number(insR.run(r.request_id, 'imported', r.request_type, r.entity, r.country, r.target_customer_id || null,
        r.requested_by, r.created_at, r.status, r.current_step || null, r.approval_path, idx, r.payload_json, r.created_at).changes);
    }
    for (const l of logs)
      la += Number(insL.run(l.log_id, 'imported', l.request_id, l.ts, l.actor, l.action, l.from_status || null, l.to_status, l.comment || null).changes);
    db.prepare(`INSERT INTO import_runs (csv_hash, csv_file, at, requests_added, audit_added, requests_seen, audit_seen)
      VALUES (?,?,?,?,?,?,?)`).run(source.hash, path.basename(source.file), new Date().toISOString(), ra, la, reqs.length, logs.length);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { requestsAdded: ra, auditAdded: la, requestsSeen: reqs.length, auditSeen: logs.length };
}

module.exports = { openDb, importWorkflow, pathOf, DB_PATH };
