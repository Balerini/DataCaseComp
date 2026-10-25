# DataCaseComp — MDM hub, regional analytics, forecasting, SAP B1 export

Built on the existing **`mdm_fake_data_all.csv`** (read-only source of truth). No replacement data is generated.

## Run

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`; no npm dependencies).

```
npm start          # http://127.0.0.1:3000   (PORT=… to change)
npm test           # 8 end-to-end tests
npm run validate   # reconciliation + matcher + approval-engine checks against the CSV
```

Env: `MDM_CSV` (alternate CSV path), `MDM_DB` (alternate SQLite path, default `data/app.db`), `OPEN_PO_WINDOW_DAYS` (default 30).

## What's in it

| Screen | What it does | Data it uses |
|---|---|---|
| Overview | Country/product/customer KPIs, monthly trend, growth; raw vs deduplicated switch | `purchase_orders`, `customers`, `golden_map` |
| Intake | Create / update / merge / deactivate requests; live validation, duplicate candidates with scores and reasons, approval route preview | `config_domains`, `config_approval_rules`, all customers |
| Requests | Queue, step-by-step approvals, reject-with-comment, apply, audit trail | CSV `requests`/`audit_log` (imported once) + new requests in `data/app.db` |
| Duplicates | Golden groups, matcher precision/recall vs the provided mapping | `customers`, `golden_map` |
| Analytics | Top customers, drop-off, cross-sell, raw-vs-dedup comparison | `purchase_orders` |
| Forecast | Rolling-average vs seasonal model, 3-month holdout, WAPE/MAPE, per-country table | monthly PO history |
| SAP B1 export | Business Partner CSV from approved requests, with missing fields flagged per row | approved/applied requests |
| Data & quality | CSV profile, findings, validation checks, what the data can't support | everything |

## Principles followed

- The CSV is never written; the app keeps its own data in `data/app.db` (requests, decisions, audit events, new customers, field updates, merge mappings, export batches).
- Re-importing the CSV is idempotent and never overwrites decisions.
- Raw and deduplicated analytics use the same PO rows; only the customer identity key changes.
- Gaps are reported, not filled: only 21 months of PO history, no PO open/closed status, placeholder values in update requests, no SAP B1 customer group/currency. See **[docs/DATA_NOTES.md](docs/DATA_NOTES.md)** for the schema mapping, assumptions and measured results.
- The SAP export is a generated file only. Nothing is sent to, or imported into, SAP B1.
- There is no authentication: the "Acting as" user and role are workflow controls, not access control.
