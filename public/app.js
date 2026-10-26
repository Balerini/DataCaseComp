'use strict';
/* MDM Regional Hub — single-page UI. All data comes from /api (backed by mdm_fake_data_all.csv + app DB). */

// ---------- helpers ----------
// Native append/replaceChildren stringify null/false/arrays (rendering "null"); make them skip empties and flatten.
for (const m of ['append', 'replaceChildren']) {
  const native = Element.prototype[m];
  Element.prototype[m] = function (...kids) { return native.apply(this, kids.flat(Infinity).filter(k => k != null && k !== false)); };
}
const $ = s => document.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') e[k] = !!v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const svgNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const e = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  kids.flat().forEach(k => k != null && e.append(k.nodeType ? k : document.createTextNode(String(k))));
  return e;
}
const nf = new Intl.NumberFormat('en-US');
const n0 = x => (x == null ? '–' : nf.format(Math.round(x)));
const money = x => (x == null ? '–' : 'S$' + (Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : Math.abs(x) >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : x.toFixed(0)));
const moneyFull = x => 'S$' + nf.format(Math.round(x));
const pct = (x, d = 1) => (x == null ? '–' : (x * 100).toFixed(d) + '%');
const sgn = x => (x == null ? '–' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');

async function api(path, opts) {
  const r = await fetch('/api' + path, opts && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts) });
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; e.data = j; throw e; }
  return j;
}
const qs = o => { const p = new URLSearchParams(); Object.entries(o).forEach(([k, v]) => v && p.set(k, v)); const t = p.toString(); return t ? '?' + t : ''; };
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => (t.style.display = 'none'), 3800); }
const debounce = (f, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
const load = (el, msg = 'Loading…') => { el.replaceChildren(h('p', { class: 'muted' }, msg)); };
const COUNTRY_COLOR = { ID: 'var(--s1)', MY: 'var(--s2)', SG: 'var(--s3)', TH: 'var(--s4)', VN: 'var(--s5)' };
const COUNTRY_NAME = { SG: 'Singapore', MY: 'Malaysia', ID: 'Indonesia', TH: 'Thailand', VN: 'Vietnam' };
const statusPill = st => h('span', { class: 'pill ' + ({ applied: 'good', approved: 'good', rejected: 'bad', pending_approval: 'warn', draft: '' }[st] || '') }, st.replace('_', ' '));

const S = { meta: null, basis: 'dedup', f: { country: '', product: '', entity: '' }, tab: {} };
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

// ---------- charts ----------
function lineChart({ labels, series, fmt = money, height = 260, yMin = 0 }) {
  const W = 760, H = height, m = { l: 52, r: 12, t: 10, b: 26 };
  const max = Math.max(...series.flatMap(x => x.values.filter(v => v != null)), 1) * 1.08;
  const X = i => m.l + (i * (W - m.l - m.r)) / Math.max(labels.length - 1, 1);
  const Y = v => H - m.b - ((v - yMin) / (max - yMin)) * (H - m.t - m.b);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'line chart' });
  for (let t = 0; t <= 4; t++) {
    const v = yMin + ((max - yMin) * t) / 4, y = Y(v);
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, stroke: 'var(--line)', 'stroke-width': 1 }), s('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--ink-3)' }, fmt(v)));
  }
  const step = Math.ceil(labels.length / 8);
  labels.forEach((l, i) => i % step === 0 && svg.append(s('text', { x: X(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--ink-3)' }, l)));
  for (const sr of series) {
    const pts = sr.values.map((v, i) => (v == null ? null : [X(i), Y(v)]));
    let d = '', pen = false;
    pts.forEach(p => { if (!p) { pen = false; return; } d += (pen ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); pen = true; });
    svg.append(s('path', { d, fill: 'none', stroke: sr.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-dasharray': sr.dash || '' }));
    if (labels.length <= 24 && sr.dots !== false) pts.forEach(p => p && svg.append(s('circle', { cx: p[0], cy: p[1], r: 2.5, fill: sr.color, stroke: 'var(--surface)', 'stroke-width': 1.5 })));
  }
  const cross = s('line', { y1: m.t, y2: H - m.b, stroke: 'var(--ink-3)', 'stroke-width': 1, visibility: 'hidden' });
  svg.append(cross);
  const tip = h('div', { class: 'tip' });
  const wrap = h('div', { class: 'chart' }, svg, tip);
  const hit = s('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' });
  hit.addEventListener('mousemove', ev => {
    const r = svg.getBoundingClientRect(), px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(labels.length - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (labels.length - 1))));
    cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
    tip.replaceChildren(h('b', {}, labels[i]), ...series.filter(x => x.values[i] != null).map(x => h('div', {}, h('i', { style: `display:inline-block;width:8px;height:8px;border-radius:2px;background:${x.color};margin-right:6px` }), `${x.name}: ${(x.fmt || fmt)(x.values[i])}`)));
    tip.style.display = 'block';
    const left = (X(i) / W) * r.width;
    tip.style.left = Math.min(left + 12, r.width - tip.offsetWidth - 4) + 'px'; tip.style.top = '8px';
  });
  hit.addEventListener('mouseleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); });
  svg.append(hit);
  const legend = series.length > 1 || series[0].name ? h('div', { class: 'legend' }, series.map(x => h('span', {}, h('i', { style: `background:${x.color}` }), x.name))) : null;
  return h('div', {}, legend, wrap);
}

function hbars(rows, { label, value, fmt = money, color = 'var(--s1)', sub }) {
  const max = Math.max(...rows.map(value), 1);
  return h('table', {}, rows.map(r => h('tr', {},
    h('td', { style: 'width:34%' }, label(r), sub ? h('div', { class: 'muted', style: 'font-size:11px' }, sub(r)) : null),
    h('td', {}, h('div', { class: 'bar', style: `width:${(value(r) / max) * 100}%;background:${typeof color === 'function' ? color(r) : color};min-width:2px` })),
    h('td', { class: 'num' }, fmt(value(r))))));
}

const table = (cols, rows, { onRow } = {}) => h('div', { class: 'scroll' }, h('table', {},
  h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: c.num ? 'num' : '' }, c.h)))),
  h('tbody', {}, rows.map(r => h('tr', { class: onRow ? 'click' : '', onclick: onRow && (() => onRow(r)) }, cols.map(c => h('td', { class: c.num ? 'num' : '' }, c.f(r))))))));

const kpi = (label, value, note) => h('div', { class: 'card kpi' }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value), note ? h('div', { class: 'n' }, note) : null);
const seg = (opts, cur, on) => h('div', { class: 'seg' }, opts.map(([v, l]) => h('button', { class: v === cur ? 'on' : 'ghost', onclick: () => on(v) }, l)));
const sel = (opts, cur, on, any) => h('select', { onchange: e => on(e.target.value) }, any ? h('option', { value: '' }, any) : null, opts.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: v === cur }, l); }));

function filterBar(rerender, { basis = true, entity = true } = {}) {
  const o = S.meta.options;
  return h('div', { class: 'filters' },
    h('label', {}, 'Country', sel(o.countries.map(c => [c, `${c} – ${COUNTRY_NAME[c]}`]), S.f.country, v => { S.f.country = v; rerender(); }, 'All countries')),
    h('label', {}, 'Product code', sel(['A', 'B', 'C'], S.f.product, v => { S.f.product = v; rerender(); }, 'All product codes')),
    entity ? h('label', {}, 'Entity', sel(o.entities, S.f.entity, v => { S.f.entity = v; rerender(); }, 'All entities')) : null,
    basis ? h('label', {}, 'Customer basis', seg([['dedup', 'Deduplicated'], ['raw', 'Raw records']], S.basis, v => { S.basis = v; rerender(); })) : null);
}

// ---------- pages ----------
const pages = {};

