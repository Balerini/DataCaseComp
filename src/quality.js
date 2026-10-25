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

function findings(source, model) {
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
  const cov = coverage(model);
  f.push({ severity: cov.enoughFor24Months ? 'ok' : 'warn', area: 'purchase_orders', text: `PO history covers ${cov.months} months (${cov.firstDate} to ${cov.lastDate})${cov.enoughFor24Months ? '' : ' — less than 24 months; no history was fabricated.'}` });
  f.push({ severity: 'info', area: 'purchase_orders', text: 'The data ends on its last PO date; later months have no data (not zero demand).' });
  return f;
}

const CAPABILITIES = [
  { feature: 'Duplicate detection (name / registration no. / address)', status: 'supported', basis: 'customers.name, uen, address, country, entity' },
  { feature: 'Canonical (golden) mapping', status: 'supported', basis: 'golden_map (240 rows) + canonical_overrides table for merges applied in the app' },
  { feature: 'Regional PO analytics (country, product, customer, growth)', status: 'supported', basis: 'purchase_orders: customer_id, country, date, product, qty, value (SGD)' },
  { feature: 'Raw vs deduplicated comparison', status: 'supported', basis: 'same PO rows keyed by customer_id vs golden_id' },
  { feature: 'Drop-off', status: 'supported', basis: 'customers active in the prior window with no PO in the recent window (default 90 days). "Churn" is inferred from absence of POs; the data has no contract/closure status.' },
  { feature: 'Cross-sell', status: 'supported', basis: 'product mix per customer (3 products: A, B, C). No product hierarchy or price list.' },
  { feature: 'Forecast with 24-month history', status: 'partial', basis: 'Only 21 months exist; 3-month holdout leaves 18 months of training. Seasonal factors rest on one prior-year observation.' },
  { feature: 'Open PO value (approval rule R07)', status: 'partial', basis: 'purchase_orders has no open/closed status. A proxy (POs dated in the last N days) is used and labelled as such.' },
  { feature: 'Approval routing', status: 'supported', basis: 'config_approval_rules (12 rules), evaluated per request' },
  { feature: 'Approver identity / authentication', status: 'missing', basis: 'No user or role table beyond role names. The app lets the operator choose the role they act as; this is not access control.' },
  { feature: 'SAP B1 export - CardName, tax ID, country, address', status: 'supported', basis: 'request payload + customer columns' },
  { feature: 'SAP B1 export - GroupCode, Currency, payment terms, contacts, tax code', status: 'missing', basis: 'Not in the source; exported blank and flagged on each row.' },
  { feature: 'SAP B1 export - CardCode numbering', status: 'partial', basis: 'App-assigned id for new customers; B1 numbering series must be confirmed.' },
  { feature: 'Update-request new values', status: 'partial', basis: 'Imported update requests contain "<<new value>>" placeholders; real values can only be added to drafts.' },
  { feature: 'Inbox classification (inbox_messages)', status: 'not used', basis: 'Table is loaded and profiled but no feature in this scope consumes it.' },
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
  return { checks, evaluation: { tp: ev.tp, fp: ev.fp, fn: ev.fn, precision: ev.precision, recall: ev.recall, f1: ev.f1, missed: ev.missed, falsePos: ev.falsePos, thresholds: DEFAULTS } };
}

module.exports = { profile, findings, CAPABILITIES, validate, memoised };
