'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { isEnc } = require('../src/crypto');

process.env.MDM_KEYFILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdmkey-')), 'k');
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdm-')), 'app.db');
const Q = s => new URLSearchParams(s);
const call = (app, route, { body, q, params, who } = {}) => app.routes[route]({ body: body || {}, q: Q(q || ''), params: params || {}, who: who || {} });
const approveAll = (app, req, prefix = 'ap.') => { let r = req; for (const role of req.path) r = app.wf.decide(req.request_id, { actor: prefix + role.replace(/\W/g, ''), role, decision: 'approve' }); return r; };

test('master data is in the database: customers, items, per-customer items, golden ids, POs, inbox', () => {
  const app = createApp({ dbFile: ':memory:' });
  const n = t => app.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  assert.equal(n('md_customers'), 240);
  assert.equal(n('md_purchase_orders'), 1500);
  assert.equal(n('md_inbox'), 200);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM md_records WHERE domain='item'").get().n, 3);
  assert.equal(app.db.prepare('SELECT COUNT(DISTINCT golden_id) n FROM md_customers').get().n, 166);
  const total = app.db.prepare('SELECT ROUND(SUM(value),2) v FROM md_customer_items').get().v;
  assert.equal(total, app.db.prepare('SELECT ROUND(SUM(value),2) v FROM md_purchase_orders').get().v);
  const d = call(app, 'GET /api/master/customer/:id', { params: { id: 'C00003' } });
  assert.ok(d.items.length >= 1 && d.items.every(i => ['A', 'B', 'C'].includes(i.item_code)));
  assert.equal(call(app, 'GET /api/master/:domain', { params: { domain: 'vendor' } }).total, 0); // nothing invented
});

test('a restart does not duplicate master rows or overwrite local edits', () => {
  const db = tmpDb();
  let app = createApp({ dbFile: db });
  const req = approveAll(app, app.wf.createRequest({ request_type: 'update_customer', target_customer_id: 'C00003', field: 'address', new_value: '5 New Road, Singapore 111111', requested_by: 'a.b' }));
  app.wf.apply(req.request_id, 'sys');
  assert.equal(app.ctx.getModel().customers.get('C00003').address, '5 New Road, Singapore 111111');
  app.db.close();
  app = createApp({ dbFile: db });
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM md_customers').get().n, 240);
  assert.equal(app.ctx.getModel().customers.get('C00003').address, '5 New Road, Singapore 111111');
  assert.equal(app.ctx.getModel().customers.get('C00003').original.address, '71 Kallang Way, Singapore 383158'); // CSV value kept for traceability
  const r = call(app, 'POST /api/source/refresh');
  assert.equal(r.importResult.master.customers, 0);
});

test('item request routes through Quality/Regulatory only when regulated, and creates an item record', () => {
  const app = createApp({ dbFile: tmpDb() });
  const base = { request_type: 'create_item', item_code: 'LAB-100', name: 'Pipette tips 200ul (box of 960)', product_line: 'Other', requested_by: 'amy.pm' };
  const noReg = app.wf.preview({ ...base, regulated: 'N' });
  assert.deepEqual(noReg.route.steps.map(s => s.role), ['Business Unit Head', 'Business Support']);
  const reg = app.wf.preview({ ...base, regulated: 'Y' });
  assert.deepEqual(reg.route.steps.map(s => s.role), ['Quality/Regulatory Affairs', 'Business Unit Head', 'Business Support']);
  assert.ok(app.wf.preview({ ...base, regulated: '' }).errors.regulated, 'regulated flag is required (the brief\'s Amy problem)');

  const dup = app.wf.preview({ ...base, item_code: 'lab-100x', name: 'Pipette tips 200 ul (box of 960)', regulated: 'N' });
  assert.deepEqual(dup.duplicates, []); // nothing similar yet
  const req = app.wf.createRequest({ ...base, regulated: 'Y' });
  assert.equal(req.domain, 'item');
  approveAll(app, req);
  app.wf.apply(req.request_id, 'sys');
  const rec = call(app, 'GET /api/master/:domain/:id', { params: { domain: 'item', id: 'LAB-100' } });
  assert.equal(rec.name, 'Pipette tips 200ul (box of 960)');
  // now a near-identical item is flagged
  const again = app.wf.preview({ ...base, item_code: 'LAB-101', name: 'PIPETTE TIPS 200UL (BOX OF 960)', regulated: 'Y' });
  assert.equal(again.duplicates[0].id, 'LAB-100');
  assert.equal(again.duplicates[0].class, 'duplicate');
  // the same code is refused outright
  assert.ok(app.wf.preview({ ...base, regulated: 'Y' }).errors.item_code);
});