pages.overview = async el => {
  const draw = async () => {
    const q = qs({ ...S.f, basis: S.basis });
    const [o, top, v, raw, dedup, rawCustomerFc, dedupCustomerFc] = await Promise.all([
      api('/analytics/overview' + q), api('/analytics/top-customers' + q + (q ? '&' : '?') + 'n=10'), api('/validate'),
      api('/analytics/overview' + qs({ ...S.f, basis: 'raw' })),
      api('/analytics/overview' + qs({ ...S.f, basis: 'dedup' })),
      api('/forecast' + qs({ ...S.f, basis: 'raw', metric: 'customers' })),
      api('/forecast' + qs({ ...S.f, basis: 'dedup', metric: 'customers' })),
    ]);
    const bad = v.checks.filter(c => !c.pass).length;
    const mode = S.tab.ov || 'country';
    const detailMode = S.tab.ovDetail || 'country';
    const labels = o.monthly.map(x => x.month);
    const countries = Object.keys(o.monthlyByCountry).filter(c => !S.f.country || c === S.f.country);
    const rawSeasonalWape = rawCustomerFc.backtest?.metrics.find(x => x.model === 'seasonal')?.wape;
    const dedupSeasonalWape = dedupCustomerFc.backtest?.metrics.find(x => x.model === 'seasonal')?.wape;
    const pp = (a, b) => a == null || b == null ? 'n/a' : `${((a - b) * 100) > 0 ? '+' : ''}${((a - b) * 100).toFixed(1)} pp`;
    const chart = mode === 'total'
      ? lineChart({ labels, series: [{ name: 'All selected', color: 'var(--s1)', values: o.monthly.map(x => x.value) }] })
      : lineChart({ labels, series: countries.map(c => ({ name: c, color: COUNTRY_COLOR[c], values: o.monthlyByCountry[c].map(x => (S.f.product || S.f.entity ? null : x.value)) })) });
    const filtered = !!(S.f.product || S.f.entity);
    wrap.replaceChildren(
      filterBar(draw),
      h('div', { class: 'card story' },
        h('div', { class: 'story-head' }, h('div', {}, h('h2', {}, 'You can’t forecast customers you can’t count'), h('p', { class: 'sub' }, 'The same purchase-order history tells a different customer story when duplicate records are consolidated into golden identities.')),
          h('button', { onclick: () => { S.tab.fm = 'customers'; location.hash = '#forecast'; } }, 'See raw vs. golden forecast')),
        table([
          { h: 'Measure', f: r => r.measure },
          { h: 'Raw records', num: 1, f: r => r.raw },
          { h: 'Golden customers', num: 1, f: r => r.golden },
          { h: 'Raw − golden', num: 1, f: r => r.delta },
        ], [
          { measure: 'Active customers with orders', raw: n0(raw.totals.activeCustomers), golden: n0(dedup.totals.activeCustomers), delta: `−${n0(raw.totals.activeCustomers - dedup.totals.activeCustomers)} identities` },
          { measure: 'Growth · latest 3 vs prior 3 months', raw: rawCustomerFc.growth ? sgn(rawCustomerFc.growth.change) : 'n/a', golden: dedupCustomerFc.growth ? sgn(dedupCustomerFc.growth.change) : 'n/a', delta: pp(rawCustomerFc.growth?.change, dedupCustomerFc.growth?.change) },
          { measure: `Seasonal forecast WAPE · ${rawCustomerFc.backtest?.testMonths.length || 0}-month holdout`, raw: rawSeasonalWape == null ? 'n/a' : pct(rawSeasonalWape), golden: dedupSeasonalWape == null ? 'n/a' : pct(dedupSeasonalWape), delta: pp(rawSeasonalWape, dedupSeasonalWape) },
        ]),
        h('p', { class: 'muted', style: 'font-size:12px;margin-bottom:0' }, 'Growth compares average monthly active customer identities in the latest 3 months with the prior 3. WAPE is measured on the same final 3 months. PO value and PO-count totals do not change when customer IDs are deduplicated.')),
      h('div', { class: 'grid g4' },
        kpi('PO value (SGD)', moneyFull(o.totals.value), `${n0(o.totals.pos)} purchase orders · avg ${moneyFull(o.totals.avgOrderValue)}`),
        kpi('Active customers', n0(o.totals.activeCustomers), S.basis === 'dedup' ? `${n0(raw.totals.activeCustomers)} raw records → ${n0(o.totals.activeCustomers)} real customers` : `Raw customer_id records (deduplicated: ${n0((await api('/analytics/overview' + qs({ ...S.f, basis: 'dedup' }))).totals.activeCustomers)})`),
        kpi('Growth, ' + (o.yoy ? o.yoy.window.replace('..', ' → ') : 'n/a'), o.yoy ? sgn(o.yoy.growth) : 'n/a', o.yoy ? `vs ${o.yoy.vs.replace('..', ' → ')} (${o.yoy.months} comparable months)` : 'Needs 13+ months of history'),
        kpi('Data coverage', `${o.coverage.months} months`, `${o.coverage.firstDate} → ${o.coverage.lastDate}` + (o.coverage.enoughFor24Months ? '' : ' · <24 months, nothing fabricated'))),
      bad ? h('div', { class: 'note bad' }, `${bad} data validation check(s) failing — see Data & Quality.`)
        : h('div', { class: 'note good' }, `All ${v.checks.length} reconciliation checks pass: dashboard totals equal the source CSV recomputed independently (see Data & Quality).`),
      h('div', { class: 'card' },
        h('div', { class: 'filters' }, h('h2', { style: 'margin:0;flex:1' }, 'Monthly PO value'), seg([['country', 'By country'], ['total', 'Total']], mode, v => { S.tab.ov = v; draw(); })),
        mode === 'country' && filtered ? h('p', { class: 'note warn' }, 'Per-country lines are shown without product/entity filters; switch to Total to see the filtered series.') : null,
        mode === 'country' && filtered ? lineChart({ labels, series: [{ name: 'Filtered total', color: 'var(--s1)', values: o.monthly.map(x => x.value) }] }) : chart),
      h('div', { class: 'card' },
        h('div', { class: 'filters detail-tabs' }, h('h2', { style: 'margin:0;flex:1' }, 'Regional breakdown'),
          seg([['country', 'Countries'], ['product', 'Product codes'], ['customers', 'Top customers']], detailMode, v => { S.tab.ovDetail = v; draw(); })),
        detailMode === 'country' ? table([{ h: 'Country', f: r => `${r.country} – ${COUNTRY_NAME[r.country]}` }, { h: 'POs', num: 1, f: r => n0(r.pos) }, { h: 'Value', num: 1, f: r => money(r.value) }, { h: 'Share', num: 1, f: r => pct(r.shareOfValue, 0) },
          { h: S.basis === 'dedup' ? 'Customers' : 'Records', num: 1, f: r => n0(r.activeCustomers) }, { h: 'Growth', num: 1, f: r => (r.yoy ? sgn(r.yoy.growth) : '–') }], o.byCountry)
          : detailMode === 'product' ? table([{ h: 'Product code', f: r => r.product }, { h: 'POs', num: 1, f: r => n0(r.pos) }, { h: 'Units', num: 1, f: r => n0(r.qty) }, { h: 'Value', num: 1, f: r => money(r.value) }, { h: 'Unit price', num: 1, f: r => (r.unitPrice ? 'S$' + r.unitPrice.toFixed(0) : '–') }, { h: 'Growth', num: 1, f: r => (r.yoy ? sgn(r.yoy.growth) : '–') }], o.byProduct)
            : hbars(top, { label: r => r.name || r.key, sub: r => `${r.country} · ${r.pos} POs · products ${r.products}` + (r.recordsMerged > 1 ? ` · ${r.recordsMerged} records merged` : ''), value: r => r.value, color: r => COUNTRY_COLOR[r.country] })));
  };
  const wrap = h('div', {});
  el.append(h('h1', {}, 'Regional overview'), h('p', { class: 'sub' }, 'Calculated live from purchase_orders in the source CSV. Deduplicated view re-keys the same PO rows by golden customer.'), wrap);
  load(wrap); await draw();
};

