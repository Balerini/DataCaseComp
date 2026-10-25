'use strict';
// CLI: node src/validate.js  — runs the reconciliation / matcher / approval-engine checks against the CSV (in-memory DB).
const { createApp } = require('./server');
const app = createApp({ dbFile: ':memory:' });
const { checks, evaluation } = app.routes['GET /api/validate']({});
let bad = 0;
for (const c of checks) { console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  — ${c.detail}`); if (!c.pass) bad++; }
console.log(`\nMatcher @ duplicate>=${evaluation.thresholds.duplicate}: precision ${evaluation.precision.toFixed(3)} recall ${evaluation.recall.toFixed(3)} F1 ${evaluation.f1.toFixed(3)}`);
process.exit(bad ? 1 : 0);
