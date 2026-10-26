# Data notes: how the app uses `mdm_fake_data_all.csv`

The CSV is the source of truth and is **never modified**. It is read once and copied into the application database (`data/app.db`, SQLite), where it becomes the working master data. Everything the app creates or changes afterwards is stored beside it and tagged.

## 1. What the CSV actually is

One file, 48 columns, 2,416 data rows: several tables stacked together, distinguished by the `table` column.

| `table` | Rows | Goes to | Used for |
|---|---:|---|---|
| `customers` | 240 | `md_customers` | Customer master (name, entity, country, registration no., address) |
| `golden_map` | 240 | `md_customers.golden_id / is_survivor` | Provided canonical mapping (166 golden customers); also the reference for scoring the matcher |
| `purchase_orders` | 1,500 | `md_purchase_orders` | All order analytics and forecasting |
| *(derived from POs)* | 517 | `md_customer_items` | What each customer buys: POs, units, value, first/last PO per item |
| *(derived from POs)* | 3 | `md_records` (domain `item`) | Items A, B, C |
| `inbox_messages` | 200 | `md_inbox` | Inbox triage (order / enquiry / follow-up / MDM request) |
| `config_domains` | 15 | `domain_fields` (source `csv`) | Customer field definitions and validation |
| `config_approval_rules` | 12 | `approval_rules` (source `csv`) | Customer approval routing |
| `requests` | 40 | `requests` (source `imported`) | Existing workflow history |
| `audit_log` | 169 | `audit_log` (source `imported`) | Existing audit trail |

Observed properties: no malformed rows; every PO's `customer_id` exists in `customers`; PO country always equals the customer's country; every customer has a `golden_map` row; no golden group spans countries.

## 2. Imported / derived / application records

| Layer | Where | Rule |
|---|---|---|
| **Imported** | `source='imported'` rows | Copied once, `INSERT OR IGNORE`. A refresh adds only new keys and never overwrites a row, so local edits and approval decisions survive. Rows whose CSV values changed upstream are counted and reported ("changed upstream, not applied"), not applied silently. |
| **Derived** | `md_customer_items` | Rebuilt from `md_purchase_orders` on every import. |
| **Application** | `source='app'` rows, `requests`, `audit_log`, `change_log`, `sensitive_access_log`, `export_batches` | Created through requests. Applying an approved request writes to the master tables. |

Original values of imported customers (`orig_name`, `orig_uen`, `orig_address`) are kept next to the current ones, so the CSV value is always visible. Changes to other domains are written to `change_log`.

Databases from the earlier overlay-based version are migrated on first start (overlay tables are copied into `md_customers`, then dropped).

## 3. Domains

| Domain | Records in CSV | Notes |
|---|---|---|
| Customer | 240 | Fields from `config_domains`; two proposed optional sensitive fields (`credit_terms`, `bank_account`) |
| Item | 0 (3 derived) | The CSV has no item table. A, B and C exist only as the PO `product` code and were loaded as "Product A/B/C" (how the PO and inbox data name them). Description, unit, item group and regulatory status are **not** in the data. |
| Vendor | 0 | No vendor data in the CSV. Configured, empty; records arrive through requests. |
| Cost center | 0 | No cost-center data in the CSV. Configured, empty. |

Field definitions (`domain_fields`), approval rules (`approval_rules`) and domains (`domains`) are database rows, editable on the **Config** screen. Rows are tagged `csv` (from the source), `proposed` (authored for this prototype because the CSV has nothing for it: item, vendor, cost-center fields and rules; sensitive-field rules) or `app` (added in the app). Proposed approvers follow the brief's roles: Quality/Regulatory Affairs, Business Unit Head, Business Support, Finance.

## 4. Gaps, assumptions, limits (nothing was invented to fill them)