pages.intake = async el => {
  const o = S.meta.options;
  const F = { request_type: 'create_customer', entity: '', country: '', name: '', uen: '', address: '', target: null, field: 'address', new_value: '', merge_ids: [], reason: '', dup_note: '', dup_ack: false };
  const out = h('div', {}), formBox = h('div', { class: 'card' }), side = h('div', {});
  let touched = false, last = null, token = 0;
  const body = (submit = true) => ({
    request_type: F.request_type, entity: F.entity, country: F.country, name: F.name, uen: F.uen, address: F.address,
    target_customer_id: F.target?.customer_id, field: F.field, new_value: F.new_value, merge_ids: F.merge_ids, reason: F.reason,
    requested_by: $('#actor').value.trim(), submit, duplicate_ack: F.dup_ack ? 'not_duplicate' : undefined, duplicate_note: F.dup_note,
  });
  const run = debounce(async () => {
    const my = ++token;
    try { last = await api('/intake/preview', body()); } catch (e) { last = { errors: { _: e.message }, duplicates: [], route: null }; }
    if (my === token) drawSide();
  }, 250);
  const field = (label, key, extra = {}) => h('label', { class: extra.full ? 'full' : '' }, label + (extra.req ? ' *' : ''),
    extra.opts ? sel(extra.opts, F[key], v => { F[key] = v; run(); drawForm(); }, extra.any)
      : (extra.area ? h('textarea', { rows: 2, value: F[key], oninput: e => { F[key] = e.target.value; run(); } }) : h('input', { value: F[key], placeholder: extra.ph || '', oninput: e => { F[key] = e.target.value; run(); } })),
    h('span', { class: 'err', id: 'e_' + key }));
  const picker = () => {
    const res = h('div', {}), inp = h('input', { placeholder: 'Search id / name / registration no. / address…', oninput: debounce(async e => {
      const r = await api('/customers' + qs({ q: e.target.value, limit: 8 }));
      res.replaceChildren(table([{ h: 'ID', f: c => c.customer_id }, { h: 'Name', f: c => c.name }, { h: 'Ctry', f: c => c.country }, { h: 'Golden', f: c => c.golden_id }, { h: 'UEN', f: c => c.uen || '–' }], r.rows,
        { onRow: c => { F.target = c; F.merge_ids = [c.customer_id]; run(); drawForm(); } }));
    }) });
    return h('div', { class: 'full' }, h('label', {}, 'Customer *', inp), F.target ? h('div', { class: 'note' }, `Selected: ${F.target.customer_id} · ${F.target.name} · ${F.target.entity}/${F.target.country} · ${F.target.golden_id}`) : null, res);
  };
  const drawForm = () => {
    const t = F.request_type;
    const fields = [h('label', {}, 'Request type', sel(o.requestTypes.map(x => [x, x.replace('_', ' ')]), t, v => { F.request_type = v; F.target = null; F.merge_ids = []; run(); drawForm(); }))];
    if (t === 'create_customer') fields.push(field('Owning entity', 'entity', { opts: o.entities, any: 'Select…', req: 1 }), field('Country', 'country', { opts: o.countries.map(c => [c, `${c} – ${COUNTRY_NAME[c]}`]), any: 'Select…', req: 1 }),
      field('Registered legal name', 'name', { req: 1, full: 1, ph: 'e.g. Orchid Industrial Pte. Ltd.' }), field('Registration no. (UEN / SSM / NIB / MST…)', 'uen', { ph: o.fieldRules.uen.description }), field('Registered address', 'address', { req: 1, full: 1, area: 1 }));
    else {
      fields.push(picker());
      if (t === 'update_customer') fields.push(field('Field to change', 'field', { opts: o.updatableFields }), field('New value', 'new_value', { req: 1, full: 1 }));
      if (t === 'merge_customer') fields.push(mergePicker());
      if (t === 'deactivate_customer') fields.push(field('Reason', 'reason', { req: 1, full: 1 }));
    }
    formBox.replaceChildren(h('h2', {}, 'New master-data request'), h('div', { class: 'form' }, fields));
    drawErrors();
  };
  const mergeBox = h('div', { class: 'full' });
  const mergePicker = () => {
    if (!F.target) return h('p', { class: 'muted full' }, 'Select the first record, then tick the records to merge into it.');
    (async () => {
      const g = await api('/customers/' + F.target.customer_id);
      const cands = await api('/duplicates/check', { name: F.target.name, uen: F.target.uen, address: F.target.address, country: F.target.country, entity: F.target.entity, request_type: 'create_customer' });
      const seen = new Set([F.target.customer_id]);
      const list = [...g.groupMembers.filter(m => !seen.has(m.customer_id)).map(m => ({ ...m, why: 'same golden id ' + g.golden_id })), ...cands.duplicates.filter(d => d.customer_id !== F.target.customer_id && !g.groupMembers.some(m => m.customer_id === d.customer_id)).map(d => ({ ...d, why: `matcher ${pct(d.score, 0)} (${d.class})` }))];
      mergeBox.replaceChildren(h('label', {}, 'Merge these records into ' + F.target.customer_id + ' (same country only)'), list.length ? list.map(m => h('label', { style: 'flex-direction:row;gap:8px;align-items:center' },
        h('input', { type: 'checkbox', checked: F.merge_ids.includes(m.customer_id), onchange: e => { F.merge_ids = e.target.checked ? [...F.merge_ids, m.customer_id] : F.merge_ids.filter(x => x !== m.customer_id); run(); } }),
        `${m.customer_id} · ${m.name} · ${m.entity}/${m.country} — ${m.why}`)) : h('p', { class: 'muted' }, 'No candidate records found for this customer.'));
    })();
    return mergeBox;
  };
  const drawErrors = () => {
    const errs = last?.errors || {};
    for (const [k, v] of Object.entries(errs)) { const n = $('#e_' + k); if (n && (touched || F[k])) n.textContent = v; }
  };
  const drawSide = () => {
    drawErrors();
    const d = last, nodes = [];
    if (d?.route) {
      nodes.push(h('div', { class: 'card' }, h('h2', {}, 'Approval route'),
        d.route.steps.length ? h('div', { class: 'steps' }, d.route.steps.flatMap((st, i) => [i ? '›' : null, h('span', { class: 'step', title: `${st.rule_id}: ${st.note} · SLA ${st.sla_hours}h` }, st.role)])) : h('p', { class: 'muted' }, 'No rule matched.'),
        d.route.context.openPoValueSgd != null ? h('p', { class: 'muted', style: 'font-size:12px' }, `Open-PO value proxy (POs in last ${d.route.openPoWindowDays} days): ${moneyFull(d.route.context.openPoValueSgd)} — the source has no PO status, so R07 uses this proxy.`) : null));
    }
    if (d?.duplicates?.length) {
      nodes.push(h('div', { class: 'card' }, h('h2', {}, 'Possible existing records'),
        d.duplicates.map(c => h('div', { class: 'cand ' + c.class }, h('div', {}, h('b', {}, c.name), ' ', h('span', { class: 'pill ' + (c.class === 'duplicate' ? 'bad' : 'warn') }, `${c.class} · ${pct(c.score, 0)}`)),
          h('div', { class: 'muted' }, `${c.customer_id} · ${c.entity}/${c.country} · ${c.uen || 'no reg. no.'} · ${c.golden_id}${c.origin === 'app' ? ' · created in app' : ''}`), h('div', { class: 'muted' }, c.address),
          h('div', { style: 'font-size:12px;margin-top:4px' }, c.reasons.join(' · '))))));
    } else if (d && F.request_type === 'create_customer' && (F.name || F.uen)) nodes.push(h('div', { class: 'note good' }, 'No similar customer found in the master data.'));
    side.replaceChildren(...nodes);
    const strong = (d?.duplicates || []).some(c => c.class === 'duplicate') && F.request_type === 'create_customer';
    if (strong) side.append(h('div', { class: 'card' }, h('div', { class: 'note bad' }, 'A likely duplicate exists. Do not create a new record unless this is genuinely a different company.'),
      h('label', { style: 'flex-direction:row;gap:8px;align-items:center' }, h('input', { type: 'checkbox', checked: F.dup_ack, onchange: e => { F.dup_ack = e.target.checked; } }), 'I confirm this is a different company'),
      h('label', {}, 'Why is it different? *', h('input', { value: F.dup_note, oninput: e => { F.dup_note = e.target.value; } }))));
  };
  const submitRow = h('div', { class: 'card' });
  const drawSubmit = () => submitRow.replaceChildren(h('button', { onclick: () => go(true) }, 'Submit for approval'), ' ', h('button', { class: 'ghost', onclick: () => go(false) }, 'Save as draft'),
    h('p', { class: 'muted', style: 'font-size:12px' }, 'Requests are stored in the app database (data/app.db), separate from the source CSV. “Requested by” uses the “Acting as” box in the header.'));
  async function go(submit) {
    touched = true;
    if (!$('#actor').value.trim()) { toast('Enter your user id in “Acting as” (top right).'); $('#actor').focus(); return; }
    try {
      const r = await api('/requests', body(submit));
      toast(`Created ${r.request_id} (${r.status.replace('_', ' ')})`);
      location.hash = '#requests/' + r.request_id;
    } catch (e) {
      if (e.data?.errors) { last = { ...last, errors: e.data.errors }; drawErrors(); toast('Please fix the highlighted fields.'); }
      else if (e.status === 409 && e.data?.duplicates) { last = { ...last, duplicates: e.data.duplicates }; drawSide(); toast(e.message); }
      else toast(e.message);
    }
  }
  el.append(h('h1', {}, 'Intake'), h('p', { class: 'sub' }, 'Dropdowns and validation rules come from config_domains; duplicate checks run against every customer in the dataset (plus anything created in the app).'),
    h('div', { class: 'grid g2' }, h('div', {}, formBox, submitRow), side));
  drawForm(); drawSubmit(); run();
};

