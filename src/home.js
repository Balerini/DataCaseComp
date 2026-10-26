'use strict';
// Role-aware landing page: each position gets the sections relevant to its job, nothing else.
const insights = require('./insights');
const inbox = require('./inbox');
const sap = require('./sap');

const slim = r => ({
  request_id: r.request_id, source: r.source, domain: r.domain, request_type: r.request_type, entity: r.entity, country: r.country, target: r.target_customer_id,
  requested_by: r.requested_by_label, created_at: r.created_at, status: r.status, awaiting: r.awaiting_position, path: r.path_positions, step_index: r.step_index, waiting: r.waiting, can: r.can,
});

function buildHome(ctx, who) {
  const { db, wf, access, master } = ctx, p = who.profile, model = ctx.scoped(who), sections = [];
  const reqs = wf.listRequests({}, who);
  const aliases = access.aliasMap(), approverRoles = new Set(db.prepare('SELECT DISTINCT approver_role r FROM approval_rules WHERE enabled = 1').all().map(x => access.positionOf(x.r, aliases)));
  const count = (list, f) => list.filter(f).length;

  // Requestors lead with their own requests. Everyone else leads with their job (queue / workbench) and only shows
  // "my requests" if they have raised something.
  const mine = reqs.filter(r => r.can?.mine);
  if (p.can_request && (p.kind === 'requestor' || mine.length)) {
    sections.push({ type: 'mine', title: 'My requests',
      counts: { draft: count(mine, r => r.status === 'draft'), pending: count(mine, r => r.status === 'pending_approval'), approved: count(mine, r => r.status === 'approved'),
        applied: count(mine, r => r.status === 'applied'), rejected: count(mine, r => r.status === 'rejected') },
      items: mine.slice(0, 15).map(slim) });
  }

  if (approverRoles.has(who.role)) {
    const queue = reqs.filter(r => r.awaiting_position === who.role && !r.can?.mine);
    const upcoming = reqs.filter(r => r.status === 'pending_approval' && r.awaiting_position !== who.role && r.path_positions.some((p, i) => p === who.role && i > r.step_index));
    const decided = db.prepare("SELECT a.request_id, a.action, a.ts, a.comment, r.request_type, r.status FROM audit_log a JOIN requests r ON r.request_id = a.request_id LEFT JOIN actor_positions p ON p.actor = a.actor WHERE (a.actor = ? OR p.position = ?) AND a.action IN ('approved','rejected') ORDER BY a.ts DESC LIMIT 8").all(who.role, who.role);
    sections.push({ type: 'queue', title: 'Waiting for my decision', position: who.role,
      queue: queue.sort((a, b) => (b.waiting?.hours ?? 0) - (a.waiting?.hours ?? 0)).map(slim), overdue: count(queue, r => r.waiting?.overdue),
      upcoming: upcoming.map(slim), decided, sensitive: master.canSee(who) });
  }

  if (p.can_apply || p.can_export || p.can_triage) {
    const t = inbox.triage(model, db).summary, ready = reqs.filter(r => r.status === 'approved');
    const exportRows = master.domains().map(d => ({ domain: d.key, label: d.label, rows: sap.buildExport(db, model, master, { domain: d.key }).rows.length }));
    const pend = reqs.filter(r => r.status === 'pending_approval');
    sections.push({ type: 'apply', title: 'MDM team workbench',
      ready: ready.map(slim), exportRows, stuck: count(pend, r => r.waiting?.overdue), pending: pend.length,
      oldestPending: pend.sort((a, b) => b.waiting.hours - a.waiting.hours).slice(0, 5).map(slim),
      inbox: { mdmEmails: t.perClass.find(c => c.label === 'MDM request')?.predicted ?? 0, orderEmailsUnidentified: t.extraction.orderTotal - t.extraction.orderCustomerResolved, total: t.total },
      duplicateGroups: [...model.goldenMembers.values()].filter(a => a.length > 1).length });
  }

  if (p.views.includes('regional')) {
    const mx = insights.matrix(model, 6);
    sections.push({ type: 'insights', title: 'Commercial picture', window: mx.window, growth: mx.total.growth, value: mx.total.value,
      countries: mx.rows.map(r => ({ country: r.country, value: r.total.value, growth: r.total.growth })).sort((a, b) => (b.growth ?? -9) - (a.growth ?? -9)),
      actions: insights.actions(model, db).slice(0, 4) });
  }

  if (p.can_config) {
    sections.push({ type: 'admin', title: 'Administration',
      positions: access.positions().length,
      recentChanges: db.prepare("SELECT ts, field, new_value FROM change_log WHERE domain = 'config' ORDER BY id DESC LIMIT 5").all(),
      rules: db.prepare('SELECT COUNT(*) n FROM approval_rules WHERE enabled = 1').get().n });
  }

  if (master.canSee(who)) {
    sections.push({ type: 'sensitive', title: 'Sensitive-field access',
      reveals7d: db.prepare("SELECT COUNT(*) n FROM sensitive_access_log WHERE ts >= ?").get(new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 16)).n,
      recent: db.prepare('SELECT ts, role, domain, record_id, field FROM sensitive_access_log ORDER BY id DESC LIMIT 5').all() });
  }

  if (p.kind !== 'requestor') sections.sort((a, b) => (a.type === 'mine') - (b.type === 'mine')); // their own requests come after their job
  return { user: access.me(who), sections };
}

module.exports = { buildHome };
