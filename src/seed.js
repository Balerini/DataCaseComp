'use strict';
// Seeds domain / field / approval-rule configuration. INSERT OR IGNORE: admin edits made in the app are never overwritten.
//   source = 'csv'      : taken from config_domains / config_approval_rules in the source CSV
//   source = 'proposed' : authored for this prototype (the CSV has no definition for it) — shown as such in the UI

const ENT = 'SPD|QTS|QTG', CTRY = 'SG|MY|ID|TH|VN';

// [name, label, data_type, required, validation, sensitive, match_role, editable, sap_field, description]
const PROPOSED_FIELDS = {
  customer: [
    ['credit_terms', 'Credit terms', 'enum', 0, 'COD|NET30|NET45|NET60', 1, null, 1, 'PayTermsGrpCode', 'Sensitive. Not in source data.'],
    ['bank_account', 'Bank account', 'string', 0, '^[0-9A-Za-z\\- ]{6,34}$', 1, null, 1, 'DFLAccount', 'Sensitive. Not in source data.'],
  ],
  item: [
    ['item_code', 'Item code', 'string', 1, '^[A-Z0-9][A-Z0-9\\-]{0,19}$', 0, 'key', 0, 'ItemCode', 'Unique item code'],
    ['name', 'Item description', 'string', 1, '^.{2,100}$', 0, 'name', 1, 'ItemName', 'Description'],
    ['product_line', 'Product line', 'enum', 1, 'A|B|C|Other', 0, null, 1, 'ItmsGrpCod', 'A, B, C are the core products in the PO data'],
    ['uom', 'Unit of measure', 'string', 0, '^.{1,20}$', 0, null, 1, 'InvntryUom', ''],
    ['regulated', 'Regulated product (Quality/Regulatory sign-off)', 'enum', 1, 'Y|N', 0, null, 1, null, 'Drives the Quality/Regulatory approval step'],
    ['license_no', 'Licence / registration no.', 'string', 0, '^.{3,40}$', 0, null, 1, null, ''],
  ],
  vendor: [
    ['name', 'Registered legal name', 'string', 1, '^.{2,120}$', 0, 'name', 1, 'CardName', ''],
    ['entity', 'Owning entity', 'enum', 1, ENT, 0, null, 0, null, ''],
    ['country', 'Country', 'enum', 1, CTRY, 0, 'country', 0, 'Country', ''],
    ['registration_no', 'Business registration no.', 'string', 0, '^[0-9A-Z]{9,13}$', 0, 'registration', 1, 'FederalTaxID', ''],
    ['address', 'Registered address', 'string', 1, '^.{10,200}$', 0, 'address', 1, 'Street', ''],
    ['payment_terms', 'Payment terms', 'enum', 0, 'COD|NET30|NET45|NET60', 1, null, 1, 'PayTermsGrpCode', 'Sensitive'],
    ['bank_account', 'Bank account', 'string', 0, '^[0-9A-Za-z\\- ]{6,34}$', 1, null, 1, 'DFLAccount', 'Sensitive'],
  ],
  cost_center: [
    ['code', 'Cost center code', 'string', 1, '^[A-Z0-9][A-Z0-9\\-]{2,11}$', 0, 'key', 0, 'PrcCode', ''],
    ['name', 'Name', 'string', 1, '^.{2,100}$', 0, 'name', 1, 'PrcName', ''],
    ['entity', 'Owning entity', 'enum', 1, ENT, 0, null, 0, null, ''],
    ['country', 'Country', 'enum', 0, CTRY, 0, 'country', 0, null, ''],
    ['owner', 'Budget owner', 'string', 0, '^.{2,80}$', 0, null, 1, null, ''],
  ],
};

const DOMAINS = [
  ['customer', 'Customer', 'Business Partner (customer)', null, 'N', 1, 'csv'],
  ['item', 'Item', 'Item master data', 'item_code', null, 2, 'proposed'],
  ['vendor', 'Vendor', 'Business Partner (vendor)', null, 'V', 3, 'proposed'],
  ['cost_center', 'Cost center', 'Cost center (dimension)', 'code', null, 4, 'proposed'],
];