pages.duplicates = async el => {
  const [ev, cl, gr] = await Promise.all([api('/duplicates/evaluation'), api('/duplicates/clusters'), api('/duplicates/groups')]);
  let term = '', countryFilter = '', entityFilter = '', mode = S.tab.dup || 'groups', page = S.tab.dupPage || 0;
  const list = h('div', {});
  const content = h('div', {});
  const controls = h('div', { class: 'filters' });
  const drawTabs = () => controls.replaceChildren(h('h2', { style: 'margin:0;flex:1' }, 'Duplicate review'),
    seg([['groups', 'Golden groups'], ['quality', 'Matcher quality']], mode, v => { mode = v; S.tab.dup = v; drawTabs(); drawContent(); }));
  const drawList = () => {
    const g = gr.groups.filter(x => (!term || JSON.stringify(x).toLowerCase().includes(term))
      && (!countryFilter || x.members.some(m => m.country === countryFilter))
      && (!entityFilter || x.members.some(m => m.entity === entityFilter)));
    const pageSize = 5, pageCount = Math.max(1, Math.ceil(g.length / pageSize));
    page = Math.min(page, pageCount - 1);
    const shown = g.slice(page * pageSize, (page + 1) * pageSize);
    list.replaceChildren(
      h('div', { class: 'pagination' }, h('span', { class: 'muted' }, g.length ? `Showing ${page * pageSize + 1}–${page * pageSize + shown.length} of ${g.length} groups · ${gr.total} total` : `No matching groups · ${gr.total} total`),
        h('div', { class: 'pagination-actions' }, h('button', { class: 'ghost', disabled: page === 0, onclick: () => { page--; S.tab.dupPage = page; drawList(); } }, 'Previous'),
          h('span', { class: 'muted' }, `Page ${page + 1} of ${pageCount}`),
          h('button', { class: 'ghost', disabled: page + 1 >= pageCount, onclick: () => { page++; S.tab.dupPage = page; drawList(); } }, 'Next'))),
      shown.map(x => h('div', { class: 'card' },
      h('b', {}, x.golden_id), ' ', h('span', { class: 'muted' }, `${x.members.length} records`),
      table([{ h: 'ID', f: m => m.customer_id + (m.is_survivor ? ' ★' : '') }, { h: 'Name', f: m => m.name }, { h: 'Entity', f: m => m.entity }, { h: 'Country', f: m => m.country }, { h: 'UEN', f: m => m.uen || '–' }, { h: 'Address', f: m => m.address }, { h: 'Recorded reason', f: m => m.match_reason }], x.members))));
  };
  const drawContent = () => {
    if (mode === 'groups') {
      drawList();
      content.replaceChildren(h('div', { class: 'filters group-filters' },
        h('label', {}, 'Search groups', h('input', { value: term, placeholder: 'Name, customer ID, golden ID…', oninput: debounce(e => { term = e.target.value.toLowerCase(); page = 0; S.tab.dupPage = page; drawList(); }) })),
        h('label', {}, 'Country', sel(S.meta.options.countries.map(c => [c, `${c} – ${COUNTRY_NAME[c]}`]), countryFilter, v => { countryFilter = v; page = 0; S.tab.dupPage = page; drawList(); }, 'All countries')),
        h('label', {}, 'Entity', sel(S.meta.options.entities, entityFilter, v => { entityFilter = v; page = 0; S.tab.dupPage = page; drawList(); }, 'All entities')),
        h('button', { class: 'ghost', disabled: !term && !countryFilter && !entityFilter, onclick: () => { term = ''; countryFilter = ''; entityFilter = ''; page = 0; S.tab.dupPage = page; drawContent(); } }, 'Clear filters')), list);
    } else content.replaceChildren(
      h('div', { class: 'grid g4' }, kpi('Source customer records', n0(S.meta.source.tables.customers), 'mdm_fake_data_all.csv'), kpi('Golden customers (provided mapping)', n0(cl.distinctInGoldenMap), 'golden_map table'),
        kpi('Distinct after live matching', n0(cl.distinctAfterMatching), `${cl.pairs} duplicate pairs at ≥ ${pct(ev.thresholds.duplicate, 0)}`), kpi('Matcher vs provided mapping', `P ${pct(ev.precision, 1)} · R ${pct(ev.recall, 1)}`, `${ev.tp} true pairs found, ${ev.fp} false, ${ev.fn} missed`)),
      ev.fn ? h('div', { class: 'note warn' }, `Missed pair(s): ${ev.missed.map(m => `${m[0]} / ${m[1]} (score ${m[2]}, below the ${ev.thresholds.duplicate} duplicate threshold but ≥ ${ev.thresholds.possible} so it is surfaced as “possible”)`).join('; ')}. Thresholds were set once and not tuned to this reference.`) : h('div', { class: 'note good' }, 'No missed pairs against the provided golden mapping.'));
  };
  el.append(h('h1', {}, 'Duplicate detection'), h('p', { class: 'sub' }, 'Hard key = normalised registration number + country. Fuzzy = normalised name (legal suffixes dropped, token-sorted, edit distance) and address (Jalan/Jln/Jl, Road/Rd…). Source records are never deleted; the canonical mapping is kept separately.'),
    h('div', { class: 'card' }, controls, content));
  drawTabs();
  drawContent();
};

pages.requests = async (el, arg) => {
  const f = { status: S.tab.rs ?? 'pending_approval', type: '', role: '', q: '' };
  const listBox = h('div', {});
  const statusControls = h('div', { class: 'filters status-tabs' });
  let page = S.tab.reqPage || 0;
  const draw = async () => {
    const rows = await api('/requests' + qs(f));
    const pageSize = 15, pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    page = Math.min(page, pageCount - 1);
    const shown = rows.slice(page * pageSize, (page + 1) * pageSize);
    const controls = h('div', { class: 'pagination' }, h('span', { class: 'muted' }, rows.length ? `Showing ${page * pageSize + 1}–${page * pageSize + shown.length} of ${rows.length} requests` : 'No matching requests'),
      h('div', { class: 'pagination-actions' }, h('button', { class: 'ghost', disabled: page === 0, onclick: () => { page--; S.tab.reqPage = page; draw(); } }, 'Previous'),
        h('span', { class: 'muted' }, `Page ${page + 1} of ${pageCount}`),
        h('button', { class: 'ghost', disabled: page + 1 >= pageCount, onclick: () => { page++; S.tab.reqPage = page; draw(); } }, 'Next')));
    listBox.replaceChildren(controls, table([
      { h: 'Request', f: r => h('span', {}, r.request_id, ' ', r.source === 'app' ? h('span', { class: 'pill info' }, 'new') : null) }, { h: 'Type', f: r => r.request_type.replace('_', ' ') },
      { h: 'Entity/Ctry', f: r => `${r.entity}/${r.country}` }, { h: 'Target', f: r => r.target_customer_id || '–' }, { h: 'Status', f: r => statusPill(r.status) },
      { h: 'Awaiting', f: r => r.awaiting || '–' }, { h: 'By', f: r => r.requested_by }, { h: 'Created', f: r => r.created_at.replace('T', ' ') }], shown, { onRow: r => (location.hash = '#requests/' + r.request_id) }));
  };
  const resetPage = () => { page = 0; S.tab.reqPage = page; draw(); };
  const drawStatusTabs = () => statusControls.replaceChildren(seg(
    [['', 'All'], ['pending_approval', 'Pending'], ['approved', 'Approved'], ['applied', 'Applied'], ['rejected', 'Rejected'], ['draft', 'Draft']],
    f.status, v => { f.status = v; S.tab.rs = v; drawStatusTabs(); resetPage(); }));
  el.append(h('h1', {}, 'Requests & approvals'), h('p', { class: 'sub' }, 'Imported rows come from the CSV’s requests/audit_log tables (loaded once into the app database). Decisions made here are stored in the app database only.'),
    statusControls,
    h('div', { class: 'filters' },
      h('label', {}, 'Type', sel(S.meta.options.requestTypes, f.type, v => { f.type = v; resetPage(); }, 'Any')),
      h('label', {}, 'Awaiting role', sel(S.meta.options.roles, f.role, v => { f.role = v; resetPage(); }, 'Any')),
      h('label', {}, 'Search', h('input', { oninput: debounce(e => { f.q = e.target.value; resetPage(); }) })),
      h('button', { class: 'ghost', onclick: () => { f.role = $('#role').value; resetPage(); } }, 'My queue (header role)')), listBox);
  drawStatusTabs();
  await draw();
  if (arg) openDrawer(arg, draw);
};

