'use strict';
// Data profile, quality findings, capability matrix (what the CSV can / cannot support) and reconciliation checks.
const { evaluate, DEFAULTS } = require('./matching');
const { overview, coverage } = require('./analytics');
const { buildApprovalPath } = require('./rules');
const { openPoProxy } = require('./analytics');

// Pairwise matching over the immutable source is O(n^2); compute once per loaded source.
const memo = new WeakMap();
function memoised(source, key, fn) {
  let m = memo.get(source);
  if (!m) memo.set(source, (m = {}));
  return key in m ? m[key] : (m[key] = fn());
}

function profile(source) {
  const out = {};
  for (const [t, rows] of Object.entries(source.tables)) {
    const cols = Object.keys(rows[0] || {});
    out[t] = {
      rows: rows.length,
      columns: cols.map(c => {
        const vals = rows.map(r => r[c]), nn = vals.filter(v => v !== '');
        const uniq = new Set(nn);
        return { name: c, nonEmpty: nn.length, missing: rows.length - nn.length, unique: uniq.size, sample: [...uniq].slice(0, 3) };
      }),
    };
  }
  return out;
}

function findings(source, model, db) {
  const T = source.tables, f = [];
  const custs = T.customers;
  const noUen = custs.filter(c => !c.uen);
  f.push({ severity: 'info', area: 'customers', text: `${noUen.length} of ${custs.length} customers have no registration number (uen); hard-key matching is impossible for them, so they rely on name + address.` });
  const fmt = custs.filter(c => c.uen && /[^0-9A-Z]/.test(c.uen));
  f.push({ severity: 'info', area: 'customers', text: `${fmt.length} registration numbers contain separators (e.g. ${fmt[0]?.uen}); they are normalised before comparison and before validating against config_domains.` });
  const countryMismatch = T.purchase_orders.filter(p => model.customers.get(p.customer_id)?.country !== p.country).length;
  f.push({ severity: countryMismatch ? 'warn' : 'ok', area: 'purchase_orders', text: `${countryMismatch} POs whose country differs from the customer's country.` });
  const orphanPo = T.purchase_orders.filter(p => !model.customers.has(p.customer_id)).length;
  f.push({ severity: orphanPo ? 'warn' : 'ok', area: 'purchase_orders', text: `${orphanPo} POs reference a customer_id missing from customers.` });
  const unmapped = custs.filter(c => !T.golden_map.some(g => g.customer_id === c.customer_id)).length;
  f.push({ severity: unmapped ? 'warn' : 'ok', area: 'golden_map', text: `${unmapped} customers have no golden_map row.` });
  const ph = T.requests.filter(r => (r.payload_json || '').includes('<<new value>>'));
  f.push({ severity: 'warn', area: 'requests', text: `${ph.length} update requests carry the literal placeholder "<<new value>>" instead of a new value. They cannot be applied or exported until a value is supplied.` });
  const mergeKey = {};
  T.requests.filter(r => r.request_type === 'merge_customer').forEach(r => { (mergeKey[r.payload_json] ??= []).push(r.request_id + ':' + r.status); });
  Object.values(mergeKey).filter(a => a.length > 1).forEach(a => f.push({ severity: 'warn', area: 'requests', text: `Identical merge requested more than once: ${a.join(', ')}.` }));
  const pend = T.requests.filter(r => r.status === 'pending_approval' && r.current_step);
  f.push({ severity: 'info', area: 'requests', text: `${pend.length} imported requests are pending approval (carried into app storage with their position in the approval path).` });
  f.push({ severity: 'warn', area: 'items', text: 'The CSV has no item table. Items A, B and C exist only as the product code on POs; they were loaded as items named "Product A/B/C" (the way the PO and inbox data refer to them). Descriptions, units, item groups and regulatory status are not in the data.' });
  f.push({ severity: 'warn', area: 'vendors / cost centers', text: 'The CSV has no vendor or cost-center records. Both domains are configured and ready but start empty; records arrive through requests. Nothing was invented.' });
  f.push({ severity: 'info', area: 'sensitive fields', text: 'The CSV has no bank-account or credit/payment-term data. Those fields are defined as sensitive (encrypted at rest, masked by role) and are populated only through requests.' });
  if (db) { const ib = db.prepare('SELECT COUNT(*) n, MIN(received_at) a, MAX(received_at) b FROM md_inbox').get(); f.push({ severity: 'info', area: 'inbox_messages', text: `${ib.n} inbox messages (${ib.a.slice(0, 10)} to ${ib.b.slice(0, 10)}) are loaded and triaged; they are highly templated, so triage accuracy on this data will overstate real-world accuracy.` }); }
  const cov = coverage(model);
  f.push({ severity: cov.enoughFor24Months ? 'ok' : 'warn', area: 'purchase_orders', text: `PO history covers ${cov.months} months (${cov.firstDate} to ${cov.lastDate})${cov.enoughFor24Months ? '' : ' — less than 24 months; no history was fabricated.'}` });
  f.push({ severity: 'info', area: 'purchase_orders', text: 'The data ends on its last PO date; later months have no data (not zero demand).' });
  return f;
}

