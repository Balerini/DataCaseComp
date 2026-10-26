'use strict';
// Regional business view: country x product growth, orders vs MDM setup requests, and data-driven recommended actions.
const { coverage, monthsBetween, shiftMonth, dropOff, crossSell, filterPos } = require('./analytics');
const { forecast } = require('./forecast');
const { triage } = require('./inbox');

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const r2 = x => Math.round(x * 100) / 100;
const money = x => 'S$' + (Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : Math.round(x / 1e3) + 'k');

/**
 * Growth measure: PO value in the last k months vs the same k calendar months one year earlier ((cur - prev) / prev).
 * Comparing like-for-like months removes seasonality. k is capped by history (needs k + 12 months).
 */
function matrix(m, k = 6) {
  const cov = coverage(m), maxK = Math.max(0, cov.months - 12);
  const period = Math.max(1, Math.min(k, maxK, 12));
  const end = cov.monthList.at(-1), start = shiftMonth(end, -(period - 1)), pe = shiftMonth(end, -12), ps = shiftMonth(start, -12);
  const countries = [...new Set(m.pos.map(p => p.country))].sort(), products = ['A', 'B', 'C'];
  const cell = pos => {
    const cur = pos.filter(p => p.month >= start && p.month <= end), prev = pos.filter(p => p.month >= ps && p.month <= pe);
    const c = sum(cur, p => p.value), p0 = sum(prev, p => p.value);
    return { pos: cur.length, qty: sum(cur, p => p.qty), value: r2(c), prevValue: r2(p0), prevPos: prev.length, growth: p0 ? (c - p0) / p0 : null };
  };
  const rows = countries.map(c => ({ country: c, total: cell(m.pos.filter(p => p.country === c)), products: Object.fromEntries(products.map(pr => [pr, cell(m.pos.filter(p => p.country === c && p.product === pr))])) }));
  return {
    period, requestedPeriod: k, maxPeriod: maxK, window: `${start} to ${end}`, vs: `${ps} to ${pe}`,
    definition: `Growth = (PO value in ${start}..${end}) ÷ (PO value in the same ${period} months a year earlier, ${ps}..${pe}) − 1. Same-month comparison removes seasonality. Only purchase orders count; enquiries and MDM requests are excluded.`,
    rows, totalsByProduct: Object.fromEntries(products.map(pr => [pr, cell(m.pos.filter(p => p.product === pr))])), total: cell(m.pos),
  };
}

/** Orders (purchase_orders) vs inbound messages vs MDM setup requests, kept separate. */
function ordersVsMdm(m, db, region) {
  const reqCount = (where, ...args) => db.prepare(`SELECT COUNT(*) n FROM requests WHERE ${where}${region && region !== 'ALL' ? ' AND (country = ? OR country IS NULL)' : ''}`).get(...args, ...(region && region !== 'ALL' ? [region] : [])).n;
  const cov = coverage(m), t = triage(m, db);
  const months = monthsBetween(cov.firstDate.slice(0, 7), [cov.lastDate.slice(0, 7), ...t.items.map(i => i.received_at.slice(0, 7)), ...db.prepare('SELECT created_at FROM requests').all().map(r => r.created_at.slice(0, 7))].sort().at(-1));
  const row = mo => ({ month: mo, orders: m.pos.filter(p => p.month === mo).length, orderValue: r2(sum(m.pos.filter(p => p.month === mo), p => p.value)) });
  const byMonth = months.map(mo => ({
    ...row(mo),
    msgOrder: t.items.filter(i => i.received_at.startsWith(mo) && i.predicted === 'PO').length,
    msgEnquiry: t.items.filter(i => i.received_at.startsWith(mo) && i.predicted === 'enquiry').length,
    msgFollowUp: t.items.filter(i => i.received_at.startsWith(mo) && i.predicted === 'follow-up').length,
    msgMdm: t.items.filter(i => i.received_at.startsWith(mo) && i.predicted === 'MDM request').length,
    mdmRequests: reqCount("substr(created_at,1,7) = ?", mo),
  }));
  const countries = [...new Set(m.pos.map(p => p.country))].sort();
  return {
    definition: {
      orders: 'Rows in purchase_orders — confirmed customer orders. Only these feed volumes, growth and the forecast.',
      messages: 'inbox_messages classified by the triage rules: order emails, enquiries, follow-ups, and MDM requests sent by customers.',
      mdmRequests: 'requests table — master-data change requests (create / update / merge / deactivate) raised in the MDM process. Never counted as demand.',
    },
    byMonth,
    byCountry: countries.map(c => ({ country: c, orders: m.pos.filter(p => p.country === c).length, orderValue: r2(sum(m.pos.filter(p => p.country === c), p => p.value)),
      mdmRequests: db.prepare('SELECT COUNT(*) n FROM requests WHERE country = ?').get(c).n })),
    byDomain: db.prepare('SELECT domain, request_type, COUNT(*) n FROM requests GROUP BY domain, request_type ORDER BY domain, request_type').all(),
    messageTotals: Object.fromEntries(['PO', 'enquiry', 'follow-up', 'MDM request'].map(l => [l, t.items.filter(i => i.predicted === l).length])),
    note: `Inbox messages run ${t.items[0]?.received_at.slice(0, 10)} to ${t.items.at(-1)?.received_at.slice(0, 10)}, partly after the last PO in the data (${cov.lastDate}). Inbox messages carry no country, so they are shown by month only.`,
  };
}

