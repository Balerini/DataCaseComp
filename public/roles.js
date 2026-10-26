'use strict';
/* Position-aware screens: Home (different for every kind of position) and Requests / the request drawer.
   Everything here displays what the server says the signed-in person may see and do (request.can, /api/home);
   hiding a button is a convenience, the server enforces the rule. */

const KIND_LABEL = { requestor: 'Requestor', approver: 'Approver', mdm: 'MDM team', admin: 'IT' };
const waitPill = w => (w ? h('span', { class: 'pill ' + (w.overdue ? 'bad' : 'good'), title: `With the current approver since ${w.since.replace('T', ' ')}` }, `${w.overdue ? '⚠ ' : ''}${w.hours}h of ${w.sla}h SLA`) : '–');
const pathChips = r => h('div', { class: 'steps' }, (r.path_positions || r.path).flatMap((role, i) => {
  const done = r.status === 'approved' || r.status === 'applied' || (r.status === 'pending_approval' && i < r.step_index);
  const cur = r.status === 'pending_approval' && i === r.step_index, bad = r.status === 'rejected' && i === r.step_index;
  return [i ? '›' : null, h('span', { class: 'step ' + (done ? 'done' : cur ? 'cur' : bad ? 'bad' : '') }, (done ? '✓ ' : '') + role)];
}));
const openReq = r => { location.hash = '#requests/' + r.request_id; };
const typeLabel = r => `${r.request_type.replace(/_/g, ' ')}${r.target ? ' · ' + r.target : ''}`;

