'use strict';
// Stages a few real requests in a FRESH database so a live demo has something to act on.
//
//   PowerShell:  $env:MDM_DB="data/demo.db"; node scripts/seed-demo.js
//   then:        $env:MDM_DB="data/demo.db"; node src/server.js
//
// It goes through the same workflow code as the UI (validation, routing, approvals), so the audit trail is genuine.
// It never touches mdm_fake_data_all.csv and refuses to run twice on the same database.
const { createApp } = require('../src/server');

const app = createApp();
const { wf, access, db } = app;
const who = role => access.whoFromHeaders({ 'x-role': encodeURIComponent(role), 'x-region': 'ALL' });
const approve = (id, role) => wf.decide(id, { actor: role, role, decision: 'approve' });

if (db.prepare("SELECT COUNT(*) n FROM requests WHERE source = 'app'").get().n) {
  console.log('This database already has requests created in the app. Use a fresh file (for example data/demo.db) to stage the demo.');
  process.exit(0);
}

// 1. A regulated item waiting on Quality/Regulatory Affairs: lets you act as Quality/Regulatory and show approval chips + audit trail.
const item = wf.createRequest({ request_type: 'create_item', item_code: 'LAB-200', name: 'Centrifuge tubes 15ml', product_line: 'Other', regulated: 'Y' }, who('Product Manager'));

// 2. An item approved by all its approvers but not yet applied: lets the MDM Team click Apply and open the SAP B1 export.
//    (Deliberately an item, not a customer: applying a customer would change the 240 records / 166 customers shown on the analytics screens.)
const done = wf.createRequest({ request_type: 'create_item', item_code: 'LAB-300', name: 'Pipette tips 200ul, box of 960', product_line: 'Other', regulated: 'N' }, who('Product Manager'));
approve(done.request_id, 'Business Unit Head');
approve(done.request_id, 'Business Support');

// 3. A vendor with sensitive fields, approved and applied: shows masked bank details (MDM Team) and the reveal (Finance).
const vend = wf.createRequest({ request_type: 'create_vendor', name: 'Bright Reagents Pte. Ltd.', entity: 'QTG', country: 'SG', registration_no: '201811223M',
  address: '20 Biopolis Way, Singapore 138668', payment_terms: 'NET30', bank_account: '123-456-789012' }, who('Procurement Officer'));
approve(vend.request_id, 'MDM Team');
approve(vend.request_id, 'Finance');
wf.apply(vend.request_id, 'MDM Team');

const row = id => db.prepare('SELECT request_id, request_type, status, current_step FROM requests WHERE request_id = ?').get(id);
console.log('Demo staged:');
for (const id of [item.request_id, done.request_id, vend.request_id]) { const r = row(id); console.log(`  ${r.request_id}  ${r.request_type.padEnd(16)} ${r.status}${r.current_step ? ' (waiting for ' + r.current_step + ')' : ''}`); }
console.log('\nWhat each is for:');
console.log('  ' + item.request_id + ': act as Quality/Regulatory Affairs, open it, show approval chips + audit trail, Approve');
console.log('  ' + done.request_id + ': act as MDM Team, Apply, then SAP B1 export > Item');
console.log('  ' + vend.request_id + ': Master data > Vendor > Bright Reagents: masked as MDM Team, revealed as Finance');
process.exit(0);
