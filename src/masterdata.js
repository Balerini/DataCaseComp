'use strict';
// Master-data access: domain configuration, listing/detail for every domain, sensitive-field masking and access log.
const { fieldTest } = require('./rules');
const { decrypt, isEnc, MASK } = require('./crypto');

const CORE_CUSTOMER_COLS = new Set(['name', 'uen', 'address', 'entity', 'country']);

function makeMaster(ctx) {
  const { db } = ctx;
  const now = () => new Date().toISOString().slice(0, 16);

  const domains = () => db.prepare('SELECT * FROM domains WHERE enabled = 1 ORDER BY sort, key').all();
  const domainRow = k => db.prepare('SELECT * FROM domains WHERE key = ?').get(k);
  const fieldsOf = k => db.prepare('SELECT * FROM domain_fields WHERE domain = ? ORDER BY sort, name').all(k)
    .map(f => ({ ...f, required: !!f.required, sensitive: !!f.sensitive, editable: !!f.editable, test: fieldTest(f) }));
  const viewRoles = () => { try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'sensitive_view_roles'").get()?.value || '[]'); } catch { return []; } };
  const canSee = who => !!(who?.actor && who?.role && viewRoles().includes(who.role));

  /** Replace sensitive values with a mask unless `who` may see them; reveals are logged. */
  function redact(domain, data, who, { recordId, context, log = false } = {}) {
    const sens = new Set(fieldsOf(domain).filter(f => f.sensitive).map(f => f.name));
    const out = { ...data };
    for (const k of Object.keys(out)) {
      if (!sens.has(k) || !isEnc(out[k])) continue;
      if (canSee(who)) {
        out[k] = decrypt(out[k]);
        if (log) db.prepare('INSERT INTO sensitive_access_log (ts, actor, role, domain, record_id, field, context) VALUES (?,?,?,?,?,?,?)').run(now(), who.actor, who.role, domain, recordId, k, context || 'view');
      } else out[k] = MASK;
    }
    return out;
  }

  const custView = (m, c) => ({
    id: c.customer_id, customer_id: c.customer_id, name: c.name, entity: c.entity, country: c.country, uen: c.uen, address: c.address,
    golden_id: m.golden.get(c.customer_id), is_survivor: m.survivor.get(m.golden.get(c.customer_id)) === c.customer_id,
    origin: c.origin, active: c.active, modified: c.origin === 'imported' && ['name', 'uen', 'address'].some(k => (c[k] || '') !== (c.original[k] || '')),
    extra: c.extra,
  });

  function list(domain, { q, country, entity, limit = 50, offset = 0, region } = {}, who) {
    const inReg = c => !region || region === 'ALL' || !c || c === region; // region scope: records without a country (items, cost centers) always show
    const m = ctx.getModel(), term = (q || '').toLowerCase();
    let rows;
    if (domain === 'customer') {
      rows = [...m.customers.values()].filter(c => inReg(c.country) && (!country || c.country === country) && (!entity || c.entity === entity)
        && (!term || `${c.customer_id} ${c.name} ${c.uen} ${c.address} ${m.golden.get(c.customer_id)}`.toLowerCase().includes(term)))
        .map(c => ({ ...custView(m, c), extra: redact('customer', c.extra, who) }));
    } else {
      rows = [...(m.records[domain]?.values() || [])].filter(r => inReg(r.country) && (!country || r.country === country) && (!entity || r.entity === entity)
        && (!term || `${r.record_id} ${r.name} ${JSON.stringify(r.data)}`.toLowerCase().includes(term)))
        .map(r => ({ id: r.record_id, record_id: r.record_id, name: r.name, entity: r.entity, country: r.country, active: r.active, origin: r.source,
          data: redact(domain, r.data, who), created_at: r.created_at }));
    }
    return { total: rows.length, rows: rows.slice(offset, offset + limit) };
  }

  /** Customer detail incl. the items the customer buys (derived from POs) and its duplicate group. */
  function customerDetail(id, who) {
    const m = ctx.getModel(), c = m.customers.get(id);
    if (!c) return null;
    const gid = m.golden.get(id);
    const items = db.prepare(`SELECT ci.*, r.name AS item_name FROM md_customer_items ci LEFT JOIN md_records r ON r.domain = 'item' AND r.record_id = ci.item_code
      WHERE ci.customer_id = ? ORDER BY ci.value DESC`).all(id);
    const groupItems = db.prepare(`SELECT item_code, SUM(po_count) po_count, SUM(qty) qty, ROUND(SUM(value),2) value, MIN(first_po) first_po, MAX(last_po) last_po
      FROM md_customer_items WHERE customer_id IN (${(m.goldenMembers.get(gid) || [id]).map(() => '?').join(',')}) GROUP BY item_code ORDER BY value DESC`).all(...(m.goldenMembers.get(gid) || [id]));
    const reqs = db.prepare("SELECT request_id, request_type, status, created_at FROM requests WHERE domain = 'customer' AND target_customer_id = ? ORDER BY created_at DESC").all(id);
    const pos = m.pos.filter(p => p.customer_id === id);
    return {
      ...custView(m, c), extra: redact('customer', c.extra, who, { recordId: id, context: 'customer detail', log: true }), original: c.original,
      groupMembers: (m.goldenMembers.get(gid) || []).map(i => custView(m, m.customers.get(i))),
      items, groupItems, requests: reqs,
      pos: { count: pos.length, value: pos.reduce((s, p) => s + p.value, 0), last: pos.reduce((a, p) => (p.date > a ? p.date : a), '') },
    };
  }

  function recordDetail(domain, id, who) {
    const r = ctx.getModel().records[domain]?.get(id);
    if (!r) return null;
    const customers = domain === 'item'
      ? db.prepare(`SELECT ci.customer_id, c.name, c.country, ci.po_count, ci.qty, ci.value, ci.last_po FROM md_customer_items ci JOIN md_customers c ON c.customer_id = ci.customer_id
          WHERE ci.item_code = ? ORDER BY ci.value DESC LIMIT 50`).all(id) : [];
    return { id: r.record_id, name: r.name, entity: r.entity, country: r.country, active: r.active, origin: r.source,
      data: redact(domain, r.data, who, { recordId: id, context: domain + ' detail', log: true }), customers,
      requests: db.prepare('SELECT request_id, request_type, status, created_at FROM requests WHERE domain = ? AND target_customer_id = ? ORDER BY created_at DESC').all(domain, id) };
  }

  /** Counts per domain for the dashboard / master-data page. */
  function summary() {
    const m = ctx.getModel();
    return domains().map(d => {
      const n = d.key === 'customer' ? m.customers.size : (m.records[d.key]?.size || 0);
      const src = d.key === 'customer' ? [...m.customers.values()] : [...(m.records[d.key]?.values() || [])];
      return { key: d.key, label: d.label, count: n, imported: src.filter(x => (x.origin ?? x.source) === 'imported').length,
        created: src.filter(x => (x.origin ?? x.source) === 'app').length, source: d.source };
    });
  }

  return { domains, domainRow, fieldsOf, viewRoles, canSee, redact, list, customerDetail, recordDetail, summary, custView, now };
}

module.exports = { makeMaster, CORE_CUSTOMER_COLS };
