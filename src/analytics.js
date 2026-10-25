'use strict';
// Regional analytics computed only from purchase_orders + customers + golden mapping.
const { keyOf, repOf } = require('./model');

const dayNum = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
const addDays = (d, n) => new Date((dayNum(d) + n) * 86400000).toISOString().slice(0, 10);
const monthsBetween = (a, b) => {
  const out = [];
  let [y, m] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  while (y < y2 || (y === y2 && m <= m2)) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
  return out;
};
const shiftMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const r2 = x => Math.round(x * 100) / 100;

function filterPos(m, f = {}) {
  return m.pos.filter(p => {
    if (f.country && p.country !== f.country) return false;
    if (f.product && p.product !== f.product) return false;
    if (f.entity && m.customers.get(p.customer_id)?.entity !== f.entity) return false;
    if (f.from && p.date < f.from) return false;
    if (f.to && p.date > f.to) return false;
    return true;
  });
}

function totals(pos, key) {
  const cust = new Set(pos.map(p => key(p.customer_id)));
  const value = sum(pos, p => p.value);
  return { pos: pos.length, value: r2(value), qty: sum(pos, p => p.qty), activeCustomers: cust.size, avgOrderValue: pos.length ? r2(value / pos.length) : 0 };
}

function coverage(m) {
  const months = monthsBetween(m.firstDate.slice(0, 7), m.asOf.slice(0, 7));
  return { firstDate: m.firstDate, lastDate: m.asOf, months: months.length, enoughFor24Months: months.length >= 24, monthList: months };
}

function monthly(pos, months) {
  const by = new Map(months.map(k => [k, { month: k, pos: 0, value: 0, qty: 0 }]));
  for (const p of pos) { const r = by.get(p.month); if (r) { r.pos++; r.value += p.value; r.qty += p.qty; } }
  return [...by.values()].map(r => ({ ...r, value: r2(r.value) }));
}

/** Growth over the last k months vs the same k months a year earlier (needs 12+k months of history). */
function yoy(pos, cov) {
  const k = Math.min(12, cov.months - 12);
  if (k < 1) return null;
  const end = cov.monthList.at(-1), start = shiftMonth(end, -(k - 1));
  const pe = shiftMonth(end, -12), ps = shiftMonth(start, -12);
  const cur = sum(pos.filter(p => p.month >= start && p.month <= end), p => p.value);
  const prev = sum(pos.filter(p => p.month >= ps && p.month <= pe), p => p.value);
  return { window: `${start}..${end}`, vs: `${ps}..${pe}`, months: k, current: r2(cur), previous: r2(prev), growth: prev ? (cur - prev) / prev : null };
}

function overview(m, f = {}, basis = 'dedup') {
  const key = keyOf(m, basis), pos = filterPos(m, f), cov = coverage(m);
  const countries = [...new Set(m.pos.map(p => p.country))].sort();
  const byCountry = countries.filter(c => !f.country || c === f.country).map(c => {
    const cp = pos.filter(p => p.country === c);
    const master = [...m.customers.values()].filter(x => x.country === c && (!f.entity || x.entity === f.entity));
    return {
      country: c, ...totals(cp, key), masterRecords: new Set(master.map(x => key(x.customer_id))).size,
      yoy: yoy(cp, cov), shareOfValue: 0,
    };
  });
  const tv = sum(byCountry, c => c.value);
  byCountry.forEach(c => { c.shareOfValue = tv ? c.value / tv : 0; });
  const byProduct = ['A', 'B', 'C'].filter(p => !f.product || p === f.product).map(p => {
    const pp = pos.filter(x => x.product === p);
    return { product: p, ...totals(pp, key), unitPrice: pp.length ? r2(sum(pp, x => x.value) / sum(pp, x => x.qty)) : null, yoy: yoy(pp, cov) };
  });
  return {
    basis, filters: f, coverage: { ...cov, monthList: undefined },
    totals: totals(pos, key), yoy: yoy(pos, cov), byCountry, byProduct,
    monthly: monthly(pos, cov.monthList),
    monthlyByCountry: Object.fromEntries(countries.map(c => [c, monthly(pos.filter(p => p.country === c), cov.monthList)])),
  };
}

function topCustomers(m, f = {}, basis = 'dedup', n = 15) {
  const key = keyOf(m, basis), pos = filterPos(m, f), agg = new Map();
  for (const p of pos) {
    const k = key(p.customer_id);
    const a = agg.get(k) ?? { key: k, pos: 0, value: 0, products: new Set(), last: '' };
    a.pos++; a.value += p.value; a.products.add(p.product);
    if (p.date > a.last) a.last = p.date;
    agg.set(k, a);
  }
  const tv = sum(pos, p => p.value);
  return [...agg.values()].sort((a, b) => b.value - a.value).slice(0, n).map(a => {
    const rep = basis === 'dedup' ? repOf(m, a.key) : m.customers.get(a.key);
    return {
      key: a.key, name: rep?.name, country: rep?.country, pos: a.pos, value: r2(a.value), share: tv ? a.value / tv : 0,
      products: [...a.products].sort().join(''), lastOrder: a.last,
      recordsMerged: basis === 'dedup' ? (m.goldenMembers.get(a.key) || []).length : 1,
    };
  });
}

