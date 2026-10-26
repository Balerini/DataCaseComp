# DataCaseComp — MDM hub, regional analytics, forecasting, SAP B1 export

Built on **`mdm_fake_data_all.csv`**, which is imported into a SQLite database on first start and never modified. No replacement data is generated.

## Run

Requires Node ≥ 22.5 (built-in `node:sqlite`; no npm dependencies).

```
npm start          # http://127.0.0.1:3000   (PORT=… to change)
npm test           # 27 end-to-end tests (incl. position- and region-based access over HTTP)
npm run validate   # 23 reconciliation / matcher / approval-engine / database checks
```

On Windows PowerShell, if `npm` is blocked by the script policy, use `npm.cmd start` or `node src/server.js`.

Env: `MDM_CSV` (alternate CSV), `MDM_DB` (SQLite path, default `data/app.db`), `MDM_KEY` / `MDM_KEYFILE` (encryption key for sensitive fields; auto-created at `data/.mdm.key` — back it up, never commit it), `OPEN_PO_WINDOW_DAYS` (default 30).

## Acting as a position

The header has **Acting as** (a position) and **Region** (default *All regions*). Only roles are shown; no individuals are stored or displayed. The server enforces what each position can see and do, so menus, home screens and approvals genuinely differ. The choice is *declared, not authenticated* (anyone can pick any position); production would take the position from Microsoft 365 sign-in.

The positions are the ones in the brief (section 2):

| Kind | Positions | Gets |
|---|---|---|
| Requestor | Product Manager, Regional Sales, Procurement Officer | Home with *my requests*, New request, Requests raised by their position, Master data. Regional Sales also has Overview, Regional view, Analytics, Forecast. |
| Approver | Business Unit Head, Finance, Quality/Regulatory Affairs, Business Support | Home with *waiting for my decision* and SLA clock, Requests in their lane, Master data. Approve/reject only on their own step. Finance may see sensitive fields. Business Unit Head also has the commercial views. |
| MDM team | MDM Team | Everything except Config: all requests, apply approved records, Inbox, Duplicates, SAP B1 export, Data & quality, regional views. |
| IT | IT | Config (domains, fields, approval steps, sensitive-field viewers), Data & quality, read-only requests. |

**Lane** = requests raised by your position, requests whose approval path includes your position, and requests your position already acted on. The position that raised a request can never approve it.

**CSV approval rules** name roles that are not all in the brief's list (Data Steward, Group MDM Owner, Entity Finance Lead, Compliance Officer, Local Country Admin ID/VN). Each is performed by one position: Data Steward and Group MDM Owner → MDM Team; Entity Finance Lead → Finance; Compliance Officer → Finance *(assumption)*; Local Country Admin (ID)/(VN) → Business Support *(assumption)*. The rules themselves are unchanged source data; the mapping is shown on the Config screen.

**Region.** Country does not change anyone's authority in the data: the same finance and steward approvers decide requests across every country. The only country-specific rules are R11/R12 (local registration pre-check for Indonesia and Vietnam). Leave Region on *All regions* unless you want a country view: choosing one limits requests, master data and analytics to that country, and the Indonesia/Vietnam pre-check can only be decided by Business Support in that region (or All regions).

## What's in it

| Screen | What it does |
|---|---|
| **Home** | Different for every position: my requests with progress (requestors), my queue and SLA clock (approvers), ready-to-apply / export / inbox workbench (MDM team), commercial picture (regional roles), administration (IT). |
| **Master data** | Browse customers, items, vendors, cost centers from the database. Customer drawer shows the items each customer buys, duplicate group, original CSV values, request history. |
| **Intake** | One configuration-driven form for every domain: create / change / merge / deactivate. Required fields and formats come from config; duplicates and the approval route are shown before submission; likely duplicates are blocked until justified. |
| **Requests** | Every request shows who it awaits; per-role queue; approve / reject (comment required) / apply; full audit trail. |
| **Inbox** | 200 customer emails triaged into orders, enquiries, follow-ups and MDM setup requests; MDM emails become pre-filled requests; PO follow-ups are checked against the PO table. |
| **Duplicates** | Golden groups, matcher precision/recall against the provided mapping. |
| **Regional view** | Country × product PO value and growth for a stated 6/9-month window with the growth measure defined; orders vs MDM requests kept separate; what data science adds; recommended actions with evidence. |
| **Analytics / Forecast** | Top customers, drop-off, cross-sell, raw vs deduplicated; rolling-average vs seasonal forecast with 3-month holdout, WAPE/MAPE, per-country table, active-customer comparison. |
| **SAP B1 export** | Per-domain CSV from approved requests via the field→SAP mapping, with missing/unconfirmed B1 fields flagged per row. File only; nothing is imported into SAP. |
| **Config** | Add a domain, field, or approval step; mark fields sensitive; choose which positions may see them; see what each position gets. Changes are logged. (IT only.) |
| **Data & quality** | CSV profile, database row counts, findings, validation checks, what the data can and cannot support. |

## Principles

- The CSV is read-only. The database holds imported rows (`source='imported'`), derived rows, and everything created in the app (`source='app'`). Re-importing is idempotent and never overwrites edits or decisions.
- Raw and deduplicated analytics use the same PO rows; only the customer identity key changes.
- Gaps are reported, not filled: 21 months of history, no vendors / cost centers / item descriptions / bank or credit data, no PO status, placeholder values in update requests. Rules, fields and domains authored for this prototype are labelled **proposed**. See **[docs/DATA_NOTES.md](docs/DATA_NOTES.md)**.
- Sensitive fields are encrypted at rest, masked by acting role, logged on reveal, and never exported.
- Access is enforced on the server by the declared position (every route has an explicit permission; unlisted routes are refused). It is not authenticated in this prototype; production would use Microsoft 365 identity.