// [rule_id, domain, country, request_type, condition, step, role, sla, notes]
const PROPOSED_RULES = [
  ['PC1', 'customer', '*', 'update_customer', 'field in (credit_terms, bank_account)', 1, 'Entity Finance Lead', 48, 'Credit terms / banking change: finance check'],
  ['PC2', 'customer', '*', 'update_customer', 'field in (credit_terms, bank_account)', 2, 'Compliance Officer', 48, 'Sensitive field change: second check'],
  ['PI1', 'item', '*', 'create_item', 'regulated = Y', 1, 'Quality/Regulatory Affairs', 48, 'Regulated product must be licensed (brief §6 persona Amy)'],
  ['PI2', 'item', '*', 'create_item', '*', 2, 'Business Unit Head', 48, 'Business owner sign-off'],
  ['PI3', 'item', '*', 'create_item', '*', 3, 'Business Support', 24, 'Final check before SAP B1 creation'],
  ['PI4', 'item', '*', 'update_item', '*', 1, 'Data Steward', 24, ''],
  ['PI5', 'item', '*', 'update_item', 'field = regulated', 2, 'Quality/Regulatory Affairs', 48, 'Regulatory status change'],
  ['PI6', 'item', '*', 'deactivate_item', '*', 1, 'Business Unit Head', 24, ''],
  ['PI7', 'item', '*', 'deactivate_item', '*', 2, 'Business Support', 24, ''],
  ['PV1', 'vendor', '*', 'create_vendor', '*', 1, 'Data Steward', 24, 'Check for duplicates and identity'],
  ['PV2', 'vendor', '*', 'create_vendor', '*', 2, 'Entity Finance Lead', 48, 'Credit terms and banking accuracy'],
  ['PV3', 'vendor', '*', 'update_vendor', 'field in (name, registration_no, address)', 1, 'Data Steward', 24, ''],
  ['PV4', 'vendor', '*', 'update_vendor', 'field in (payment_terms, bank_account)', 1, 'Entity Finance Lead', 48, 'Sensitive field change'],
  ['PV5', 'vendor', '*', 'update_vendor', 'field in (payment_terms, bank_account)', 2, 'Compliance Officer', 48, 'Sensitive field change'],
  ['PV6', 'vendor', '*', 'deactivate_vendor', '*', 1, 'Data Steward', 24, ''],
  ['PV7', 'vendor', '*', 'deactivate_vendor', '*', 2, 'Entity Finance Lead', 48, ''],
  ['PK1', 'cost_center', '*', 'create_cost_center', '*', 1, 'Entity Finance Lead', 48, ''],
  ['PK2', 'cost_center', '*', 'create_cost_center', '*', 2, 'Business Support', 24, ''],
  ['PK3', 'cost_center', '*', 'update_cost_center', '*', 1, 'Entity Finance Lead', 48, ''],
  ['PK4', 'cost_center', '*', 'deactivate_cost_center', '*', 1, 'Entity Finance Lead', 48, ''],
  ['PK5', 'cost_center', '*', 'deactivate_cost_center', '*', 2, 'Business Support', 24, ''],
];

const CSV_SAP = { name: 'CardName', uen: 'FederalTaxID', address: 'Street', country: 'Country' };
const CSV_MATCH = { name: 'name', uen: 'registration', address: 'address', country: 'country' };

