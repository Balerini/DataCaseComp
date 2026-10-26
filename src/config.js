'use strict';
// Admin configuration: add a data domain, add/change a field, add/disable an approval rule — no code change, no IT ticket.
// Every change is written to change_log (domain='config') so configuration changes are auditable too.
const { evalCondition } = require('./rules');

const DATA_TYPES = ['string', 'enum', 'date', 'integer', 'decimal'];
const KEY_RE = /^[a-z][a-z0-9_]{1,30}$/;
const ROLE_PLAIN = /^[\w .&/()\-]{2,60}$/;

class ConfigError extends Error { constructor(message, status = 422) { super(message); this.status = status; } }

function makeConfig(ctx) {
  const { db } = ctx;
  const log = (actor, action, detail) => db.prepare('INSERT INTO change_log (ts, domain, record_id, field, old_value, new_value, request_id) VALUES (?,?,?,?,?,?,?)')
    .run(new Date().toISOString().slice(0, 16), 'config', detail.key || '', action, null, JSON.stringify(detail), actor || null);

  function snapshot() {
    return {
      domains: db.prepare('SELECT * FROM domains ORDER BY sort, key').all().map(d => ({
        ...d, fields: db.prepare('SELECT * FROM domain_fields WHERE domain = ? ORDER BY sort, name').all(d.key),
        rules: db.prepare('SELECT * FROM approval_rules WHERE domain = ? ORDER BY request_type, step, rule_id').all(d.key),
      })),
      settings: { sensitive_view_roles: ctx.master.viewRoles() },
      dataTypes: DATA_TYPES,
      conditionSyntax: ['*', 'field in (a, b)', '<field> = <value>', 'country = ID', 'entities differ', 'open_po_value_sgd > 50000'],
      recentChanges: db.prepare("SELECT * FROM change_log WHERE domain = 'config' ORDER BY id DESC LIMIT 15").all(),
    };
  }

  function addDomain(b, actor) {
    const key = String(b.key || '').trim();
    if (!KEY_RE.test(key)) throw new ConfigError('Domain key: lower-case letters, digits, underscore (2-31 chars, starts with a letter)');
    if (db.prepare('SELECT 1 FROM domains WHERE key = ?').get(key)) throw new ConfigError(`Domain "${key}" already exists`, 409);
    if (!String(b.label || '').trim()) throw new ConfigError('Label is required');
    db.prepare('INSERT INTO domains (key, label, sap_object, id_field, id_prefix, enabled, sort, source) VALUES (?,?,?,?,?,1,?,?)')
      .run(key, b.label.trim(), b.sap_object || null, b.id_field || null, b.id_prefix || key.slice(0, 1).toUpperCase(), 100, 'app');
    // every domain starts with a name field and the standard approval path so it is usable immediately
    db.prepare(`INSERT INTO domain_fields (domain, name, label, data_type, required, validation, match_role, editable, source, sort) VALUES (?,?,?,?,1,?,?,1,'app',1)`)
      .run(key, 'name', 'Name', 'string', '^.{2,120}$', 'name');
    const ins = db.prepare('INSERT INTO approval_rules (rule_id, domain, country, request_type, condition, step, approver_role, sla_hours, notes, source) VALUES (?,?,?,?,?,?,?,?,?,?)');
    ins.run(`${key.toUpperCase()}-C1`, key, '*', `create_${key}`, '*', 1, 'Data Steward', 24, 'Default (edit in Config)', 'app');
    ins.run(`${key.toUpperCase()}-U1`, key, '*', `update_${key}`, '*', 1, 'Data Steward', 24, 'Default (edit in Config)', 'app');
    ins.run(`${key.toUpperCase()}-D1`, key, '*', `deactivate_${key}`, '*', 1, 'Data Steward', 24, 'Default (edit in Config)', 'app');
    log(actor, 'add_domain', { key, label: b.label });
    return snapshot();
  }

  function saveField(b, actor) {
    const d = db.prepare('SELECT * FROM domains WHERE key = ?').get(b.domain);
    if (!d) throw new ConfigError('Unknown domain', 404);
    const name = String(b.name || '').trim();
    if (!KEY_RE.test(name)) throw new ConfigError('Field name: lower-case letters, digits, underscore');
    const type = b.data_type || 'string';
    if (!DATA_TYPES.includes(type)) throw new ConfigError('Unknown data type');
    if (b.validation) {
      if (type === 'enum') { if (!/^[^|]+(\|[^|]+)*$/.test(b.validation)) throw new ConfigError('Enum options: A|B|C'); }
      else { try { new RegExp(b.validation); } catch { throw new ConfigError('Validation is not a valid regular expression'); } }
    } else if (type === 'enum') throw new ConfigError('Enum fields need options, e.g. A|B|C');
    const cur = db.prepare('SELECT * FROM domain_fields WHERE domain = ? AND name = ?').get(b.domain, name);
    const v = {
      label: b.label || name, required: b.required ? 1 : 0, sensitive: b.sensitive ? 1 : 0, editable: b.editable === false ? 0 : 1,
      match_role: ['name', 'registration', 'address', 'country', 'key'].includes(b.match_role) ? b.match_role : null, sap_field: b.sap_field || null, description: b.description || null,
    };
    if (cur) {
      if (cur.source === 'csv' && (cur.data_type !== type || cur.name !== name)) throw new ConfigError('Fields defined in the source CSV cannot change type');
      db.prepare(`UPDATE domain_fields SET label=?, data_type=?, required=?, validation=?, sensitive=?, match_role=?, editable=?, sap_field=?, description=? WHERE domain=? AND name=?`)
        .run(v.label, type, v.required, b.validation || null, v.sensitive, v.match_role, v.editable, v.sap_field, v.description, b.domain, name);
    } else {
      db.prepare(`INSERT INTO domain_fields (domain, name, label, data_type, required, validation, sensitive, match_role, editable, sap_field, description, source, sort)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'app',?)`).run(b.domain, name, v.label, type, v.required, b.validation || null, v.sensitive, v.match_role, v.editable, v.sap_field, v.description, 100);
    }
    log(actor, cur ? 'update_field' : 'add_field', { key: b.domain, field: name, required: !!v.required, sensitive: !!v.sensitive });
    return snapshot();
  }

  function deleteField(b, actor) {
    const f = db.prepare('SELECT * FROM domain_fields WHERE domain = ? AND name = ?').get(b.domain, b.name);
    if (!f) throw new ConfigError('Unknown field', 404);
    if (f.source !== 'app') throw new ConfigError('Only fields added in the app can be removed; mark others as not required instead');
    db.prepare('DELETE FROM domain_fields WHERE domain = ? AND name = ?').run(b.domain, b.name);
    log(actor, 'delete_field', { key: b.domain, field: b.name });
    return snapshot();
  }

  function saveRule(b, actor) {
    if (!db.prepare('SELECT 1 FROM domains WHERE key = ?').get(b.domain)) throw new ConfigError('Unknown domain', 404);
    const type = String(b.request_type || '');
    if (!new RegExp(`^(create|update|merge|deactivate)_${b.domain}$`).test(type)) throw new ConfigError(`Request type must look like create_${b.domain}, update_${b.domain}, deactivate_${b.domain}`);
    const role = String(b.approver_role || '').trim();
    if (!ROLE_PLAIN.test(role)) throw new ConfigError('Approver role is required');
    const step = Number(b.step);
    if (!Number.isInteger(step) || step < 0 || step > 9) throw new ConfigError('Step must be a whole number 0-9');
    const sla = Number(b.sla_hours || 24);
    if (!(sla > 0 && sla <= 720)) throw new ConfigError('SLA hours must be 1-720');
    const cond = String(b.condition || '*').trim();
    if (evalCondition(cond, { values: {} }) === null) throw new ConfigError('Condition not understood. Examples: *, field in (a, b), regulated = Y, country = ID, entities differ');
    const country = String(b.country || '*').trim() || '*';
    let id = String(b.rule_id || '').trim();
    const exists = id && db.prepare('SELECT * FROM approval_rules WHERE rule_id = ?').get(id);
    if (exists && exists.domain !== b.domain) throw new ConfigError('rule_id belongs to another domain', 409);
    if (!id) { let n = db.prepare('SELECT COUNT(*) n FROM approval_rules WHERE domain = ?').get(b.domain).n + 1; id = `${b.domain.toUpperCase()}-${n}`; while (db.prepare('SELECT 1 FROM approval_rules WHERE rule_id = ?').get(id)) id = `${b.domain.toUpperCase()}-${++n}`; }
    if (exists) db.prepare('UPDATE approval_rules SET country=?, request_type=?, condition=?, step=?, approver_role=?, sla_hours=?, notes=? WHERE rule_id=?').run(country, type, cond, step, role, sla, b.notes || null, id);
    else db.prepare('INSERT INTO approval_rules (rule_id, domain, country, request_type, condition, step, approver_role, sla_hours, notes, source) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, b.domain, country, type, cond, step, role, sla, b.notes || null, 'app');
    log(actor, exists ? 'update_rule' : 'add_rule', { key: b.domain, rule_id: id, type, step, role, cond });
    return snapshot();
  }

  function toggleRule(b, actor) {
    const r = db.prepare('SELECT * FROM approval_rules WHERE rule_id = ?').get(b.rule_id);
    if (!r) throw new ConfigError('Unknown rule', 404);
    db.prepare('UPDATE approval_rules SET enabled = ? WHERE rule_id = ?').run(b.enabled ? 1 : 0, b.rule_id);
    log(actor, b.enabled ? 'enable_rule' : 'disable_rule', { key: r.domain, rule_id: r.rule_id });
    return snapshot();
  }

  function saveSettings(b, actor) {
    if (Array.isArray(b.sensitive_view_roles)) {
      const roles = b.sensitive_view_roles.map(String).filter(r => ROLE_PLAIN.test(r));
      db.prepare("INSERT INTO settings (key, value) VALUES ('sensitive_view_roles', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(roles));
      log(actor, 'set_sensitive_view_roles', { key: 'settings', roles });
    }
    return snapshot();
  }

  return { snapshot, addDomain, saveField, deleteField, saveRule, toggleRule, saveSettings };
}

module.exports = { makeConfig, ConfigError };