async function openDrawer(id, refresh) {
  document.querySelector('.drawer')?.remove();
  const d = h('div', { class: 'drawer' });
  document.body.append(d);
  const close = () => { d.remove(); if (location.hash.startsWith('#requests/')) history.replaceState(null, '', '#requests'); };
  const draw = async () => {
    let r;
    try { r = await api('/requests/' + id); } catch (e) { d.replaceChildren(h('p', {}, e.message), h('button', { onclick: close }, 'Close')); return; }
    const p = r.payload || {};
    const stepEls = r.path.map((role, i) => {
      const done = r.status === 'approved' || r.status === 'applied' || (r.status === 'pending_approval' && i < r.step_index);
      return h('span', { class: 'step ' + (done ? 'done' : r.status === 'pending_approval' && i === r.step_index ? 'cur' : r.status === 'rejected' && i === r.step_index ? 'bad' : '') }, (done ? '✓ ' : '') + role);
    });
    const actions = [];
    const actor = () => $('#actor').value.trim(), role = () => $('#role').value;
    if (r.status === 'pending_approval') {
      const cm = h('input', { placeholder: 'Comment (required to reject)', style: 'width:100%' });
      actions.push(h('div', { class: 'card' }, h('h2', {}, `Awaiting ${r.awaiting}`),
        h('p', { class: 'muted', style: 'font-size:12px' }, `You are acting as “${actor() || '—'}” in role “${role()}”. This build has no authentication: role selection is a workflow control, not access control.`), cm,
        h('div', { style: 'margin-top:8px;display:flex;gap:8px' },
          h('button', { onclick: () => act('decide', { actor: actor(), role: role(), decision: 'approve', comment: cm.value }) }, 'Approve'),
          h('button', { class: 'danger', onclick: () => act('decide', { actor: actor(), role: role(), decision: 'reject', comment: cm.value }) }, 'Reject'))));
    }
    if (r.status === 'approved') actions.push(h('div', { class: 'card' }, h('button', { onclick: () => act('apply', { actor: actor() }) }, 'Apply to master data (app overlay)'), h('p', { class: 'muted', style: 'font-size:12px' }, 'Writes to app tables only; the source CSV is not modified.')));
    if (r.status === 'draft') {
      if (p.new === '<<new value>>') {
        const nv = h('input', { placeholder: `New ${p.field}` });
        actions.push(h('div', { class: 'card' }, h('div', { class: 'note warn' }, 'This draft only has the placeholder “<<new value>>”. Enter the real value to continue.'), nv, ' ', h('button', { onclick: () => act('new-value', { value: nv.value }) }, 'Save value')));
      } else actions.push(h('div', { class: 'card' }, h('button', { onclick: () => act('submit', { actor: actor() }) }, 'Submit for approval')));
    }
    async function act(what, b) {
      try { await api(`/requests/${id}/${what}`, b); toast('Done'); await draw(); refresh && refresh(); } catch (e) { toast(e.message); }
    }
    d.replaceChildren(h('div', { style: 'display:flex;justify-content:space-between' }, h('h1', {}, r.request_id), h('button', { class: 'ghost', onclick: close }, 'Close')),
      h('p', {}, statusPill(r.status), ' ', h('span', { class: 'pill' }, r.source === 'app' ? 'created in app' : 'imported from CSV'), ' ', r.request_type.replace('_', ' '), ` · ${r.entity}/${r.country}`),
      h('p', { class: 'muted' }, `Target ${r.target_customer_id || '—'} · requested by ${r.requested_by} · ${r.created_at.replace('T', ' ')}`),
      h('h3', {}, 'Approval path'), h('div', { class: 'steps' }, stepEls.flatMap((e, i) => [i ? '›' : null, e])),
      p.new === '<<new value>>' ? h('div', { class: 'note warn' }, 'This request’s payload holds only the placeholder “<<new value>>” (as in the source CSV). It can be routed, but it cannot be applied or exported until a real value is recorded.') : null,
      h('h3', {}, 'Payload'), h('pre', { class: 'mono card', style: 'white-space:pre-wrap' }, JSON.stringify(p, null, 2)),
      r.duplicate_check?.candidates?.length ? h('div', {}, h('h3', {}, 'Duplicate check at submission'), r.duplicate_check.candidates.map(c => h('div', { class: 'cand ' + c.class }, `${c.customer_id} ${c.name} — ${c.class} ${pct(c.score, 0)}`)), r.duplicate_check.acknowledged ? h('p', { class: 'muted' }, 'Acknowledged: ' + r.duplicate_check.acknowledged.note) : null) : null,
      actions, h('h3', {}, 'Audit trail'), table([{ h: 'When', f: a => a.ts.replace('T', ' ') }, { h: 'Actor', f: a => a.actor }, { h: 'Action', f: a => a.action }, { h: 'Status', f: a => (a.from_status ? a.from_status + ' → ' : '') + a.to_status }, { h: 'Comment', f: a => a.comment || '' }], r.audit));
  };
  await draw();
}

