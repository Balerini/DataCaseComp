# Data notes: how the app uses `mdm_fake_data_all.csv`

The CSV is the source of truth and is **never modified**. The app reads it, derives views in memory, and keeps everything it creates in a separate SQLite file (`data/app.db`, git-ignored).

## 1. What the CSV actually is

One file, 48 columns, 2,416 data rows. Several tables are stacked together and distinguished by the `table` column; each table uses only its own columns (the rest are empty). `src/csv.js` splits them and drops columns that are empty for a table.

| `table` | Rows | Columns used | Role in the app |
|---|---:|---|---|
| `customers` | 240 | customer_id, name, entity, country, uen, address | Master records. Duplicate detection, intake lookups, analytics identity |
| `golden_map` | 240 | customer_id, golden_id, is_survivor, match_reason | Provided canonical mapping (166 golden ids). Also the **reference for evaluating the matcher** |
| `purchase_orders` | 1,500 | po_id, customer_id, country, date, product (A/B/C), qty, value (SGD) | All analytics and forecasting |
| `config_domains` | 15 | domain, field_name, data_type, required, validation, description | Drives dropdown values and input validation |
| `config_approval_rules` | 12 | rule_id, country, request_type, condition, step, approver_role, sla_hours | Drives approval routing |
| `requests` | 40 | request_id, request_type, entity, country, target_customer_id, requested_by, created_at, status, current_step, approval_path, payload_json | Imported once into app DB as existing workflow history |
| `audit_log` | 169 | log_id, request_id, ts, actor, action, from/to_status, comment | Imported once into app DB |
| `inbox_messages` | 200 | msg_id, received_at, from_email, text, true_label | Loaded and profiled; **not used** by any feature in this scope |

Observed properties: no malformed rows; every PO's `customer_id` exists in `customers`; PO country always equals the customer's country; every customer has a `golden_map` row; no golden group spans countries.

## 2. Imported / derived / application records

| Layer | Where | Examples |
|---|---|---|
| **Imported** | CSV (read-only) + `requests`/`audit_log` rows with `source='imported'` | customers, POs, golden_map; the 40 CSV requests and 169 audit events |
| **Derived** | in memory, rebuilt on demand | normalised names/addresses, clusters, raw-vs-dedup customer identity, monthly series, forecasts |
| **Application** | `data/app.db` | `requests`/`audit_log` with `source='app'` (ids `NEW-0001`, `AL000001`), `app_customers` (ids `N00001`), `customer_overrides`, `canonical_overrides`, `inactive_customers`, `export_batches` |

Applying an approved request writes to the overlay tables only. The model overlays them on the CSV (an updated address shows in the app; the CSV row is unchanged and its `original` values stay available).

**Refreshing the CSV.** The CSV's hash is recorded in `import_runs`. On start, or via *Data & quality → Re-read CSV*, new `request_id`/`log_id` values are inserted with `INSERT OR IGNORE`. Existing rows, including any decision made in the app, are never overwritten, and a restart never duplicates anything. Customers, POs and golden_map are read fresh from the file each time.

## 3. Column mapping to the app model

| App concept | CSV source | Notes |
|---|---|---|
| Customer name / address / country / entity | `customers.*` | Validated by `config_domains` regexes |
| Registration no. | `customers.uen` | 20 customers have none. 13 contain separators (`7173-327540153`) and are normalised (strip non-alphanumerics, upper-case) before comparing and before validating |
| Hard match key | normalised `uen` + same `country` | Used only when both sides have one |
| Raw customer | `customer_id` | |
| Deduplicated customer | `golden_map.golden_id` + `canonical_overrides` | Same PO rows, different identity key |
| Country / product / month | PO `country`, `product`, `date` | Entity is derived through the PO's customer |
| Approval path | rules in `config_approval_rules` | Roles from `approver_role`; conditions parsed from the `condition` text |

## 4. Gaps, assumptions, limits (nothing was invented to fill them)

1. **History is 21 months (2025-01-01 → 2026-09-30), not 24.** Nothing was fabricated. The forecast page says so. The 3-month holdout leaves 18 training months; each seasonal factor therefore rests on one prior-year observation.
2. **No open/closed status on POs.** Rule R07 (`open_po_value_sgd > 50000`) uses a *proxy*: PO value dated in the last `OPEN_PO_WINDOW_DAYS` (default 30) before the data's last PO date. With a 14–30 day window the engine adds a Finance step to 2 of the CSV's 8 merge requests (REQ0001, REQ0040) that the CSV does not have (3 with 60–90 days); with ≤7 days all 40 CSV paths are reproduced. The CSV never exercises R07, so the true definition is unknown. The default errs towards more oversight.
3. **Update requests carry `"<<new value>>"` placeholders** (all 18). They can be routed but not applied or exported; drafts can be given a real value in the UI.
4. **Merge duplicated in the CSV:** REQ0019, REQ0026 (applied) and REQ0028 (pending) are the same C00141→C00178 merge.
5. **No users/permissions.** The "Acting as" role is a workflow control, not authentication. Requesters can't approve their own requests, and the acting role must match the awaiting step.
6. **Customer attributes missing for SAP B1:** GroupCode, Currency, payment terms, contacts, tax code. They are exported blank and listed per row in `MissingOrToConfirm`. `CardCode` numbering is unconfirmed. Address splitting (street/city/zip) is heuristic and flagged when it doesn't fit.
7. **SAP B1 export is a file only.** No integration exists, and the app never claims anything was imported. Column names follow common B1 Business Partner import fields; check them against your own template. Imported requests already `applied` in the CSV are excluded by default (the data doesn't show whether they reached SAP).
8. **Drop-off ("churn") is inferred** from absence of POs in a window; there is no contract/closure data.
9. **Currency:** all values are SGD per `config_domains`; no FX is applied.
10. `inbox_messages` is unused here.

## 5. Matching method and measured quality

Normalisation: lower-case, strip punctuation/diacritics, drop legal-form tokens (pte, ltd, sdn, bhd, co, pt, tbk, joint stock company…), token-sort the name; expand address abbreviations (Jl/Jln→jalan, Rd→road…). Score = 0.65·name similarity + 0.35·address similarity (Levenshtein ratio); an exact normalised registration number in the same country lifts the score to ≥0.9; conflicting registration numbers cap it at 0.6; a different country halves it. Bands: ≥0.90 duplicate, ≥0.75 possible.

Against the provided `golden_map` (all 28,680 record pairs): precision 1.000, recall 0.991 (110 of 111 true pairs). The one miss, C00141 / C00178, has a typo ("SDNN") and no registration number; it scores 0.829 and is surfaced as "possible". All 6 `near_miss_distinct_company` decoys stay separate. Thresholds were set once, not tuned to this reference. This is evaluation on the data the design was developed against, so treat it as a sanity check, not an out-of-sample estimate.

## 6. Forecast evaluation (PO value, all countries, holdout 2026-07 → 2026-09)

| Model | WAPE | MAPE |
|---|---:|---:|
| Rolling 3-month average (flat) | 14.4% | 12.9% |
| Seasonal: last year × level ratio | 11.2% | 10.4% |
| Seasonal naive: last year | 21.1% | 20.3% |

By country the ranking is not stable: seasonal wins for MY, but the rolling average wins for SG, ID and VN and seasonal-naive for TH. With 3 test points and ~15 POs per country-month, treat the forecast as indicative. The *Forecast* page shows the full per-country table.
