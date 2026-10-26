'use strict';
// SAP Business One export (file generation only — nothing is sent to or imported into SAP B1).
// Columns come from domain_fields.sap_field, so a new domain or field is exportable by configuration.
// Column names follow common B1 import field names (OCRD/CRD1 business partners, OITM items, OPRC cost centers);
// confirm them against your company's own import template before loading.
const { PLACEHOLDER, parseType } = require('./workflow');

const ID_COLUMN = { customer: 'CardCode', vendor: 'CardCode', item: 'ItemCode', cost_center: 'PrcCode' };
const STATIC = { customer: { CardType: 'C' }, vendor: { CardType: 'S' } };
// B1 fields the source data cannot supply for a domain: exported blank and flagged on every row.
const NEVER_IN_SOURCE = {
  customer: [['GroupCode', 'BP group is mandatory in B1; the source has no customer group/segment'], ['Currency', 'BP currency is not in the source (PO values are SGD but the billing currency is unknown)']],
  vendor: [['GroupCode', 'BP group is mandatory in B1; not captured'], ['Currency', 'BP currency not captured']],
  item: [['ItmsGrpCod', 'B1 item group is numeric; map product_line (A/B/C) to your B1 item group codes']],
  cost_center: [['DimCode', 'Cost-center dimension is not captured; choose the B1 dimension (1-5)']],
};
const META = ['AppRequestId', 'AppEntity', 'ChangeType', 'MissingOrToConfirm'];

/** "37 Le Duan, Da Nang 768891" -> street "37 Le Duan", city "Da Nang", zip "768891". Heuristic; flagged when it does not fit. */
function splitAddress(a) {
  const s = String(a || '').trim();
  const i = s.lastIndexOf(',');
  if (i < 0) return { street: s, city: '', zip: '', ok: false };
  const tail = s.slice(i + 1).trim(), street = s.slice(0, i).trim();
  const m = tail.match(/^(.*?)\s+(\d{4,6})$/);
  return m ? { street, city: m[1], zip: m[2], ok: true } : { street, city: tail, zip: '', ok: false };
}

function columnsFor(domain, fields) {
  const cols = [ID_COLUMN[domain] || 'Code'];
  const add = c => { if (!cols.includes(c)) cols.push(c); };
  for (const k of Object.keys(STATIC[domain] || {})) add(k);
  for (const [c] of NEVER_IN_SOURCE[domain] || []) add(c);
  for (const f of fields) {
    if (!f.sap_field || f.sensitive) continue;
    if (f.sap_field === 'Street') { add('Street'); add('City'); add('ZipCode'); } else add(f.sap_field);
  }
  return [...cols, ...META];
}

function eligible(db, domain, { includeExported = false, includeImported = false } = {}) {
  const rows = db.prepare("SELECT * FROM requests WHERE domain = ? AND status IN ('approved','applied') ORDER BY created_at, request_id").all(domain);
  const done = new Set(db.prepare('SELECT DISTINCT request_id FROM export_items').all().map(r => r.request_id));
  return rows.map(r => ({ ...r, payload: JSON.parse(r.payload_json || '{}'), alreadyExported: done.has(r.request_id),
    importedDone: r.source === 'imported' && r.status === 'applied' && !includeImported })).filter(r => includeExported || !r.alreadyExported);
}