// ---------------- Home ----------------
pages.home = async el => {
  const home = await api('/home'), me = home.user;
  const reqTable = (items, cols = []) => table([{ h: 'Request', f: r => r.request_id }, { h: 'What', f: typeLabel }, { h: 'Status', f: r => statusPill(r.status) }, ...cols], items, { onRow: openReq });
  const out = [h('h1', {}, me.role), h('p', { class: 'sub' }, `${KIND_LABEL[me.kind] || me.kind}${me.region !== 'ALL' ? ` · region ${me.region}` : ' · all regions'}. ${me.description}`)];

  for (const s of home.sections) {
    if (s.type === 'mine') {
      out.push(h('div', { class: 'card' }, h('h2', {}, s.title),
        h('div', { class: 'grid g4' }, kpi('Waiting for approval', s.counts.pending), kpi('Approved, awaiting SAP entry', s.counts.approved), kpi('Completed', s.counts.applied), kpi('Sent back (rejected)', s.counts.rejected, s.counts.rejected ? 'Open them to see why' : null)),
        s.items.length ? reqTable(s.items, [{ h: 'Where it stands', f: r => (r.status === 'pending_approval' ? pathChips(r) : '–') }, { h: 'With', f: r => r.awaiting || '–' }, { h: 'Waiting', f: r => waitPill(r.waiting) }])
          : h('p', { class: 'muted' }, 'You have not raised any requests yet.'),
        me.can.can_request ? h('p', {}, h('button', { onclick: () => (location.hash = '#intake') }, 'New request')) : null));
    } else if (s.type === 'queue') {
      out.push(h('div', { class: 'card' }, h('h2', {}, `${s.title} — as ${s.position}`),
        h('div', { class: 'grid g4' }, kpi('Waiting for me', s.queue.length), kpi('Past SLA', s.overdue, s.overdue ? 'Needs attention first' : 'Nothing overdue'), kpi('Coming to me later', s.upcoming.length, 'Earlier steps still open'), kpi('My recent decisions', s.decided.length)),
        s.queue.length ? reqTable(s.queue, [{ h: 'Raised by', f: r => r.requested_by }, { h: 'Waiting', f: r => waitPill(r.waiting) }, { h: '', f: r => h('button', { onclick: ev => { ev.stopPropagation(); openReq(r); } }, 'Review') }])
          : h('div', { class: 'note good' }, 'Nothing is waiting for you.'),
        s.sensitive ? h('p', { class: 'muted', style: 'font-size:12px' }, 'Your position may see sensitive fields (bank, credit terms); each reveal is logged.') : h('p', { class: 'muted', style: 'font-size:12px' }, 'Sensitive fields (bank, credit terms) are masked for your position.')));
      if (s.upcoming.length) out.push(h('div', { class: 'card' }, h('h2', {}, 'Coming to me after earlier approvers'), reqTable(s.upcoming, [{ h: 'Now with', f: r => r.awaiting }, { h: 'Waiting', f: r => waitPill(r.waiting) }])));
      if (s.decided.length) out.push(h('div', { class: 'card' }, h('h2', {}, 'My recent decisions'), table([{ h: 'When', f: d => d.ts.replace('T', ' ') }, { h: 'Request', f: d => d.request_id }, { h: 'Decision', f: d => d.action }, { h: 'Now', f: d => statusPill(d.status) }, { h: 'Comment', f: d => d.comment || '' }], s.decided, { onRow: d => (location.hash = '#requests/' + d.request_id) })));
    } else if (s.type === 'apply') {
      const rows = s.exportRows.reduce((a, x) => a + x.rows, 0);
      out.push(h('div', { class: 'card' }, h('h2', {}, s.title),
        h('div', { class: 'grid g4' }, kpi('Approved — ready to apply', s.ready.length), kpi('Open requests', s.pending, s.stuck ? `${s.stuck} past SLA` : 'None past SLA'),
          kpi('SAP export rows ready', rows, s.exportRows.filter(x => x.rows).map(x => `${x.label}: ${x.rows}`).join(' · ') || 'Nothing approved yet'), kpi('Customer emails to act on', s.inbox.mdmEmails, `${s.inbox.orderEmailsUnidentified} order emails name no customer`)),
        s.ready.length ? h('div', {}, h('h3', {}, 'Approved: key into master data'), reqTable(s.ready, [{ h: 'Raised by', f: r => r.requested_by }, { h: '', f: r => h('button', { onclick: ev => { ev.stopPropagation(); openReq(r); } }, 'Open') }])) : h('div', { class: 'note good' }, 'No approved requests are waiting to be applied.'),
        s.oldestPending.length ? h('div', {}, h('h3', {}, 'Longest-waiting open requests'), reqTable(s.oldestPending, [{ h: 'With', f: r => r.awaiting }, { h: 'Waiting', f: r => waitPill(r.waiting) }])) : null,
        h('p', { class: 'muted', style: 'font-size:12px' }, `${s.duplicateGroups} golden customers have more than one source record (see Duplicates).`)));
    } else if (s.type === 'insights') {
      out.push(h('div', { class: 'card' }, h('h2', {}, `${s.title} — ${s.window}`),
        h('div', { class: 'grid g4' }, kpi('PO value, last 6 months', money(s.value), 'vs the same months a year earlier'), kpi('Growth', s.growth == null ? '–' : sgn(s.growth)), ...s.countries.slice(0, 2).map(c => kpi(`${c.country} growth`, c.growth == null ? '–' : sgn(c.growth), money(c.value)))),
        h('h3', {}, 'What to do next'), s.actions.map(a => h('div', { class: 'cand' }, h('b', {}, a.action), h('div', { class: 'muted', style: 'font-size:12px' }, a.evidence))),
        h('p', {}, h('button', { class: 'ghost', onclick: () => (location.hash = '#regional') }, 'Open the regional view'))));
    } else if (s.type === 'admin') {
      out.push(h('div', { class: 'card' }, h('h2', {}, s.title),
        h('div', { class: 'grid g4' }, kpi('Active approval rules', s.rules), kpi('Positions', s.positions)),
        s.recentChanges.length ? table([{ h: 'When', f: x => x.ts.replace('T', ' ') }, { h: 'Change', f: x => x.field }, { h: 'Detail', f: x => h('span', { class: 'mono' }, (x.new_value || '').slice(0, 90)) }], s.recentChanges) : h('p', { class: 'muted' }, 'No configuration changes yet.'),
        h('p', {}, h('button', { class: 'ghost', onclick: () => (location.hash = '#config') }, 'Open configuration'))));
    } else if (s.type === 'sensitive') {
      out.push(h('div', { class: 'card' }, h('h2', {}, s.title), h('p', {}, `${s.reveals7d} sensitive value(s) revealed in the last 7 days.`),
        s.recent.length ? table([{ h: 'When', f: x => x.ts.replace('T', ' ') }, { h: 'Who', f: x => x.role }, { h: 'What', f: x => `${x.domain} ${x.record_id} · ${x.field}` }], s.recent) : null));
    }
  }
  const hidden = ['overview', 'master', 'intake', 'requests', 'inbox', 'duplicates', 'regional', 'analytics', 'forecast', 'sap', 'config', 'data'].filter(v => !me.views.includes(v));
  out.push(h('p', { class: 'muted', style: 'font-size:12px' }, `Your position can open: ${me.views.join(', ')}. Not available to ${me.role}: ${hidden.join(', ') || 'nothing'}.`));
  el.append(...out);
};

