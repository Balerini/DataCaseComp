'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadSource, SOURCE_CSV } = require('./csv');
const { openDb, importWorkflow, importMaster } = require('./store');
const { buildModel } = require('./model');
const analytics = require('./analytics');
const insights = require('./insights');
const { forecast } = require('./forecast');
const { clusterAll, DEFAULTS } = require('./matching');
const { makeMaster } = require('./masterdata');
const { makeWorkflow, HttpError } = require('./workflow');
const { makeAccess } = require('./access');
const { buildHome } = require('./home');
const { makeConfig, ConfigError } = require('./config');
const inbox = require('./inbox');
const sap = require('./sap');
const quality = require('./quality');

function createApp({ csv = SOURCE_CSV, dbFile } = {}) {
  const db = openDb(dbFile);
  let source = loadSource(csv);
  let importResult;

  /** Copy the CSV into the app DB (idempotent) and record the run if anything was added or the file changed. */
  function runImports() {
    const last = db.prepare('SELECT * FROM import_runs ORDER BY id DESC LIMIT 1').get();
    const wf = importWorkflow(db, source), master = importMaster(db, source);
    const added = wf.requestsAdded + wf.auditAdded + master.customers + master.purchaseOrders + master.items + master.inbox;
    if (!last || last.csv_hash !== source.hash || added) {
      db.prepare(`INSERT INTO import_runs (csv_hash, csv_file, at, requests_added, audit_added, requests_seen, audit_seen, detail_json) VALUES (?,?,?,?,?,?,?,?)`)
        .run(source.hash, path.basename(source.file), new Date().toISOString(), wf.requestsAdded, wf.auditAdded, wf.requestsSeen, wf.auditSeen, JSON.stringify(master));
    }
    return { ...wf, master, changed: !last || last.csv_hash !== source.hash || added > 0 };
  }
  importResult = runImports();

  let model = buildModel(source, db);
  const ctx = { db, getSource: () => source, getModel: () => model, refreshModel: () => { model = buildModel(source, db); } };
  ctx.master = makeMaster(ctx);
  ctx.access = makeAccess(ctx);
  const wf = makeWorkflow(ctx), config = makeConfig(ctx);
  ctx.wf = wf;
  const access = ctx.access;

  /** The model as seen from a region: purchase orders restricted to that country ("All regions" sees everything). */
  const scoped = who => (!who?.region || who.region === 'ALL' ? model : { ...model, pos: model.pos.filter(p => p.country === who.region) });
  ctx.scoped = scoped;

  const filt = q => ({ country: q.get('country') || undefined, product: q.get('product') || undefined, entity: q.get('entity') || undefined, from: q.get('from') || undefined, to: q.get('to') || undefined });
  const basisOf = q => (q.get('basis') === 'raw' ? 'raw' : 'dedup');
  const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
  const wrapCfg = fn => args => { try { return fn(args); } catch (e) { if (e instanceof ConfigError) throw new HttpError(e.status, e.message); throw e; } };

  const routes = {
    'GET /api/meta': () => ({
      source: { file: path.basename(source.file), hash: source.hash, rowCount: source.rowCount, tables: Object.fromEntries(Object.entries(source.tables).map(([k, v]) => [k, v.length])) },
      imports: db.prepare('SELECT * FROM import_runs ORDER BY id DESC LIMIT 5').all(), lastImportResult: importResult,
      coverage: { ...analytics.coverage(model), monthList: undefined }, asOf: model.asOf, options: wf.options(), thresholds: DEFAULTS,
      master: ctx.master.summary(),
      db: Object.fromEntries(['md_customers', 'md_records', 'md_purchase_orders', 'md_customer_items', 'md_inbox', 'requests', 'audit_log', 'domain_fields', 'approval_rules', 'change_log', 'sensitive_access_log']
        .map(t => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n])),
      appData: {
        requests: db.prepare('SELECT source, COUNT(*) n FROM requests GROUP BY source').all(),
        newRecords: db.prepare("SELECT (SELECT COUNT(*) FROM md_customers WHERE source='app') + (SELECT COUNT(*) FROM md_records WHERE source='app') n").get().n,
      },
    }),
    'GET /api/profile': () => quality.profile(source),
    'GET /api/findings': () => quality.findings(source, model, db),
    'GET /api/capabilities': () => quality.CAPABILITIES,
    'GET /api/validate': () => quality.validate(source, model, db),
    'POST /api/source/refresh': () => {
      source = loadSource(csv);
      importResult = runImports(); // INSERT OR IGNORE: existing records, requests and decisions are never overwritten
      ctx.refreshModel();
      return { importResult, hash: source.hash };
    },

    // ----- master data (all domains)
    'GET /api/master/summary': () => ctx.master.summary(),
    'GET /api/master/customer/:id': ({ params, who }) => ctx.master.customerDetail(params.id, who) ?? bad('Customer not found', 404),
    'GET /api/master/:domain': ({ params, q, who }) => {
      if (!ctx.master.domainRow(params.domain)) bad('Unknown domain', 404);
      return ctx.master.list(params.domain, { q: q.get('q'), country: q.get('country'), entity: q.get('entity'), limit: Math.min(Number(q.get('limit') || 50), 500), offset: Number(q.get('offset') || 0), region: who?.region }, who);
    },
    'GET /api/master/:domain/:id': ({ params, who }) => ctx.master.recordDetail(params.domain, params.id, who) ?? bad('Record not found', 404),
    'GET /api/customers': ({ q, who }) => ctx.master.list('customer', { q: q.get('q'), country: q.get('country'), entity: q.get('entity'), limit: Math.min(Number(q.get('limit') || 50), 500), region: who?.region }, who),
    'GET /api/customers/:id': ({ params, who }) => ctx.master.customerDetail(params.id, who) ?? bad('Customer not found', 404),
    'GET /api/sensitive-access': ({ who }) => (ctx.master.canSee(who) ? db.prepare('SELECT * FROM sensitive_access_log ORDER BY id DESC LIMIT 100').all() : bad('Restricted to roles allowed to view sensitive fields', 403)),

    // ----- configuration (no-code domain / field / rule changes)
    'GET /api/config': () => config.snapshot(),
    'POST /api/config/domain': wrapCfg(({ body, who }) => config.addDomain(body, who?.actor)),
    'POST /api/config/field': wrapCfg(({ body, who }) => config.saveField(body, who?.actor)),
    'POST /api/config/field/delete': wrapCfg(({ body, who }) => config.deleteField(body, who?.actor)),
    'POST /api/config/rule': wrapCfg(({ body, who }) => config.saveRule(body, who?.actor)),
    'POST /api/config/rule/toggle': wrapCfg(({ body, who }) => config.toggleRule(body, who?.actor)),
    'POST /api/config/settings': wrapCfg(({ body, who }) => config.saveSettings(body, who?.actor)),

    // ----- intake & workflow
    'POST /api/intake/preview': ({ body }) => wf.preview(body),
    // identity always comes from the session when there is one: the body can never name the requester or approver
    'POST /api/requests': ({ body, who }) => wf.createRequest(who?.user_id ? { ...body, requested_by: who.user_id } : body, who),
    'GET /api/requests': ({ q, who }) => wf.listRequests({ mine: q.get('mine') === '1', status: q.get('status') || undefined, role: q.get('role') || undefined, type: q.get('type') || undefined, source: q.get('source') || undefined, domain: q.get('domain') || undefined, q: q.get('q') || undefined }, who),
    'GET /api/requests/:id': ({ params, who }) => wf.getRequest(params.id, who),
    'POST /api/requests/:id/submit': ({ params, body, who }) => wf.submitDraft(params.id, who?.user_id || body.actor || 'unknown', who),
    'POST /api/requests/:id/new-value': ({ params, body, who }) => wf.setDraftNewValue(params.id, body.value, who),
    'POST /api/requests/:id/decide': ({ params, body, who }) => {
      wf.getRequest(params.id, who); // 403 if the request is outside this person's lane
      return wf.decide(params.id, who?.user_id ? { ...body, actor: who.user_id, role: who.role } : body);
    },
    'POST /api/requests/:id/apply': ({ params, body, who }) => wf.apply(params.id, who?.user_id || body.actor || 'unknown'),

    // ----- identity ("Acting as" position + optional region) and the role-aware home
    'GET /api/positions': () => ({ positions: access.positions(), regions: access.regions(), aliases: db.prepare('SELECT * FROM role_aliases ORDER BY position, rule_role').all() }),
    'GET /api/me': ({ who }) => access.me(who),
    'GET /api/home': ({ who }) => buildHome(ctx, who),

    // ----- duplicates
    'GET /api/duplicates/groups': () => {
      const groups = [...model.goldenMembers].filter(([, ids]) => ids.length > 1).map(([gid, ids]) => ({
        golden_id: gid, members: ids.map(i => {
          const g = (source.tables.golden_map || []).find(x => x.customer_id === i);
          return { ...ctx.master.custView(model, model.customers.get(i)), match_reason: g?.match_reason };
        }),
      }));
      return { total: groups.length, groups };
    },
    'GET /api/duplicates/evaluation': () => quality.validate(source, model, db).evaluation,
    'GET /api/duplicates/clusters': () => {
      const pool = [...model.customers.values()].filter(c => c.origin === 'imported').map(c => ({ ...c, ...c.original }));
      const { pairs, clusterOf } = quality.memoised(source, 'clusters', () => clusterAll(pool));
      const groups = new Map();
      for (const [cid, root] of clusterOf) (groups.get(root) ?? groups.set(root, []).get(root)).push(cid);
      return { pairs: pairs.length, clusters: [...groups.values()].filter(g => g.length > 1).length, distinctAfterMatching: groups.size, distinctInGoldenMap: new Set((source.tables.golden_map || []).map(g => g.golden_id)).size };
    },
    'POST /api/duplicates/check': ({ body }) => wf.preview({ ...body, request_type: body.request_type || 'create_customer' }),

    // ----- inbox triage
    'GET /api/inbox': ({ q }) => {
      const t = inbox.triage(model, db), label = q.get('label'), term = (q.get('q') || '').toLowerCase();
      const items = t.items.filter(i => (!label || i.predicted === label) && (!term || JSON.stringify(i).toLowerCase().includes(term)));
      return { summary: t.summary, total: items.length, items: items.slice(Number(q.get('offset') || 0), Number(q.get('offset') || 0) + Math.min(Number(q.get('limit') || 60), 300)) };
    },

    // ----- analytics & regional view
    'GET /api/analytics/triage-summary': () => inbox.triage(model, db).summary,
    'GET /api/analytics/overview': ({ q, who }) => analytics.overview(scoped(who), filt(q), basisOf(q)),
    'GET /api/analytics/top-customers': ({ q, who }) => analytics.topCustomers(scoped(who), filt(q), basisOf(q), Number(q.get('n') || 15)),
    'GET /api/analytics/dropoff': ({ q, who }) => analytics.dropOff(scoped(who), filt(q), basisOf(q), Number(q.get('days') || 90)),
    'GET /api/analytics/crosssell': ({ q, who }) => analytics.crossSell(scoped(who), filt(q), basisOf(q)),
    'GET /api/analytics/dedup-impact': ({ q, who }) => analytics.dedupImpact(scoped(who), filt(q), Number(q.get('days') || 90)),
    'GET /api/analytics/matrix': ({ q, who }) => insights.matrix(scoped(who), Number(q.get('period') || 6)),
    'GET /api/analytics/orders-vs-mdm': ({ who }) => insights.ordersVsMdm(scoped(who), db, who?.region),
    'GET /api/analytics/actions': ({ who }) => insights.actions(scoped(who), db),
    'GET /api/forecast': ({ q, who }) => forecast(scoped(who), filt(q), { metric: q.get('metric') || 'value', basis: q.get('basis') || 'dedup', holdout: Number(q.get('holdout') || 3), horizon: Number(q.get('horizon') || 3) }),
    'GET /api/forecast/summary': ({ q, who }) => {
      const m = scoped(who), countries = [...new Set(m.pos.map(p => p.country))].sort();
      const row = (label, f) => {
        const r = forecast(m, f, { metric: q.get('metric') || 'value' });
        return { scope: label, months: r.months, metrics: r.backtest?.metrics ?? null, selected: r.forecast?.selectedByBacktest ?? null, forecast: r.forecast };
      };
      return [row('All', {}), ...countries.map(c => row(c, { country: c }))];
    },

    // ----- SAP B1 export
    'GET /api/sap/preview': ({ q }) => sap.buildExport(db, model, ctx.master, { domain: q.get('domain') || 'customer', includeExported: q.get('includeExported') === '1', includeImported: q.get('includeImported') === '1' }),
    'POST /api/sap/export': ({ body }) => {
      const ex = sap.buildExport(db, model, ctx.master, { domain: body.domain || 'customer', includeExported: !!body.includeExported, includeImported: !!body.includeImported });
      if (!ex.rows.length) throw new HttpError(409, 'No eligible approved requests to export', { excluded: ex.excluded });
      const fileName = `sapb1_${ex.domain}_export_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.csv`;
      const batchId = sap.recordBatch(db, ex, fileName);
      return { batchId, fileName, csv: sap.toCsv(ex), rows: ex.rows.length, excluded: ex.excluded, statement: ex.statement };
    },
    'GET /api/sap/batches': () => db.prepare('SELECT * FROM export_batches ORDER BY id DESC').all(),
  };

  // Who may call what. 'public' needs no session; everything else needs one. A route with no entry is refused.
  const PERM = {
    'GET /api/positions': 'public',
    'GET /api/meta': 'any', 'GET /api/me': 'any', 'GET /api/home': 'any',
    'GET /api/profile': 'view:data', 'GET /api/findings': 'view:data', 'GET /api/capabilities': 'view:data', 'GET /api/validate': ['view:data', 'view:overview'],
    'POST /api/source/refresh': 'can_config',
    'GET /api/master/summary': 'view:master', 'GET /api/master/customer/:id': 'view:master', 'GET /api/master/:domain': 'view:master', 'GET /api/master/:domain/:id': 'view:master',
    'GET /api/customers': 'view:master', 'GET /api/customers/:id': 'view:master', 'GET /api/sensitive-access': 'any',
    'GET /api/config': 'can_config', 'POST /api/config/domain': 'can_config', 'POST /api/config/field': 'can_config', 'POST /api/config/field/delete': 'can_config',
    'POST /api/config/rule': 'can_config', 'POST /api/config/rule/toggle': 'can_config', 'POST /api/config/settings': 'can_config',
    'POST /api/intake/preview': 'can_request', 'POST /api/requests': 'can_request', 'GET /api/requests': 'view:requests', 'GET /api/requests/:id': 'view:requests',
    'POST /api/requests/:id/submit': 'view:requests', 'POST /api/requests/:id/new-value': 'view:requests', 'POST /api/requests/:id/decide': 'view:requests', 'POST /api/requests/:id/apply': 'can_apply',
    'GET /api/duplicates/groups': 'view:duplicates', 'GET /api/duplicates/evaluation': 'view:duplicates', 'GET /api/duplicates/clusters': 'view:duplicates', 'POST /api/duplicates/check': ['can_request', 'view:duplicates'],
    'GET /api/inbox': 'view:inbox',
    'GET /api/analytics/triage-summary': ['view:regional', 'view:inbox'],
    'GET /api/analytics/overview': ['view:overview', 'view:analytics'], 'GET /api/analytics/top-customers': ['view:overview', 'view:analytics'],
    'GET /api/analytics/dropoff': 'view:analytics', 'GET /api/analytics/crosssell': 'view:analytics', 'GET /api/analytics/dedup-impact': ['view:analytics', 'view:regional'],
    'GET /api/analytics/matrix': 'view:regional', 'GET /api/analytics/orders-vs-mdm': 'view:regional', 'GET /api/analytics/actions': 'view:regional',
    'GET /api/forecast': ['view:forecast', 'view:regional'], 'GET /api/forecast/summary': ['view:forecast', 'view:regional'],
    'GET /api/sap/preview': 'view:sap', 'POST /api/sap/export': 'can_export', 'GET /api/sap/batches': 'view:sap',
  };
  const permFor = key => PERM[key];

  const table = Object.entries(routes).map(([k, fn]) => {
    const [method, p] = k.split(' ');
    const names = [];
    const re = new RegExp('^' + p.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
    return { method, re, names, fn, pattern: p };
  });

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  const PUB = path.join(__dirname, '..', 'public');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      if (url.pathname.startsWith('/api/')) {
        // identity: the position (and optional region) chosen in "Acting as". Declared, not authenticated; permissions are still enforced per position.
        const who = access.whoFromHeaders(req.headers);
        for (const r of table) {
          if (r.method !== req.method) continue;
          const mt = url.pathname.match(r.re);
          if (!mt) continue;
          const key = `${r.method} ${r.pattern}`, perm = permFor(key);
          if (!perm) throw new HttpError(403, `No permission defined for ${key}`);
          if (perm !== 'public') {
            if (!who) throw new HttpError(401, 'Choose the position you are acting as');
            if (!access.allowed(who, perm)) throw new HttpError(403, `Your position (${who.role}) cannot do this.`);
          }
          const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(mt[i + 1])]));
          let body = {};
          if (req.method === 'POST') {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const txt = Buffer.concat(chunks).toString('utf8');
            try { body = txt ? JSON.parse(txt) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
          }
          return send(200, await r.fn({ q: url.searchParams, params, body, who }));
        }
        return send(404, { error: 'Not found' });
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.normalize(path.join(PUB, rel));
      if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message, ...e.extra });
      console.error(e);
      send(500, { error: 'Internal error: ' + e.message });
    }
  });
  return { server, db, ctx, wf, routes, config, access, PERM };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.server.listen(port, '127.0.0.1', () => console.log(`MDM app on http://127.0.0.1:${port}  (source CSV is read-only; app data in data/app.db)`));
}

module.exports = { createApp };