test('vendor: sensitive fields are encrypted at rest, masked by role, reveals are logged, and never exported', () => {
  const app = createApp({ dbFile: tmpDb() });
  const body = { request_type: 'create_vendor', name: 'Bright Reagents Pte. Ltd.', entity: 'QTG', country: 'SG', registration_no: '201912345K',
    address: '10 Science Park Rd, Singapore 118000', payment_terms: 'NET30', bank_account: '123-456-789012', requested_by: 'proc.sg' };
  const req = app.wf.createRequest(body);
  assert.deepEqual(req.path, ['Data Steward', 'Entity Finance Lead']);
  const raw = app.db.prepare('SELECT payload_json FROM requests WHERE request_id = ?').get(req.request_id).payload_json;
  assert.ok(!raw.includes('123-456-789012'), 'bank account must not be in the DB in clear text');
  assert.ok(isEnc(JSON.parse(raw).bank_account));
  // masked for a non-finance role, visible (and logged) for finance
  assert.match(app.wf.getRequest(req.request_id, { actor: 'x', role: 'Data Steward' }).payload.bank_account, /restricted/);
  assert.equal(app.wf.getRequest(req.request_id, { actor: 'Finance', role: 'Finance' }).payload.bank_account, '123-456-789012');
  assert.equal(app.wf.getRequest(req.request_id, { role: 'Finance' }).payload.bank_account.includes('restricted'), true, 'no actor, no reveal');
  assert.ok(app.db.prepare("SELECT COUNT(*) n FROM sensitive_access_log WHERE actor = 'Finance' AND field = 'bank_account'").get().n >= 1);

  approveAll(app, req);
  app.wf.apply(req.request_id, 'sys');
  const stored = app.db.prepare("SELECT data_json FROM md_records WHERE domain = 'vendor'").get().data_json;
  assert.ok(!stored.includes('123-456-789012') && stored.includes('enc:v1:'));
  const id = call(app, 'GET /api/master/:domain', { params: { domain: 'vendor' } }).rows[0].id;
  assert.match(id, /^V\d{5}$/);
  assert.match(call(app, 'GET /api/master/:domain/:id', { params: { domain: 'vendor', id }, who: { actor: 'k', role: 'Business Support' } }).data.bank_account, /restricted/);

  const ex = call(app, 'GET /api/sap/preview', { q: 'domain=vendor' });
  assert.equal(ex.rows.length, 1);
  assert.equal(ex.rows[0].CardType, 'S');
  assert.ok(!JSON.stringify(ex).includes('123-456-789012'));
  assert.match(ex.rows[0].MissingOrToConfirm, /Not exported \(sensitive\)/);

  // updating a sensitive field escalates to Finance + Compliance
  const upd = app.wf.createRequest({ request_type: 'update_vendor', target_customer_id: id, field: 'bank_account', new_value: '999-888-777666', requested_by: 'proc.sg' });
  assert.deepEqual(upd.path, ['Entity Finance Lead', 'Compliance Officer']);
});

