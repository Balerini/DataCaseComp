'use strict';
// Approval routing (from config_approval_rules) and field validation (from config_domains).

/** Evaluate one rule `condition` against a request context. Returns true/false/null (null = cannot evaluate). */
function evalCondition(cond, ctx) {
  const c = (cond || '*').trim();
  if (c === '*') return true;
  let m;
  if ((m = c.match(/^field in \((.+)\)$/))) {
    if (!ctx.field) return false;
    return m[1].split(',').map(s => s.trim()).includes(ctx.field);
  }
  if ((m = c.match(/^field = (\w+)$/))) return ctx.field === m[1];
  if ((m = c.match(/^country = (\w+)$/))) return ctx.country === m[1];
  if (c === 'entities differ') return !!ctx.entitiesDiffer;
  if ((m = c.match(/^open_po_value_sgd > (\d+(?:\.\d+)?)$/))) return (ctx.openPoValueSgd ?? 0) > Number(m[1]);
  return null;
}

/**
 * Build the approval path for a request.
 * ctx: { request_type, country, field?, entitiesDiffer?, openPoValueSgd? }
 * Returns { steps: [{step, role, rule_id, sla_hours, note}], unevaluable: [rule_id] }
 */
function buildApprovalPath(rules, ctx) {
  const steps = [], unevaluable = [];
  for (const r of rules) {
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

/** Parse config_domains.validation into a checker. Supports enum "A|B|C" and regex "^...$". */
function makeValidator(def) {
  const v = def.validation;
  if (def.data_type === 'enum') { const set = new Set(v.split('|')); return x => set.has(x); }
  const re = new RegExp(v);
  return x => re.test(x);
}

function buildValidators(domains) {
  const out = {};
  for (const d of domains) (out[d.domain] ??= {})[d.field_name] = { ...d, test: makeValidator(d) };
  return out;
}

/** Registration numbers appear with separators in the source (e.g. 7173-327540153); normalise before validating. */
const normUen = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

module.exports = { evalCondition, buildApprovalPath, buildValidators, normUen };