1. **History is 21 months (2025-01-01 → 2026-09-30), not 24.** The forecast holds out 3 months and trains on 18; seasonal factors rest on one prior-year observation.
2. **No open/closed status on POs.** Rule R07 (`open_po_value_sgd > 50000`) uses a *proxy*: PO value dated in the last `OPEN_PO_WINDOW_DAYS` (default 30) before the last PO date. With a 14–30 day window the engine adds a Finance step to 2 of the CSV's 8 merge requests (REQ0001, REQ0040) that the CSV does not have; with ≤7 days all 40 CSV paths are reproduced. The CSV never exercises R07, so the true definition is unknown; the default errs towards more oversight.
3. **Update requests carry `"<<new value>>"` placeholders** (all 18). They can be routed but not applied or exported until a real value is supplied on a draft.
4. **Merge duplicated in the CSV:** REQ0019, REQ0026 (applied) and REQ0028 (pending) are the same C00141→C00178 merge.
5. **Positions, not people.** The "Acting as" list is the brief's section 2 (Product Manager, Regional Sales, Procurement Officer; Business Unit Head, Finance, Quality/Regulatory Affairs, Business Support; MDM Team; IT). No individuals are stored or shown. The CSV does name 15 actors (e.g. `budi.s`, `lim.jh`), but only to translate them into a position for display (`actor_positions`): approvers by the role written in the audit comment, requesters by the handle prefix (`sales.` → Regional Sales; `cs.` and `ops.` have no matching position and are shown as "Customer Service" / "Operations"; `mdm.bot`/`mdm.system` as "System"). The CSV approval rules use roles outside the brief's list; each is performed by one position (`role_aliases`: Data Steward and Group MDM Owner → MDM Team; Entity Finance Lead → Finance; Compliance Officer → Finance and Local Country Admin (ID)/(VN) → Business Support, the last two being **assumptions**). The views and powers per position (`role_profiles`) are my design, not data. The position is declared, not authenticated.
   **Region/country:** the CSV shows the same approvers deciding requests in every country, so country does not restrict authority by default. The optional Region selector limits what a position sees (requests, master data, analytics) and where it can act; the only country-specific rules are R11/R12.
6. **Sensitive fields** (bank account, credit/payment terms): none exist in the CSV. They are AES-256-GCM encrypted at rest (key in `data/.mdm.key` or `MDM_KEY`), masked unless the acting position is allowed (default: Finance; editable), every reveal is logged against the position, and they are never written to SAP export files. Losing the key file makes stored values unreadable.
7. **SAP B1 export is a file only.** No integration exists and nothing is claimed as imported. Columns come from the per-field SAP mapping (customer/vendor: OCRD/CRD1-style `CardCode, CardName, FederalTaxID, Street…`; item: `ItemCode, ItemName…`; cost center: `PrcCode, PrcName`); confirm them against your own import template. B1-required fields the source cannot supply are exported blank and flagged on every row: customer/vendor `GroupCode`, `Currency`; item group mapping; cost-center dimension. Imported requests already `applied` in the CSV are excluded by default (the data doesn't show whether they reached SAP).
8. **Drop-off ("churn") is inferred** from absence of POs in a window; no contract/closure data exists.
9. **Inbox messages are highly templated**, so triage accuracy on them (100% vs the provided labels) will overstate real-world accuracy. Triage is rule-based, not a language model. 17 of 71 order emails name no company (only a first-name signature), so the customer cannot be identified automatically.
10. **Notifications / reminders** (Outlook, Teams) are not built; the app shows each request's current approver and a per-role queue.
11. Currency: all values are SGD per `config_domains`; no FX is applied.

## 5. Matching method and measured quality

Normalisation: lower-case, strip punctuation/diacritics, drop legal-form tokens (pte, ltd, sdn, bhd, co, pt, tbk, joint stock company…), token-sort the name; expand address abbreviations (Jl/Jln→jalan, Rd→road…). Score = 0.65·name + 0.35·address similarity (Levenshtein ratio); records without addresses (items, cost centers) use name only; an exact normalised registration number in the same country, or an identical code (items, cost centers), lifts the score to ≥0.9/0.95; conflicting registration numbers cap it at 0.6; a different country halves it. Bands: ≥0.90 duplicate, ≥0.75 possible.

Against the provided `golden_map` (all 28,680 customer record pairs): precision 1.000, recall 0.991 (110 of 111 true pairs). The one miss, C00141 / C00178, has a name typo ("SDNN") and no registration number; it scores 0.829 and is surfaced as "possible". All 6 `near_miss_distinct_company` decoys stay separate. Thresholds were set once, not tuned to this reference; this is evaluation on the data the design was developed against, so treat it as a sanity check.

## 6. Regional view definitions

- **Orders** = rows in `purchase_orders`. Only these feed volumes, growth and the forecast.
- **Growth** = PO value in the last *k* months ÷ PO value in the same *k* calendar months one year earlier − 1 (*k* = 6 by default, capped at 9 by the 21 months of history). Same-month comparison removes seasonality.
- **MDM setup requests** = rows in `requests` (create / update / merge / deactivate). They are never counted as demand.
- **Inbox messages** are shown separately by class; they carry no country, so they appear by month only.

## 7. Forecast evaluation (PO value, all countries, holdout 2026-07 → 2026-09)

| Model | WAPE | MAPE |
|---|---:|---:|
| Rolling 3-month average (flat) | 14.4% | 12.9% |
| Seasonal: last year × level ratio | 11.2% | 10.4% |
| Seasonal naive: last year | 21.1% | 20.3% |

By country the ranking is not stable: seasonal wins for MY, but the rolling average wins for SG, ID and VN and seasonal-naive for TH. With 3 test points and ~15 POs per country-month, treat the forecast as indicative.