/** Recommended actions derived from the numbers (each carries its evidence). */
function actions(m, db) {
  const out = [], mx = matrix(m, 6), cov = coverage(m);
  const ranked = [...mx.rows].filter(r => r.total.growth != null).sort((a, b) => b.total.growth - a.total.growth);
  if (ranked.length) {
    const hi = ranked[0], lo = ranked.at(-1);
    out.push({ priority: 'high', area: 'Growth', action: `Prioritise stock and sales coverage for ${hi.country}, the fastest-growing country; review account plans in ${lo.country}, the slowest.`,
      evidence: `${mx.window}: ${hi.country} ${(hi.total.growth * 100).toFixed(1)}% (${money(hi.total.value)}), ${lo.country} ${(lo.total.growth * 100).toFixed(1)}% (${money(lo.total.value)}) vs the same months a year earlier.` });
    const cells = mx.rows.flatMap(r => Object.entries(r.products).map(([p, c]) => ({ country: r.country, product: p, ...c }))).filter(c => c.growth != null && c.prevValue > 500000);
    const worst = cells.sort((a, b) => a.growth - b.growth)[0];
    if (worst && worst.growth < 0) out.push({ priority: 'medium', area: 'Growth', action: `Investigate the decline in Product ${worst.product} in ${worst.country} (pricing, competitor, or a lost account).`,
      evidence: `${(worst.growth * 100).toFixed(1)}% over ${mx.window}: ${money(worst.value)} vs ${money(worst.prevValue)}.` });
  }
  const dd = dropOff(m, {}, 'dedup', 90), dr = dropOff(m, {}, 'raw', 90);
  if (dd.dropped) out.push({ priority: 'high', area: 'Retention', action: `Contact the ${Math.min(5, dd.top.length)} largest lapsed customers this week: ${dd.top.slice(0, 5).map(t => t.name).join('; ')}.`,
    evidence: `${dd.dropped} of ${dd.activePrior} customers (${(dd.dropRate * 100).toFixed(0)}%) bought in ${dd.priorWindow} but not in ${dd.recentWindow}; ${money(dd.lostValue)} of prior-period value.` });
  if (dr.dropped > dd.dropped) out.push({ priority: 'medium', area: 'Data quality', action: 'Use deduplicated customers for churn alerts: duplicate records make healthy customers look lapsed.',
    evidence: `Raw records flag ${dr.dropped} drop-offs; after merging duplicates only ${dd.dropped} remain (${dr.dropped - dd.dropped} were duplicates of customers still ordering).` });
  const cs = crossSell(m, {}, 'dedup');
  const topOpp = cs.topOpportunities[0];
  out.push({ priority: 'medium', area: 'Cross-sell', action: `Run a Product C introduction for customers who buy A/B but never C, starting with ${cs.topOpportunities.filter(o => o.missing === 'C').slice(0, 3).map(o => o.name).join(', ') || topOpp?.name}.`,
    evidence: `${cs.whitespace.C} of ${cs.customers} customers never bought C (${cs.whitespace.B} never B, ${cs.whitespace.A} never A); only ${cs.buyAll3} buy all three.` });
  const f = forecast(m, {}, {});
  if (f.forecast) {
    const key = f.forecast.selectedByBacktest === 'seasonal' && f.forecast.seasonal ? 'seasonal' : 'rolling';
    const next = sum(f.forecast[key], x => x), last = sum(f.history.slice(-3), h => h.value);
    const err = f.backtest.metrics.find(x => x.model === key)?.wape;
    out.push({ priority: 'medium', area: 'Forecast', action: `Plan ${f.forecast.months[0]} to ${f.forecast.months.at(-1)} supply around ${money(next)} (${key} model), with a ${err != null ? '±' + (err * 100).toFixed(0) + '%' : 'wide'} buffer.`,
      evidence: `vs ${money(last)} in the last 3 months (${((next / last - 1) * 100).toFixed(0)}%). Backtest on the last 3 months: WAPE ${err != null ? (err * 100).toFixed(1) + '%' : 'n/a'}; only ${cov.months} months of history, so re-check monthly.` });
  }
  const t = triage(m, db), late = t.items.filter(i => i.predicted === 'PO' && i.received_at.slice(0, 10) > cov.lastDate);
  if (late.length) out.push({ priority: 'high', area: 'Order capture', action: `Confirm the ${late.length} order emails received after ${cov.lastDate} have been keyed into SAP B1.`,
    evidence: `${late.length} inbox messages classified as orders, dated after the last PO in the data (${cov.lastDate}), totalling ${sum(late, i => i.order?.units || 0)} units.` });
  const pend = db.prepare("SELECT request_id, created_at, request_type FROM requests WHERE status = 'pending_approval' ORDER BY created_at").all();
  if (pend.length) out.push({ priority: 'medium', area: 'MDM process', action: `Clear the ${pend.length} requests waiting for approval; oldest is ${pend[0].request_id} (${pend[0].request_type.replace('_', ' ')}) from ${pend[0].created_at.slice(0, 10)}.`,
    evidence: 'Each request shows who it is waiting on and every role has a queue (Requests → My queue); notifying approvers needs a Microsoft 365 integration that is not built.' });
  return out;
}

module.exports = { matrix, ordersVsMdm, actions };
