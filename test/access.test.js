'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');

process.env.MDM_KEYFILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdmkey-')), 'k');

/** Boot the real HTTP server and return a client that "acts as" a position (and optionally a region). */
async function boot() {
  const app = createApp({ dbFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdm-')), 'app.db') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const as = (role, region = 'ALL') => async (method, p, body) => {
    const headers = { 'content-type': 'application/json', ...(role ? { 'x-role': encodeURIComponent(role), 'x-region': region } : {}) };
    const r = await fetch(base + '/api' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { app, as, close: () => app.server.close() };
}

test('every route has an explicit permission entry', async () => {
  const { app, close } = await boot();
  const missing = Object.keys(app.routes).filter(k => !app.PERM[k]);
  close();
  assert.deepEqual(missing, []);
});

test('the "Acting as" list is exactly the brief\'s positions, with roles only (no individuals)', async () => {
  const { as, close } = await boot();
  const { body } = await as(null)('GET', '/positions');
  close();
  const names = body.positions.map(p => p.role);
  assert.deepEqual(names.sort(), ['Business Support', 'Business Unit Head', 'Finance', 'IT', 'MDM Team', 'Procurement Officer', 'Product Manager', 'Quality/Regulatory Affairs', 'Regional Sales'].sort());
  assert.deepEqual(body.regions, ['ALL', 'SG', 'MY', 'ID', 'TH', 'VN']);
  // the CSV's other approval roles are performed by one of those positions
  const alias = Object.fromEntries(body.aliases.map(a => [a.rule_role, a.position]));
  assert.equal(alias['Data Steward'], 'MDM Team');
  assert.equal(alias['Entity Finance Lead'], 'Finance');
  assert.ok(Object.values(alias).every(p => names.includes(p)));
  assert.ok(!JSON.stringify(body).match(/budi\.s|lim\.jh|ong\.sk|chua\.bl|goh\.yt/), 'no personal handles are exposed');
});

test('no position chosen, no access; an unknown position is refused', async () => {
  const { as, close } = await boot();
  assert.equal((await as(null)('GET', '/requests')).status, 401);
  assert.equal((await as('Chief Wizard')('GET', '/requests')).status, 401);
  assert.equal((await as(null)('GET', '/positions')).status, 200);
  close();
});

test('a requestor sees only requests raised by their position and cannot approve, apply, export, triage or configure', async () => {
  const { as, close } = await boot();
  const sales = as('Regional Sales');
  const mine = (await sales('GET', '/requests')).body;
  assert.ok(mine.length > 0 && mine.length < 40);
  assert.ok(mine.every(r => r.requested_by_label === 'Regional Sales'));
  const other = (await as('MDM Team')('GET', '/requests')).body.find(r => r.requested_by_label !== 'Regional Sales');
  assert.equal((await sales('GET', '/requests/' + other.request_id)).status, 403);
  assert.equal((await sales('POST', `/requests/${mine.find(r => r.status === 'pending_approval').request_id}/decide`, { decision: 'approve' })).status, 403);
  for (const p of ['/config', '/inbox', '/sap/preview', '/duplicates/groups']) assert.equal((await sales('GET', p)).status, 403, p);
  assert.equal((await sales('POST', '/sap/export', {})).status, 403);
  assert.equal((await sales('POST', '/requests/REQ0001/apply', {})).status, 403);
  assert.equal((await sales('GET', '/analytics/matrix')).status, 200, 'Regional Sales has the commercial views');
  // a requestor with no commercial views
  assert.equal((await as('Procurement Officer')('GET', '/analytics/matrix')).status, 403);
  close();
});

test('approvers only decide their own step, in their own lane; the audit trail records the position', async () => {
  const { app, as, close } = await boot();
  const amy = as('Product Manager');
  const created = (await amy('POST', '/requests', { request_type: 'create_item', item_code: 'LAB-9', name: 'Lab consumable 9', product_line: 'Other', regulated: 'Y' })).body;
  assert.equal(created.requested_by, 'Product Manager');
  assert.deepEqual(created.path_positions, ['Quality/Regulatory Affairs', 'Business Unit Head', 'Business Support']);

  const finance = as('Finance'), qra = as('Quality/Regulatory Affairs'), buh = as('Business Unit Head');
  assert.equal((await finance('GET', '/requests/' + created.request_id)).status, 403, 'Finance has no step on an item request');
  assert.equal((await qra('GET', '/requests/' + created.request_id)).body.can.approve, true);
  assert.equal((await buh('GET', '/requests/' + created.request_id)).body.can.approve, false, 'cannot jump the queue');
  assert.equal((await buh('POST', `/requests/${created.request_id}/decide`, { decision: 'approve' })).status, 403);
  // the position that raised the request cannot approve it, whatever the body says
  assert.equal((await amy('POST', `/requests/${created.request_id}/decide`, { decision: 'approve', role: 'Quality/Regulatory Affairs' })).status, 403);
  // a role named in the body is ignored: the acting position decides
  assert.equal((await qra('POST', `/requests/${created.request_id}/decide`, { decision: 'approve', actor: 'someone.else', role: 'Business Support' })).status, 200);
  assert.deepEqual(app.db.prepare("SELECT actor FROM audit_log WHERE request_id = ? AND action = 'approved'").all(created.request_id).map(a => a.actor), ['Quality/Regulatory Affairs']);
  const detail = (await qra('GET', '/requests/' + created.request_id)).body;
  assert.ok(detail.audit.every(a => a.actor_role));
  close();
});

test('CSV roles are performed by the mapped position (Finance performs "Entity Finance Lead"; Business Support the local-country pre-check)', async () => {
  const { as, close } = await boot();
  const fin = (await as('Finance')('GET', '/requests')).body;
  const waitingFin = fin.filter(r => r.awaiting === 'Entity Finance Lead' || r.awaiting === 'Compliance Officer');
  assert.ok(waitingFin.length > 0 && waitingFin.every(r => r.awaiting_position === 'Finance'));
  assert.ok(waitingFin.every(r => r.can.approve));
  // an imported ID request awaiting the Local Country Admin (ID) is a Business Support step
  const idStep = (await as('MDM Team')('GET', '/requests')).body.find(r => r.awaiting === 'Local Country Admin (ID)');
  if (idStep) assert.equal(idStep.awaiting_position, 'Business Support');
  close();
});

test('approvers see their lane; the MDM team and IT oversee everything', async () => {
  const { as, close } = await boot();
  const ids = async role => (await as(role)('GET', '/requests')).body.map(r => r.request_id).sort();
  const [mdm, it, fin, bs, qra] = await Promise.all(['MDM Team', 'IT', 'Finance', 'Business Support', 'Quality/Regulatory Affairs'].map(ids));
  assert.equal(mdm.length, 40);
  assert.equal(it.length, 40);
  assert.ok(fin.length < 40 && bs.length < 40);
  assert.equal(qra.length, 0, 'no imported request routes through Quality/Regulatory');
  assert.notDeepEqual(fin, bs);
  close();
});

test('region: "All regions" is the default; a region narrows requests, analytics and master data to that country', async () => {
  const { as, close } = await boot();
  const all = as('MDM Team'), sg = as('MDM Team', 'SG');
  const allReqs = (await all('GET', '/requests')).body, sgReqs = (await sg('GET', '/requests')).body;
  assert.equal(allReqs.length, 40);
  assert.ok(sgReqs.length > 0 && sgReqs.length < 40 && sgReqs.every(r => !r.country || r.country === 'SG'));
  const a = (await all('GET', '/analytics/overview')).body, s = (await sg('GET', '/analytics/overview')).body;
  assert.ok(s.totals.value < a.totals.value);
  assert.deepEqual(s.byCountry.map(c => c.country), ['SG']);
  assert.equal((await sg('GET', '/master/customer')).body.rows.every(c => c.country === 'SG'), true);
  const m = (await sg('GET', '/analytics/matrix')).body;
  assert.ok(m.rows.every(r => r.country === 'SG') || m.rows.filter(r => r.total.value > 0).every(r => r.country === 'SG'));
  // a request outside the region cannot be opened, decided, or raised
  const outside = allReqs.find(r => r.country && r.country !== 'SG');
  assert.equal((await sg('GET', '/requests/' + outside.request_id)).status, 403);
  const raise = await as('Regional Sales', 'SG')('POST', '/requests', { request_type: 'create_customer', name: 'Zed Labs Pte. Ltd.', entity: 'QTG', country: 'MY', uen: '202611111A', address: '9 Test Avenue, Kuala Lumpur 50000' });
  assert.equal(raise.status, 403);
  close();
});

test('the Indonesia/Vietnam local pre-check step needs Business Support in that region (or All regions)', async () => {
  const { app, as, close } = await boot();
  const req = (await as('Regional Sales')('POST', '/requests', { request_type: 'create_customer', name: 'Zed Labs PT', entity: 'QTG', country: 'ID', uen: '9456022987855', address: 'Jl. Sudirman 1, Jakarta 10110' })).body;
  assert.deepEqual(req.path, ['Local Country Admin (ID)', 'Data Steward', 'Entity Finance Lead']);
  assert.deepEqual(req.path_positions, ['Business Support', 'MDM Team', 'Finance']);
  assert.equal((await as('Business Support', 'SG')('GET', '/requests/' + req.request_id)).status, 403, 'wrong region');
  assert.equal((await as('Business Support', 'VN')('GET', '/requests/' + req.request_id)).status, 403, 'wrong region');
  assert.equal((await as('Business Support', 'ID')('POST', `/requests/${req.request_id}/decide`, { decision: 'approve' })).status, 200);
  assert.equal(app.db.prepare('SELECT current_step FROM requests WHERE request_id = ?').get(req.request_id).current_step, 'Data Steward');
  close();
});

test('the home screen is different for each kind of position', async () => {
  const { as, close } = await boot();
  const kinds = async (role, region) => (await as(role, region)('GET', '/home')).body.sections.map(s => s.type);
  assert.deepEqual(await kinds('Regional Sales'), ['mine', 'insights']);
  assert.deepEqual(await kinds('Procurement Officer'), ['mine']);
  assert.deepEqual(await kinds('Business Support'), ['queue']);
  assert.deepEqual(await kinds('Finance'), ['queue', 'sensitive']);
  assert.deepEqual(await kinds('Quality/Regulatory Affairs'), ['queue']);
  assert.deepEqual(await kinds('Business Unit Head'), ['queue', 'insights']);
  assert.deepEqual(await kinds('MDM Team'), ['queue', 'apply', 'insights']);
  assert.deepEqual(await kinds('IT'), ['admin']);
  close();
});

test('only IT can change configuration; the MDM team cannot', async () => {
  const { as, close } = await boot();
  assert.equal((await as('MDM Team')('GET', '/config')).status, 403);
  assert.equal((await as('IT')('GET', '/config')).status, 200);
  assert.equal((await as('IT')('POST', '/config/domain', { key: 'price_list', label: 'Price list' })).status, 200);
  assert.ok((await as('Finance')('GET', '/meta')).body.options.domains.some(d => d.key === 'price_list'));
  close();
});

test('sensitive values: masked for every position except Finance; Finance reveals are logged against the position', async () => {
  const { app, as, close } = await boot();
  const req = (await as('Procurement Officer')('POST', '/requests', { request_type: 'create_vendor', name: 'Bright Reagents Pte. Ltd.', entity: 'QTG', country: 'SG', registration_no: '201912345K',
    address: '10 Science Park Rd, Singapore 118000', payment_terms: 'NET30', bank_account: '123-456-789012' })).body;
  assert.match(req.payload.bank_account, /restricted/, 'even the requester cannot read it back');
  assert.match((await as('MDM Team')('GET', '/requests/' + req.request_id)).body.payload.bank_account, /restricted/);
  assert.equal((await as('MDM Team')('GET', '/sensitive-access')).status, 403);
  assert.equal((await as('Finance')('GET', '/requests/' + req.request_id)).body.payload.bank_account, '123-456-789012');
  const log = (await as('Finance')('GET', '/sensitive-access')).body;
  assert.ok(log.some(l => l.role === 'Finance' && l.field === 'bank_account'));
  assert.ok(!JSON.stringify(app.db.prepare('SELECT payload_json FROM requests WHERE request_id = ?').get(req.request_id)).includes('123-456-789012'));
  close();
});
