'use strict';
// Request intake, approval routing, decisions, and applying approved changes to the master tables.
// Domains (customer, item, vendor, cost_center, ...) are configuration rows; this code has no per-domain field lists.
const { buildApprovalPath, normUen } = require('./rules');
const { findCandidates, DEFAULTS } = require('./matching');
const { openPoProxy } = require('./analytics');
const { pathOf, tx } = require('./store');
const { encrypt, decrypt, isEnc, MASK } = require('./crypto');
const { CORE_CUSTOMER_COLS } = require('./masterdata');

const PLACEHOLDER = '<<new value>>';
const OPEN_PO_DAYS = Number(process.env.OPEN_PO_WINDOW_DAYS || 30);
const TYPE_RE = /^(create|update|merge|deactivate)_(\w+)$/;

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

function nextId(db, table, col, prefix, width, where = '', args = []) {
  const rows = db.prepare(`SELECT ${col} AS id FROM ${table} WHERE ${col} LIKE ? ${where}`).all(prefix + '%', ...args);
  const max = rows.reduce((m, r) => Math.max(m, /^\d+$/.test(r.id.slice(prefix.length)) ? Number(r.id.slice(prefix.length)) : 0), 0);
  return prefix + String(max + 1).padStart(width, '0');
}

function logEvent(db, { request_id, actor, action, from_status, to_status, comment, ts }) {
  const log_id = nextId(db, 'audit_log', 'log_id', 'AL', 6);
  db.prepare(`INSERT INTO audit_log (log_id, source, request_id, ts, actor, action, from_status, to_status, comment)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(log_id, 'app', request_id, ts || new Date().toISOString().slice(0, 16), actor, action, from_status ?? null, to_status, comment ?? null);
}

const parseType = t => { const m = TYPE_RE.exec(t || ''); return m ? { verb: m[1], domain: m[2] } : null; };
const typesFor = domain => ['create', 'update', ...(domain === 'customer' ? ['merge'] : []), 'deactivate'].map(v => `${v}_${domain}`);
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

function makeWorkflow(ctx) {
  const { db, master } = ctx;
  const rulesOf = () => db.prepare('SELECT * FROM approval_rules WHERE enabled = 1 ORDER BY domain, request_type, step, rule_id').all();

  function enumOf(domain, name) {
    const f = master.fieldsOf(domain).find(x => x.name === name);
    return f && f.data_type === 'enum' ? f.validation.split('|') : [];
  }

  function options() {
    const m = ctx.getModel();
    return {
      domains: master.domains().map(d => ({
        key: d.key, label: d.label, sap_object: d.sap_object, id_field: d.id_field, requestTypes: typesFor(d.key),
        fields: master.fieldsOf(d.key).map(f => ({
          name: f.name, label: f.label || f.name, data_type: f.data_type, required: f.required, sensitive: f.sensitive, editable: f.editable,
          validation: f.validation, description: f.description, source: f.source, match_role: f.match_role, sap_field: f.sap_field,
          options: f.data_type === 'enum' ? f.validation.split('|') : null,
        })),
      })),
      entities: enumOf('customer', 'entity'), countries: enumOf('customer', 'country'),
      roles: [...new Set(rulesOf().map(r => r.approver_role))].sort(),
      requestTypes: master.domains().flatMap(d => typesFor(d.key)),
      sensitiveViewRoles: master.viewRoles(), customerCount: m.customers.size,
    };
  }

  /** Normalise raw form input for the given domain fields. */
  function normalise(fields, input) {
    const out = {};
    for (const f of fields) {
      if (f.name === 'customer_id') continue;
      const raw = input[f.name];
      if (raw == null || clean(raw) === '') continue;
      let v = clean(raw);
      if (f.match_role === 'registration') v = normUen(v);
      else if (f.match_role === 'key') v = v.toUpperCase().replace(/\s+/g, '');
      out[f.name] = v;
    }
    return out;
  }

  function validateValues(fields, values, { requireAll }) {
    const errors = {};
    for (const f of fields) {
      if (f.name === 'customer_id') continue;
      const v = values[f.name];
      if (v == null || v === '') { if (f.required && requireAll) errors[f.name] = 'Required'; continue; }
      if (!f.test(v)) errors[f.name] = f.data_type === 'enum' ? `Must be one of ${f.validation.split('|').join(', ')}` : `Does not match ${f.validation}${f.description ? ' (' + f.description + ')' : ''}`;
    }
    return errors;
  }

  const matchRec = (fields, values, extra = {}) => {
    const r = { ...extra };
    for (const f of fields) {
      const v = values[f.name];
      if (v == null) continue;
      if (f.match_role === 'name') r.name = v; else if (f.match_role === 'registration') r.uen = v; else if (f.match_role === 'address') r.address = v;
      else if (f.match_role === 'country') r.country = v; else if (f.match_role === 'key') r.key = v;
    }
    if (values.entity) r.entity = values.entity;
    return r;
  };

  function candidatesFor(domain, rec, excludeId) {
    const m = ctx.getModel(), fields = master.fieldsOf(domain);
    let pool;
    if (domain === 'customer') pool = [...m.customers.values()].filter(c => c.active);
    else pool = [...(m.records[domain]?.values() || [])].filter(r => r.active).map(r => ({ customer_id: r.record_id, ...matchRec(fields, { ...r.data, name: r.data.name ?? r.name }, { entity: r.entity, country: r.country }) , name: r.name || r.data.name, _rec: r }));
    return findCandidates({ ...rec, customer_id: excludeId }, pool, DEFAULTS, 8).map(c => ({
      id: c.customer.customer_id, customer_id: c.customer.customer_id, name: c.customer.name, entity: c.customer.entity, country: c.customer.country,
      uen: c.customer.uen, address: c.customer.address, golden_id: domain === 'customer' ? m.golden.get(c.customer.customer_id) : null,
      origin: c.customer.origin ?? c.customer._rec?.source, score: Number(c.score.toFixed(3)), class: c.class, reasons: c.reasons,
    }));
  }

  function approvalContext(domain, type, country, values, payload, targetId) {
    const m = ctx.getModel();
    const c = { domain, request_type: type, country, values };
    if (payload.field) c.field = payload.field;
    if (type === 'merge_customer') {
      const ids = payload.merge_ids || [];
      c.entitiesDiffer = new Set(ids.map(i => m.customers.get(i)?.entity)).size > 1;
      c.openPoValueSgd = openPoProxy(m, ids, OPEN_PO_DAYS);
    }
    if (domain === 'customer' && targetId && ['deactivate_customer', 'update_customer'].includes(type)) c.openPoValueSgd = openPoProxy(m, [targetId], OPEN_PO_DAYS);
    return c;
  }

  function targetOf(domain, id) {
    const m = ctx.getModel();
    if (domain === 'customer') {
      const c = m.customers.get(id);
      return c && { id, entity: c.entity, country: c.country, active: c.active, name: c.name, get: f => (CORE_CUSTOMER_COLS.has(f) ? c[f] : c.extra?.[f]) };
    }
    const r = m.records[domain]?.get(id);
    return r && { id, entity: r.entity, country: r.country, active: r.active, name: r.name, get: f => (f === 'name' ? r.name : r.data[f]) };
  }

  /** Validate a request and compute everything needed to store it (payload with sensitive values encrypted, duplicates, route). */
  function buildRequestDraft(body, { forPreview = false } = {}) {
    const pt = parseType(body.request_type);
    if (!pt) throw new HttpError(400, 'Unknown request_type');
    const { verb, domain } = pt, drow = master.domainRow(domain);
    if (!drow || !drow.enabled || !typesFor(domain).includes(body.request_type)) throw new HttpError(400, 'Unknown or disabled request type');
    const fields = master.fieldsOf(domain), byName = Object.fromEntries(fields.map(f => [f.name, f]));
    const enc = (name, v) => (byName[name]?.sensitive ? encrypt(v) : v);
    const errors = {};
    let payload = {}, plain = {}, entity = body.entity, country = body.country, target = body.target_customer_id || null, duplicates = [];

    if (verb === 'create') {
      plain = normalise(fields, { ...(body.values || {}), ...body });
      Object.assign(errors, validateValues(fields, plain, { requireAll: true }));
      entity = plain.entity; country = plain.country;
      payload = Object.fromEntries(Object.entries(plain).map(([k, v]) => [k, enc(k, v)]));
      const idf = drow.id_field;
      if (idf && plain[idf] && !errors[idf] && ctx.getModel().records[domain]?.has(plain[idf])) errors[idf] = 'Already exists';
      if (!Object.keys(errors).length || forPreview) {
        const rec = matchRec(fields, plain);
        if (rec.name || rec.uen || rec.key) duplicates = candidatesFor(domain, rec, null);
      }
    } else {
      const t = targetOf(domain, target);
      if (!t) errors.target_customer_id = 'Select an existing record';
      else { entity = t.entity; country = t.country; }
      if (verb === 'update') {
        const f = byName[body.field];
        if (!f || !f.editable) errors.field = 'Choose a field that can be changed';
        else if (t) {
          const nv = normalise([f], { [f.name]: body.new_value })[f.name];
          if (!nv && !forPreview) errors.new_value = 'Required';
          else if (nv) {
            if (!f.test(nv)) errors.new_value = f.data_type === 'enum' ? `Must be one of ${f.validation.split('|').join(', ')}` : `Does not match ${f.validation}`;
            else {
              const cur = t.get(f.name);
              if ((isEnc(cur) ? decrypt(cur) : (cur ?? '')) === nv) errors.new_value = 'Same as the current value';
            }
          }
          const oldv = t.get(f.name) ?? '';
          payload = { field: f.name, old: f.sensitive ? encrypt(oldv) : oldv, new: nv ? enc(f.name, nv) : PLACEHOLDER };
          plain = { [f.name]: nv };
          if (nv && !errors.new_value && ['name', 'registration'].includes(f.match_role)) {
            const base = domain === 'customer' ? ctx.getModel().customers.get(target) : null;
            if (base) duplicates = candidatesFor(domain, { ...base, customer_id: target, [f.match_role === 'name' ? 'name' : 'uen']: nv }, target);
          }
        }
      } else if (verb === 'merge') {
        const m = ctx.getModel();
        const ids = [...new Set([target, ...(body.merge_ids || [])].filter(Boolean))];
        if (ids.length < 2) errors.merge_ids = 'Pick at least two customer records to merge';
        const bad = ids.filter(i => !m.customers.has(i));
        if (bad.length) errors.merge_ids = `Unknown customer(s): ${bad.join(', ')}`;
        if (new Set(ids.map(i => m.customers.get(i)?.country)).size > 1) errors.merge_ids = 'Records span more than one country';
        payload = { merge_ids: ids, into_golden_id: body.into_golden_id || m.golden.get(target) };
      } else if (verb === 'deactivate') {
        if (!body.reason || clean(body.reason).length < 3) errors.reason = 'Give a reason';
        payload = { reason: clean(body.reason) };
        if (t && !t.active) errors.target_customer_id = 'Already inactive';
      }
    }

    let route = null;
    if ((!Object.keys(errors).length || forPreview) && (country || !byName.country?.required)) {
      const actx = approvalContext(domain, body.request_type, country, plain, payload, target);
      const built = buildApprovalPath(rulesOf(), actx), amap = ctx.access.aliasMap();
      // each step names the position that performs it (the rule's own role is kept for traceability)
      route = { ...built, steps: built.steps.map(s => ({ ...s, position: ctx.access.positionOf(s.role, amap) })), context: { ...actx, values: undefined }, openPoWindowDays: OPEN_PO_DAYS };
    }
    return { domain, verb, type: body.request_type, entity, country, target, payload, errors, duplicates, route };
  }

  function preview(body) { return buildRequestDraft(body, { forPreview: true }); }

  function createRequest(body, who = {}) {
    const d = buildRequestDraft(body);
    if (Object.keys(d.errors).length) throw new HttpError(422, 'Validation failed', { errors: d.errors });
    if (!d.route?.steps.length) throw new HttpError(422, 'No approval rule matched this request');
    let dupAck = null;
    if (d.duplicates.some(x => x.class === 'duplicate') && d.verb === 'create') {
      if (body.duplicate_ack !== 'not_duplicate' || !clean(body.duplicate_note))
        throw new HttpError(409, 'Likely duplicate(s) found. Confirm it is a different record and explain why, or use the existing record.', { duplicates: d.duplicates });
      dupAck = { ack: 'not_duplicate', note: clean(body.duplicate_note) };
    }
    if (who?.profile && !ctx.access.inRegion(who, d.country)) throw new HttpError(403, `You are acting for region ${who.region}; this request is for ${d.country}. Switch to All regions or ${d.country}.`);
    const actor = clean(body.requested_by || who.actor);
    if (!actor) throw new HttpError(422, 'Validation failed', { errors: { requested_by: 'Required' } });

    const request_id = nextId(db, 'requests', 'request_id', 'NEW-', 4);
    const submit = body.submit !== false;
    const roles = d.route.steps.map(s => s.role);
    const now = new Date().toISOString().slice(0, 16);
    tx(db, () => {
      db.prepare(`INSERT INTO requests (request_id, source, domain, request_type, entity, country, target_customer_id, requested_by, created_at, status,
        current_step, approval_path, step_index, payload_json, duplicate_check_json, updated_at, requested_role) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(request_id, 'app', d.domain, d.type, d.entity ?? null, d.country ?? null, d.target, actor, now, submit ? 'pending_approval' : 'draft', submit ? roles[0] : null,
          roles.join(' > '), 0, JSON.stringify(d.payload), JSON.stringify({ candidates: d.duplicates.slice(0, 5), acknowledged: dupAck, rules: d.route.steps.map(s => s.rule_id) }), now, who?.role ?? null);
      logEvent(db, { request_id, actor, action: 'created', to_status: 'draft', ts: now });
      if (submit) logEvent(db, { request_id, actor, action: 'submitted', from_status: 'draft', to_status: 'pending_approval', ts: now });
    });
    return getRequest(request_id, who);
  }

  function getRow(id) {
    const r = db.prepare('SELECT * FROM requests WHERE request_id = ?').get(id);
    if (!r) throw new HttpError(404, 'Request not found');
    return r;
  }

  /** Parse a request row; sensitive payload values are masked unless `who` is allowed to see them. */
  function shape(r, who, { log = false, rules } = {}) {
    const roles = pathOf(r.approval_path);
    let payload = r.payload_json ? JSON.parse(r.payload_json) : null;
    if (payload) {
      const sens = new Set(master.fieldsOf(r.domain).filter(f => f.sensitive).map(f => f.name));
      if (payload.field && sens.has(payload.field)) {
        const one = master.redact(r.domain, { [payload.field]: payload.old }, who, { recordId: r.request_id, context: 'request old', log });
        const two = master.redact(r.domain, { [payload.field]: payload.new }, who, { recordId: r.request_id, context: 'request new', log });
        payload = { ...payload, old: one[payload.field], new: two[payload.field] };
      } else payload = master.redact(r.domain, payload, who, { recordId: r.request_id, context: 'request', log });
    }
    const awaiting = r.status === 'pending_approval' ? roles[r.step_index] ?? null : null;
    // `path` / `awaiting` keep the rule's own role names (traceable to the CSV); the *_position fields are what the screens show
    const map = ctx.access.aliasMap(), pos = x => ctx.access.positionOf(x, map);
    const awaitingPosition = awaiting ? pos(awaiting) : null;
    return {
      ...r, payload, duplicate_check: r.duplicate_check_json ? JSON.parse(r.duplicate_check_json) : null,
      path: roles, path_positions: roles.map(pos), awaiting, awaiting_position: awaitingPosition,
      requested_by_label: requesterLabel(r), waiting: waitInfo(r, awaiting, rules), can: abilities(r, awaiting, awaitingPosition, who),
      payload_json: undefined, duplicate_check_json: undefined,
    };
  }

  /** Screens show roles, not names: CSV handles are translated to the position (or department) they belong to. */
  function requesterLabel(r) {
    return r.requested_role || db.prepare('SELECT label FROM actor_positions WHERE actor = ?').get(r.requested_by)?.label || r.requested_by;
  }

  /** How long the request has been with the current approver, against that step's SLA. */
  function waitInfo(r, awaiting, rules = rulesOf()) {
    if (!awaiting) return null;
    const last = db.prepare("SELECT ts FROM audit_log WHERE request_id = ? AND action IN ('submitted','approved') ORDER BY ts DESC, log_id DESC LIMIT 1").get(r.request_id);
    const since = last?.ts || r.created_at, hours = Math.max(0, (Date.now() - Date.parse(since + ':00Z')) / 36e5);
    const rule = rules.find(x => x.approver_role === awaiting && x.request_type === r.request_type && x.domain === r.domain);
    const sla = rule?.sla_hours ?? 24;
    return { since, hours: Math.round(hours), sla, overdue: hours > sla };
  }

  /** What the signed-in person can do with this request (computed server-side; the UI only displays it). */
  function abilities(r, awaiting, awaitingPosition, who) {
    if (!who?.user_id) return null;
    const p = who.profile || {}, mine = r.requested_by === who.user_id || r.requested_role === who.role;
    return {
      approve: r.status === 'pending_approval' && who.role === awaitingPosition && !mine,
      mine,
      apply: r.status === 'approved' && !!p.can_apply,
      submit: r.status === 'draft' && (mine || !!p.sees_all_requests),
      edit: r.status === 'draft' && (mine || !!p.sees_all_requests),
    };
  }

  function assertVisible(row, who) {
    if (who?.profile && !ctx.access.visible(who, row)) throw new HttpError(403, 'This request is outside your lane: you are not the requester or an approver on it.');
  }

  function getRequest(id, who) {
    const row = getRow(id);
    assertVisible(row, who);
    const r = shape(row, who, { log: true });
    r.audit = db.prepare('SELECT a.*, COALESCE(p.label, a.actor) AS actor_role FROM audit_log a LEFT JOIN actor_positions p ON p.actor = a.actor WHERE a.request_id = ? ORDER BY a.ts, a.log_id').all(id);
    return r;
  }

  function listRequests({ status, role, type, source, domain, q, mine } = {}, who) {
    const rules = rulesOf();
    return db.prepare('SELECT * FROM requests ORDER BY created_at DESC, request_id DESC').all()
      .filter(r => !who?.profile || ctx.access.visible(who, r))
      .map(r => shape(r, who, { rules }))
      .filter(r => (!status || r.status === status) && (!type || r.request_type === type) && (!source || r.source === source) && (!domain || r.domain === domain)
        && (!role || r.awaiting === role || r.awaiting_position === role) && (!mine || r.requested_by === who?.user_id || r.requested_role === who?.role) && (!q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase())));
  }

  function submitDraft(id, actor, who) {
    const r = getRow(id);
    if (who?.profile && !abilities(r, null, null, who).submit && r.status === 'draft') throw new HttpError(403, 'Only the requester (or the MDM team) can submit this draft.');
    if (r.status !== 'draft') throw new HttpError(409, `Only drafts can be submitted (status is ${r.status})`);
    const p = JSON.parse(r.payload_json || '{}');
    if (p.new === PLACEHOLDER) throw new HttpError(422, 'This update draft has no new value recorded (placeholder). Set the new value before submitting.');
    const roles = pathOf(r.approval_path), now = new Date().toISOString().slice(0, 16);
    db.prepare("UPDATE requests SET status='pending_approval', current_step=?, step_index=0, updated_at=? WHERE request_id=?").run(roles[0], now, id);
    logEvent(db, { request_id: id, actor, action: 'submitted', from_status: 'draft', to_status: 'pending_approval', ts: now });
    return getRequest(id, { actor });
  }

  function setDraftNewValue(id, value, who) {
    const r = getRow(id);
    if (who?.profile && !abilities(r, null, null, who).edit && r.status === 'draft') throw new HttpError(403, 'Only the requester (or the MDM team) can edit this draft.');
    if (r.status !== 'draft' || !r.request_type.startsWith('update_')) throw new HttpError(409, 'Only draft update requests can be edited');
    const p = JSON.parse(r.payload_json), f = master.fieldsOf(r.domain).find(x => x.name === p.field);
    if (!f) throw new HttpError(422, 'Unknown field on this request');
    const nv = normalise([f], { [f.name]: value })[f.name];
    if (!nv || !f.test(nv)) throw new HttpError(422, 'Validation failed', { errors: { new_value: `Does not match ${f.validation}` } });
    p.new = f.sensitive ? encrypt(nv) : nv;
    db.prepare('UPDATE requests SET payload_json=?, updated_at=? WHERE request_id=?').run(JSON.stringify(p), new Date().toISOString().slice(0, 16), id);
    return getRequest(id, {});
  }

  /** decision: 'approve' | 'reject'. `role` is the role the actor is acting as (no authentication in this build). */
  function decide(id, { actor, role, decision, comment }) {
    const r = getRow(id);
    if (r.status !== 'pending_approval') throw new HttpError(409, `Request is ${r.status}, not pending approval`);
    const roles = pathOf(r.approval_path), expected = roles[r.step_index];
    if (!actor || !clean(actor)) throw new HttpError(422, 'Actor is required');
    const expectedPosition = ctx.access.positionOf(expected);
    if (role !== expected && role !== expectedPosition) throw new HttpError(403, `Awaiting ${expectedPosition}; you are acting as ${role || 'no position'}`);
    if (clean(actor) === r.requested_by || (r.requested_role && role === r.requested_role)) throw new HttpError(403, 'Requester cannot approve their own request: the position that raised it cannot approve it');
    const now = new Date().toISOString().slice(0, 16), n = roles.length;
    tx(db, () => {
      if (decision === 'reject') {
        if (!comment || !clean(comment)) throw new HttpError(422, 'A comment is required to reject');
        db.prepare("UPDATE requests SET status='rejected', current_step=NULL, updated_at=? WHERE request_id=?").run(now, id);
        logEvent(db, { request_id: id, actor, action: 'rejected', from_status: 'pending_approval', to_status: 'rejected', comment: clean(comment), ts: now });
      } else if (decision === 'approve') {
        logEvent(db, { request_id: id, actor, action: 'approved', from_status: 'pending_approval', to_status: 'pending_approval',
          comment: `step ${r.step_index + 1}/${n} ${expected}` + (expectedPosition !== expected ? ` (${expectedPosition})` : '') + (comment ? ` — ${clean(comment)}` : ''), ts: now });
        if (r.step_index + 1 >= n) {
          db.prepare("UPDATE requests SET status='approved', current_step=NULL, updated_at=? WHERE request_id=?").run(now, id);
          logEvent(db, { request_id: id, actor, action: 'final_approval', from_status: 'pending_approval', to_status: 'approved', ts: now });
        } else db.prepare('UPDATE requests SET step_index=?, current_step=?, updated_at=? WHERE request_id=?').run(r.step_index + 1, roles[r.step_index + 1], now, id);
      } else throw new HttpError(400, 'decision must be approve or reject');
    });
    return getRequest(id, { actor, role });
  }

  /** Apply an approved request to the master tables (the source CSV is never touched). */
  function apply(id, actor) {
    const r = getRow(id);
    if (r.status !== 'approved') throw new HttpError(409, `Only approved requests can be applied (status is ${r.status})`);
    const { verb } = parseType(r.request_type), p = JSON.parse(r.payload_json || '{}'), m = ctx.getModel(), now = new Date().toISOString().slice(0, 16);
    const drow = master.domainRow(r.domain), fields = master.fieldsOf(r.domain);
    tx(db, () => {
      if (verb === 'create' && r.domain === 'customer') {
        if (!p.address) throw new HttpError(422, 'Cannot create the customer: no address was captured on this request');
        const cid = nextId(db, 'md_customers', 'customer_id', drow.id_prefix || 'N', 5);
        const extra = Object.fromEntries(Object.entries(p).filter(([k]) => !CORE_CUSTOMER_COLS.has(k)));
        db.prepare(`INSERT INTO md_customers (customer_id, name, entity, country, uen, address, golden_id, is_survivor, active, extra_json, source,
          orig_name, orig_uen, orig_address, request_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,1,?,'app',?,?,?,?,?,?)`)
          .run(cid, p.name, r.entity, r.country, p.uen || null, p.address, 'GN-' + cid, Object.keys(extra).length ? JSON.stringify(extra) : null, p.name, p.uen || null, p.address, id, now, now);
      } else if (verb === 'create') {
        const rid = drow.id_field ? p[drow.id_field] : nextId(db, 'md_records', 'record_id', drow.id_prefix || r.domain.slice(0, 1).toUpperCase(), 5, 'AND domain = ?', [r.domain]);
        if (!rid) throw new HttpError(422, 'No record id could be determined');
        if (db.prepare('SELECT 1 FROM md_records WHERE domain = ? AND record_id = ?').get(r.domain, rid)) throw new HttpError(409, `${rid} already exists`);
        const nameField = fields.find(f => f.match_role === 'name')?.name || 'name';
        db.prepare(`INSERT INTO md_records (domain, record_id, name, entity, country, data_json, active, source, request_id, created_at, updated_at) VALUES (?,?,?,?,?,?,1,'app',?,?,?)`)
          .run(r.domain, rid, p[nameField] ?? rid, p.entity ?? null, p.country ?? null, JSON.stringify({ ...p, ...(drow.id_field ? {} : { id: rid }) }), id, now, now);
      } else if (verb === 'update') {
        if (p.new === PLACEHOLDER || !p.new) throw new HttpError(422, 'No new value recorded on this request (placeholder) — cannot apply');
        if (r.domain === 'customer') {
          if (CORE_CUSTOMER_COLS.has(p.field)) db.prepare(`UPDATE md_customers SET ${p.field} = ?, updated_at = ? WHERE customer_id = ?`).run(p.new, now, r.target_customer_id);
          else {
            const cur = db.prepare('SELECT extra_json FROM md_customers WHERE customer_id = ?').get(r.target_customer_id);
            const extra = { ...(cur?.extra_json ? JSON.parse(cur.extra_json) : {}), [p.field]: p.new };
            db.prepare('UPDATE md_customers SET extra_json = ?, updated_at = ? WHERE customer_id = ?').run(JSON.stringify(extra), now, r.target_customer_id);
          }
        } else {
          const cur = db.prepare('SELECT * FROM md_records WHERE domain = ? AND record_id = ?').get(r.domain, r.target_customer_id);
          const data = { ...(cur.data_json ? JSON.parse(cur.data_json) : {}), [p.field]: p.new };
          const nameField = fields.find(f => f.match_role === 'name')?.name;
          db.prepare('UPDATE md_records SET data_json = ?, name = ?, updated_at = ? WHERE domain = ? AND record_id = ?')
            .run(JSON.stringify(data), p.field === nameField ? p.new : cur.name, now, r.domain, r.target_customer_id);
        }
        db.prepare('INSERT INTO change_log (ts, domain, record_id, field, old_value, new_value, request_id) VALUES (?,?,?,?,?,?,?)').run(now, r.domain, r.target_customer_id, p.field, p.old, p.new, id);
      } else if (verb === 'merge') {
        const gid = p.into_golden_id || m.golden.get(r.target_customer_id), keep = m.survivor.get(gid);
        for (const cid of p.merge_ids) db.prepare('UPDATE md_customers SET golden_id = ?, updated_at = ? WHERE customer_id = ?').run(gid, now, cid);
        if (keep) db.prepare('UPDATE md_customers SET is_survivor = CASE WHEN customer_id = ? THEN 1 ELSE 0 END WHERE golden_id = ?').run(keep, gid);
        db.prepare('INSERT INTO change_log (ts, domain, record_id, field, old_value, new_value, request_id) VALUES (?,?,?,?,?,?,?)').run(now, 'customer', r.target_customer_id, 'golden_id', null, gid, id);
      } else if (verb === 'deactivate') {
        if (r.domain === 'customer') db.prepare('UPDATE md_customers SET active = 0, updated_at = ? WHERE customer_id = ?').run(now, r.target_customer_id);
        else db.prepare('UPDATE md_records SET active = 0, updated_at = ? WHERE domain = ? AND record_id = ?').run(now, r.domain, r.target_customer_id);
      }
      db.prepare("UPDATE requests SET status='applied', updated_at=? WHERE request_id=?").run(now, id);
      logEvent(db, { request_id: id, actor, action: 'applied', from_status: 'approved', to_status: 'applied', comment: 'Applied to master data (source CSV unchanged)', ts: now });
    });
    ctx.refreshModel();
    return getRequest(id, { actor });
  }

  function stats() {
    return { byStatus: db.prepare('SELECT source, domain, status, COUNT(*) n FROM requests GROUP BY source, domain, status').all(), pending: db.prepare("SELECT COUNT(*) n FROM requests WHERE status='pending_approval'").get().n };
  }

  return { options, preview, createRequest, getRequest, listRequests, submitDraft, setDraftNewValue, decide, apply, stats, parseType, typesFor };
}

module.exports = { makeWorkflow, HttpError, PLACEHOLDER, parseType, MASK };
