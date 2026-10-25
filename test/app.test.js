'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('../src/server');
const { SOURCE_CSV } = require('../src/csv');
const { forecastSeries, wape, mape } = require('../src/forecast');
const { comparePair, normName } = require('../src/matching');

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdm-')), 'app.db');
const Q = s => new URLSearchParams(s);
const call = (app, route, { body, q, params } = {}) => app.routes[route]({ body: body || {}, q: Q(q || ''), params: params || {} });

test('source CSV loads and validation checks pass', () => {
  const app = createApp({ dbFile: ':memory:' });
  const v = call(app, 'GET /api/validate');
  const failed = v.checks.filter(c => !c.pass);
  assert.deepEqual(failed, []);
  const meta = call(app, 'GET /api/meta');
  assert.equal(meta.source.tables.customers, 240);
  assert.equal(meta.source.tables.purchase_orders, 1500);
  assert.equal(meta.coverage.months, 21);
  assert.equal(meta.coverage.enoughFor24Months, false);
});

test('raw vs dedup analytics share the same PO rows', () => {
  const app = createApp({ dbFile: ':memory:' });
  const d = call(app, 'GET /api/analytics/dedup-impact');
  assert.equal(d.sameTotals, true);
  assert.equal(d.raw.value, d.dedup.value);
  assert.equal(d.masterRecords.raw, 240);
  assert.equal(d.masterRecords.dedup, 166);
  assert.ok(d.dedup.activeCustomers < d.raw.activeCustomers);
  // country filter reconciles to the CSV
  const sg = call(app, 'GET /api/analytics/overview', { q: 'country=SG' });
  const csvSg = app.ctx.getSource().tables.purchase_orders.filter(p => p.country === 'SG').reduce((s, p) => s + Number(p.value), 0);
  assert.equal(sg.totals.value, Math.round(csvSg * 100) / 100);
});

test('duplicate matcher: variants match, near-miss decoys do not', () => {
  const a = { name: 'Siam Components Sdn. Bhd.', country: 'MY', uen: '200801554582', address: '130 Jalan Perindustrian 2, Kuala Lumpur 67528' };
  const b = { name: 'SIAM COMPONENTS SDN. BHD.', country: 'MY', uen: '200801554582', address: '130 Jln Perindustrian 2, Kuala Lumpur 67528' };
  assert.ok(comparePair(a, b).score >= 0.9);
  assert.equal(normName('PT  Saigon Marine '), normName('Saigon Marine PT'));
  const decoy = { name: 'Summit Trading Co., Ltd.', country: 'TH', uen: '0201075518511', address: '129 Rama IV Road, Chonburi 12904' };
  const other = { name: 'PT Summit Trading', country: 'ID', uen: '2519921265064', address: '17 Jl. Raya Bekasi, Batam 57094' };
  assert.ok(comparePair(decoy, other).score < 0.75);
});

test('workflow persists across restarts, never touches the CSV, and import is idempotent', () => {
  const db = tmpDb(), before = sha(SOURCE_CSV);
  let app = createApp({ dbFile: db });
  assert.equal(call(app, 'GET /api/requests').length, 40);
  // REQ0012 is pending at Compliance Officer (name update, TH)
  const r0 = call(app, 'GET /api/requests/:id', { params: { id: 'REQ0012' } });
  assert.equal(r0.awaiting, 'Compliance Officer');
  assert.throws(() => app.wf.decide('REQ0012', { actor: 'x.y', role: 'Data Steward', decision: 'approve' }), /Awaiting Compliance Officer/);
  const done = app.wf.decide('REQ0012', { actor: 'k.lee', role: 'Compliance Officer', decision: 'approve', comment: 'ok' });
  assert.equal(done.status, 'approved');
  app.db.close();

  app = createApp({ dbFile: db }); // restart: same CSV hash => no re-import
  assert.equal(call(app, 'GET /api/requests').length, 40);
  assert.equal(call(app, 'GET /api/requests/:id', { params: { id: 'REQ0012' } }).status, 'approved');
  // forced refresh: INSERT OR IGNORE must not duplicate or overwrite
  const r = call(app, 'POST /api/source/refresh');
  assert.equal(r.importResult.requestsAdded, 0);
  assert.equal(r.importResult.auditAdded, 0);
  assert.equal(call(app, 'GET /api/requests/:id', { params: { id: 'REQ0012' } }).status, 'approved');
  assert.equal(sha(SOURCE_CSV), before, 'source CSV must be byte-identical');
});

