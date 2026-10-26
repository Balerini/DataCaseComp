'use strict';
// Duplicate detection: hard-key (registration no.) + normalised fuzzy name + normalised address.
const { normUen } = require('./rules');

const LEGAL = new Set(['pte', 'ltd', 'limited', 'sdn', 'bhd', 'berhad', 'co', 'company', 'joint', 'stock', 'jsc',
  'pt', 'tbk', 'cv', 'inc', 'corp', 'corporation', 'llc', 'plc', 'public', 'private', 'llp', 'the',
  'sdnn' // common extra-n typo for the Malaysian legal suffix Sdn.
]);
const ADDR = { jl: 'jalan', jln: 'jalan', rd: 'road', st: 'street', ave: 'avenue', ind: 'industrial', blvd: 'boulevard', pk: 'park' };

const strip = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

function normName(name) {
  const t = strip(String(name || '').replace(/\./g, '')).split(' ').filter(w => w && !LEGAL.has(w));
  return t.sort().join(' ');
}
function normAddress(a) {
  return strip(a).split(' ').map(w => ADDR[w] || w).join(' ');
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const ratio = (a, b) => (!a && !b) ? 0 : 1 - lev(a, b) / Math.max(a.length, b.length);

const DEFAULTS = { duplicate: 0.9, possible: 0.75 };

/** Compare two customer-like records {name, country, uen, address, entity}. */
function comparePair(a, b) {
  const nA = normName(a.name), nB = normName(b.name);
  const nameSim = ratio(nA, nB);
  const hasAddr = !!(strip(a.address) && strip(b.address));
  const addrSim = hasAddr ? ratio(normAddress(a.address), normAddress(b.address)) : 0;
  const uA = normUen(a.uen), uB = normUen(b.uen);
  const bothUen = !!(uA && uB);
  const uenMatch = bothUen && uA === uB;
  const uenConflict = bothUen && uA !== uB;
  const sameCountry = !a.country || !b.country || a.country === b.country;
  const reasons = [];

  // records without addresses (items, cost centers) are compared on name alone
  let score = hasAddr ? 0.65 * nameSim + 0.35 * addrSim : nameSim;
  const keyA = strip(a.key).replace(/ /g, ''), keyB = strip(b.key).replace(/ /g, '');
  if (keyA && keyA === keyB) { score = Math.max(score, 0.95); reasons.push('Same code (hard key)'); }
  if (uenMatch && sameCountry) { score = Math.max(score, 0.9) * 0.4 + 0.6; reasons.push('Registration no. matches exactly (hard key)'); }
  else if (uenMatch) reasons.push('Registration no. matches but country differs');
  if (uenConflict) { score = Math.min(score, 0.6); reasons.push('Registration no. conflicts — treated as different company'); }
  if (!sameCountry) { score *= 0.5; reasons.push('Different country'); }
  if (nameSim >= 0.999) reasons.push('Name identical after normalisation');
  else if (nameSim >= 0.85) reasons.push(`Name similar (${Math.round(nameSim * 100)}%) after normalisation`);
  if (addrSim >= 0.95) reasons.push('Address matches after normalisation');
  else if (addrSim >= 0.8) reasons.push(`Address similar (${Math.round(addrSim * 100)}%)`);
  if (!bothUen && !uenConflict && (a.uen !== undefined || b.uen !== undefined)) reasons.push('Registration no. missing on one side — no hard key available');
  if (a.entity && b.entity && a.entity !== b.entity) reasons.push(`Different owning entity (${a.entity} vs ${b.entity})`);
  return { score: Math.min(1, Math.max(0, score)), nameSim, addrSim, uenMatch, uenConflict, reasons };
}

function classify(score, th = DEFAULTS) {
  return score >= th.duplicate ? 'duplicate' : score >= th.possible ? 'possible' : 'distinct';
}

/** Candidates in `pool` for an incoming record. */
function findCandidates(rec, pool, th = DEFAULTS, limit = 10) {
  const out = [];
  for (const c of pool) {
    if (c.customer_id && c.customer_id === rec.customer_id) continue;
    const r = comparePair(rec, c);
    const cls = classify(r.score, th);
    if (cls !== 'distinct') out.push({ customer: c, ...r, class: cls });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

/** All pairs >= threshold over a pool, plus union-find clusters. */
function clusterAll(pool, th = DEFAULTS) {
  const parent = new Map(pool.map(c => [c.customer_id, c.customer_id]));
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const pairs = [];
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
    const r = comparePair(pool[i], pool[j]);
    if (r.score >= th.duplicate) {
      pairs.push([pool[i].customer_id, pool[j].customer_id, r.score]);
      parent.set(find(pool[i].customer_id), find(pool[j].customer_id));
    }
  }
  const clusters = new Map();
  for (const c of pool) clusters.set(c.customer_id, find(c.customer_id));
  return { pairs, clusterOf: clusters };
}

/** Evaluate against reference groups (golden_map). Pairwise precision / recall / F1. */
function evaluate(pool, goldenOf, th = DEFAULTS) {
  let tp = 0, fp = 0, fn = 0; const missed = [], falsePos = [];
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
    const a = pool[i], b = pool[j];
    const truth = goldenOf.get(a.customer_id) === goldenOf.get(b.customer_id);
    const r = comparePair(a, b);
    const pred = r.score >= th.duplicate;
    if (pred && truth) tp++;
    else if (pred && !truth) { fp++; falsePos.push([a.customer_id, b.customer_id, +r.score.toFixed(3)]); }
    else if (!pred && truth) { fn++; missed.push([a.customer_id, b.customer_id, +r.score.toFixed(3)]); }
  }
  const precision = tp / (tp + fp || 1), recall = tp / (tp + fn || 1);
  return { tp, fp, fn, precision, recall, f1: 2 * precision * recall / (precision + recall || 1), missed, falsePos };
}

module.exports = { normName, normAddress, comparePair, classify, findCandidates, clusterAll, evaluate, DEFAULTS, lev, ratio };