/** Customers with POs in the prior window but none in the recent window. Date filters are ignored (windows are fixed to the as-of date). */
function dropOff(m, f = {}, basis = 'dedup', windowDays = 90) {
  const key = keyOf(m, basis), pos = filterPos(m, { country: f.country, product: f.product, entity: f.entity });
  const rs = addDays(m.asOf, -(windowDays - 1)), ps = addDays(m.asOf, -(2 * windowDays - 1)), pe = addDays(m.asOf, -windowDays);
  const prior = new Map(), recent = new Set();
  for (const p of pos) {
    const k = key(p.customer_id);
    if (p.date >= rs) recent.add(k);
    else if (p.date >= ps && p.date <= pe) {
      const a = prior.get(k) ?? { value: 0, pos: 0, country: p.country };
      a.value += p.value; a.pos++; prior.set(k, a);
    }
  }
  const dropped = [...prior].filter(([k]) => !recent.has(k)).map(([k, a]) => {
    const rep = basis === 'dedup' ? repOf(m, k) : m.customers.get(k);
    return { key: k, name: rep?.name, country: a.country, priorValue: r2(a.value), priorPos: a.pos };
  }).sort((a, b) => b.priorValue - a.priorValue);
  const byCountry = {};
  dropped.forEach(d => {
    const c = (byCountry[d.country] ??= { country: d.country, customers: 0, priorValue: 0 });
    c.customers++; c.priorValue = r2(c.priorValue + d.priorValue);
  });
  return {
    basis, windowDays, recentWindow: `${rs}..${m.asOf}`, priorWindow: `${ps}..${pe}`, activePrior: prior.size, dropped: dropped.length,
    dropRate: prior.size ? dropped.length / prior.size : 0, lostValue: r2(sum(dropped, d => d.priorValue)),
    byCountry: Object.values(byCountry).sort((a, b) => a.country.localeCompare(b.country)), top: dropped.slice(0, 15),
  };
}

/** Which products each customer buys; co-purchase matrix and whitespace (bought something, never bought product Y). */
function crossSell(m, f = {}, basis = 'dedup') {
  const key = keyOf(m, basis), pos = filterPos(m, { country: f.country, entity: f.entity, from: f.from, to: f.to });
  const by = new Map();
  for (const p of pos) {
    const k = key(p.customer_id);
    const a = by.get(k) ?? { products: {}, value: 0, country: p.country };
    a.products[p.product] = (a.products[p.product] || 0) + p.value; a.value += p.value;
    by.set(k, a);
  }
  const P = ['A', 'B', 'C'], matrix = {};
  let all = 0;
  P.forEach(x => P.forEach(y => { matrix[x + y] = 0; }));
  const opp = [];
  for (const [k, a] of by) {
    const has = P.filter(x => a.products[x]);
    has.forEach(x => has.forEach(y => matrix[x + y]++));
    if (has.length === 3) all++;
    for (const y of P) {
      if (a.products[y]) continue;
      const rep = basis === 'dedup' ? repOf(m, k) : m.customers.get(k);
      opp.push({ key: k, name: rep?.name, country: a.country, has: has.join(''), missing: y, value: r2(a.value) });
    }
  }
  const whitespace = Object.fromEntries(P.map(y => [y, opp.filter(o => o.missing === y).length]));
  return {
    basis, customers: by.size, buyAll3: all, singleProduct: [...by.values()].filter(a => Object.keys(a.products).length === 1).length,
    matrix, whitespace, topOpportunities: opp.sort((a, b) => b.value - a.value).slice(0, 15),
  };
}

/** Raw vs deduplicated on the same PO rows, so the effect is comparable. */
function dedupImpact(m, f = {}, windowDays = 90) {
  const raw = overview(m, f, 'raw'), dd = overview(m, f, 'dedup');
  return {
    sameTotals: raw.totals.value === dd.totals.value && raw.totals.pos === dd.totals.pos,
    raw: raw.totals, dedup: dd.totals,
    masterRecords: { raw: m.customers.size, dedup: new Set([...m.customers.keys()].map(c => m.golden.get(c))).size },
    byCountry: raw.byCountry.map((r, i) => ({
      country: r.country, rawCustomers: r.activeCustomers, dedupCustomers: dd.byCountry[i].activeCustomers,
      rawMaster: r.masterRecords, dedupMaster: dd.byCountry[i].masterRecords,
    })),
    dropOff: { raw: dropOff(m, f, 'raw', windowDays), dedup: dropOff(m, f, 'dedup', windowDays) },
    crossSell: { raw: crossSell(m, f, 'raw'), dedup: crossSell(m, f, 'dedup') },
  };
}

/** Open-PO proxy: the CSV has no PO status, so use value of POs dated in the last `days` days before the data as-of date. */
function openPoProxy(m, customerIds, days = 30) {
  const since = addDays(m.asOf, -(days - 1)), ids = new Set(customerIds);
  return r2(sum(m.pos.filter(p => ids.has(p.customer_id) && p.date >= since), p => p.value));
}

module.exports = { filterPos, overview, topCustomers, dropOff, crossSell, dedupImpact, coverage, monthly, monthsBetween, shiftMonth, openPoProxy, addDays };