function seedConfig(db, T) {
  const insD = db.prepare('INSERT OR IGNORE INTO domains (key, label, sap_object, id_field, id_prefix, enabled, sort, source) VALUES (?,?,?,?,?,1,?,?)');
  for (const [k, label, sap, idf, pre, sort, src] of DOMAINS) insD.run(k, label, sap, idf, pre, sort, src);

  const insF = db.prepare(`INSERT OR IGNORE INTO domain_fields (domain, name, label, data_type, required, validation, sensitive, match_role, editable, sap_field, description, source, sort)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // customer fields from the CSV's config_domains
  let n = 0;
  for (const d of (T.config_domains || []).filter(x => x.domain === 'customer')) {
    n++;
    const sys = d.field_name === 'customer_id';
    insF.run('customer', d.field_name, d.field_name.replace(/_/g, ' '), d.data_type, d.required === 'Y' ? 1 : 0, d.validation, 0, CSV_MATCH[d.field_name] ?? null,
      sys || ['entity', 'country'].includes(d.field_name) ? 0 : 1, CSV_SAP[d.field_name] ?? null, d.description, 'csv', n);
  }
  for (const [dom, fields] of Object.entries(PROPOSED_FIELDS)) {
    fields.forEach((f, i) => insF.run(dom, f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8], f[9], 'proposed', 50 + i));
  }
  // item/cost_center/customer id helpers: entity & country enums for items are not needed (items are group-wide)

  const insR = db.prepare(`INSERT OR IGNORE INTO approval_rules (rule_id, domain, country, request_type, condition, step, approver_role, sla_hours, notes, source)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const r of T.config_approval_rules || []) insR.run(r.rule_id, 'customer', r.country, r.request_type, r.condition, Number(r.step), r.approver_role, Number(r.sla_hours), r.notes, 'csv');
  for (const r of PROPOSED_RULES) insR.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], 'proposed');

  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('sensitive_view_roles', JSON.stringify(['Finance']));
  seedPositions(db, T);
}

// ---- positions ----------------------------------------------------------------------------------------------
// The "Acting as" list comes from the competition brief (section 2): requestors, approvers, the MDM team and IT.
// No individuals are stored. What each position can see and do is a design decision, not source data.
const ALL_VIEWS = ['home', 'overview', 'master', 'intake', 'requests', 'inbox', 'duplicates', 'regional', 'analytics', 'forecast', 'sap', 'config', 'data'];
const COMMERCIAL = ['overview', 'regional', 'analytics', 'forecast'];
// [position, kind, description, views, can_request, can_apply, can_export, can_triage, can_config, sees_all_requests]
const PROFILES = [
  ['Product Manager', 'requestor', 'Raises customer and item requests and tracks their own.', ['home', 'intake', 'requests', 'master'], 1, 0, 0, 0, 0, 0],
  ['Regional Sales', 'requestor', 'Raises customer requests, tracks their own, and has the regional commercial views.', ['home', 'intake', 'requests', 'master', ...COMMERCIAL], 1, 0, 0, 0, 0, 0],
  ['Procurement Officer', 'requestor', 'Raises vendor and cost-center requests and tracks their own.', ['home', 'intake', 'requests', 'master'], 1, 0, 0, 0, 0, 0],
  ['Business Unit Head', 'approver', 'Business sign-off on items and accounts; has the regional commercial views.', ['home', 'requests', 'master', ...COMMERCIAL], 0, 0, 0, 0, 0, 0],
  ['Finance', 'approver', 'Checks credit terms, banking and finance-related changes; may see sensitive fields.', ['home', 'requests', 'master'], 0, 0, 0, 0, 0, 0],
  ['Quality/Regulatory Affairs', 'approver', 'Checks that regulated items are licensed.', ['home', 'requests', 'master'], 0, 0, 0, 0, 0, 0],
  ['Business Support', 'approver', 'Final business check before SAP B1 creation; local registration pre-checks.', ['home', 'requests', 'master'], 0, 0, 0, 0, 0, 0],
  ['MDM Team', 'mdm', 'Central team: first-line and final checks, applies approved records, triages the inbox, reviews duplicates, generates the SAP export.', ALL_VIEWS.filter(v => v !== 'config'), 1, 1, 1, 1, 0, 1],
  ['IT', 'admin', 'Maintains forms, approval steps and positions in Config; read-only view of requests for support.', ['home', 'master', 'requests', 'data', 'config'], 0, 0, 0, 0, 1, 1],
];
// The CSV approval rules name roles that are not all in the brief's list. Each is performed by one position (editable assumption).
const ALIASES = [
  ['Data Steward', 'MDM Team', 'Data stewardship is the MDM team\'s job (brief: "the MDM team performs the final check")'],
  ['Group MDM Owner', 'MDM Team', 'Owner of the MDM process; assigned to the MDM team'],
  ['Entity Finance Lead', 'Finance', 'Brief: "Finance checks credit terms and banking details"'],
  ['Compliance Officer', 'Finance', 'ASSUMPTION: KYC re-check on identity change is not in the brief\'s approver list; assigned to Finance'],
  ['Local Country Admin (ID)', 'Business Support', 'ASSUMPTION: local registration pre-check for Indonesia; assigned to Business Support. Acts only in region ID or All regions'],
  ['Local Country Admin (VN)', 'Business Support', 'ASSUMPTION: local registration pre-check for Vietnam; assigned to Business Support. Acts only in region VN or All regions'],
];
// CSV handle prefix -> label shown instead of the handle. Only 'sales' corresponds to a position in the brief's list.
const DEPT = { sales: ['Regional Sales', 'Regional Sales'], cs: [null, 'Customer Service'], ops: [null, 'Operations'] };

