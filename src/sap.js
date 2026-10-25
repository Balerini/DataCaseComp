'use strict';
// SAP Business One Business Partner export (file generation only — nothing is sent to or imported into SAP B1).
// Column names follow the common B1 Business Partner (OCRD/CRD1) import field names; confirm them against your
// company's own import template before loading.
const { PLACEHOLDER } = require('./workflow');

const COLUMNS = ['CardCode', 'CardName', 'CardType', 'GroupCode', 'Currency', 'FederalTaxID', 'Street', 'City', 'ZipCode', 'Country',
  'AppRequestId', 'AppEntity', 'ChangeType', 'MissingOrToConfirm'];

/** Fields B1 needs (or that the company will usually require) that this dataset cannot supply. */
const NEVER_IN_SOURCE = [
  ['GroupCode', 'BP group is mandatory in B1; the source has no customer group/segment'],
  ['Currency', 'BP currency is not in the source (PO values are SGD but the customer billing currency is unknown)'],
];

/** "37 Le Duan, Da Nang 768891" -> street "37 Le Duan", city "Da Nang", zip "768891". Heuristic; flagged when it does not fit. */
function splitAddress(a) {
  const s = String(a || '').trim();
  const i = s.lastIndexOf(',');
  if (i < 0) return { street: s, city: '', zip: '', ok: false };
  const tail = s.slice(i + 1).trim(), street = s.slice(0, i).trim();
  const m = tail.match(/^(.*?)\s+(\d{4,6})$/);
  return m ? { street, city: m[1], zip: m[2], ok: true } : { street, city: tail, zip: '', ok: false };
}

function eligible(db, { includeExported = false, includeImported = false } = {}) {
  const rows = db.prepare("SELECT * FROM requests WHERE status IN ('approved','applied') ORDER BY created_at, request_id").all();
  const done = new Set(db.prepare('SELECT DISTINCT request_id FROM export_items').all().map(r => r.request_id));
  return rows.map(r => ({ ...r, payload: JSON.parse(r.payload_json || '{}'), alreadyExported: done.has(r.request_id) }))
    .map(r => ({ ...r, importedDone: r.source === 'imported' && r.status === 'applied' && !includeImported }))
    .filter(r => includeExported || !r.alreadyExported);
}

function buildExport(db, model, opts = {}) {
  const rows = [], excluded = [];
  for (const r of eligible(db, opts)) {
    if (r.importedDone) {
      excluded.push({ request_id: r.request_id, type: r.request_type, reason: 'Imported from the CSV already in status "applied"; the data does not show whether it reached SAP B1, so it is not re-exported unless you opt in' });
      continue;
    }
    const p = r.payload, missing = NEVER_IN_SOURCE.map(([f, why]) => `${f}: ${why}`);
    if (r.request_type === 'create_customer') {
      const addr = splitAddress(p.address);
      if (!p.address) missing.push('Street/City/ZipCode: address was not captured on this request');
      else if (!addr.ok) missing.push('City/ZipCode: address could not be split reliably — check');
      if (!p.uen) missing.push('FederalTaxID: no registration number supplied');
      if ((p.name || '').length > 100) missing.push('CardName: exceeds 100 characters');
      const created = db.prepare('SELECT customer_id FROM app_customers WHERE request_id = ?').get(r.request_id);
      if (!created) missing.push('CardCode: not yet assigned — apply the request or confirm the B1 numbering series');
      rows.push({
        CardCode: created?.customer_id ?? '', CardName: p.name ?? '', CardType: 'C', GroupCode: '', Currency: '', FederalTaxID: p.uen ?? '',
        Street: addr.street, City: addr.city, ZipCode: addr.zip, Country: r.country, AppRequestId: r.request_id, AppEntity: r.entity,
        ChangeType: 'ADD', MissingOrToConfirm: missing.join('; ')
      });
    } else if (r.request_type === 'update_customer') {
      if (p.new === PLACEHOLDER || !p.new) { excluded.push({ request_id: r.request_id, type: r.request_type, reason: 'No new value recorded on the request (placeholder text only)' }); continue; }
      const cust = model.customers.get(r.target_customer_id);
      const row = { CardCode: r.target_customer_id, CardName: '', CardType: 'C', GroupCode: '', Currency: '', FederalTaxID: '', Street: '', City: '', ZipCode: '',
        Country: r.country, AppRequestId: r.request_id, AppEntity: r.entity, ChangeType: 'UPDATE', MissingOrToConfirm: '' };
      const note = ['CardCode: the app uses the source customer_id; confirm it equals the B1 CardCode in the target company database'];
      if (p.field === 'name') row.CardName = p.new;
      else if (p.field === 'uen') row.FederalTaxID = p.new;
      else if (p.field === 'address') {
        const a = splitAddress(p.new);
        Object.assign(row, { Street: a.street, City: a.city, ZipCode: a.zip });
        if (!a.ok) note.push('City/ZipCode: address could not be split reliably — check');
      }
      note.push('Only the changed field is populated; blank columns must be ignored (not blanked) by the import');
      if (!cust) note.push('Customer not found in current master');
      row.MissingOrToConfirm = note.join('; ');
      rows.push(row);
    } else {
      excluded.push({ request_id: r.request_id, type: r.request_type,
        reason: r.request_type === 'merge_customer' ? 'Merges are done with the B1 Business Partner Merge tool, not a data import' : 'Deactivation is a status change (Frozen/Inactive) and is not part of this create/update template' });
    }
  }
  return { columns: COLUMNS, rows, excluded, notImported: true,
    statement: 'File generated only. Nothing has been sent to or imported into SAP B1; no integration is configured.' };
}

const q = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = ex => [ex.columns.join(','), ...ex.rows.map(r => ex.columns.map(c => q(r[c])).join(','))].join('\r\n') + '\r\n';

function recordBatch(db, ex, fileName) {
  const b = db.prepare('INSERT INTO export_batches (created_at, file_name, row_count, note) VALUES (?,?,?,?)')
    .run(new Date().toISOString(), fileName, ex.rows.length, 'generated file only; not imported to SAP B1');
  const id = Number(b.lastInsertRowid);
  const ins = db.prepare('INSERT OR IGNORE INTO export_items (batch_id, request_id) VALUES (?,?)');
  for (const r of ex.rows) ins.run(id, r.AppRequestId);
  return id;
}

module.exports = { buildExport, toCsv, recordBatch, splitAddress, eligible, COLUMNS };
