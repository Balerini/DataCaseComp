'use strict';
// In-memory model built from the application database (master data was imported from the CSV; see store.importMaster).
// The CSV file itself is only read at import time and is never written.

function buildModel(source, db) {
  const customers = new Map();
  for (const r of db.prepare('SELECT * FROM md_customers').all()) {
    customers.set(r.customer_id, {
      customer_id: r.customer_id, name: r.name, entity: r.entity, country: r.country, uen: r.uen || '', address: r.address,
      origin: r.source, active: !!r.active, golden_id: r.golden_id, extra: r.extra_json ? JSON.parse(r.extra_json) : {},
      request_id: r.request_id, created_at: r.created_at,
      original: { name: r.orig_name ?? r.name, uen: r.orig_uen ?? '', address: r.orig_address ?? r.address },
    });
  }

  const golden = new Map(), survivor = new Map(), goldenMembers = new Map();
  for (const r of db.prepare('SELECT customer_id, golden_id, is_survivor FROM md_customers').all()) {
    golden.set(r.customer_id, r.golden_id);
    if (r.is_survivor) survivor.set(r.golden_id, r.customer_id);
    if (!goldenMembers.has(r.golden_id)) goldenMembers.set(r.golden_id, []);
    goldenMembers.get(r.golden_id).push(r.customer_id);
  }
  // a golden group left without a survivor (e.g. after a merge) gets its first member as representative
  for (const [gid, ids] of goldenMembers) if (!survivor.has(gid) || golden.get(survivor.get(gid)) !== gid) survivor.set(gid, ids[0]);

  const pos = db.prepare('SELECT * FROM md_purchase_orders ORDER BY date, po_id').all().map(p => ({ ...p, month: p.date.slice(0, 7) }));
  const asOf = pos.reduce((m, p) => (p.date > m ? p.date : m), '0000-00-00');
  const firstDate = pos.reduce((m, p) => (p.date < m ? p.date : m), '9999-99-99');

  const records = {};
  for (const r of db.prepare('SELECT * FROM md_records').all())
    ((records[r.domain] ??= new Map()).set(r.record_id, { ...r, data: r.data_json ? JSON.parse(r.data_json) : {}, active: !!r.active }));

  return { customers, golden, goldenMembers, survivor, pos, asOf, firstDate, records, tables: source.tables };
}

/** Identity used for counting customers: raw = customer_id, dedup = golden_id. */
const keyOf = (m, basis) => cid => (basis === 'dedup' ? m.golden.get(cid) : cid);

/** Representative customer record for a golden id (survivor if known, else first member). */
const repOf = (m, gid) => m.customers.get(m.survivor.get(gid)) ?? m.customers.get((m.goldenMembers.get(gid) || [])[0]);

module.exports = { buildModel, keyOf, repOf };