function seedPositions(db, T) {
  // positions are defined here (not user data): refresh them on every start so the list always matches the code
  db.exec('DELETE FROM role_profiles');
  const insP = db.prepare('INSERT INTO role_profiles (role, kind, description, views_json, can_request, can_apply, can_export, can_triage, can_config, sees_all_requests) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const p of PROFILES) insP.run(p[0], p[1], p[2], JSON.stringify(p[3]), p[4], p[5], p[6], p[7], p[8], p[9]);
  const insA = db.prepare('INSERT OR IGNORE INTO role_aliases (rule_role, position, basis) VALUES (?,?,?)');
  for (const a of ALIASES) insA.run(a[0], a[1], a[2]);
  const posOf = new Map(db.prepare('SELECT rule_role, position FROM role_aliases').all().map(r => [r.rule_role, r.position]));

  // sensitive-field viewers were stored as rule roles; express them as positions
  const cur = db.prepare("SELECT value FROM settings WHERE key = 'sensitive_view_roles'").get();
  if (cur) {
    let roles = []; try { roles = JSON.parse(cur.value); } catch { /* reset below */ }
    const mapped = [...new Set(roles.map(r => posOf.get(r) || r))];
    if (JSON.stringify(mapped) !== cur.value) db.prepare("UPDATE settings SET value = ? WHERE key = 'sensitive_view_roles'").run(JSON.stringify(mapped));
  }

  // translate CSV handles to positions for display only (the screens show roles, never names)
  const insH = db.prepare('INSERT OR IGNORE INTO actor_positions (actor, position, label) VALUES (?,?,?)');
  const seen = new Set();
  for (const a of T.audit_log || []) {
    const m = /^step \d+\/\d+ (.+?)(?: — .*)?$/.exec(a.comment || '');
    if (m && a.actor && !seen.has(a.actor)) { seen.add(a.actor); insH.run(a.actor, posOf.get(m[1]) || m[1], posOf.get(m[1]) || m[1]); }
  }
  const handles = new Set([...(T.requests || []).map(r => r.requested_by), ...(T.audit_log || []).map(a => a.actor)].filter(Boolean));
  for (const hnd of handles) {
    if (seen.has(hnd)) continue;
    const m = /^(\w+)\.(\w+)@hq$/.exec(hnd);
    if (m && DEPT[m[1]]) insH.run(hnd, DEPT[m[1]][0], DEPT[m[1]][1]);
    else if (/^mdm\.(bot|system)$/.test(hnd)) insH.run(hnd, null, 'System');
    else insH.run(hnd, null, 'Unknown');
  }
}

module.exports = { seedConfig, ALL_VIEWS, PROFILES, ALIASES };
