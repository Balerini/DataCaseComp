'use strict';
/* Screens added for the multi-domain build: Master data, Intake (all domains), Requests, Inbox, Regional view, Config, SAP export.
   Uses the helpers defined in app.js (h, api, table, kpi, seg, sel, lineChart, ...). */

const domOf = k => S.meta.options.domains.find(d => d.key === k);
const verbLabel = { create: 'Create', update: 'Change', merge: 'Merge duplicates', deactivate: 'Deactivate' };
const fieldLabel = f => (f.label || f.name) + (f.required ? ' *' : '') + (f.sensitive ? ' 🔒' : '');
const srcPill = s => h('span', { class: 'pill ' + ({ csv: 'good', proposed: 'warn', app: 'info', imported: 'good' }[s] || '') }, s === 'proposed' ? 'proposed' : s === 'csv' ? 'from CSV' : s);
const NOTE_SENS = 'Sensitive values (🔒) are masked unless you act as a role allowed to see them and enter a user id; every reveal is logged.';

function showDrawer(...kids) {
  document.querySelector('.drawer')?.remove();
  const d = h('div', { class: 'drawer' });
  d.append(h('div', { style: 'text-align:right' }, h('button', { class: 'ghost', onclick: () => { d.remove(); if (/^#(requests|master)\//.test(location.hash)) history.replaceState(null, '', '#' + location.hash.slice(1).split('/')[0]); } }, 'Close')), ...kids);
  document.body.append(d);
  return d;
}

const kv = rows => h('div', { class: 'scroll' }, h('table', {}, rows.filter(Boolean).map(([k, v]) => h('tr', {}, h('th', { style: 'width:36%' }, k), h('td', {}, v)))));

// ---------------- Master data ----------------
pages.master = async (el, arg) => {
  const dkey = S.tab.md || 'customer';
  const f = { q: '', country: '', entity: '' };
  const summary = await api('/master/summary');
  const listBox = h('div', {});
  const draw = async () => {
    const r = await api(`/master/${dkey}` + qs({ ...f, limit: 100 }));
    const d = domOf(dkey), keyFields = d.fields.filter(x => !x.sensitive && !['name', 'entity', 'country', 'customer_id'].includes(x.name)).slice(0, 3);
    const cols = dkey === 'customer'
      ? [{ h: 'ID', f: x => x.id }, { h: 'Name', f: x => x.name }, { h: 'Entity', f: x => x.entity }, { h: 'Ctry', f: x => x.country }, { h: 'Reg. no.', f: x => x.uen || '–' }, { h: 'Address', f: x => x.address },
        { h: 'Golden', f: x => x.golden_id + (x.is_survivor ? ' ★' : '') }, { h: '', f: x => h('span', {}, x.origin === 'app' ? h('span', { class: 'pill info' }, 'new') : null, x.modified ? h('span', { class: 'pill warn' }, 'edited') : null, !x.active ? h('span', { class: 'pill bad' }, 'inactive') : null) }]
      : [{ h: 'ID', f: x => x.id }, { h: 'Name', f: x => x.name }, { h: 'Entity', f: x => x.entity || '–' }, { h: 'Ctry', f: x => x.country || '–' },
        ...keyFields.map(k => ({ h: k.label || k.name, f: x => x.data[k.name] ?? '–' })), { h: '', f: x => h('span', {}, srcPill(x.origin), !x.active ? h('span', { class: 'pill bad' }, 'inactive') : null) }];
    listBox.replaceChildren(h('p', { class: 'muted' }, `${r.total} record(s)${r.total > 100 ? ' (first 100 shown — refine the search)' : ''}`),
      r.rows.length ? table(cols, r.rows, { onRow: x => (location.hash = `#master/${dkey}:${x.id}`) })
        : h('div', { class: 'note' }, dkey === 'customer' ? 'No customers match.' : `No ${d.label.toLowerCase()} records yet. The source CSV has none; records are created through requests.`));
  };
  const d0 = domOf(dkey);
  el.append(h('h1', {}, 'Master data'), h('p', { class: 'sub' }, 'The working master tables in the database. Customers, golden ids, purchase orders and items were imported from the CSV; anything created or changed afterwards is tagged and traceable.'),
    h('div', { class: 'grid g4' }, summary.map(s => h('div', { class: 'card kpi', style: 'cursor:pointer', onclick: () => { S.tab.md = s.key; route(); } },
      h('div', { class: 'l' }, s.label + 's'), h('div', { class: 'v' }, n0(s.count)), h('div', { class: 'n' }, `${s.imported} imported · ${s.created} created in app`)))),
    h('div', { class: 'filters' }, seg(summary.map(s => [s.key, s.label]), dkey, v => { S.tab.md = v; route(); }),
      h('label', {}, 'Search', h('input', { placeholder: 'id, name, registration, address…', oninput: debounce(e => { f.q = e.target.value; draw(); }) })),
      dkey === 'customer' || d0.fields.some(x => x.name === 'country') ? h('label', {}, 'Country', sel(S.meta.options.countries, '', v => { f.country = v; draw(); }, 'All')) : null,
      d0.fields.some(x => x.name === 'entity') ? h('label', {}, 'Entity', sel(S.meta.options.entities, '', v => { f.entity = v; draw(); }, 'All')) : null,
      S.me.can.can_request ? h('button', { onclick: () => { S.intakeDomain = dkey; location.hash = '#intake'; } }, `New ${d0.label.toLowerCase()} request`) : null), listBox);
  await draw();
  if (arg) { const [dk, id] = arg.split(':'); openMasterDrawer(dk, id); }
};

async function openMasterDrawer(dk, id) {
  const d = domOf(dk);
  const r = await api(dk === 'customer' ? `/master/customer/${encodeURIComponent(id)}` : `/master/${dk}/${encodeURIComponent(id)}`);
  const reqs = r.requests.length ? table([{ h: 'Request', f: x => h('a', { href: '#requests/' + x.request_id }, x.request_id) }, { h: 'Type', f: x => x.request_type.replace(/_/g, ' ') }, { h: 'Status', f: x => statusPill(x.status) }, { h: 'Created', f: x => x.created_at.replace('T', ' ') }], r.requests) : h('p', { class: 'muted' }, 'No requests.');
  if (dk === 'customer') {
    const changed = k => (r.original[k] || '') !== (r[k] || '');
    showDrawer(h('h1', {}, r.name), h('p', {}, srcPill(r.origin === 'app' ? 'app' : 'imported'), ' ', r.active ? h('span', { class: 'pill good' }, 'active') : h('span', { class: 'pill bad' }, 'inactive')),
      kv([['Customer ID', r.id], ['Entity / country', `${r.entity} / ${r.country}`], ['Registration no.', r.uen || '–'], ['Address', r.address], ['Golden customer', r.golden_id + (r.is_survivor ? ' (survivor)' : '')],
        ...['name', 'uen', 'address'].filter(changed).map(k => [`Original ${k} (CSV)`, r.original[k] || '–'])]),
      Object.keys(r.extra || {}).length ? h('div', {}, h('h3', {}, 'Sensitive / extra fields'), kv(Object.entries(r.extra)), h('p', { class: 'muted', style: 'font-size:12px' }, NOTE_SENS)) : null,
      h('h3', {}, `Items this customer buys (${r.items.length})`),
      r.items.length ? table([{ h: 'Item', f: x => `${x.item_code} – ${x.item_name || ''}` }, { h: 'POs', num: 1, f: x => x.po_count }, { h: 'Units', num: 1, f: x => n0(x.qty) }, { h: 'Value', num: 1, f: x => moneyFull(x.value) }, { h: 'First PO', f: x => x.first_po }, { h: 'Last PO', f: x => x.last_po }], r.items) : h('p', { class: 'muted' }, 'No purchase orders for this record.'),
      r.groupMembers.length > 1 ? h('div', {}, h('h3', {}, `All records of ${r.golden_id} (${r.groupMembers.length}) – items combined`),
        table([{ h: 'Item', f: x => x.item_code }, { h: 'POs', num: 1, f: x => x.po_count }, { h: 'Units', num: 1, f: x => n0(x.qty) }, { h: 'Value', num: 1, f: x => moneyFull(x.value) }], r.groupItems),
        table([{ h: 'ID', f: x => h('a', { href: `#master/customer:${x.id}` }, x.id) }, { h: 'Name', f: x => x.name }, { h: 'Entity', f: x => x.entity }, { h: 'Reg. no.', f: x => x.uen || '–' }], r.groupMembers)) : null,
      h('h3', {}, 'Requests touching this record'), reqs);
  } else {
    showDrawer(h('h1', {}, r.name || r.id), h('p', {}, srcPill(r.origin), ' ', r.active ? h('span', { class: 'pill good' }, 'active') : h('span', { class: 'pill bad' }, 'inactive')),
      kv([['ID', r.id], r.entity ? ['Entity', r.entity] : null, r.country ? ['Country', r.country] : null, ...d.fields.filter(f => r.data[f.name] != null && f.name !== 'name').map(f => [fieldLabel(f), String(r.data[f.name])])]),
      d.fields.some(f => f.sensitive) ? h('p', { class: 'muted', style: 'font-size:12px' }, NOTE_SENS) : null,
      r.customers?.length ? h('div', {}, h('h3', {}, `Customers buying this item (${r.customers.length})`), table([{ h: 'Customer', f: x => h('a', { href: `#master/customer:${x.customer_id}` }, x.name) }, { h: 'Ctry', f: x => x.country }, { h: 'POs', num: 1, f: x => x.po_count }, { h: 'Units', num: 1, f: x => n0(x.qty) }, { h: 'Value', num: 1, f: x => money(x.value) }, { h: 'Last PO', f: x => x.last_po }], r.customers)) : null,
      h('h3', {}, 'Requests touching this record'), reqs);
  }
}

// ---------------- Intake (all domains) ----------------
pages.intake = async el => {
  const o = S.meta.options;
  const pre = S.prefill; S.prefill = null;
  const F = { domain: S.intakeDomain || 'customer', verb: 'create', values: {}, target: null, field: '', new_value: '', merge_ids: [], reason: '', dup_note: '', dup_ack: false, from: null };
  S.intakeDomain = null;
  if (pre) {
    const m = /^(create|update|merge|deactivate)_(\w+)$/.exec(pre.request_type || '');
    if (m) { F.verb = m[1]; F.domain = m[2]; F.from = pre.from; const p = pre.prefill || {};
      F.values = m[1] === 'create' ? { ...p } : {}; F.field = p.field || ''; F.new_value = p.new_value || ''; F.reason = p.reason || '';
      if (p.target_customer_id) { try { F.target = await api(`/master/${F.domain}/${p.target_customer_id}`.replace('/customer/', '/customer/')); F.target.id = F.target.id || p.target_customer_id; F.merge_ids = [F.target.id]; } catch { /* leave unselected */ } } }
  }
  let last = null, token = 0, touched = false;
  const formBox = h('div', { class: 'card' }), side = h('div', {}), submitRow = h('div', { class: 'card' });
  const type = () => `${F.verb}_${F.domain}`;
  const body = (submit = true) => ({ request_type: type(), ...F.values, target_customer_id: F.target?.id, field: F.field, new_value: F.new_value, merge_ids: F.merge_ids, reason: F.reason,
    submit, duplicate_ack: F.dup_ack ? 'not_duplicate' : undefined, duplicate_note: F.dup_note });
  const run = debounce(async () => {
    const my = ++token;
    try { last = await api('/intake/preview', body()); } catch (e) { last = { errors: { _: e.message }, duplicates: [], route: null }; }
    if (my === token) drawSide();
  }, 250);

  const input = (f, get, set) => {
    const wrap = h('label', { class: f.long ? 'full' : '' }, fieldLabel(f), f.options
      ? sel(f.options, get() || '', v => { set(v); run(); }, 'Select…')
      : f.name === 'address' ? h('textarea', { rows: 2, value: get() || '', oninput: e => { set(e.target.value); run(); } })
        : h('input', { value: get() || '', autocomplete: 'off', type: f.sensitive ? 'password' : 'text', placeholder: f.description || '', oninput: e => { set(e.target.value); run(); } }),
      h('span', { class: 'err', id: 'e_' + f.name }));
    return wrap;
  };

  const picker = () => {
    const res = h('div', {}), inp = h('input', { placeholder: 'Search id / name / registration…', oninput: debounce(async e => {
      const r = await api(`/master/${F.domain}` + qs({ q: e.target.value, limit: 8 }));
      res.replaceChildren(table([{ h: 'ID', f: c => c.id }, { h: 'Name', f: c => c.name }, { h: 'Ctry', f: c => c.country || '–' }, F.domain === 'customer' ? { h: 'Golden', f: c => c.golden_id } : { h: 'Entity', f: c => c.entity || '–' }], r.rows,
        { onRow: c => { F.target = c; F.merge_ids = [c.id]; if (F.verb === 'update') F.field = F.field || ''; run(); drawForm(); } }));
    }) });
    return h('div', { class: 'full' }, h('label', {}, `${domOf(F.domain).label} *`, inp), h('span', { class: 'err', id: 'e_target_customer_id' }),
      F.target ? h('div', { class: 'note' }, `Selected: ${F.target.id} · ${F.target.name}${F.target.entity ? ' · ' + F.target.entity : ''}${F.target.country ? '/' + F.target.country : ''}`) : null, res);
  };

  const mergeBox = h('div', { class: 'full' });
  const mergePicker = () => {
    if (!F.target) return h('p', { class: 'muted full' }, 'Select the first record, then tick the records to merge into it.');
    (async () => {
      const g = await api('/master/customer/' + F.target.id);
      const cands = await api('/duplicates/check', { name: g.name, uen: g.uen, address: g.address, country: g.country, entity: g.entity });
      const list = [...g.groupMembers.filter(m => m.id !== F.target.id).map(m => ({ ...m, why: 'same golden id ' + g.golden_id })), ...cands.duplicates.filter(x => x.id !== F.target.id && !g.groupMembers.some(m => m.id === x.id)).map(x => ({ ...x, why: `matcher ${pct(x.score, 0)} (${x.class})` }))];
      mergeBox.replaceChildren(h('label', {}, 'Merge these records into ' + F.target.id + ' (same country only)'), list.length ? list.map(m => h('label', { style: 'flex-direction:row;gap:8px;align-items:center' },
        h('input', { type: 'checkbox', checked: F.merge_ids.includes(m.id), onchange: e => { F.merge_ids = e.target.checked ? [...F.merge_ids, m.id] : F.merge_ids.filter(x => x !== m.id); run(); } }),
        `${m.id} · ${m.name} · ${m.entity}/${m.country} — ${m.why}`)) : h('p', { class: 'muted' }, 'No candidate records found.'));
    })();
    return mergeBox;
  };

  const drawForm = () => {
    const d = domOf(F.domain), fields = d.fields.filter(f => f.name !== 'customer_id'), kids = [];
    kids.push(h('label', {}, 'Data domain', sel(o.domains.map(x => [x.key, x.label]), F.domain, v => { F.domain = v; F.verb = 'create'; F.values = {}; F.target = null; F.merge_ids = []; F.field = ''; run(); drawForm(); })),
      h('label', {}, 'What do you need?', sel(d.requestTypes.map(t => [t.split('_')[0], verbLabel[t.split('_')[0]]]), F.verb, v => { F.verb = v; F.target = null; F.merge_ids = []; run(); drawForm(); })));
    if (F.verb === 'create') fields.forEach(f => kids.push(input({ ...f, long: ['address', 'name'].includes(f.name) }, () => F.values[f.name], v => { F.values[f.name] = v; })));
    else {
      kids.push(picker());
      if (F.verb === 'update') {
        const ef = fields.filter(f => f.editable), cur = ef.find(f => f.name === F.field);
        kids.push(h('label', {}, 'Field to change', sel(ef.map(f => [f.name, (f.label || f.name) + (f.sensitive ? ' 🔒' : '')]), F.field, v => { F.field = v; F.new_value = ''; run(); drawForm(); }, 'Select…')), h('span', { class: 'err', id: 'e_field' }));
        if (cur) kids.push(input({ ...cur, name: 'new_value', label: 'New value', long: true }, () => F.new_value, v => { F.new_value = v; }));
      }
      if (F.verb === 'merge') kids.push(mergePicker());
      if (F.verb === 'deactivate') kids.push(input({ name: 'reason', label: 'Reason', required: true, long: true }, () => F.reason, v => { F.reason = v; }));
    }
    formBox.replaceChildren(h('h2', {}, 'New master-data request'), F.from ? h('div', { class: 'note' }, `Pre-filled from inbox message ${F.from}. Check every field before submitting.`) : null, h('div', { class: 'form' }, kids));
    drawErrors();
  };
  const drawErrors = () => { for (const [k, v] of Object.entries(last?.errors || {})) { const n = $('#e_' + k); if (n && (touched || F.values[k] || k === 'new_value' && F.new_value)) n.textContent = v; } };
  const drawSide = () => {
    drawErrors();
    const d = last, nodes = [];
    if (d?.route) nodes.push(h('div', { class: 'card' }, h('h2', {}, 'Approval route'),
      d.route.steps.length ? h('div', { class: 'steps' }, d.route.steps.flatMap((st, i) => [i ? '›' : null, h('span', { class: 'step', title: `${st.rule_id}: ${st.note || ''} · SLA ${st.sla_hours}h` }, `${st.role} · ${st.sla_hours}h`)])) : h('p', { class: 'muted' }, 'No rule matched.'),
      d.route.context.openPoValueSgd != null ? h('p', { class: 'muted', style: 'font-size:12px' }, `Open-PO value proxy (POs in last ${d.route.openPoWindowDays} days): ${moneyFull(d.route.context.openPoValueSgd)} — the source has no PO status, so R07 uses this proxy.`) : null));
    if (d?.duplicates?.length) nodes.push(h('div', { class: 'card' }, h('h2', {}, 'Possible existing records'),
      d.duplicates.map(c => h('div', { class: 'cand ' + c.class }, h('div', {}, h('b', {}, c.name), ' ', h('span', { class: 'pill ' + (c.class === 'duplicate' ? 'bad' : 'warn') }, `${c.class} · ${pct(c.score, 0)}`)),
        h('div', { class: 'muted' }, `${c.id} · ${c.entity || ''}${c.country ? '/' + c.country : ''}${c.uen ? ' · ' + c.uen : ''}${c.golden_id ? ' · ' + c.golden_id : ''}${c.origin === 'app' ? ' · created in app' : ''}`), c.address ? h('div', { class: 'muted' }, c.address) : null,
        h('div', { style: 'font-size:12px;margin-top:4px' }, c.reasons.join(' · '))))));
    else if (d && F.verb === 'create' && (F.values.name || F.values.item_code)) nodes.push(h('div', { class: 'note good' }, 'No similar record found in the master data.'));
    side.replaceChildren(...nodes);
    if (F.verb === 'create' && (d?.duplicates || []).some(c => c.class === 'duplicate'))
      side.append(h('div', { class: 'card' }, h('div', { class: 'note bad' }, 'A likely duplicate exists. Do not create a new record unless this is genuinely a different one.'),
        h('label', { style: 'flex-direction:row;gap:8px;align-items:center' }, h('input', { type: 'checkbox', checked: F.dup_ack, onchange: e => { F.dup_ack = e.target.checked; } }), 'I confirm this is a different record'),
        h('label', {}, 'Why is it different? *', h('input', { value: F.dup_note, oninput: e => { F.dup_note = e.target.value; } }))));
  };
  async function go(submit) {
    touched = true;
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
  submitRow.append(h('button', { onclick: () => go(true) }, 'Submit for approval'), ' ', h('button', { class: 'ghost', onclick: () => go(false) }, 'Save as draft'),
    h('p', { class: 'muted', style: 'font-size:12px' }, 'Required fields, formats and allowed values come from the domain configuration (Config). Incomplete or duplicate requests are stopped here and never reach an approver.'));
  el.append(h('h1', {}, 'Intake'), h('p', { class: 'sub' }, 'One form for every domain — customer, item, vendor, cost center — driven by configuration. Duplicates are checked before submission and the approval route is shown up front.'),
    h('div', { class: 'grid g2' }, h('div', {}, formBox, submitRow), side));
  drawForm(); run();
};

// ---------------- Inbox triage ----------------
pages.inbox = async el => {
  const label = S.tab.ib || '';
  const r = await api('/inbox' + qs({ label, limit: 80 }));
  const s = r.summary, ex = s.extraction, labels = ['PO', 'enquiry', 'follow-up', 'MDM request'];
  const names = { PO: 'Order', enquiry: 'Enquiry', 'follow-up': 'Follow-up', 'MDM request': 'MDM setup request' };
  const tone = { PO: 'good', enquiry: 'info', 'follow-up': 'warn', 'MDM request': 'bad' };
  el.append(h('h1', {}, 'Inbox triage'), h('p', { class: 'sub' }, 'Customer emails are sorted into actionable orders, enquiries, follow-ups and master-data setup requests. Only confirmed orders (purchase_orders) count as demand; MDM requests become intake requests.'),
    h('div', { class: 'grid g4' }, kpi('Messages triaged', n0(s.total), 'inbox_messages in the database'), kpi('Agreement with provided labels', pct(s.accuracy), 'Messages are templated, so real-world accuracy will be lower'),
      kpi('MDM requests understood', `${ex.mdmTargetResolved} of ${ex.mdmTotal}`, 'target customer identified or new customer parsed'), kpi('Order emails naming a customer', `${ex.orderCustomerResolved} of ${ex.orderTotal}`, `${ex.orderTotal - ex.orderCustomerResolved} need a human to identify the customer`)),
    h('div', { class: 'grid g2' }, h('div', { class: 'card' }, h('h2', {}, 'Accuracy by class'), table([{ h: 'Class', f: x => names[x.label] }, { h: 'Labelled', num: 1, f: x => x.actual }, { h: 'Predicted', num: 1, f: x => x.predicted }, { h: 'Precision', num: 1, f: x => pct(x.precision, 0) }, { h: 'Recall', num: 1, f: x => pct(x.recall, 0) }], s.perClass)),
      h('div', { class: 'card' }, h('h2', {}, 'Follow-ups quoting a PO number'), h('p', {}, `${ex.followUpPoFound} of ${ex.followUpPoRefs} quoted PO numbers exist in the purchase-order table, so the status can be answered from data instead of by email.`), h('p', { class: 'muted' }, 'Rules, not a language model: each decision shows the phrase it matched. A model would be the next step for free-text emails.'))),
    h('div', { class: 'filters' }, seg([['', 'All'], ...labels.map(l => [l, names[l]])], label, v => { S.tab.ib = v; route(); })),
    h('div', { class: 'card' }, table([{ h: 'Received', f: x => x.received_at.replace('T', ' ') }, { h: 'From', f: x => x.from_email },
      { h: 'Message', f: x => h('span', { style: 'font-size:12px' }, x.text.slice(0, 150)) },
      { h: 'Class', f: x => h('span', {}, h('span', { class: 'pill ' + (tone[x.predicted] || '') }, names[x.predicted] || x.predicted), x.correct ? null : h('span', { class: 'pill bad', title: 'labelled ' + x.true_label }, 'label differs')) },
      { h: 'What the app found', f: x => x.order ? h('span', { style: 'font-size:12px' }, `${x.order.units} units (${x.order.lines.map(l => `${l.qty}×${l.product || '?'}`).join(', ')}) · ` + (x.order.customer ? x.order.customer.name : 'customer not identified'))
        : x.mdm ? h('span', { style: 'font-size:12px' }, `${x.mdm.kind.replace('_', ' ')} · ` + (x.mdm.customer ? `${x.mdm.customer.customer_id} ${x.mdm.customer.name}` : x.mdm.kind === 'create' ? 'new customer' : 'customer not found'))
          : x.followUp ? h('span', { style: 'font-size:12px' }, x.followUp.poRef ? `${x.followUp.poRef} ${x.followUp.poFound ? 'found: ' + x.followUp.po.date + ', ' + moneyFull(x.followUp.po.value) : 'not found'}` : x.followUp.topic) : '' },
      { h: '', f: x => (x.mdm?.request_type ? h('button', { class: 'ghost', onclick: () => { S.prefill = { request_type: x.mdm.request_type, prefill: x.mdm.prefill, from: x.msg_id }; location.hash = '#intake'; } }, 'Create request') : '') }], r.items),
    h('p', { class: 'muted' }, `Showing ${r.items.length} of ${r.total}.`)));
};

// ---------------- Regional business view ----------------
pages.regional = async el => {
  const period = Number(S.tab.rp || 6);
  const [mx, ov, acts, fc, di, tri] = await Promise.all([api('/analytics/matrix?period=' + period), api('/analytics/orders-vs-mdm'), api('/analytics/actions'), api('/forecast'), api('/analytics/dedup-impact'), api('/analytics/triage-summary')]);
  const gcell = c => (c.growth == null ? '–' : `${c.growth >= 0 ? '▲' : '▼'} ${(Math.abs(c.growth) * 100).toFixed(1)}%`);
  const gstyle = c => (c.growth == null ? '' : `color:var(--${c.growth >= 0 ? 'good' : 'bad'})`);
  const cell = c => h('td', { class: 'num' }, h('div', {}, money(c.value)), h('div', { style: 'font-size:11px;' + gstyle(c) }, gcell(c)), h('div', { class: 'muted', style: 'font-size:11px' }, `${c.pos} POs`));
  const labels = ov.byMonth.map(m => m.month);
  const seasonal = fc.backtest?.metrics.find(m => m.model === 'seasonal'), rolling = fc.backtest?.metrics.find(m => m.model === 'rolling');
  el.append(h('h1', {}, 'Regional business view'), h('p', { class: 'sub' }, `Customer orders for Products A, B and C across the five countries, ${mx.window}.`),
    h('div', { class: 'filters' }, h('label', {}, 'Period', seg([[6, 'Last 6 months'], [9, 'Last 9 months']].filter(x => x[0] <= mx.maxPeriod || x[0] === 6), period, v => { S.tab.rp = v; route(); }))),
    h('div', { class: 'note' }, mx.definition),
    h('div', { class: 'card scroll' }, h('h2', {}, `PO value and growth by country × product (${mx.window} vs ${mx.vs})`),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Country'), ['A', 'B', 'C'].map(p => h('th', { class: 'num' }, 'Product ' + p)), h('th', { class: 'num' }, 'All products'))),
        h('tbody', {}, mx.rows.map(r => h('tr', {}, h('td', {}, `${r.country} – ${COUNTRY_NAME[r.country]}`), ['A', 'B', 'C'].map(p => cell(r.products[p])), cell(r.total))),
          h('tr', {}, h('th', {}, 'All countries'), ['A', 'B', 'C'].map(p => cell(mx.totalsByProduct[p])), cell(mx.total))))),
    h('div', { class: 'card' }, h('h2', {}, 'Orders vs MDM setup requests'),
      h('p', { class: 'muted' }, `${ov.definition.orders} ${ov.definition.mdmRequests}`),
      lineChart({ labels, series: [{ name: 'Confirmed orders (POs)', color: 'var(--s1)', values: ov.byMonth.map(m => m.orders), fmt: n0 }], fmt: n0, height: 200 }),
      h('h3', {}, 'Inbound messages and MDM requests per month'),
      lineChart({ labels, series: [{ name: 'Order emails', color: 'var(--s3)', values: ov.byMonth.map(m => m.msgOrder), fmt: n0 }, { name: 'Enquiries', color: 'var(--s4)', values: ov.byMonth.map(m => m.msgEnquiry), fmt: n0 }, { name: 'Follow-ups', color: 'var(--s5)', values: ov.byMonth.map(m => m.msgFollowUp), fmt: n0 }, { name: 'MDM emails', color: 'var(--s2)', values: ov.byMonth.map(m => m.msgMdm), fmt: n0 }, { name: 'MDM requests raised', color: 'var(--ink-3)', dash: '4 3', values: ov.byMonth.map(m => m.mdmRequests), fmt: n0 }], fmt: n0, height: 200 }),
      h('p', { class: 'muted', style: 'font-size:12px' }, ov.note),
      table([{ h: 'Country', f: r => r.country }, { h: 'Orders', num: 1, f: r => n0(r.orders) }, { h: 'Order value', num: 1, f: r => money(r.orderValue) }, { h: 'MDM requests', num: 1, f: r => r.mdmRequests }], ov.byCountry)),
    h('div', { class: 'card' }, h('h2', {}, 'What data science adds'),
      h('div', { class: 'grid g2' },
        h('div', {}, h('b', {}, 'Better forecast'), h('p', {}, rolling && seasonal ? `Seasonal model: WAPE ${pct(seasonal.wape)} vs ${pct(rolling.wape)} for the rolling-average baseline (3-month holdout, ${fc.backtest.trainMonths} training months).` : 'Not enough history to compare.'), h('p', { class: 'muted' }, 'Wins on total demand, not in every country — see Forecast.')),
        h('div', {}, h('b', {}, 'Clean customer view'), h('p', {}, `${di.masterRecords.raw} customer records are really ${di.masterRecords.dedup}. Raw data flags ${di.dropOff.raw.dropped} lapsed customers; ${di.dropOff.dedup.dropped} after merging duplicates.`), h('p', { class: 'muted' }, 'Same POs, different customer identity.')),
        h('div', {}, h('b', {}, 'Less manual triage'), h('p', {}, `${tri.total} inbound emails sorted into orders, enquiries, follow-ups and MDM requests; MDM emails become pre-filled requests.`), h('p', { class: 'muted' }, `${tri.extraction.orderTotal - tri.extraction.orderCustomerResolved} order emails still need a person to identify the customer.`)),
        h('div', {}, h('b', {}, 'Growth opportunities'), h('p', {}, 'Cross-sell whitespace and lapsed-customer lists are generated per country from deduplicated customers.'), h('p', { class: 'muted' }, 'See the actions below and Analytics.')))),
    h('div', { class: 'card' }, h('h2', {}, 'Recommended actions'), acts.map(a => h('div', { class: 'cand' }, h('div', {}, h('span', { class: 'pill ' + (a.priority === 'high' ? 'bad' : 'warn') }, a.priority), ' ', h('span', { class: 'pill' }, a.area), ' ', h('b', {}, a.action)), h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, a.evidence)))));
};

// ---------------- Config (no-code) ----------------
pages.config = async el => {
  const c = await api('/config');
  const cur = S.tab.cf || c.domains[0].key, d = c.domains.find(x => x.key === cur) || c.domains[0];
  const fld = { domain: d.key, name: '', label: '', data_type: 'string', validation: '', required: false, sensitive: false, match_role: '', sap_field: '', description: '' };
  const rule = { domain: d.key, request_type: `create_${d.key}`, condition: '*', step: 1, approver_role: '', sla_hours: 24, country: '*', notes: '' };
  const save = async (path, b, msg) => { try { await api(path, b); toast(msg); route(); } catch (e) { toast(e.message); } };
  const txt = (o, k, ph, size) => h('input', { value: o[k], placeholder: ph || '', size: size || 14, oninput: e => { o[k] = e.target.value; } });
  const chk = (o, k, label) => h('label', { style: 'flex-direction:row;gap:6px;align-items:center' }, h('input', { type: 'checkbox', checked: o[k], onchange: e => { o[k] = e.target.checked; } }), label);
  const dn = { key: '', label: '', sap_object: '' };
  el.append(h('h1', {}, 'Configuration'), h('p', { class: 'sub' }, 'Add a data domain, change a required field, or add an approval step for a new business unit — here, without IT. Changes apply immediately and are written to the change log.'),
    h('div', { class: 'filters' }, seg(c.domains.map(x => [x.key, x.label]), d.key, v => { S.tab.cf = v; route(); })),
    h('div', { class: 'card scroll' }, h('h2', {}, `${d.label}: fields`), h('p', { class: 'muted', style: 'font-size:12px' }, `SAP object: ${d.sap_object || '—'} · domain source: ${d.source}. 🔒 = sensitive (encrypted at rest, masked by role, never exported).`),
      table([{ h: 'Field', f: f => f.name }, { h: 'Type', f: f => f.data_type }, { h: 'Req.', f: f => (f.required ? 'yes' : '') }, { h: '🔒', f: f => (f.sensitive ? 'yes' : '') }, { h: 'Validation / options', f: f => h('span', { class: 'mono' }, f.validation || '') }, { h: 'Match role', f: f => f.match_role || '' }, { h: 'SAP field', f: f => f.sap_field || '' }, { h: 'Source', f: f => srcPill(f.source) },
        { h: '', f: f => h('span', {}, h('button', { class: 'ghost', onclick: () => save('/config/field', { ...f, required: !f.required }, 'Updated') }, f.required ? 'Make optional' : 'Make required'), ' ', h('button', { class: 'ghost', onclick: () => save('/config/field', { ...f, sensitive: !f.sensitive }, 'Updated') }, f.sensitive ? 'Unmark 🔒' : 'Mark 🔒'), f.source === 'app' ? h('button', { class: 'ghost', onclick: () => save('/config/field/delete', { domain: d.key, name: f.name }, 'Removed') }, 'Remove') : null) }], d.fields),
      h('h3', {}, 'Add a field'), h('div', { class: 'filters' }, h('label', {}, 'Name', txt(fld, 'name', 'e.g. licence_expiry')), h('label', {}, 'Label', txt(fld, 'label')),
        h('label', {}, 'Type', sel(c.dataTypes, 'string', v => { fld.data_type = v; })), h('label', {}, 'Validation (regex) or options A|B|C', txt(fld, 'validation', '^\\d{4}$ or Y|N', 22)),
        h('label', {}, 'Match role', sel(['name', 'registration', 'address', 'country', 'key'], '', v => { fld.match_role = v; }, 'none')), h('label', {}, 'SAP field', txt(fld, 'sap_field', 'e.g. CardName')), chk(fld, 'required', 'Required'), chk(fld, 'sensitive', 'Sensitive 🔒'),
        h('button', { onclick: () => save('/config/field', fld, 'Field saved') }, 'Add field'))),
    h('div', { class: 'card scroll' }, h('h2', {}, `${d.label}: approval rules`), h('p', { class: 'muted', style: 'font-size:12px' }, 'Steps run in ascending order. Conditions: * · field in (a, b) · <field> = <value> · country = ID · entities differ · open_po_value_sgd > 50000.'),
      table([{ h: 'Rule', f: r => r.rule_id }, { h: 'Request type', f: r => r.request_type }, { h: 'Country', f: r => r.country }, { h: 'Condition', f: r => h('span', { class: 'mono' }, r.condition) }, { h: 'Step', num: 1, f: r => r.step }, { h: 'Approver', f: r => r.approver_role }, { h: 'SLA h', num: 1, f: r => r.sla_hours }, { h: 'Source', f: r => srcPill(r.source) },
        { h: '', f: r => h('button', { class: 'ghost', onclick: () => save('/config/rule/toggle', { rule_id: r.rule_id, enabled: !r.enabled }, r.enabled ? 'Rule disabled' : 'Rule enabled') }, r.enabled ? 'Disable' : 'Enable') }], d.rules),
      h('h3', {}, 'Add an approval step'), h('div', { class: 'filters' }, h('label', {}, 'Request type', sel(['create', 'update', 'deactivate'].map(v => `${v}_${d.key}`), rule.request_type, v => { rule.request_type = v; })),
        h('label', {}, 'Condition', txt(rule, 'condition', '*', 22)), h('label', {}, 'Country', txt(rule, 'country', '*', 4)), h('label', {}, 'Step', h('input', { type: 'number', min: 0, max: 9, value: rule.step, style: 'width:60px', oninput: e => { rule.step = Number(e.target.value); } })),
        h('label', {}, 'Approver role', txt(rule, 'approver_role', 'e.g. Regional Director', 20)), h('label', {}, 'SLA hours', h('input', { type: 'number', value: rule.sla_hours, style: 'width:70px', oninput: e => { rule.sla_hours = Number(e.target.value); } })),
        h('label', {}, 'Note', txt(rule, 'notes', '', 20)), h('button', { onclick: () => save('/config/rule', rule, 'Rule saved') }, 'Add step'))),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('h2', {}, 'Add a data domain'), h('p', { class: 'muted', style: 'font-size:12px' }, 'Starts with a name field and a one-step Data Steward route you can then extend.'),
        h('div', { class: 'filters' }, h('label', {}, 'Key', txt(dn, 'key', 'e.g. price_list')), h('label', {}, 'Label', txt(dn, 'label', 'Price list')), h('label', {}, 'SAP object', txt(dn, 'sap_object', 'optional')), h('button', { onclick: () => save('/config/domain', dn, 'Domain added') }, 'Add domain'))),
      h('div', { class: 'card' }, h('h2', {}, 'Who may see sensitive fields'), h('p', { class: 'muted', style: 'font-size:12px' }, 'Roles, comma separated. Reveals are logged with user id and role.'),
        (() => { const s = { v: c.settings.sensitive_view_roles.join(', ') }; return h('div', { class: 'filters' }, h('input', { value: s.v, size: 34, oninput: e => { s.v = e.target.value; } }), h('button', { onclick: () => save('/config/settings', { sensitive_view_roles: s.v.split(',').map(x => x.trim()).filter(Boolean) }, 'Saved') }, 'Save')); })())),
    h('div', { class: 'card scroll' }, h('h2', {}, 'Positions — what each "Acting as" role gets'),
      h('p', { class: 'muted', style: 'font-size:12px' }, 'No individuals are stored: people act as a position. A position decides the views and powers below; the server enforces them. Defined in the seed (src/seed.js); an approval role added in Config with no position gets a plain approver profile.'),
      table([{ h: 'Position', f: x => x.role }, { h: 'Kind', f: x => x.kind }, { h: 'Views', f: x => x.views.join(', ') || '–' },
        { h: 'Can', f: x => ['can_request', 'can_apply', 'can_export', 'can_triage', 'can_config', 'sees_all_requests'].filter(k => x[k]).map(k => k.replace('can_', '').replace('sees_all_requests', 'sees all requests')).join(', ') || '–' }], S.positions.positions),
      h('h3', {}, 'Who performs each approval-rule role'), h('p', { class: 'muted', style: 'font-size:12px' }, 'The CSV approval rules name some roles that are not in the brief’s list. Each is performed by one position; lines marked ASSUMPTION are my mapping, not source data.'),
      table([{ h: 'Role in the rule', f: x => x.rule_role }, { h: 'Performed by', f: x => x.position }, { h: 'Basis', f: x => h('span', { style: 'font-size:12px' }, x.basis || '') }], S.positions.aliases)),
    h('div', { class: 'card' }, h('h2', {}, 'Recent configuration changes'), c.recentChanges.length ? table([{ h: 'When', f: x => x.ts.replace('T', ' ') }, { h: 'By', f: x => x.request_id || '–' }, { h: 'Change', f: x => x.field }, { h: 'Detail', f: x => h('span', { class: 'mono' }, x.new_value) }], c.recentChanges) : h('p', { class: 'muted' }, 'No changes yet.')));
};

// ---------------- SAP B1 export ----------------
pages.sap = async el => {
  const dk = S.tab.sd || 'customer';
  const [pv, batches] = await Promise.all([api('/sap/preview' + qs({ domain: dk })), api('/sap/batches')]);
  async function gen() {
    try {
      const r = await api('/sap/export', { domain: dk });
      const a = h('a', { href: URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })), download: r.fileName });
      document.body.append(a); a.click(); a.remove();
      toast(`${r.fileName}: ${r.rows} rows generated (file only — not imported into SAP B1)`); route();
    } catch (e) { toast(e.message); }
  }
  el.append(h('h1', {}, 'SAP B1 export'), h('p', { class: 'sub' }, 'Rows built from approved or applied requests, using the SAP field mapping in Config. Sensitive fields are never written to the file.'),
    h('div', { class: 'filters' }, seg(S.meta.options.domains.map(d => [d.key, d.label]), dk, v => { S.tab.sd = v; route(); })),
    h('div', { class: 'note warn' }, pv.statement + ' Column names follow common B1 import fields; confirm them against your own import template.'),
    h('div', { class: 'card' }, S.me.can.can_export ? h('button', { disabled: !pv.rows.length, onclick: gen }, `Generate CSV (${pv.rows.length} row${pv.rows.length === 1 ? '' : 's'})`) : h('span', { class: 'muted' }, `${pv.rows.length} row(s) ready. Generating the file is done by the MDM team.`), h('span', { class: 'muted' }, ' Rows already exported are excluded next time.')),
    pv.rows.length ? h('div', { class: 'card' }, h('h2', {}, 'Preview'), table(pv.columns.map(c => ({ h: c, f: r => (c === 'MissingOrToConfirm' ? h('span', { style: 'font-size:11px;color:var(--warn)' }, r[c]) : r[c] ?? '') })), pv.rows)) : h('div', { class: 'card' }, `No approved ${dk.replace('_', ' ')} requests are waiting to be exported. Approve one first.`),
    pv.excluded.length ? h('div', { class: 'card' }, h('h2', {}, 'Approved but not exportable'), table([{ h: 'Request', f: r => r.request_id }, { h: 'Type', f: r => r.type }, { h: 'Why', f: r => r.reason }], pv.excluded)) : null,
    batches.length ? h('div', { class: 'card' }, h('h2', {}, 'Generated files'), table([{ h: '#', f: b => b.id }, { h: 'File', f: b => b.file_name }, { h: 'Rows', num: 1, f: b => b.row_count }, { h: 'When', f: b => b.created_at.replace('T', ' ').slice(0, 16) }, { h: 'Note', f: b => b.note }], batches)) : null);
};