const analyticsTabs = [['customers', 'Top customers'], ['dropoff', 'Drop-off'], ['crosssell', 'Cross-sell'], ['impact', 'Raw vs deduplicated']];
pages.analytics = async el => {
  const body = h('div', {});
  const draw = async () => {
    const tab = S.tab.an || 'customers', q = qs({ ...S.f, basis: S.basis }), days = S.tab.days || '90';
    load(body);
    let c;
    if (tab === 'customers') {
      const rows = await api('/analytics/top-customers' + q + (q ? '&' : '?') + 'n=25');
      c = h('div', { class: 'card' }, h('h2', {}, 'Top 25 customers by PO value'), table([{ h: 'Customer', f: r => r.name }, { h: 'Key', f: r => r.key }, { h: 'Ctry', f: r => r.country }, { h: 'POs', num: 1, f: r => n0(r.pos) }, { h: 'Value', num: 1, f: r => moneyFull(r.value) }, { h: 'Share', num: 1, f: r => pct(r.share) }, { h: 'Product codes', f: r => r.products }, { h: 'Last PO', f: r => r.lastOrder }, { h: 'Records', num: 1, f: r => r.recordsMerged }], rows));
    } else if (tab === 'dropoff') {
      const r = await api('/analytics/dropoff' + q + (q ? '&' : '?') + 'days=' + days);
      c = h('div', {}, h('div', { class: 'filters' }, h('label', {}, 'Window', sel([['60', '60 days'], ['90', '90 days'], ['180', '180 days']], days, v => { S.tab.days = v; draw(); }))),
        h('div', { class: 'grid g4' }, kpi('Dropped customers', n0(r.dropped), `of ${n0(r.activePrior)} active in prior window`), kpi('Drop-off rate', pct(r.dropRate), `${r.priorWindow.replace('..', ' → ')} vs ${r.recentWindow.replace('..', ' → ')}`), kpi('Prior-window value lost', moneyFull(r.lostValue))),
        h('p', { class: 'muted' }, 'Drop-off = bought in the prior window, no PO in the recent window (relative to the last PO date in the data). “Churn” is inferred from absence of POs; the data has no contract or closure status.'),
        h('div', { class: 'grid g2' }, h('div', { class: 'card' }, h('h2', {}, 'By country'), table([{ h: 'Country', f: x => x.country }, { h: 'Customers', num: 1, f: x => x.customers }, { h: 'Prior value', num: 1, f: x => money(x.priorValue) }], r.byCountry)),
          h('div', { class: 'card' }, h('h2', {}, 'Largest drop-offs'), table([{ h: 'Customer', f: x => x.name }, { h: 'Ctry', f: x => x.country }, { h: 'Prior POs', num: 1, f: x => x.priorPos }, { h: 'Prior value', num: 1, f: x => money(x.priorValue) }], r.top))));
    } else if (tab === 'crosssell') {
      const r = await api('/analytics/crosssell' + q);
      const P = ['A', 'B', 'C'];
      c = h('div', {}, h('div', { class: 'grid g4' }, kpi('Customers with POs', n0(r.customers)), kpi('Buy all 3 products', n0(r.buyAll3), pct(r.buyAll3 / r.customers, 0) + ' of customers'), kpi('Single-product', n0(r.singleProduct), pct(r.singleProduct / r.customers, 0))),
        h('div', { class: 'grid g2' }, h('div', { class: 'card' }, h('h2', {}, 'Co-purchase (customers buying both)'), table([{ h: '' , f: x => x }, ...P.map(y => ({ h: y, num: 1, f: x => n0(r.matrix[x + y]) }))], P)),
          h('div', { class: 'card' }, h('h2', {}, 'Whitespace: customers who never bought…'), table([{ h: 'Product code', f: x => x }, { h: 'Customers', num: 1, f: x => n0(r.whitespace[x]) }], P))),
        h('div', { class: 'card' }, h('h2', {}, 'Largest cross-sell opportunities'), table([{ h: 'Customer', f: x => x.name }, { h: 'Ctry', f: x => x.country }, { h: 'Buys', f: x => x.has }, { h: 'Not yet', f: x => x.missing }, { h: 'Their PO value', num: 1, f: x => money(x.value) }], r.topOpportunities)));
    } else {
      const r = await api('/analytics/dedup-impact' + qs({ ...S.f, days }));
      c = h('div', {}, r.sameTotals ? h('div', { class: 'note good' }, `Same underlying data: ${n0(r.raw.pos)} POs and ${moneyFull(r.raw.value)} in both views. Only the customer identity changes.`) : h('div', { class: 'note bad' }, 'Totals differ between raw and deduplicated — investigate.'),
        h('div', { class: 'grid g4' }, kpi('Master records', `${n0(r.masterRecords.raw)} → ${n0(r.masterRecords.dedup)}`, `${n0(r.masterRecords.raw - r.masterRecords.dedup)} duplicate records collapsed`), kpi('Customers with POs', `${n0(r.raw.activeCustomers)} → ${n0(r.dedup.activeCustomers)}`, 'raw → deduplicated'),
          kpi('Drop-off rate', `${pct(r.dropOff.raw.dropRate)} → ${pct(r.dropOff.dedup.dropRate)}`, `${r.dropOff.raw.dropped} → ${r.dropOff.dedup.dropped} “dropped” (${r.dropOff.raw.dropped - r.dropOff.dedup.dropped} were duplicates of customers still buying)`),
          kpi('Cross-sell whitespace (C)', `${r.crossSell.raw.whitespace.C} → ${r.crossSell.dedup.whitespace.C}`, 'customers never buying product C')),
        h('div', { class: 'card' }, h('h2', {}, 'By country'), table([{ h: 'Country', f: x => x.country }, { h: 'Master (raw)', num: 1, f: x => x.rawMaster }, { h: 'Master (dedup)', num: 1, f: x => x.dedupMaster }, { h: 'Buying (raw)', num: 1, f: x => x.rawCustomers }, { h: 'Buying (dedup)', num: 1, f: x => x.dedupCustomers }], r.byCountry)),
        h('div', { class: 'card' }, h('h2', {}, 'Cross-sell detail'), table([{ h: 'View', f: x => x[0] }, { h: 'Customers', num: 1, f: x => x[1].customers }, { h: 'All 3 products', num: 1, f: x => x[1].buyAll3 }, { h: 'Single-product', num: 1, f: x => x[1].singleProduct }, { h: 'Never A', num: 1, f: x => x[1].whitespace.A }, { h: 'Never B', num: 1, f: x => x[1].whitespace.B }, { h: 'Never C', num: 1, f: x => x[1].whitespace.C }], [['Raw', r.crossSell.raw], ['Deduplicated', r.crossSell.dedup]])));
    }
    body.replaceChildren(c);
  };
  const top = h('div', {});
  const drawTop = () => top.replaceChildren(filterBar(() => { drawTop(); draw(); }, { basis: (S.tab.an || 'customers') !== 'impact' }), seg(analyticsTabs, S.tab.an || 'customers', v => { S.tab.an = v; drawTop(); draw(); }));
  el.append(h('h1', {}, 'Regional analytics'), h('p', { class: 'sub' }, 'Customer, product, drop-off and cross-sell views, computed from PO rows. Toggle raw vs deduplicated customer identity.'), top, h('div', { style: 'height:12px' }), body);
  drawTop(); await draw();
};