test('config: add a domain, a field and an approval rule at runtime without code', () => {
  const app = createApp({ dbFile: tmpDb() });
  call(app, 'POST /api/config/domain', { body: { key: 'service_contract', label: 'Service contract' }, who: { actor: 'mdm.lead' } });
  call(app, 'POST /api/config/field', { body: { domain: 'service_contract', name: 'tier', data_type: 'enum', validation: 'GOLD|SILVER', required: true } });
  call(app, 'POST /api/config/rule', { body: { domain: 'service_contract', request_type: 'create_service_contract', condition: 'tier = GOLD', step: 2, approver_role: 'Regional Director', sla_hours: 48 } });
  assert.throws(() => call(app, 'POST /api/config/field', { body: { domain: 'service_contract', name: 'bad', data_type: 'string', validation: '([' } }), /regular expression/);
  assert.throws(() => call(app, 'POST /api/config/rule', { body: { domain: 'service_contract', request_type: 'create_service_contract', condition: 'nonsense ~~', step: 1, approver_role: 'X Y' } }), /Condition not understood/);

  const gold = app.wf.preview({ request_type: 'create_service_contract', name: 'Hospital A SLA', tier: 'GOLD' });
  assert.deepEqual(gold.route.steps.map(s => s.role), ['Data Steward', 'Regional Director']);
  const silver = app.wf.preview({ request_type: 'create_service_contract', name: 'Hospital B SLA', tier: 'SILVER' });
  assert.deepEqual(silver.route.steps.map(s => s.role), ['Data Steward']);
  assert.ok(app.wf.preview({ request_type: 'create_service_contract', name: 'X', tier: 'BRONZE' }).errors.tier);
  assert.ok(call(app, 'GET /api/meta').options.domains.some(d => d.key === 'service_contract'));
  // every config change is logged
  assert.ok(call(app, 'GET /api/config').recentChanges.length >= 3);
  // disabling a rule changes routing immediately
  call(app, 'POST /api/config/rule/toggle', { body: { rule_id: 'PI3', enabled: false } });
  assert.deepEqual(app.wf.preview({ request_type: 'create_item', item_code: 'Z1', name: 'Thing', product_line: 'A', regulated: 'N' }).route.steps.map(s => s.role), ['Business Unit Head']);
});

test('inbox triage separates orders, enquiries, follow-ups and MDM requests and pre-fills requests', () => {
  const app = createApp({ dbFile: ':memory:' });
  const t = call(app, 'GET /api/inbox');
  assert.ok(t.summary.accuracy >= 0.9);
  assert.equal(t.summary.total, 200);
  const mdm = t.items.find(i => i.mdm?.kind === 'update_uen');
  assert.equal(mdm.mdm.request_type, 'update_customer');
  assert.ok(mdm.mdm.prefill.target_customer_id && mdm.mdm.prefill.new_value);
  // the pre-filled request is accepted by the intake validator
  const pv = app.wf.preview({ request_type: mdm.mdm.request_type, ...mdm.mdm.prefill });
  assert.deepEqual(pv.errors, {});
  // follow-ups quoting a PO number are checked against the PO table
  assert.ok(t.items.some(i => i.followUp?.poFound));
  // order emails never get counted as orders in analytics
  const o = call(app, 'GET /api/analytics/orders-vs-mdm');
  assert.equal(o.byMonth.reduce((s, m) => s + m.orders, 0), 1500);
});

test('growth table: stated period, stated definition, reconciles to PO totals', () => {
  const app = createApp({ dbFile: ':memory:' });
  const mx = call(app, 'GET /api/analytics/matrix', { q: 'period=6' });
  assert.equal(mx.period, 6);
  assert.equal(mx.window, '2026-04 to 2026-09');
  assert.match(mx.definition, /same 6 months a year earlier/);
  const csv = app.ctx.getSource().tables.purchase_orders.filter(p => p.date >= '2026-04-01' && p.date <= '2026-09-30').reduce((s, p) => s + Number(p.value), 0);
  assert.ok(Math.abs(mx.total.value - csv) < 0.01);
  assert.ok(Math.abs(mx.rows.reduce((s, r) => s + r.total.value, 0) - csv) < 0.01);
  assert.equal(call(app, 'GET /api/analytics/matrix', { q: 'period=12' }).period, 9); // capped by the 21 months of history
  assert.ok(call(app, 'GET /api/analytics/actions').length >= 5);
});
