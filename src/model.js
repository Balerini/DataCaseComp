'use strict';
// Builds the in-memory model: imported CSV records + app overlays (new customers, field updates,
// canonical merges, deactivations). Nothing here writes to the CSV.

function buildModel(source, db) {
  const T = source.tables;
  const customers = new Map();
  for (const c of T.customers || []) customers.set(c.customer_id, { ...c, origin: 'imported', active: true, original: { ...c } });

  // overlays
  for (const o of db.prepare('SELECT * FROM customer_overrides ORDER BY id').all()) {
    const c = customers.get(o.customer_id);
    if (c) c[o.field] = o.value;
  }
  for (const a of db.prepare('SELECT * FROM app_customers ORDER BY created_at').all()) {
    customers.set(a.customer_id, {
      customer_id: a.customer_id, name: a.name, entity: a.entity, country: a.country, uen: a.uen || '',
      address: a.address, origin: 'app', active: true, request_id: a.request_id,
    });
  }
  for (const i of db.prepare('SELECT customer_id FROM inactive_customers').all()) {
    const c = customers.get(i.customer_id);
    if (c) c.active = false;
  }

  // canonical mapping: provided golden_map, overlaid with merges applied in the app
  const golden = new Map();
  const survivor = new Map();
  for (const g of T.golden_map || []) {
    golden.set(g.customer_id, g.golden_id);
    if (g.is_survivor === 'Y') survivor.set(g.golden_id, g.customer_id);
  }
  const canonOverride = new Map(db.prepare('SELECT customer_id, golden_id FROM canonical_overrides').all().map(r => [r.customer_id, r.golden_id]));
  for (const [cid, gid] of canonOverride) golden.set(cid, gid);
  // a customer with no mapping (e.g. created in the app) is its own golden record
  for (const c of customers.values()) if (!golden.has(c.customer_id)) golden.set(c.customer_id, 'GN-' + c.customer_id);

  const pos = (T.purchase_orders || []).map(p => ({ ...p, qty: Number(p.qty), value: Number(p.value), month: p.date.slice(0, 7) }));
  const asOf = pos.reduce((m, p) => (p.date > m ? p.date : m), '0000-00-00');
  const firstDate = pos.reduce((m, p) => (p.date < m ? p.date : m), '9999-99-99');

  const goldenMembers = new Map();
  for (const [cid, gid] of golden) {
    if (!goldenMembers.has(gid)) goldenMembers.set(gid, []);
    goldenMembers.get(gid).push(cid);
  }

  return { customers, golden, goldenMembers, survivor, canonOverride, pos, asOf, firstDate, tables: T };
}

/** Identity used for counting customers: raw = customer_id, dedup = golden_id. */
const keyOf = (m, basis) => cid => (basis === 'dedup' ? m.golden.get(cid) : cid);

/** Representative customer record for a golden id (survivor if known, else first member). */
const repOf = (m, gid) => m.customers.get(m.survivor.get(gid)) ?? m.customers.get((m.goldenMembers.get(gid) || [])[0]);

module.exports = { buildModel, keyOf, repOf };
