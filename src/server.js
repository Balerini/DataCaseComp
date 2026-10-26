'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadSource, SOURCE_CSV } = require('./csv');
const { openDb, importWorkflow } = require('./store');
const { buildModel } = require('./model');
const analytics = require('./analytics');
const { forecast } = require('./forecast');
const { clusterAll, evaluate, DEFAULTS } = require('./matching');
const { makeWorkflow, HttpError } = require('./workflow');
const sap = require('./sap');
const quality = require('./quality');

function createApp({ csv = SOURCE_CSV, dbFile } = {}) {
  const db = openDb(dbFile);
  let source = loadSource(csv);
  const lastImport = db.prepare('SELECT * FROM import_runs ORDER BY id DESC LIMIT 1').get();
  // Import on first start, or when the CSV content changed. Re-importing identical content is a no-op either way.
  let importResult = (!lastImport || lastImport.csv_hash !== source.hash) ? importWorkflow(db, source) : { requestsAdded: 0, auditAdded: 0, skipped: 'CSV unchanged since last import' };
  let model = buildModel(source, db);
  const ctx = {
    db, getSource: () => source, getModel: () => model,
    refreshModel: () => { model = buildModel(source, db); },
  };
  const wf = makeWorkflow(ctx);

  const filt = q => ({
    country: q.get('country') || undefined, product: q.get('product') || undefined, entity: q.get('entity') || undefined,
    from: q.get('from') || undefined, to: q.get('to') || undefined,
  });
  const basisOf = q => (q.get('basis') === 'raw' ? 'raw' : 'dedup');
  const custView = c => ({
    customer_id: c.customer_id, name: c.name, entity: c.entity, country: c.country, uen: c.uen, address: c.address,
    golden_id: model.golden.get(c.customer_id), is_survivor: model.survivor.get(model.golden.get(c.customer_id)) === c.customer_id,
    origin: c.origin, active: c.active, modified: c.origin === 'imported' && ['name', 'uen', 'address'].some(k => c[k] !== c.original[k]),
  });

  const routes = {
    'GET /api/meta': () => ({
      source: { file: path.basename(source.file), hash: source.hash, rowCount: source.rowCount, tables: Object.fromEntries(Object.entries(source.tables).map(([k, v]) => [k, v.length])) },
      imports: db.prepare('SELECT * FROM import_runs ORDER BY id DESC LIMIT 5').all(), lastImportResult: importResult,
      coverage: { ...analytics.coverage(model), monthList: undefined }, asOf: model.asOf, options: wf.options(), thresholds: DEFAULTS,
      appData: {
        requests: db.prepare('SELECT source, COUNT(*) n FROM requests GROUP BY source').all(),
        newCustomers: db.prepare('SELECT COUNT(*) n FROM app_customers').get().n,
        fieldOverrides: db.prepare('SELECT COUNT(*) n FROM customer_overrides').get().n,
        canonicalOverrides: db.prepare('SELECT COUNT(*) n FROM canonical_overrides').get().n,
        inactive: db.prepare('SELECT COUNT(*) n FROM inactive_customers').get().n,
      },
    }),
    'GET /api/profile': () => quality.profile(source),
    'GET /api/findings': () => quality.findings(source, model),
    'GET /api/capabilities': () => quality.CAPABILITIES,
    'GET /api/validate': () => quality.validate(source, model, db),
    'POST /api/source/refresh': () => {
      source = loadSource(csv);
      importResult = importWorkflow(db, source); // INSERT OR IGNORE: existing requests/decisions are never overwritten
      ctx.refreshModel();
      return { importResult, hash: source.hash };
    },

    'GET /api/customers': ({ q }) => {
      const term = (q.get('q') || '').toLowerCase(), country = q.get('country'), entity = q.get('entity');
      const lim = Math.min(Number(q.get('limit') || 50), 500);
      const out = [...model.customers.values()].filter(c => (!country || c.country === country) && (!entity || c.entity === entity)
        && (!term || `${c.customer_id} ${c.name} ${c.uen} ${c.address} ${model.golden.get(c.customer_id)}`.toLowerCase().includes(term)));
      return { total: out.length, rows: out.slice(0, lim).map(custView) };
    },
    'GET /api/customers/:id': ({ params }) => {
      const c = model.customers.get(params.id);
      if (!c) throw new HttpError(404, 'Customer not found');
      const gid = model.golden.get(c.customer_id);
      const pos = model.pos.filter(p => p.customer_id === c.customer_id);
      return {
        ...custView(c), original: c.original, groupMembers: (model.goldenMembers.get(gid) || []).map(i => custView(model.customers.get(i))),
        pos: { count: pos.length, value: pos.reduce((s, p) => s + p.value, 0), last: pos.reduce((m, p) => (p.date > m ? p.date : m), '') },
      };
    },

    'POST /api/intake/preview': ({ body }) => wf.preview(body),
    'POST /api/requests': ({ body }) => wf.createRequest(body),
    'GET /api/requests': ({ q }) => wf.listRequests({ status: q.get('status') || undefined, role: q.get('role') || undefined, type: q.get('type') || undefined, source: q.get('source') || undefined, q: q.get('q') || undefined }),
    'GET /api/requests/:id': ({ params }) => wf.getRequest(params.id),
    'POST /api/requests/:id/submit': ({ params, body }) => wf.submitDraft(params.id, body.actor || 'unknown'),
    'POST /api/requests/:id/new-value': ({ params, body }) => wf.setDraftNewValue(params.id, body.value),
    'POST /api/requests/:id/decide': ({ params, body }) => wf.decide(params.id, body),
    'POST /api/requests/:id/apply': ({ params, body }) => wf.apply(params.id, body.actor || 'unknown'),

    'GET /api/duplicates/groups': () => {
      const groups = [...model.goldenMembers].filter(([, ids]) => ids.length > 1).map(([gid, ids]) => ({
        golden_id: gid, members: ids.map(i => {
          const g = (source.tables.golden_map || []).find(x => x.customer_id === i);
          return { ...custView(model.customers.get(i)), match_reason: g?.match_reason };
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
    'POST /api/duplicates/check': ({ body }) => wf.preview({ ...body, request_type: 'create_customer' }),

    'GET /api/analytics/overview': ({ q }) => analytics.overview(model, filt(q), basisOf(q)),
    'GET /api/analytics/top-customers': ({ q }) => analytics.topCustomers(model, filt(q), basisOf(q), Number(q.get('n') || 15)),
    'GET /api/analytics/dropoff': ({ q }) => analytics.dropOff(model, filt(q), basisOf(q), Number(q.get('days') || 90)),
    'GET /api/analytics/crosssell': ({ q }) => analytics.crossSell(model, filt(q), basisOf(q)),
    'GET /api/analytics/dedup-impact': ({ q }) => analytics.dedupImpact(model, filt(q), Number(q.get('days') || 90)),
    'GET /api/forecast': ({ q }) => forecast(model, filt(q), { metric: q.get('metric') || 'value', basis: q.get('basis') || 'dedup', holdout: Number(q.get('holdout') || 3), horizon: Number(q.get('horizon') || 3) }),

    'GET /api/forecast/summary': ({ q }) => {
      const countries = [...new Set(model.pos.map(p => p.country))].sort();
      const row = (label, f) => {
        const r = forecast(model, f, { metric: q.get('metric') || 'value' });
        return { scope: label, months: r.months, metrics: r.backtest?.metrics ?? null, selected: r.forecast?.selectedByBacktest ?? null, forecast: r.forecast };
      };
      return [row('All', {}), ...countries.map(c => row(c, { country: c }))];
    },
    'GET /api/sap/preview': ({ q }) => sap.buildExport(db, model, { includeExported: q.get('includeExported') === '1', includeImported: q.get('includeImported') === '1' }),
    'POST /api/sap/export': ({ body }) => {
      const ex = sap.buildExport(db, model, { includeExported: !!body.includeExported, includeImported: !!body.includeImported });
      if (!ex.rows.length) throw new HttpError(409, 'No eligible approved requests to export', { excluded: ex.excluded });
      const fileName = `sapb1_bp_export_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.csv`;
      const batchId = sap.recordBatch(db, ex, fileName);
      return { batchId, fileName, csv: sap.toCsv(ex), rows: ex.rows.length, excluded: ex.excluded, statement: ex.statement };
    },
    'GET /api/sap/batches': () => db.prepare('SELECT * FROM export_batches ORDER BY id DESC').all(),
  };

  // compile patterns
  const table = Object.entries(routes).map(([k, fn]) => {
    const [method, p] = k.split(' ');
    const names = [];
    const re = new RegExp('^' + p.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
    return { method, re, names, fn };
  });

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  const PUB = path.join(__dirname, '..', 'public');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const r of table) {
          if (r.method !== req.method) continue;
          const mt = url.pathname.match(r.re);
          if (!mt) continue;
          const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(mt[i + 1])]));
          let body = {};
          if (req.method === 'POST') {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const txt = Buffer.concat(chunks).toString('utf8');
            try { body = txt ? JSON.parse(txt) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
          }
          return send(200, await r.fn({ q: url.searchParams, params, body }));
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
  return { server, db, ctx, wf, routes };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.server.listen(port, '127.0.0.1', () => console.log(`MDM app on http://127.0.0.1:${port}  (source CSV is read-only; app data in data/app.db)`));
}

module.exports = { createApp };