const CAPABILITIES = [
  { feature: 'Customer master in the database', status: 'supported', basis: 'customers + golden_map imported into md_customers (240 rows, golden ids kept)' },
  { feature: 'Items master and "what each customer buys"', status: 'partial', basis: 'Items A/B/C and per-customer item totals are derived from purchase_orders. No descriptions, units, groups or regulatory flags in the source.' },
  { feature: 'Vendor master', status: 'missing', basis: 'No vendor data in the CSV. Domain is configured; records come from requests.' },
  { feature: 'Cost-center master', status: 'missing', basis: 'No cost-center data in the CSV. Domain is configured; records come from requests.' },
  { feature: 'Add a domain / field / approval rule without code', status: 'supported', basis: 'domains, domain_fields, approval_rules tables + Config screen' },
  { feature: 'Duplicate detection (name / registration no. / address / code)', status: 'supported', basis: 'customers.name, uen, address, country, entity; items/vendors/cost centers via configured match roles' },
  { feature: 'Canonical (golden) mapping', status: 'supported', basis: 'golden_id on md_customers; merges applied in the app update it and are logged' },
  { feature: 'Inbox triage (order / enquiry / follow-up / MDM request)', status: 'supported', basis: 'inbox_messages with labels; rule-based classifier scored against them (templated text, so accuracy is optimistic)' },
  { feature: 'Regional PO analytics (country, product, customer, growth)', status: 'supported', basis: 'purchase_orders: customer_id, country, date, product, qty, value (SGD)' },
  { feature: 'Raw vs deduplicated comparison', status: 'supported', basis: 'same PO rows keyed by customer_id vs golden_id' },
  { feature: 'Drop-off', status: 'supported', basis: 'customers active in the prior window with no PO in the recent window (default 90 days). Churn is inferred from absence of POs.' },
  { feature: 'Cross-sell', status: 'supported', basis: 'product mix per customer (A, B, C). No product hierarchy or price list.' },
  { feature: 'Forecast with 24-month history', status: 'partial', basis: 'Only 21 months exist; 3-month holdout leaves 18 months of training. Seasonal factors rest on one prior-year observation.' },
  { feature: 'Open PO value (approval rule R07)', status: 'partial', basis: 'purchase_orders has no open/closed status. A proxy (POs dated in the last N days) is used and labelled as such.' },
  { feature: 'Approval routing', status: 'supported', basis: 'Customer rules from the CSV (12); rules for other domains are proposed and labelled as such' },
  { feature: 'Sensitive fields (bank, credit/payment terms)', status: 'partial', basis: 'Encrypted at rest, masked by acting role, reveals logged. No data in the CSV; roles are not authenticated.' },
  { feature: 'Approver identity / authentication', status: 'missing', basis: 'The app lets the operator choose the role they act as; this is not access control. Production needs Microsoft 365 / SSO identity.' },
  { feature: 'Notifications / reminders (Outlook, Teams)', status: 'missing', basis: 'Not built. Requests show who they await and each role has a queue; push notification needs Microsoft 365 integration.' },
  { feature: 'SAP B1 export (all domains)', status: 'partial', basis: 'Generated from approved requests via field-to-SAP mapping. GroupCode, Currency, item group, dimension are not in the source and are flagged; no integration with SAP B1.' },
  { feature: 'Update-request new values', status: 'partial', basis: 'Imported update requests contain "<<new value>>" placeholders; real values can only be added to drafts.' },
  { feature: 'Customer-level currency / FX', status: 'not needed', basis: 'All PO values are in SGD per config_domains.' },
];