function buildExport(db, model, master, { domain = 'customer', includeExported = false, includeImported = false } = {}) {
  const drow = master.domainRow(domain);
  if (!drow) return { domain, columns: [], rows: [], excluded: [], notImported: true, statement: 'Unknown domain' };
  const fields = master.fieldsOf(domain), bySap = f => fields.find(x => x.name === f);
  const columns = columnsFor(domain, fields), rows = [], excluded = [];
  const sensNotExported = fields.filter(f => f.sensitive).map(f => f.name);

  const setValue = (row, f, v, flags) => {
    if (f.sap_field === 'Street') {
      const a = splitAddress(v);
      Object.assign(row, { Street: a.street, City: a.city, ZipCode: a.zip });
      if (!a.ok) flags.push('City/ZipCode: address could not be split reliably — check');
    } else if (f.sap_field) row[f.sap_field] = v;
  };

  for (const r of eligible(db, domain, { includeExported, includeImported })) {
    const { verb } = parseType(r.request_type), p = r.payload, flags = (NEVER_IN_SOURCE[domain] || []).map(([f, why]) => `${f}: ${why}`);
    if (r.importedDone) { excluded.push({ request_id: r.request_id, type: r.request_type, reason: 'Imported from the CSV already in status "applied"; the data does not show whether it reached SAP B1, so it is not re-exported unless you opt in' }); continue; }
    if (verb === 'create') {
      const row = { ...(STATIC[domain] || {}), AppRequestId: r.request_id, AppEntity: r.entity || '', ChangeType: 'ADD' };
      for (const f of fields) if (p[f.name] != null && f.sap_field && !f.sensitive) setValue(row, f, p[f.name], flags);
      for (const f of fields) if (f.required && !f.sensitive && f.sap_field && (p[f.name] == null || p[f.name] === '') && f.name !== 'customer_id') flags.push(`${f.sap_field}: ${f.name} was not captured on this request`);
      const created = domain === 'customer' ? db.prepare('SELECT customer_id id FROM md_customers WHERE request_id = ?').get(r.request_id)
        : db.prepare('SELECT record_id id FROM md_records WHERE request_id = ?').get(r.request_id);
      const idCol = columns[0];
      if (created) row[idCol] = created.id; else if (domain === 'item' || domain === 'cost_center') row[idCol] = p[drow.id_field] || ''; else flags.push(`${idCol}: not yet assigned — apply the request or confirm the B1 numbering series`);
      if (domain === 'customer' && !p.uen) flags.push('FederalTaxID: no registration number supplied');
      if (sensNotExported.length) flags.push(`Not exported (sensitive): ${sensNotExported.join(', ')} — enter via a secured process`);
      row.MissingOrToConfirm = flags.join('; ');
      rows.push(row);
    } else if (verb === 'update') {
      const f = bySap(p.field) || fields.find(x => x.name === p.field);
      if (p.new === PLACEHOLDER || !p.new) { excluded.push({ request_id: r.request_id, type: r.request_type, reason: 'No new value recorded on the request (placeholder text only)' }); continue; }
      if (!f || f.sensitive) { excluded.push({ request_id: r.request_id, type: r.request_type, reason: f?.sensitive ? 'Sensitive field — not written to export files' : 'Field has no SAP mapping' }); continue; }
      if (!f.sap_field) { excluded.push({ request_id: r.request_id, type: r.request_type, reason: `Field "${f.name}" has no SAP mapping (set one in Config)` }); continue; }
      const row = { [columns[0]]: r.target_customer_id, ...(STATIC[domain] || {}), AppRequestId: r.request_id, AppEntity: r.entity || '', ChangeType: 'UPDATE' };
      const fl = [`${columns[0]}: the app uses its own id; confirm it equals the B1 key in the target company database`, 'Only the changed field is populated; blank columns must be ignored (not blanked) by the import'];
      setValue(row, f, p.new, fl);
      row.MissingOrToConfirm = fl.join('; ');
      rows.push(row);
    } else excluded.push({ request_id: r.request_id, type: r.request_type,
      reason: verb === 'merge' ? 'Merges are done with the B1 Business Partner Merge tool, not a data import' : 'Deactivation is a status change (Frozen/Inactive) and is not part of this create/update template' });
  }
  return { domain, label: drow.label, sap_object: drow.sap_object, columns, rows, excluded, notImported: true,
    statement: 'File generated only. Nothing has been sent to or imported into SAP B1; no integration is configured.' };
}

const q = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = ex => [ex.columns.join(','), ...ex.rows.map(r => ex.columns.map(c => q(r[c])).join(','))].join('\r\n') + '\r\n';

function recordBatch(db, ex, fileName) {
  const b = db.prepare('INSERT INTO export_batches (created_at, file_name, row_count, note) VALUES (?,?,?,?)')
    .run(new Date().toISOString(), fileName, ex.rows.length, `${ex.domain}: generated file only; not imported to SAP B1`);
  const id = Number(b.lastInsertRowid), ins = db.prepare('INSERT OR IGNORE INTO export_items (batch_id, request_id) VALUES (?,?)');
  for (const r of ex.rows) ins.run(id, r.AppRequestId);
  return id;
}

module.exports = { buildExport, toCsv, recordBatch, splitAddress, eligible };