test('intake validation + duplicate gate + approval + apply + SAP export', () => {
  const app = createApp({ dbFile: tmpDb() });
  const base = { request_type: 'create_customer', entity: 'QTG', country: 'SG', name: 'Tropika Marine Pte Ltd', uen: '201698696R', address: '71 Kallang Way, Singapore 383158', requested_by: 'sales.sg@hq' };

  const bad = call(app, 'POST /api/intake/preview', { body: { ...base, entity: 'XXX', uen: '12' } });
  assert.ok(bad.errors.entity && bad.errors.uen);

  // duplicate of C00003 is blocked until acknowledged
  const p = call(app, 'POST /api/intake/preview', { body: base });
  assert.equal(p.duplicates[0].customer_id, 'C00003');
  assert.equal(p.duplicates[0].class, 'duplicate');
  assert.throws(() => app.wf.createRequest(base), e => e.status === 409);

  const fresh = { ...base, name: 'Zephyr Quantum Pte. Ltd.', uen: '202611111A', address: '9 Test Avenue, Singapore 123456' };
  assert.equal(call(app, 'POST /api/intake/preview', { body: fresh }).duplicates.length, 0);
  const req = app.wf.createRequest(fresh);
  assert.equal(req.status, 'pending_approval');
  assert.deepEqual(req.path, ['Data Steward', 'Entity Finance Lead']); // R01 + R02, matches CSV SG create paths
  assert.match(req.request_id, /^NEW-/);

  assert.throws(() => app.wf.decide(req.request_id, { actor: 'sales.sg@hq', role: 'Data Steward', decision: 'approve' }), /own request/);
  assert.throws(() => app.wf.decide(req.request_id, { actor: 'a', role: 'Entity Finance Lead', decision: 'approve' }), /Awaiting Data Steward/);
  assert.throws(() => app.wf.decide(req.request_id, { actor: 'a', role: 'Data Steward', decision: 'reject' }), /comment is required/);
  app.wf.decide(req.request_id, { actor: 'lim.jh', role: 'Data Steward', decision: 'approve' });
  const appr = app.wf.decide(req.request_id, { actor: 'tan.wl', role: 'Entity Finance Lead', decision: 'approve' });
  assert.equal(appr.status, 'approved');
  assert.deepEqual(appr.audit.map(a => a.action), ['created', 'submitted', 'approved', 'approved', 'final_approval']);

  // export before apply: flagged, no CardCode
  let ex = call(app, 'GET /api/sap/preview');
  assert.equal(ex.rows.length, 1);
  assert.match(ex.rows[0].MissingOrToConfirm, /CardCode: not yet assigned/);
  assert.match(ex.rows[0].MissingOrToConfirm, /GroupCode/);
  assert.equal(ex.notImported, true);

  const before = call(app, 'GET /api/customers', { q: 'limit=1' }).total;
  app.wf.apply(req.request_id, 'mdm.system');
  assert.equal(call(app, 'GET /api/customers', { q: 'limit=1' }).total, before + 1);
  // new customer now participates in duplicate detection
  assert.equal(call(app, 'POST /api/intake/preview', { body: fresh }).duplicates[0].origin, 'app');

  ex = call(app, 'GET /api/sap/preview');
  assert.equal(ex.rows[0].CardCode, 'N00001');
  assert.equal(ex.rows[0].City, 'Singapore');
  assert.equal(ex.rows[0].ZipCode, '123456');
  const out = call(app, 'POST /api/sap/export', { body: {} });
  assert.match(out.csv, /^CardCode,CardName/);
  assert.match(out.statement, /Nothing has been sent/);
  assert.throws(() => call(app, 'POST /api/sap/export', { body: {} }), e => e.status === 409); // already exported

  // PO analytics untouched by master-data changes
  assert.equal(call(app, 'GET /api/analytics/overview').totals.value, 53251111.5);
});

