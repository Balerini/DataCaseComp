'use strict';
// Monthly PO-value forecasting built only on the observed purchase_orders history.
//   baseline : flat forecast = mean of the last `window` months (rolling average)
//   seasonal : value one year earlier x level ratio (recent k months / same k months a year before)
// Evaluation: hold out the last `holdout` months, fit on the rest, score WAPE / MAPE on actuals.
const { filterPos, coverage, monthly, shiftMonth } = require('./analytics');
const { keyOf } = require('./model');

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sum = a => a.reduce((s, x) => s + x, 0);

function rollingAvg(train, h, window = 3) {
  const lvl = mean(train.slice(-window));
  return Array(h).fill(lvl);
}

/** Needs at least 12 + 1 months in `train`. k = months used to estimate the level ratio (max 6). */
function seasonalLevel(train, h, maxK = 6) {
  const n = train.length;
  if (n < 13) return null;
  const k = Math.min(maxK, n - 12);
  const recent = sum(train.slice(-k)), prior = sum(train.slice(n - 12 - k, n - 12));
  const ratio = prior > 0 ? recent / prior : 1;
  const out = [];
  for (let i = 0; i < h; i++) {
    // forecast for index n+i: the observation 12 months earlier (always inside train when h <= 12)
    const idx = n + i - 12;
    out.push(train[idx] * ratio);
  }
  return { forecast: out, ratio, k };
}

function wape(actual, fc) {
  const den = sum(actual);
  return den ? sum(actual.map((a, i) => Math.abs(a - fc[i]))) / den : null;
}
function mape(actual, fc) {
  const pts = actual.map((a, i) => (a ? Math.abs(a - fc[i]) / Math.abs(a) : null)).filter(x => x !== null);
  return pts.length ? mean(pts) : null;
}

function forecastSeries(series, months, { holdout = 3, horizon = 3, window = 3 } = {}) {
  const n = series.length;
  const result = { months: n, holdout, horizon, window, backtest: null, forecast: null, notes: [] };
  const minForSeasonalBacktest = 12 + 1 + holdout;
  if (n <= holdout + window) {
    result.notes.push(`Only ${n} months of history — not enough for a ${holdout}-month holdout.`);
    return result;
  }
  const train = series.slice(0, n - holdout), actual = series.slice(n - holdout);
  const testMonths = months.slice(n - holdout);
  const base = rollingAvg(train, holdout, window);
  const seas = seasonalLevel(train, holdout);
  const naive = train.length >= 12 ? Array.from({ length: holdout }, (_, i) => train[train.length + i - 12]) : null;
  const rows = testMonths.map((mo, i) => ({
    month: mo, actual: actual[i], rolling: base[i], seasonal: seas ? seas.forecast[i] : null, seasonalNaive: naive ? naive[i] : null,
  }));
  const metrics = (name, fc) => (fc ? { model: name, wape: wape(actual, fc), mape: mape(actual, fc) } : { model: name, wape: null, mape: null, unavailable: true });
  result.backtest = {
    trainMonths: train.length, testMonths,
    rows,
    metrics: [
      metrics('rolling', base),
      metrics('seasonal', seas?.forecast),
      metrics('seasonalNaive', naive),
    ],
    seasonalRatio: seas?.ratio ?? null, seasonalK: seas?.k ?? null,
  };
  if (!seas) result.notes.push(`Seasonal model needs at least 13 training months; the backtest has ${train.length}.`);
  else if (n < minForSeasonalBacktest + 8)
    result.notes.push(`Seasonal backtest uses ${train.length} training months: each seasonal factor rests on a single prior-year observation, so treat the comparison as indicative only (${holdout} test points).`);

  // Refit on all observed months and project forward.
  const futureMonths = Array.from({ length: horizon }, (_, i) => shiftMonth(months[n - 1], i + 1));
  const fbase = rollingAvg(series, horizon, window);
  const fseas = seasonalLevel(series, horizon);
  const ok = result.backtest.metrics.filter(x => x.wape !== null);
  const best = ok.length ? ok.reduce((a, b) => (a.wape <= b.wape ? a : b)).model : 'rolling';
  result.forecast = {
    months: futureMonths, rolling: fbase, seasonal: fseas?.forecast ?? null, seasonalRatio: fseas?.ratio ?? null,
    selectedByBacktest: best,
  };
  return result;
}

function forecast(m, f = {}, opts = {}) {
  const cov = coverage(m);
  const pos = filterPos(m, { ...f, from: undefined, to: undefined });
  const metric = ['pos', 'customers'].includes(opts.metric) ? opts.metric : 'value';
  const basis = opts.basis === 'raw' ? 'raw' : 'dedup';
  let rows;
  if (metric === 'customers') {
    const customerKey = keyOf(m, basis), monthCustomers = new Map(cov.monthList.map(month => [month, new Set()]));
    for (const p of pos) monthCustomers.get(p.month)?.add(customerKey(p.customer_id));
    rows = cov.monthList.map(month => ({ month, customers: monthCustomers.get(month).size }));
  } else rows = monthly(pos, cov.monthList);
  const series = rows.map(r => metric === 'customers' ? r.customers : r[metric]);
  const out = forecastSeries(series, cov.monthList, opts);
  const split = Math.max(0, series.length - 3), recent = series.slice(split), prior = series.slice(Math.max(0, split - 3), split);
  const recentTotal = sum(recent), priorTotal = sum(prior);
  return {
    metric, basis, filters: f,
    history: rows.map(r => ({ month: r.month, value: metric === 'customers' ? r.customers : r[metric] })),
    growth: metric === 'customers' && prior.length === 3 ? {
      recentMonths: `${cov.monthList[split]}..${cov.monthList.at(-1)}`,
      priorMonths: `${cov.monthList[split - 3]}..${cov.monthList[split - 1]}`,
      recent: recentTotal / 3, prior: priorTotal / 3, change: priorTotal ? (recentTotal - priorTotal) / priorTotal : null,
    } : null,
    coverage: { firstDate: cov.firstDate, lastDate: cov.lastDate, months: cov.months, enoughFor24Months: cov.enoughFor24Months },
    requested24Months: !cov.enoughFor24Months
      ? `Source history is ${cov.months} months (${cov.firstDate} to ${cov.lastDate}); a 24-month history is not available and none was fabricated.` : null,
    dedupNote: metric === 'customers'
      ? 'Active customers = distinct customer identities with at least one PO in a month. Raw counts use source customer IDs; deduplicated counts use golden customer IDs. Growth compares the latest 3 months with the prior 3 months; forecast errors use the final 3 months as holdout.'
      : 'This forecasts total monthly PO value or count. Deduplication re-assigns POs between customer identities but does not change those totals, so raw and deduplicated forecast results are identical at country/product/total level.',
    ...out,
  };
}

module.exports = { forecast, forecastSeries, rollingAvg, seasonalLevel, wape, mape };
