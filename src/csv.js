'use strict';
// Read-only loader for the stacked-table source CSV. Never writes to the file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SOURCE_CSV = process.env.MDM_CSV || path.join(__dirname, '..', 'mdm_fake_data_all.csv');

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let r = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { r.push(f); f = ''; }
    else if (c === '\n') { r.push(f); rows.push(r); r = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || r.length) { r.push(f); rows.push(r); }
  return rows;
}

/** Returns { tables: {name: [row objects with only that table's non-empty columns]}, header, hash, rowCount } */
function loadSource(file = SOURCE_CSV) {
  const buf = fs.readFileSync(file);
  const rows = parseCsv(buf.toString('utf8'));
  const header = rows[0];
  const tables = {};
  const malformed = [];
  rows.slice(1).forEach((r, i) => {
    if (r.length === 1 && r[0] === '') return;
    if (r.length !== header.length) { malformed.push(i + 2); return; }
    const t = r[0];
    const o = {};
    header.forEach((c, k) => { if (c !== 'table') o[c] = r[k]; });
    (tables[t] ??= []).push(o);
  });
  // Drop columns that are entirely empty for a table (they belong to other stacked tables).
  for (const [t, list] of Object.entries(tables)) {
    const keep = header.filter(c => c !== 'table' && list.some(o => o[c] !== ''));
    tables[t] = list.map(o => Object.fromEntries(keep.map(c => [c, o[c]])));
  }
  return {
    tables, header, malformed,
    hash: crypto.createHash('sha256').update(buf).digest('hex'),
    rowCount: rows.length - 1,
    file,
  };
}

module.exports = { loadSource, parseCsv, SOURCE_CSV };
