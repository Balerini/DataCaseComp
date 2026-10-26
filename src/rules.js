'use strict';
// Approval routing (rules stored in the approval_rules table) and field validation (domain_fields table).

/**
 * Evaluate one rule `condition` against a request context. Returns true / false / null (null = cannot evaluate).
 * ctx: { request_type, country, field?, values?: {payload fields}, entitiesDiffer?, openPoValueSgd? }
 * Supported: *, `field in (a, b)`, `<key> = <value>`, `<key> in (a, b)` (key = any payload field, or country/field),
 *            `entities differ`, `open_po_value_sgd > N`.
 */
function evalCondition(cond, ctx) {
  const c = (cond || '*').trim();
  if (c === '*') return true;
  const look = k => (k === 'field' ? ctx.field : k === 'country' ? ctx.country : ctx.values?.[k]);
  let m;
  if (c === 'entities differ') return !!ctx.entitiesDiffer;
  if ((m = c.match(/^open_po_value_sgd > (\d+(?:\.\d+)?)$/))) return (ctx.openPoValueSgd ?? 0) > Number(m[1]);
  if ((m = c.match(/^(\w+) in \((.+)\)$/))) {
    const v = look(m[1]);
    return v != null && m[2].split(',').map(s => s.trim()).includes(String(v));
  }
  if ((m = c.match(/^(\w+) = (\S+)$/))) { const v = look(m[1]); return v != null && String(v) === m[2]; }
  return null;
}

/** Build the approval path. Rules are DB rows: { rule_id, domain, country, request_type, condition, step, approver_role, sla_hours, notes }. */
function buildApprovalPath(rules, ctx) {
  const steps = [], unevaluable = [];
  for (const r of rules) {
    if (r.domain && ctx.domain && r.domain !== ctx.domain) continue;
    if (r.country !== '*' && r.country !== ctx.country) continue;
    if (r.request_type !== '*' && r.request_type !== ctx.request_type) continue;
    const ok = evalCondition(r.condition, ctx);
    if (ok === null) unevaluable.push(r.rule_id);
    else if (ok) steps.push({ step: Number(r.step), role: r.approver_role, rule_id: r.rule_id, sla_hours: Number(r.sla_hours), note: r.notes });
  }
  steps.sort((a, b) => a.step - b.step);
  const seen = new Set();
  return { steps: steps.filter(s => !seen.has(s.role) && seen.add(s.role)), unevaluable };
}

/** Turn a domain_fields row into a checker. enum: "A|B|C"; otherwise a regular expression. */
function fieldTest(def) {
  if (!def.validation) return () => true;
  if (def.data_type === 'enum') { const set = new Set(def.validation.split('|')); return x => set.has(x); }
  const re = new RegExp(def.validation);
  return x => re.test(x);
}

/** Registration numbers appear with separators in the source (e.g. 7173-327540153); normalise before validating. */
const normUen = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

module.exports = { evalCondition, buildApprovalPath, fieldTest, normUen };