pages.forecast = async el => {
  const metric = S.tab.fm || 'value';
  const identityCompare = metric === 'customers';
  const common = { country: S.f.country, product: S.f.product, entity: S.f.entity, metric };
  const [r, sum, rawCustomers] = identityCompare
    ? await Promise.all([api('/forecast' + qs({ ...common, basis: 'dedup' })), api('/forecast/summary' + qs({ metric: 'value' })), api('/forecast' + qs({ ...common, basis: 'raw' }))])
    : [...await Promise.all([api('/forecast' + qs(common)), api('/forecast/summary' + qs({ metric }))]), null];
  const fmt = metric === 'value' ? money : n0;
  const hist = r.history, all = [...hist.map(x => x.month), ...(r.forecast ? r.forecast.months : [])];
  const pad = a => [...a, ...Array(all.length - a.length).fill(null)];
  const nH = hist.length, nBt = r.backtest ? r.backtest.testMonths.length : 0;
  const series = [{ name: 'Actual', color: 'var(--s1)', values: pad(hist.map(x => x.value)) }];
  if (identityCompare) {
    series.splice(0, 1,
      { name: 'Raw active customers', color: 'var(--s1)', values: pad(rawCustomers.history.map(x => x.value)) },
      { name: 'Deduplicated active customers', color: 'var(--s3)', values: pad(hist.map(x => x.value)) });
    for (const [data, name, color] of [[rawCustomers, 'Raw', 'var(--s2)'], [r, 'Deduplicated', 'var(--s4)']]) {
      if (!data.forecast) continue;
      const chosen = data.forecast.selectedByBacktest;
      const values = chosen === 'seasonal' ? data.forecast.seasonal : data.forecast.rolling;
      if (chosen === 'seasonal' && !values) continue;
      const bridge = Array(data.history.length - 1).fill(null).concat([data.history.at(-1).value]);
      const future = chosen === 'seasonalNaive'
        ? data.forecast.months.map((_, i) => data.history[data.history.length + i - 12]?.value ?? null)
        : values;
      series.push({ name: `${name} forecast (${chosen === 'seasonal' ? 'seasonal' : chosen === 'seasonalNaive' ? 'seasonal naive' : 'rolling'})`, color, dash: '5 4', values: [...bridge, ...future] });
    }
  } else if (r.forecast) {
    const bridge = Array(nH - 1).fill(null).concat([hist.at(-1).value]);
    series.push({ name: 'Rolling-avg forecast', color: 'var(--s2)', dash: '5 4', values: [...bridge, ...r.forecast.rolling] });
    if (r.forecast.seasonal) series.push({ name: 'Seasonal forecast', color: 'var(--s3)', dash: '5 4', values: [...bridge, ...r.forecast.seasonal] });
  }
  const m = x => r.backtest?.metrics.find(k => k.model === x);
  el.append(h('h1', {}, identityCompare ? 'Can we count customers?' : 'Demand forecast'), h('p', { class: 'sub' }, identityCompare ? 'Compare source record counts with golden customer counts. This is the deduplication-sensitive demand signal.' : 'Monthly purchase-order history only. Rolling average = mean of the last 3 months (flat). Seasonal = same month last year × recent level ratio.'),
    h('div', { class: 'filters' }, h('label', {}, 'Country', sel(S.meta.options.countries, S.f.country, v => { S.f.country = v; route(); }, 'All')), h('label', {}, 'Product code', sel(['A', 'B', 'C'], S.f.product, v => { S.f.product = v; route(); }, 'All product codes')),
      h('label', {}, 'Measure', seg([['customers', 'Active customers'], ['value', 'PO value (SGD)'], ['pos', 'PO count']], metric, v => { S.tab.fm = v; route(); }))),
    r.requested24Months ? h('div', { class: 'note warn' }, r.requested24Months) : null, ...(r.notes || []).map(n => h('div', { class: 'note warn' }, n)),
    h('div', { class: 'note' }, r.dedupNote),
    identityCompare ? h('div', { class: 'grid g2' },
      kpi('Raw active-customer growth', rawCustomers.growth ? sgn(rawCustomers.growth.change) : 'n/a', rawCustomers.growth ? `Avg. monthly active identities: ${rawCustomers.growth.prior.toFixed(1)} → ${rawCustomers.growth.recent.toFixed(1)} · ${rawCustomers.growth.priorMonths} vs ${rawCustomers.growth.recentMonths}` : 'Needs six months of history'),
      kpi('Golden-customer growth', r.growth ? sgn(r.growth.change) : 'n/a', r.growth ? `Avg. monthly active identities: ${r.growth.prior.toFixed(1)} → ${r.growth.recent.toFixed(1)} · ${r.growth.priorMonths} vs ${r.growth.recentMonths}` : 'Needs six months of history')) : null,
    h('div', { class: 'card' }, h('h2', {}, `Actual and forecast${r.forecast ? ' (' + r.forecast.months[0] + ' → ' + r.forecast.months.at(-1) + ')' : ''}`), lineChart({ labels: all, series, fmt })),
    r.backtest ? h('div', { class: 'card' }, h('h2', {}, `Backtest: train ${r.backtest.trainMonths} months, hold out ${r.backtest.testMonths.length}`),
      table([{ h: identityCompare ? 'Basis / model' : 'Model', f: x => (identityCompare ? `${x.basis} · ` : '') + ({ rolling: 'Rolling 3-mo average', seasonal: 'Seasonal (last year × level)', seasonalNaive: 'Seasonal naive (last year)' }[x.model]) }, { h: 'WAPE', num: 1, f: x => (x.wape == null ? 'n/a' : pct(x.wape)) }, { h: 'MAPE', num: 1, f: x => (x.mape == null ? 'n/a' : pct(x.mape)) }, { h: '', f: x => (x.model === x.selected ? h('span', { class: 'pill good' }, 'lowest WAPE') : '') }], (identityCompare ? [['raw', rawCustomers], ['deduplicated', r]].flatMap(([basis, data]) => data.backtest.metrics.map(x => ({ ...x, basis, selected: data.forecast?.selectedByBacktest }))) : r.backtest.metrics.map(x => ({ ...x, selected: r.forecast?.selectedByBacktest })))),
      h('h3', {}, 'Holdout months'), table([{ h: 'Month', f: x => x.month }, { h: 'Actual', num: 1, f: x => fmt(x.actual) }, { h: 'Rolling', num: 1, f: x => fmt(x.rolling) }, { h: 'Seasonal', num: 1, f: x => (x.seasonal == null ? '–' : fmt(x.seasonal)) }, { h: 'Seasonal naive', num: 1, f: x => (x.seasonalNaive == null ? '–' : fmt(x.seasonalNaive)) }], r.backtest.rows),
      h('p', { class: 'muted' }, 'WAPE = Σ|actual − forecast| / Σ actual. MAPE = mean of |actual − forecast| / actual. Both computed from the holdout predictions above; with only 3 test points the ranking is not statistically reliable.')) : null,
    !identityCompare ? h('div', { class: 'card' }, h('h2', {}, 'Which model wins where? (same 3-month holdout)'),
      table([{ h: 'Scope', f: x => x.scope }, { h: 'Rolling WAPE', num: 1, f: x => (x.metrics ? pct(x.metrics[0].wape) : 'n/a') }, { h: 'Seasonal WAPE', num: 1, f: x => (x.metrics?.[1].wape == null ? 'n/a' : pct(x.metrics[1].wape)) }, { h: 'Seasonal-naive WAPE', num: 1, f: x => (x.metrics?.[2].wape == null ? 'n/a' : pct(x.metrics[2].wape)) }, { h: 'Best', f: x => x.selected || '–' }], sum),
      h('p', { class: 'muted' }, 'Country-level series have ~15 POs a month, so they are noisy; no single model dominates. Treat forecasts as indicative, and re-run the backtest as more history arrives.')) : null,
    r.forecast ? h('div', { class: 'card' }, h('h2', {}, 'Forecast values'), table([{ h: 'Month', f: (x, i) => x }, { h: 'Rolling', num: 1, f: x => fmt(r.forecast.rolling[r.forecast.months.indexOf(x)]) }, { h: 'Seasonal', num: 1, f: x => (r.forecast.seasonal ? fmt(r.forecast.seasonal[r.forecast.months.indexOf(x)]) : 'n/a') }], r.forecast.months)) : null);
};

pages.sap = async el => {
  const includeImported = !!S.tab.sapImported, includeExported = !!S.tab.sapReexport;
  const options = { includeImported, includeExported };
  const pv = await api('/sap/preview' + qs({ includeImported: includeImported ? '1' : '', includeExported: includeExported ? '1' : '' }));
  const batches = await api('/sap/batches');
  const body = h('div', {});
  const exportList = h('div', {});
  let exportPage = S.tab.sapExportPage || 0;
  const drawExportRows = () => {
    const pageSize = 5, pageCount = Math.max(1, Math.ceil(pv.rows.length / pageSize));
    exportPage = Math.min(exportPage, pageCount - 1);
    const shown = pv.rows.slice(exportPage * pageSize, (exportPage + 1) * pageSize);
    exportList.replaceChildren(h('div', { class: 'pagination' }, h('span', { class: 'muted' }, `Showing ${exportPage * pageSize + 1}–${exportPage * pageSize + shown.length} of ${pv.rows.length} export rows`),
      h('div', { class: 'pagination-actions' }, h('button', { class: 'ghost', disabled: exportPage === 0, onclick: () => { exportPage--; S.tab.sapExportPage = exportPage; drawExportRows(); } }, 'Previous'),
        h('span', { class: 'muted' }, `Page ${exportPage + 1} of ${pageCount}`),
        h('button', { class: 'ghost', disabled: exportPage + 1 >= pageCount, onclick: () => { exportPage++; S.tab.sapExportPage = exportPage; drawExportRows(); } }, 'Next'))),
      table(pv.columns.map(c => ({ h: c, f: r => (c === 'MissingOrToConfirm' ? h('span', { style: 'font-size:11px;color:var(--warn)' }, r[c]) : r[c]) })), shown));
  };
  if (pv.rows.length) drawExportRows();
  const excludedList = h('div', {});
  let excludedTerm = '', excludedPage = S.tab.sapExcludedPage || 0;
  const drawExcluded = () => {
    const q = excludedTerm.trim().toLowerCase();
    const rows = pv.excluded.filter(r => !q || `${r.request_id} ${r.type} ${r.reason}`.toLowerCase().includes(q));
    const pageSize = 5, pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    excludedPage = Math.min(excludedPage, pageCount - 1);
    const shown = rows.slice(excludedPage * pageSize, (excludedPage + 1) * pageSize);
    excludedList.replaceChildren(h('div', { class: 'pagination' }, h('span', { class: 'muted' }, `${rows.length} of ${pv.excluded.length} excluded requests · ${rows.length ? `showing ${excludedPage * pageSize + 1}–${excludedPage * pageSize + shown.length}` : 'no matches'}`),
      h('div', { class: 'pagination-actions' }, h('button', { class: 'ghost', disabled: excludedPage === 0, onclick: () => { excludedPage--; S.tab.sapExcludedPage = excludedPage; drawExcluded(); } }, 'Previous'),
        h('span', { class: 'muted' }, `Page ${excludedPage + 1} of ${pageCount}`),
        h('button', { class: 'ghost', disabled: excludedPage + 1 >= pageCount, onclick: () => { excludedPage++; S.tab.sapExcludedPage = excludedPage; drawExcluded(); } }, 'Next'))),
      table([{ h: 'Request', f: r => r.request_id }, { h: 'Type', f: r => r.type }, { h: 'Why', f: r => r.reason }], shown));
  };
  if (pv.excluded.length) drawExcluded();
  const excludedPanel = pv.excluded.length ? h('div', { class: 'card' }, h('h2', {}, 'Approved but not exportable'),
    h('label', { class: 'exclusion-search' }, 'Search excluded requests', h('input', { type: 'search', placeholder: 'Request ID, type, or reason…', oninput: debounce(e => { excludedTerm = e.target.value; excludedPage = 0; S.tab.sapExcludedPage = excludedPage; drawExcluded(); }) })), excludedList) : null;
  async function gen() {
    try {
      const r = await api('/sap/export', options);
      const blob = new Blob([r.csv], { type: 'text/csv' }), a = h('a', { href: URL.createObjectURL(blob), download: r.fileName });
      document.body.append(a); a.click(); a.remove();
      toast(`${r.fileName}: ${r.rows} rows generated (file only — not imported into SAP B1)`); route();
    } catch (e) { toast(e.message); }
  }
  el.append(h('h1', {}, 'SAP B1 export'), h('p', { class: 'sub' }, 'Business Partner rows from approved or applied create/update requests.'),
    h('div', { class: 'note warn' }, pv.statement + ' Column names follow common B1 Business Partner import fields; confirm them against your own import template.'),
    h('div', { class: 'card' }, h('h2', {}, 'Export options'),
      h('label', { class: 'export-option' }, h('input', { type: 'checkbox', checked: includeImported, onchange: e => { S.tab.sapImported = e.target.checked; route(); } }), 'Include source-imported requests marked applied (use only after confirming they are not already in SAP B1)'),
      h('label', { class: 'export-option' }, h('input', { type: 'checkbox', checked: includeExported, onchange: e => { S.tab.sapReexport = e.target.checked; route(); } }), 'Include requests from previous export batches (re-generate rows)')),
    h('div', { class: 'card' }, h('button', { disabled: !pv.rows.length, onclick: gen }, `Generate CSV (${pv.rows.length} row${pv.rows.length === 1 ? '' : 's'})`), h('span', { class: 'muted' }, 'Previously exported rows are excluded unless selected above.')),
    pv.rows.length ? h('div', { class: 'card' }, h('h2', {}, 'Preview'), exportList) : h('div', { class: 'card' }, 'No exportable rows under the current options. Approve a request or adjust the export options above.'),
    excludedPanel,
    batches.length ? h('div', { class: 'card' }, h('h2', {}, 'Generated files'), table([{ h: '#', f: b => b.id }, { h: 'File', f: b => b.file_name }, { h: 'Rows', num: 1, f: b => b.row_count }, { h: 'When', f: b => b.created_at.replace('T', ' ').slice(0, 16) }, { h: 'Note', f: b => b.note }], batches)) : null, body);
};