test('update drafts with the "<<new value>>" placeholder cannot be submitted until a value is supplied', () => {
  const app = createApp({ dbFile: tmpDb() });
  // imported draft REQ0002 has "<<new value>>"
  assert.throws(() => app.wf.submitDraft('REQ0002', 'x'), /placeholder/);
  const fixed = app.wf.setDraftNewValue('REQ0002', '5170871316735');
  assert.equal(fixed.payload.new, '5170871316735');

  const sub = app.wf.submitDraft('REQ0002', 'x');
  assert.equal(sub.status, 'pending_approval');
  assert.equal(sub.awaiting, 'Local Country Admin (ID)');
});

test('merge across countries is refused; same-country merge changes dedup mapping', () => {
  const app = createApp({ dbFile: tmpDb() });
  assert.throws(() => app.wf.createRequest({ request_type: 'merge_customer', target_customer_id: 'C00010', merge_ids: ['C00010', 'C00042'], requested_by: 'a' }), e => e.status === 422);
  // C00010 (ID) and C00006 (ID) are distinct companies in golden_map; force-merge to see mapping change
  const m = app.ctx.getModel();
  // two different golden customers in the same country that both have POs
  const buyers = [...new Set(m.pos.filter(p => p.country === 'ID').map(p => p.customer_id))];
  const a = buyers[0], b = buyers.find(c => m.golden.get(c) !== m.golden.get(a));
  const req = app.wf.createRequest({ request_type: 'merge_customer', target_customer_id: a, merge_ids: [a, ...m.goldenMembers.get(m.golden.get(b))], requested_by: 'a' });
  for (const role of req.path) app.wf.decide(req.request_id, { actor: 'approver.' + role, role, decision: 'approve' });
  const before = call(app, 'GET /api/analytics/overview').totals.activeCustomers;
  app.wf.apply(req.request_id, 'sys');
  const after = call(app, 'GET /api/analytics/overview').totals.activeCustomers;
  assert.equal(after, before - 1);
  assert.equal(app.ctx.getModel().golden.get(b), app.ctx.getModel().golden.get(a));
  // raw view is unchanged by merges
  assert.equal(call(app, 'GET /api/analytics/overview', { q: 'basis=raw' }).totals.activeCustomers, 234);
});

test('forecast: metrics computed from real predictions; refuses without enough data', () => {
  assert.equal(wape([100, 100], [90, 120]), 0.15);
  assert.equal(mape([100, 200], [90, 220]), 0.1);
  const short = forecastSeries([1, 2, 3, 4, 5], ['a', 'b', 'c', 'd', 'e']);
  assert.equal(short.backtest, null);
  assert.match(short.notes[0], /not enough/);
  const app = createApp({ dbFile: ':memory:' });
  const f = call(app, 'GET /api/forecast');
  assert.equal(f.coverage.months, 21);
  assert.match(f.requested24Months, /24-month history is not available/);
  assert.equal(f.backtest.trainMonths, 18);
  assert.equal(f.backtest.testMonths.length, 3);
  // independently recompute rolling forecast & WAPE from the CSV
  const T = app.ctx.getSource().tables.purchase_orders, by = {};
  T.forEach(p => { by[p.date.slice(0, 7)] = (by[p.date.slice(0, 7)] || 0) + Number(p.value); });
  const months = Object.keys(by).sort(), v = months.map(k => by[k]);
  const tr = v.slice(0, 18), te = v.slice(18);
  const lvl = (tr[15] + tr[16] + tr[17]) / 3;
  const w = te.reduce((s, a) => s + Math.abs(a - lvl), 0) / te.reduce((s, a) => s + a, 0);
  assert.ok(Math.abs(f.backtest.metrics[0].wape - w) < 1e-9);
});