// ---------------- Requests ----------------
pages.requests = async (el, arg) => {
  const me = S.me, laneOnly = me.kind === 'approver';
  const f = { status: S.tab.rs || '', type: '', role: '', q: '', domain: S.tab.rd || '', mine: '' };
  S.tab.rv ??= laneOnly ? 'queue' : me.kind === 'requestor' ? 'mine' : 'all';
  const listBox = h('div', {});
  const draw = async () => {
    const view = S.tab.rv;
    const rows = await api('/requests' + qs({ ...f, role: view === 'queue' ? me.role : f.role, mine: view === 'mine' ? '1' : '' }));
    listBox.replaceChildren(h('p', { class: 'muted' }, `${rows.length} request(s)`), table([
      { h: 'Request', f: r => h('span', {}, r.request_id, ' ', r.source === 'app' ? h('span', { class: 'pill info' }, 'new') : null) }, { h: 'Domain', f: r => r.domain }, { h: 'Type', f: r => r.request_type.replace(/_/g, ' ') },
      { h: 'Target', f: r => r.target_customer_id || '–' }, { h: 'Status', f: r => statusPill(r.status) }, { h: 'Awaiting', f: r => r.awaiting_position || '–' }, { h: 'Waiting', f: r => waitPill(r.waiting) },
      { h: 'Raised by', f: r => r.requested_by_label }, { h: 'Created', f: r => r.created_at.replace('T', ' ') }, { h: '', f: r => (r.can?.approve ? h('span', { class: 'pill warn' }, 'your turn') : r.can?.apply ? h('span', { class: 'pill info' }, 'ready to apply') : '') }],
      rows, { onRow: r => (location.hash = '#requests/' + r.request_id) }));
  };
  const views = [...(me.can.can_request ? [['mine', 'Raised by me']] : []), ...(laneOnly || me.kind !== 'requestor' ? [['queue', 'Waiting for my decision']] : []), ['all', me.kind === 'requestor' ? 'Everything I can see' : laneOnly ? 'All in my lane' : 'All requests']];
  if (!views.some(v => v[0] === S.tab.rv)) S.tab.rv = views[0][0];
  const title = me.kind === 'requestor' ? 'My requests' : laneOnly ? 'Requests in my lane' : 'Requests & approvals';
  const sub = me.kind === 'requestor' ? 'Everything you raised, with exactly where it stands and who it is waiting on.'
    : laneOnly ? `You see requests whose approval path includes ${me.role}, plus any you raised or decided. Others are outside your lane.` : 'Every request, where it stands and who it is waiting on.';
  el.append(h('h1', {}, title), h('p', { class: 'sub' }, sub),
    h('div', { class: 'filters' }, seg(views, S.tab.rv, v => { S.tab.rv = v; route(); }),
      h('label', {}, 'Domain', sel(S.meta.options.domains.map(d => [d.key, d.label]), f.domain, v => { f.domain = v; S.tab.rd = v; draw(); }, 'All')),
      h('label', {}, 'Status', sel(['draft', 'pending_approval', 'approved', 'applied', 'rejected'], f.status, v => { f.status = v; S.tab.rs = v; draw(); }, 'Any')),
      h('label', {}, 'Search', h('input', { oninput: debounce(e => { f.q = e.target.value; draw(); }) }))), listBox);
  await draw();
  if (arg) openDrawer(arg, draw);
};