pages.data = async el => {
  const [v, fi, cap, pr] = await Promise.all([api('/validate'), api('/findings'), api('/capabilities'), api('/profile')]);
  const m = S.meta;
  const colour = { ok: 'good', warn: 'warn', info: 'info' };
  const panels = {
    source: h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('h2', {}, 'Source'), h('p', {}, h('b', {}, m.source.file), ` · ${n0(m.source.rowCount)} rows · sha256 ${m.source.hash.slice(0, 12)}…`), h('p', { class: 'muted' }, 'Read-only. Never rewritten by the app.'),
        table([{ h: 'Stacked table', f: r => r[0] }, { h: 'Rows', num: 1, f: r => n0(r[1]) }], Object.entries(m.source.tables)),
        h('button', { class: 'ghost', onclick: async () => { const r = await api('/source/refresh', {}); toast(`Refresh: +${r.importResult.requestsAdded} requests, +${r.importResult.auditAdded} audit events (existing rows untouched)`); route(); } }, 'Re-read CSV & import new workflow rows')),
      h('div', { class: 'card' }, h('h2', {}, 'App data (separate from CSV)'), table([{ h: 'Store', f: r => r[0] }, { h: 'Count', num: 1, f: r => r[1] }], [
        ...m.appData.requests.map(r => [`requests (${r.source})`, r.n]), ['new customers created', m.appData.newCustomers], ['field updates applied', m.appData.fieldOverrides], ['canonical (merge) overrides', m.appData.canonicalOverrides], ['deactivated customers', m.appData.inactive]]),
        h('h3', {}, 'Import history'), table([{ h: 'When', f: r => r.at.slice(0, 16).replace('T', ' ') }, { h: 'Requests +', num: 1, f: r => r.requests_added }, { h: 'Audit +', num: 1, f: r => r.audit_added }], m.imports))),
    validation: h('div', { class: 'card' }, h('h2', {}, `Validation (${v.checks.filter(c => c.pass).length}/${v.checks.length} pass)`), table([{ h: '', f: c => h('span', { class: 'pill ' + (c.pass ? 'good' : 'bad') }, c.pass ? 'PASS' : 'FAIL') }, { h: 'Check', f: c => c.name }, { h: 'Detail', f: c => c.detail }], v.checks)),
    findings: h('div', {},
      h('div', { class: 'card' }, h('h2', {}, 'Findings in the data'), table([{ h: '', f: x => h('span', { class: 'pill ' + (colour[x.severity] || '') }, x.severity) }, { h: 'Area', f: x => x.area }, { h: 'Finding', f: x => x.text }], fi)),
      h('div', { class: 'card' }, h('h2', {}, 'What the data can and cannot support'), table([{ h: 'Feature', f: x => x.feature }, { h: 'Status', f: x => h('span', { class: 'pill ' + ({ supported: 'good', partial: 'warn', missing: 'bad' }[x.status] || '') }, x.status) }, { h: 'Basis / gap', f: x => x.basis }], cap))),
    profile: h('div', { class: 'card' }, h('h2', {}, 'Column profile'), ...Object.entries(pr).map(([t, p]) => h('details', {}, h('summary', {}, `${t} — ${n0(p.rows)} rows`), table([{ h: 'Column', f: c => c.name }, { h: 'Non-empty', num: 1, f: c => c.nonEmpty }, { h: 'Missing', num: 1, f: c => c.missing }, { h: 'Unique', num: 1, f: c => c.unique }, { h: 'Sample', f: c => c.sample.join(' | ').slice(0, 80) }], p.columns)))),
  };
  let active = S.tab.data || 'source';
  const controls = h('div', { class: 'filters data-tabs' }), content = h('div', {});
  const drawTabs = () => controls.replaceChildren(seg([['source', 'Source & app'], ['validation', 'Validation'], ['findings', 'Findings & limits'], ['profile', 'Column profile']], active, key => { active = key; S.tab.data = key; drawTabs(); content.replaceChildren(panels[key]); }));
  el.append(h('h1', {}, 'Data & quality'), h('p', { class: 'sub' }, 'What the source CSV contains, what the app derived from it, and what it cannot support.'), controls, content);
  drawTabs();
  content.replaceChildren(panels[active]);
};

// ---------- router ----------
const NAV = [['overview', 'Overview'], ['intake', 'Intake'], ['requests', 'Requests'], ['duplicates', 'Duplicates'], ['analytics', 'Analytics'], ['forecast', 'Forecast'], ['sap', 'SAP B1 export'], ['data', 'Data & quality']];
async function route() {
  const [name, arg] = (location.hash.slice(1) || 'overview').split('/');
  const page = pages[name] ? name : 'overview';
  $('#nav').replaceChildren(...NAV.map(([k, l]) => h('a', { class: k === page ? 'on' : '', onclick: () => (location.hash = '#' + k) }, l)));
  document.querySelector('.drawer')?.remove();
  const el = $('#view');
  el.replaceChildren();
  try { await pages[page](el, arg); } catch (e) { el.append(h('div', { class: 'note bad' }, 'Error: ' + e.message)); console.error(e); }
}
addEventListener('hashchange', route);

(async function init() {
  const th = store.get('theme', '');
  if (th) document.documentElement.dataset.theme = th;
  $('#theme').onclick = () => { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); const nx = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = nx; store.set('theme', nx); route(); };
  S.meta = await api('/meta');
  $('#role').replaceChildren(...S.meta.options.roles.map(r => h('option', { value: r, selected: r === store.get('role') }, r)));
  $('#role').onchange = e => store.set('role', e.target.value);
  $('#actor').value = store.get('actor', '');
  $('#actor').oninput = e => store.set('actor', e.target.value);
  route();
})().catch(e => { document.body.append(h('pre', {}, 'Failed to start: ' + e.message)); });