/** Cross-checks the app computes from the source against independent recomputation. */
function validate(source, model, db) {
  const checks = [], add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  const T = source.tables;
  add('CSV parsed with no malformed rows', source.malformed.length === 0, `${source.rowCount} data rows, ${source.malformed.length} malformed`);
  const total = T.purchase_orders.reduce((s, p) => s + Number(p.value), 0);
  const raw = overview(model, {}, 'raw'), dd = overview(model, {}, 'dedup');
  add('Dashboard PO value reconciles to CSV (raw)', Math.abs(raw.totals.value - total) < 0.01, `${raw.totals.value} vs ${total.toFixed(2)}`);
  add('Dashboard PO value reconciles to CSV (dedup)', Math.abs(dd.totals.value - total) < 0.01, `${dd.totals.value} vs ${total.toFixed(2)}`);
  add('PO count reconciles', raw.totals.pos === T.purchase_orders.length && dd.totals.pos === T.purchase_orders.length, `${raw.totals.pos}`);
  add('Country totals sum to grand total', Math.abs(raw.byCountry.reduce((s, c) => s + c.value, 0) - total) < 0.01, '');
  add('Month totals sum to grand total', Math.abs(raw.monthly.reduce((s, c) => s + c.value, 0) - total) < 0.01, '');
  add('Product totals sum to grand total', Math.abs(raw.byProduct.reduce((s, c) => s + c.value, 0) - total) < 0.01, '');
  add('Raw customer count = customers with POs', raw.totals.activeCustomers === new Set(T.purchase_orders.map(p => p.customer_id)).size, `${raw.totals.activeCustomers}`);
  add('Dedup customer count = distinct golden ids with POs', dd.totals.activeCustomers === new Set(T.purchase_orders.map(p => model.golden.get(p.customer_id))).size, `${dd.totals.activeCustomers}`);
  add('Dedup active customers <= raw', dd.totals.activeCustomers <= raw.totals.activeCustomers, `${dd.totals.activeCustomers} <= ${raw.totals.activeCustomers}`);

  const src = [...model.customers.values()].filter(c => c.origin === 'imported');
  const goldenImported = new Map(T.golden_map.map(g => [g.customer_id, g.golden_id]));
  const ev = memoised(source, 'eval', () => evaluate(src.map(c => ({ ...c, ...c.original })), goldenImported, DEFAULTS));
  add('Matcher vs provided golden_map: precision >= 0.95', ev.precision >= 0.95, `precision ${ev.precision.toFixed(3)} (tp ${ev.tp}, fp ${ev.fp})`);
  add('Matcher vs provided golden_map: recall >= 0.95', ev.recall >= 0.95, `recall ${ev.recall.toFixed(3)} (missed ${ev.fn}${ev.missed.length ? ': ' + ev.missed.map(m => m.join('/')).join(', ') : ''})`);
  const decoys = T.golden_map.filter(g => g.match_reason === 'near_miss_distinct_company').map(g => g.customer_id);
  const decoyHit = ev.falsePos.filter(p => decoys.includes(p[0]) || decoys.includes(p[1])).length;
  add('Near-miss decoy companies are not merged', decoyHit === 0, `${decoys.length} decoys, ${decoyHit} false merges`);

  // approval engine vs the approval paths already in the CSV
  const mismatches = [], explained = [];
  let n = 0;
  for (const r of T.requests) {
    const p = JSON.parse(r.payload_json), ctx = { request_type: r.request_type, country: r.country, field: p.field };
    if (r.request_type === 'merge_customer') {
      ctx.entitiesDiffer = new Set(p.merge_ids.map(i => model.customers.get(i)?.entity)).size > 1;
      ctx.openPoValueSgd = openPoProxy(model, p.merge_ids, Number(process.env.OPEN_PO_WINDOW_DAYS || 30));
    }
    const got = buildApprovalPath(T.config_approval_rules, ctx).steps.map(s => s.role).join(' > ');
    n++;
    if (got !== r.approval_path) {
      const without = buildApprovalPath(T.config_approval_rules, { ...ctx, openPoValueSgd: 0 }).steps.map(s => s.role).join(' > ');
      (without === r.approval_path ? explained : mismatches).push(`${r.request_id}: engine "${got}" vs csv "${r.approval_path}"`);
    }
  }
  add('Approval engine reproduces CSV approval paths (excluding the open-PO proxy rule R07)', mismatches.length === 0,
    `${n - mismatches.length - explained.length}/${n} exact${explained.length ? `; ${explained.length} differ only because the open-PO proxy triggers R07 (${explained.map(x => x.split(':')[0]).join(', ')}); the CSV has no PO status so true open value is unknown` : ''}${mismatches.length ? '; UNEXPLAINED: ' + mismatches.join(' | ') : ''}`);

  const wf = db.prepare('SELECT COUNT(*) n FROM requests WHERE source = ?').get('imported').n;
  add('Imported requests persisted in app DB', wf >= T.requests.length, `${wf} imported rows vs ${T.requests.length} in CSV`);
  const lg = db.prepare('SELECT COUNT(*) n FROM audit_log WHERE source = ?').get('imported').n;
  add('Imported audit events persisted in app DB', lg >= T.audit_log.length, `${lg} vs ${T.audit_log.length}`);
  // --- database mirrors the CSV
  const one = sql => db.prepare(sql).get().n;
  const impC = one("SELECT COUNT(*) n FROM md_customers WHERE source = 'imported'");
  add('DB customers = CSV customers', impC === T.customers.length, impC + ' vs ' + T.customers.length);
  const dbPo = one('SELECT COUNT(*) n FROM md_purchase_orders'), dbVal = one('SELECT ROUND(SUM(value),2) n FROM md_purchase_orders');
  add('DB purchase orders = CSV (count and value)', dbPo === T.purchase_orders.length && Math.abs(dbVal - total) < 0.01, dbPo + ' POs, ' + dbVal);
  add('Per-customer item totals (md_customer_items) = PO total', Math.abs(one('SELECT ROUND(SUM(value),2) n FROM md_customer_items') - total) < 0.01, one('SELECT COUNT(*) n FROM md_customer_items') + ' customer-item rows');
  const merged = one("SELECT COUNT(*) n FROM requests WHERE source = 'app' AND status = 'applied' AND request_type = 'merge_customer'") > 0;
  add('DB golden mapping = CSV golden_map (unless merged in the app)', merged || T.golden_map.every(g => db.prepare('SELECT golden_id FROM md_customers WHERE customer_id = ?').get(g.customer_id)?.golden_id === g.golden_id), 'every customer carries its provided golden_id');
  add('Inbox loaded into DB', one('SELECT COUNT(*) n FROM md_inbox') === T.inbox_messages.length, one('SELECT COUNT(*) n FROM md_inbox') + ' messages');
  const tri = require('./inbox').triage(model, db);
  add('Inbox triage accuracy >= 0.9 vs provided labels', tri.summary.accuracy >= 0.9, 'accuracy ' + (tri.summary.accuracy * 100).toFixed(1) + '% on ' + tri.summary.total + ' messages (templated data: optimistic)');
  const clear = db.prepare("SELECT COUNT(*) n FROM md_records WHERE data_json LIKE '%bank_account%' AND data_json NOT LIKE '%enc:v1:%'").get().n;
  add('Sensitive fields are not stored in clear text', clear === 0, 'checked md_records');
  return { checks, evaluation: { tp: ev.tp, fp: ev.fp, fn: ev.fn, precision: ev.precision, recall: ev.recall, f1: ev.f1, missed: ev.missed, falsePos: ev.falsePos, thresholds: DEFAULTS } };
}

module.exports = { profile, findings, CAPABILITIES, validate, memoised };
