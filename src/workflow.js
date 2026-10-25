'use strict';
// Request intake, approval routing, decisions, and applying approved changes to the app overlay.
// All state lives in SQLite; the source CSV is read-only.
const { buildApprovalPath, buildValidators, normUen } = require('./rules');
const { findCandidates, DEFAULTS } = require('./matching');
const { openPoProxy } = require('./analytics');
const { pathOf } = require('./store');

const PLACEHOLDER = '<<new value>>';
const TYPES = ['create_customer', 'update_customer', 'merge_customer', 'deactivate_customer'];
const OPEN_PO_DAYS = Number(process.env.OPEN_PO_WINDOW_DAYS || 30);

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

function nextId(db, table, col, prefix, width) {
  const rows = db.prepare(`SELECT ${col} AS id FROM ${table} WHERE ${col} LIKE ?`).all(prefix + '%');
  const max = rows.reduce((m, r) => Math.max(m, Number(r.id.slice(prefix.length)) || 0), 0);
  return prefix + String(max + 1).padStart(width, '0');
}

function logEvent(db, { request_id, actor, action, from_status, to_status, comment, ts }) {
  const log_id = nextId(db, 'audit_log', 'log_id', 'AL', 6);
  db.prepare(`INSERT INTO audit_log (log_id, source, request_id, ts, actor, action, from_status, to_status, comment)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(log_id, 'app', request_id, ts || new Date().toISOString().slice(0, 16), actor, action, from_status ?? null, to_status, comment ?? null);
}

function makeWorkflow(ctx) {
  // ctx: { db, getSource, getModel, refreshModel }
  const { db } = ctx;
  const rulesOf = () => ctx.getSource().tables.config_approval_rules;
  const validators = () => buildValidators(ctx.getSource().tables.config_domains);

  function options() {
    const m = ctx.getModel(), v = validators().customer;
    return {
      entities: v.entity.validation.split('|'),
      countries: v.country.validation.split('|'),
      requestTypes: TYPES,
      updatableFields: ['name', 'uen', 'address'],
      roles: [...new Set(rulesOf().map(r => r.approver_role))],
      fieldRules: Object.fromEntries(Object.entries(v).map(([k, d]) => [k, { required: d.required === 'Y', validation: d.validation, description: d.description }])),
      customerCount: m.customers.size,
    };
  }

  /** Validate a customer-shaped input against config_domains. Returns { errors, clean }. */
  function validateCustomerInput(inp, { requireAll = true } = {}) {
    const v = validators().customer, errors = {};
    const clean = {
      name: String(inp.name ?? '').replace(/\s+/g, ' ').trim(),
      entity: String(inp.entity ?? '').trim(), country: String(inp.country ?? '').trim(),
      uen: normUen(inp.uen), address: String(inp.address ?? '').replace(/\s+/g, ' ').trim(),
    };
    for (const f of ['name', 'entity', 'country', 'uen', 'address']) {
      const def = v[f], val = clean[f];
      if (!val) { if (def.required === 'Y' && requireAll) errors[f] = 'Required'; continue; }
      if (!def.test(val)) errors[f] = `Does not satisfy ${def.validation} (${def.description})`;
    }
    return { errors, clean };
  }

  function duplicateCheck(rec) {
    const m = ctx.getModel();
    const pool = [...m.customers.values()].filter(c => c.active);
    return findCandidates(rec, pool, DEFAULTS, 8).map(c => ({
      customer_id: c.customer.customer_id, name: c.customer.name, entity: c.customer.entity, country: c.customer.country,
      uen: c.customer.uen, address: c.customer.address, golden_id: m.golden.get(c.customer.customer_id), origin: c.customer.origin,
      score: Number(c.score.toFixed(3)), class: c.class, reasons: c.reasons,
    }));
  }

  function approvalContext(type, country, payload, targetId) {
    const m = ctx.getModel();
    const c = { request_type: type, country };
    if (type === 'update_customer') c.field = payload.field;
    if (type === 'merge_customer') {
      const ids = payload.merge_ids || [];
      c.entitiesDiffer = new Set(ids.map(i => m.customers.get(i)?.entity)).size > 1;
      c.openPoValueSgd = openPoProxy(m, ids, OPEN_PO_DAYS);
    }
    if (type === 'deactivate_customer' || type === 'update_customer') c.openPoValueSgd = targetId ? openPoProxy(m, [targetId], OPEN_PO_DAYS) : 0;
    return c;
  }

  function preview(body) {
    const type = body.request_type;
    if (!TYPES.includes(type)) throw new HttpError(400, 'Unknown request_type');
    return buildRequestDraft(body, { forPreview: true });
  }

  function buildRequestDraft(body, { forPreview = false } = {}) {
    const m = ctx.getModel(), type = body.request_type, errors = {};
    let payload = {}, entity = body.entity, country = body.country, target = body.target_customer_id || null, duplicates = [];

    if (type === 'create_customer') {
      const { errors: e, clean } = validateCustomerInput(body);
      Object.assign(errors, e);
      payload = { name: clean.name, uen: clean.uen, address: clean.address };
      entity = clean.entity; country = clean.country;
      if (!Object.keys(e).length || forPreview) duplicates = duplicateCheck({ name: clean.name, country: clean.country, uen: clean.uen, address: clean.address, entity: clean.entity });
    } else {
      const tc = m.customers.get(target);
      if (!tc) errors.target_customer_id = 'Select an existing customer';
      else { entity = tc.entity; country = tc.country; }
      if (type === 'update_customer') {
        const field = body.field;
        if (!['name', 'uen', 'address'].includes(field)) errors.field = 'Choose name, uen or address';
        else if (tc) {
          let nv = field === 'uen' ? normUen(body.new_value) : String(body.new_value ?? '').replace(/\s+/g, ' ').trim();
          if (!nv && !forPreview) errors.new_value = 'Required';
          else if (nv) {
            const def = validators().customer[field];
            if (!def.test(nv)) errors.new_value = `Does not satisfy ${def.validation}`;
            else if (nv === (tc[field] ?? '')) errors.new_value = 'Same as the current value';
          }
          payload = { field, old: tc[field] ?? '', new: nv || PLACEHOLDER };
          if (nv && (field === 'name' || field === 'uen') && !errors.new_value)
            duplicates = duplicateCheck({ ...tc, customer_id: tc.customer_id, [field]: nv });
        }
      } else if (type === 'merge_customer') {
        const ids = [...new Set([target, ...(body.merge_ids || [])].filter(Boolean))];
        if (ids.length < 2) errors.merge_ids = 'Pick at least two customer records to merge';
        const bad = ids.filter(i => !m.customers.has(i));
        if (bad.length) errors.merge_ids = `Unknown customer(s): ${bad.join(', ')}`;
        const ctrs = new Set(ids.map(i => m.customers.get(i)?.country));
        if (ctrs.size > 1) errors.merge_ids = 'Records span more than one country';
        const golden = body.into_golden_id || m.golden.get(target);
        payload = { merge_ids: ids, into_golden_id: golden };
      } else if (type === 'deactivate_customer') {
        if (!body.reason || String(body.reason).trim().length < 3) errors.reason = 'Give a reason';
        payload = { reason: String(body.reason || '').trim() };
        if (tc && !tc.active) errors.target_customer_id = 'Already inactive';
      }
    }

    let route = null;
    if (!Object.keys(errors).length || forPreview) {
      if (country) {
        const actx = approvalContext(type, country, payload, target);
        route = { ...buildApprovalPath(rulesOf(), actx), context: actx, openPoWindowDays: OPEN_PO_DAYS };
      }
    }
    return { type, entity, country, target, payload, errors, duplicates, route };
  }

  function createRequest(body) {
    const d = buildRequestDraft(body);
    if (Object.keys(d.errors).length) throw new HttpError(422, 'Validation failed', { errors: d.errors });
    if (!d.route.steps.length) throw new HttpError(422, 'No approval rule matched this request');
    let dupAck = null;
    const strong = d.duplicates.filter(x => x.class === 'duplicate');
    if (strong.length && d.type === 'create_customer') {
      if (body.duplicate_ack !== 'not_duplicate' || !String(body.duplicate_note || '').trim())
        throw new HttpError(409, 'Likely duplicate(s) found. Confirm it is a different company and explain why, or use the existing record.', { duplicates: d.duplicates });
      dupAck = { ack: 'not_duplicate', note: String(body.duplicate_note).trim() };
    }
    const actor = String(body.requested_by || '').trim();
    if (!actor) throw new HttpError(422, 'Validation failed', { errors: { requested_by: 'Required' } });

    const request_id = nextId(db, 'requests', 'request_id', 'NEW-', 4);
    const submit = body.submit !== false;
    const roles = d.route.steps.map(s => s.role);
    const now = new Date().toISOString().slice(0, 16);
    const status = submit ? 'pending_approval' : 'draft';
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO requests (request_id, source, request_type, entity, country, target_customer_id, requested_by, created_at, status,
        current_step, approval_path, step_index, payload_json, duplicate_check_json, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(request_id, 'app', d.type, d.entity, d.country, d.target, actor, now, status, submit ? roles[0] : null, roles.join(' > '), 0,
          JSON.stringify(d.payload), JSON.stringify({ candidates: d.duplicates.slice(0, 5), acknowledged: dupAck, rules: d.route.steps.map(s => s.rule_id) }), now);
      logEvent(db, { request_id, actor, action: 'created', to_status: 'draft', ts: now });
      if (submit) logEvent(db, { request_id, actor, action: 'submitted', from_status: 'draft', to_status: 'pending_approval', ts: now });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return getRequest(request_id);
  }

  function getRow(id) {
    const r = db.prepare('SELECT * FROM requests WHERE request_id = ?').get(id);
    if (!r) throw new HttpError(404, 'Request not found');
    return r;
  }

  function shape(r) {
    const roles = pathOf(r.approval_path);
    return {
      ...r, payload: r.payload_json ? JSON.parse(r.payload_json) : null,
      duplicate_check: r.duplicate_check_json ? JSON.parse(r.duplicate_check_json) : null,
      path: roles, awaiting: r.status === 'pending_approval' ? roles[r.step_index] ?? null : null,
      payload_json: undefined, duplicate_check_json: undefined,
    };
  }

  function getRequest(id) {
    const r = shape(getRow(id));
    r.audit = db.prepare('SELECT * FROM audit_log WHERE request_id = ? ORDER BY ts, log_id').all(id);
    return r;
  }

  function listRequests({ status, role, type, source, q } = {}) {
    const rows = db.prepare('SELECT * FROM requests ORDER BY created_at DESC, request_id DESC').all().map(shape);
    return rows.filter(r => (!status || r.status === status) && (!type || r.request_type === type) && (!source || r.source === source)
      && (!role || r.awaiting === role)
      && (!q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase())));
  }

  function submitDraft(id, actor) {
    const r = getRow(id);
    if (r.status !== 'draft') throw new HttpError(409, `Only drafts can be submitted (status is ${r.status})`);
    const p = JSON.parse(r.payload_json || '{}');
    if (p.new === PLACEHOLDER) throw new HttpError(422, 'This update draft has no new value recorded (placeholder). Set the new value before submitting.');
    const roles = pathOf(r.approval_path), now = new Date().toISOString().slice(0, 16);
    db.prepare("UPDATE requests SET status='pending_approval', current_step=?, step_index=0, updated_at=? WHERE request_id=?").run(roles[0], now, id);
    logEvent(db, { request_id: id, actor, action: 'submitted', from_status: 'draft', to_status: 'pending_approval', ts: now });
    return getRequest(id);
  }

  function setDraftNewValue(id, value) {
    const r = getRow(id);
    if (r.status !== 'draft' || r.request_type !== 'update_customer') throw new HttpError(409, 'Only draft update requests can be edited');
    const p = JSON.parse(r.payload_json);
    const nv = p.field === 'uen' ? normUen(value) : String(value || '').replace(/\s+/g, ' ').trim();
    const def = validators().customer[p.field];
    if (!nv || !def.test(nv)) throw new HttpError(422, 'Validation failed', { errors: { new_value: `Does not satisfy ${def.validation}` } });
    p.new = nv;
    db.prepare('UPDATE requests SET payload_json=?, updated_at=? WHERE request_id=?').run(JSON.stringify(p), new Date().toISOString().slice(0, 16), id);
    return getRequest(id);
  }

  /** decision: 'approve' | 'reject'. `role` is the role the actor is acting as (no authentication in this build). */
  function decide(id, { actor, role, decision, comment }) {
    const r = getRow(id);
    if (r.status !== 'pending_approval') throw new HttpError(409, `Request is ${r.status}, not pending approval`);
    const roles = pathOf(r.approval_path), expected = roles[r.step_index];
    if (!actor || !String(actor).trim()) throw new HttpError(422, 'Actor is required');
    if (role !== expected) throw new HttpError(403, `Awaiting ${expected}; you are acting as ${role || 'no role'}`);
    if (String(actor).trim() === r.requested_by) throw new HttpError(403, 'Requester cannot approve their own request');
    const now = new Date().toISOString().slice(0, 16), n = roles.length;
    db.exec('BEGIN');
    try {
      if (decision === 'reject') {
        if (!comment || !String(comment).trim()) throw new HttpError(422, 'A comment is required to reject');
        db.prepare("UPDATE requests SET status='rejected', current_step=NULL, updated_at=? WHERE request_id=?").run(now, id);
        logEvent(db, { request_id: id, actor, action: 'rejected', from_status: 'pending_approval', to_status: 'rejected', comment: String(comment).trim(), ts: now });
      } else if (decision === 'approve') {
        logEvent(db, { request_id: id, actor, action: 'approved', from_status: 'pending_approval', to_status: 'pending_approval',
          comment: `step ${r.step_index + 1}/${n} ${expected}` + (comment ? ` — ${String(comment).trim()}` : ''), ts: now });
        if (r.step_index + 1 >= n) {
          db.prepare("UPDATE requests SET status='approved', current_step=NULL, updated_at=? WHERE request_id=?").run(now, id);
          logEvent(db, { request_id: id, actor, action: 'final_approval', from_status: 'pending_approval', to_status: 'approved', ts: now });
        } else {
          db.prepare('UPDATE requests SET step_index=?, current_step=?, updated_at=? WHERE request_id=?').run(r.step_index + 1, roles[r.step_index + 1], now, id);
        }
      } else throw new HttpError(400, 'decision must be approve or reject');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return getRequest(id);
  }

  /** Apply an approved request to the app overlay (never to the CSV). */
  function apply(id, actor) {
    const r = getRow(id);
    if (r.status !== 'approved') throw new HttpError(409, `Only approved requests can be applied (status is ${r.status})`);
    const p = JSON.parse(r.payload_json || '{}'), m = ctx.getModel(), now = new Date().toISOString().slice(0, 16);
    db.exec('BEGIN');
    try {
      if (r.request_type === 'create_customer') {
        if (!p.address) throw new HttpError(422, 'Cannot create the customer: no address was captured on this request');
        const cid = nextId(db, 'app_customers', 'customer_id', 'N', 5);
        db.prepare('INSERT INTO app_customers (customer_id, name, entity, country, uen, address, request_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(cid, p.name, r.entity, r.country, p.uen || null, p.address, id, now);
      } else if (r.request_type === 'update_customer') {
        if (p.new === PLACEHOLDER || !p.new) throw new HttpError(422, 'No new value recorded on this request (placeholder) — cannot apply');
        db.prepare('INSERT INTO customer_overrides (customer_id, field, value, request_id, at) VALUES (?,?,?,?,?)').run(r.target_customer_id, p.field, p.new, id, now);
      } else if (r.request_type === 'merge_customer') {
        const gid = p.into_golden_id || m.golden.get(r.target_customer_id);
        for (const cid of p.merge_ids) db.prepare('INSERT OR REPLACE INTO canonical_overrides (customer_id, golden_id, request_id, at) VALUES (?,?,?,?)').run(cid, gid, id, now);
      } else if (r.request_type === 'deactivate_customer') {
        db.prepare('INSERT OR REPLACE INTO inactive_customers (customer_id, request_id, at) VALUES (?,?,?)').run(r.target_customer_id, id, now);
      }
      db.prepare("UPDATE requests SET status='applied', updated_at=? WHERE request_id=?").run(now, id);
      logEvent(db, { request_id: id, actor, action: 'applied', from_status: 'approved', to_status: 'applied', comment: 'Applied to app overlay (source CSV unchanged)', ts: now });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    ctx.refreshModel();
    return getRequest(id);
  }

  function stats() {
    const byStatus = db.prepare('SELECT source, status, COUNT(*) n FROM requests GROUP BY source, status').all();
    const sla = db.prepare("SELECT COUNT(*) n FROM requests WHERE status='pending_approval'").get().n;
    return { byStatus, pending: sla };
  }

  return { options, preview, createRequest, getRequest, listRequests, submitDraft, setDraftNewValue, decide, apply, stats, validateCustomerInput };
}

module.exports = { makeWorkflow, HttpError, PLACEHOLDER };
