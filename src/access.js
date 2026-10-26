'use strict';
// Positions and permissions. The person chooses the position they are "acting as" (and optionally a region) in the header.
// There is no authentication in this prototype: the choice is declared, not proven. The server still enforces what each
// declared position can see and do, so views and approvals genuinely differ by position. No individuals are stored.

const FLAGS = ['can_request', 'can_apply', 'can_export', 'can_triage', 'can_config', 'sees_all_requests'];
const DEFAULT_VIEWS = ['home', 'requests', 'master'];

function makeAccess(ctx) {
  const { db } = ctx;

  const aliasMap = () => new Map(db.prepare('SELECT rule_role, position FROM role_aliases').all().map(r => [r.rule_role, r.position]));
  /** The position that performs an approval-rule role (e.g. "Entity Finance Lead" -> "Finance"). Unlisted roles stand for themselves. */
  const positionOf = (ruleRole, map = aliasMap()) => map.get(ruleRole) ?? ruleRole;

  function profileOf(role) {
    const r = db.prepare('SELECT * FROM role_profiles WHERE role = ?').get(role);
    if (!r) return { role, kind: 'approver', description: 'Approver position added in Config (default profile).', views: DEFAULT_VIEWS, ...Object.fromEntries(FLAGS.map(f => [f, false])) };
    return { role: r.role, kind: r.kind, description: r.description, views: JSON.parse(r.views_json), ...Object.fromEntries(FLAGS.map(f => [f, !!r[f]])) };
  }

  /** Every position that can be chosen: the defined ones plus any approval role added in Config that has no position yet. */
  function positions() {
    const defined = db.prepare('SELECT role FROM role_profiles').all().map(r => r.role);
    const map = aliasMap();
    const extra = db.prepare('SELECT DISTINCT approver_role r FROM approval_rules WHERE enabled = 1').all().map(x => positionOf(x.r, map)).filter(p => !defined.includes(p));
    const order = { requestor: 0, approver: 1, mdm: 2, admin: 3 };
    return [...new Set([...defined, ...extra])].map(profileOf).sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  }

  const regions = () => {
    const f = db.prepare("SELECT validation FROM domain_fields WHERE domain = 'customer' AND name = 'country'").get();
    return ['ALL', ...(f?.validation ? f.validation.split('|') : [])];
  };

  /** Resolve the declared position/region (request headers) into the acting context. Unknown positions resolve to null. */
  function whoFromHeaders(h) {
    const dec = v => { try { return decodeURIComponent(v || ''); } catch { return ''; } };
    const role = dec(h['x-role']), region = dec(h['x-region']).toUpperCase() || 'ALL';
    if (!role || !positions().some(p => p.role === role)) return null;
    return { user_id: role, actor: role, name: role, role, region: regions().includes(region) ? region : 'ALL', profile: profileOf(role) };
  }

  /** perm: 'any' | 'view:<name>' | one of FLAGS | an array meaning "any of these". */
  function allowed(who, perm) {
    if (!who?.profile) return false;
    if (Array.isArray(perm)) return perm.some(p => allowed(who, p));
    if (perm === 'any') return true;
    if (perm.startsWith('view:')) return who.profile.views.includes(perm.slice(5));
    return !!who.profile[perm];
  }

  /** Region scope: "All regions" sees everything; a country sees that country and records that have no country (items, cost centers). */
  const inRegion = (who, country) => !who?.region || who.region === 'ALL' || !country || country === who.region;

  /**
   * Which requests a position may see: inside its region, and either it oversees the process, raised the request,
   * has a step on the approval path, or already acted on it.
   */
  function visible(who, req) {
    if (!who?.profile) return true; // internal calls without an acting position
    if (!inRegion(who, req.country)) return false;
    if (who.profile.sees_all_requests || req.requested_role === who.role || req.requested_by === who.role) return true;
    const map = aliasMap();
    if ((req.approval_path || '').split('>').map(s => positionOf(s.trim(), map)).includes(who.role)) return true;
    return !!db.prepare('SELECT 1 FROM audit_log a LEFT JOIN actor_positions p ON p.actor = a.actor WHERE a.request_id = ? AND (a.actor = ? OR p.position = ?) LIMIT 1').get(req.request_id, who.role, who.role);
  }

  function me(who) {
    return { role: who.role, region: who.region, kind: who.profile.kind, description: who.profile.description, views: who.profile.views,
      can: Object.fromEntries(FLAGS.map(f => [f, who.profile[f]])), seesSensitive: ctx.master.canSee(who) };
  }

  return { profileOf, positions, regions, positionOf, aliasMap, whoFromHeaders, allowed, inRegion, visible, me };
}

module.exports = { makeAccess, FLAGS };