async function openDrawer(id, refresh) {
  const d = showDrawer();
  const draw = async () => {
    let r;
    try { r = await api('/requests/' + id); } catch (e) { d.append(h('div', { class: 'note bad' }, e.message)); return; }
    const p = r.payload || {}, dom = domOf(r.domain), verb = r.request_type.split('_')[0], can = r.can || {}, me = S.me;
    const fieldDef = n => dom?.fields.find(x => x.name === n);
    const act = async (what, b) => { try { await api(`/requests/${id}/${what}`, b); toast('Done'); await draw(); refresh && refresh(); } catch (e) { toast(e.message); } };
    const actions = [];
    if (r.status === 'pending_approval') {
      if (can.approve) {
        const cm = h('input', { placeholder: 'Comment (required to reject)', style: 'width:100%' });
        actions.push(h('div', { class: 'card' }, h('h2', {}, 'Your decision'),
          h('p', { class: 'muted', style: 'font-size:12px' }, `Recorded as ${me.role}.`), cm,
          h('div', { style: 'margin-top:8px;display:flex;gap:8px' }, h('button', { onclick: () => act('decide', { decision: 'approve', comment: cm.value }) }, 'Approve'), h('button', { class: 'danger', onclick: () => act('decide', { decision: 'reject', comment: cm.value }) }, 'Reject'))));
      } else {
        const later = r.path_positions.some((p, i) => p === me.role && i > r.step_index), mine = !!can.mine;
        actions.push(h('div', { class: 'note' }, mine ? `Your position raised this request. It is waiting for ${r.awaiting_position}; the position that raised a request cannot approve it.`
          : later ? `It is with ${r.awaiting_position} now and will reach you (${me.role}) afterwards.` : `Waiting for ${r.awaiting_position}. You can see it, but only ${r.awaiting_position} can decide this step.`));
      }
    }
    if (r.status === 'approved') actions.push(can.apply ? h('div', { class: 'card' }, h('button', { onclick: () => act('apply', {}) }, 'Apply to master data'), h('p', { class: 'muted', style: 'font-size:12px' }, 'Writes to the master tables in the app database; the source CSV is not modified.'))
      : h('div', { class: 'note good' }, 'Approved. The MDM team applies it to master data and generates the SAP B1 file.'));
    if (r.status === 'draft') {
      if (!can.edit) actions.push(h('div', { class: 'note' }, 'Draft. Only the requester or the MDM team can submit it.'));
      else if (p.new === '<<new value>>') {
        const nv = h('input', { placeholder: `New ${p.field}` });
        actions.push(h('div', { class: 'card' }, h('div', { class: 'note warn' }, 'This draft only has the placeholder “<<new value>>”. Enter the real value to continue.'), nv, ' ', h('button', { onclick: () => act('new-value', { value: nv.value }) }, 'Save value')));
      } else actions.push(h('div', { class: 'card' }, h('button', { onclick: () => act('submit', {}) }, 'Submit for approval')));
    }
    if (r.status === 'rejected') { const why = [...r.audit].reverse().find(a => a.action === 'rejected'); if (why) actions.push(h('div', { class: 'note bad' }, `Rejected by ${why.actor_role || why.actor}: ${why.comment || 'no comment'}`)); }
    const payloadView = verb === 'create' ? kv(Object.entries(p).map(([k, v]) => [fieldLabel(fieldDef(k) || { name: k }), String(v)]))
      : verb === 'update' ? kv([['Field', p.field], ['Current', String(p.old || '–')], ['New', String(p.new)]]) : h('pre', { class: 'mono card', style: 'white-space:pre-wrap' }, JSON.stringify(p, null, 2));
    const masked = JSON.stringify(p).includes('restricted');
    d.replaceChildren(h('div', { style: 'text-align:right' }, h('button', { class: 'ghost', onclick: () => { d.remove(); history.replaceState(null, '', '#requests'); } }, 'Close')),
      h('h1', {}, r.request_id), h('p', {}, statusPill(r.status), ' ', h('span', { class: 'pill' }, r.source === 'app' ? 'created in app' : 'imported from CSV'), ' ', h('span', { class: 'pill' }, r.domain), ' ', r.request_type.replace(/_/g, ' '), ` · ${[r.entity, r.country].filter(Boolean).join('/')}`),
      h('p', { class: 'muted' }, `Target ${r.target_customer_id || '—'} · raised by ${r.requested_by_label} · ${r.created_at.replace('T', ' ')}`),
      h('h3', {}, 'Approval path'), pathChips(r), r.waiting ? h('p', {}, waitPill(r.waiting), ` with ${r.awaiting_position}`) : null,
      p.new === '<<new value>>' ? h('div', { class: 'note warn' }, 'This request’s payload holds only the placeholder “<<new value>>” (as in the source CSV). It can be routed, but it cannot be applied or exported until a real value is recorded.') : null,
      actions,
      h('h3', {}, 'Request details'), payloadView, masked ? h('p', { class: 'muted', style: 'font-size:12px' }, NOTE_SENS) : null,
      r.duplicate_check?.candidates?.length ? h('div', {}, h('h3', {}, 'Duplicate check at submission'), r.duplicate_check.candidates.map(c => h('div', { class: 'cand ' + c.class }, `${c.id || c.customer_id} ${c.name} — ${c.class} ${pct(c.score, 0)}`)), r.duplicate_check.acknowledged ? h('p', { class: 'muted' }, 'Acknowledged: ' + r.duplicate_check.acknowledged.note) : null) : null,
      h('h3', {}, 'Audit trail'), table([{ h: 'When', f: a => a.ts.replace('T', ' ') }, { h: 'By', f: a => a.actor_role || a.actor }, { h: 'Action', f: a => a.action }, { h: 'Status', f: a => (a.from_status ? a.from_status + ' → ' : '') + a.to_status }, { h: 'Comment', f: a => a.comment || '' }], r.audit));
  };
  await draw();
}
