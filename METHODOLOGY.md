# Production Dashboard — Methodology

**Purpose:** This document defines exactly how the Production Dashboard counts revenue, classifies invoices, and reconciles against the Daily Recap Dashboard. Any time the methodology is changed, update this file.

**Last reviewed:** 2026-05-23
**Owner:** Joe Dingwall
**Source-of-truth code:**
- Invoice classification: `config.js` → `classifyProductionCategory()`, `classifyDivision()`, `isRecurring()`, `isOfficeEvent()`
- Per-card filtering: `index.html` → `renderMtdProductionCard_()`
- Cache pipeline: `loaders/merge_invoices.py`, `InvoiceWebhookHandler.gs` (live updates), `CacheRefresh.gs` (orders + locations + setups)

---

## 1. Data sources

| Source | Update frequency | What it carries |
|---|---|---|
| `cache-invoices.json` | Real-time via PestPac webhooks → Apps Script handler → GitHub PUT. Manual reconciliation via `merge_invoices.py` when Joe runs a new PestPac export. | Every invoice record YTD with the 48 curated fields the dashboard needs. |
| `cache-raw.json` | Every 10 minutes via the `refreshProductionCache` Apps Script trigger. | Open Service Orders (forecast + recently-completed). |
| `cache-locations.json` | Every 10 minutes. | Customer/location records — branches, lat/lng, addresses. |
| `cache-setups.json` | Every 10 minutes. | Service setup records — schedule, frequency. |
| `cache-employees.json` | Every 10 minutes. | Tech/employee roster with `IsTech` flag. |
| `budgets.json` | Manually via `admin.html`. | Monthly TRUE + ENHANCED budget targets per branch per category. |

---

## 2. The five revenue categories

Defined in `BUDGET_CATEGORIES` (config.js). Every counted invoice maps to exactly one of these:

| Category | What it represents |
|---|---|
| `cg_nwl` | CatGuard installs + NWL wildlife installations (one-time install revenue). |
| `pest_rodent_initial` | One-off / first-visit pest control or rodent control. |
| `recurring_residential` | Recurring residential pest contracts (PG SERVICE, LAWN/ORNAM, etc.). |
| `recurring_commercial` | Recurring commercial pest contracts (COMM SERVI). |
| `cgw_generated` | CatGuard Warranty pipeline (CG WARR 1YR, RESEAL, etc.) — guaranteed pre-billed annual maintenance. |

A sixth bucket, `recurring_total_platinum`, is tracked in admin budgets for visibility but **excluded from the dashboard's Budget total** because Total Platinum 1st-year customers don't generate revenue until year 2.

A seventh bucket, `plat_nonbillable`, exists for courtesy platinum visits but is **excluded from the Completed vs Budget card** entirely.

---

## 3. Inclusion / exclusion rules

### Invoice Type filter

The dashboard's "Production lens" includes these InvoiceTypes:

| Type | PestPac meaning | Included? | Rationale |
|---|---|---|---|
| `IN` | Standard invoice | **YES** | Real completed-work revenue |
| `PR` | Production / pre-billed | **YES (except plat_nonbillable)** | Real billed work on platinum maintenance, except courtesy visits |
| `CM` | Credit memo | **YES** | Refunds/adjustments offset revenue |
| `CB` | Callback | YES (always $0) | Tracked for callback rate computation; carries no $ |
| `PI` | Auto-billed prebill | **NO** | Auto-renewals + system-generated billing events — not field-tech revenue |
| `ES` | Estimate | **NO** | Quotes, not revenue |

### Plat Nonbillable exclusion (Joe directive 2026-05-23)

The **Completed vs Budget card** additionally excludes:

```
InvoiceType = 'PR'  AND  ServiceClass IN ('PG CG', 'PG CG PRE')
```

These records represent courtesy platinum visits — techs do the work but the customer was already billed at install time (the $960 annual CatGuard maintenance fee was collected up front). PestPac records them as PR invoices on PG CG / PG CG PRE service classes so the field-tech work is logged, but no revenue is generated to the company.

**Tech-level rows** (the Catseye Techs / USX Pest Techs master tables, the Production tab, the drill-downs) **DO include these** records so techs see credit for the work performed. Only the Completed vs Budget card excludes them.

### Office-event filter

Records routed to the "Office-Credited" bucket (and excluded from per-tech revenue attribution) are identified by:

1. **ServiceCode in office-event set** (config.js `OFFICE_EVENT_SERVICE_CODES`):
   - `CGW AUTO-RENEW` — CatGuard warranty annual auto-renewal
   - `USX WAR AUTOREN` — USX warranty auto-renewal
   - `TMS AUTO RENEWA` — Termite warranty auto-renewal
   - `CGW NO RENEWAL` — Customer declined renewal (still a billing event)
   - `EARLY TERM` — Early termination fee

2. **InvoiceType = `CM`** (all credit memos are office-entered by definition)

3. **Tech username in non-tech denylist** (config.js `NON_TECH_CODES`):
   - `DJO`, `DJOX` (Dylan O'Sick — Sales, USX Sales duplicate)
   - Other sales / CSR / admin codes added as discovered

These records still count toward branch-level totals via the office-credited footer row, just not toward individual tech credit.

### Service Class categorization (production records)

`classifyProductionCategory(rec)` in config.js applies these rules in order:

1. **Plat nonbillable check** — InvoiceType=`PR` + ServiceClass in `{PG CG, PG CG PRE}` → `plat_nonbillable`
2. **CGW warranty check** — ServiceCode in `CGW_GENERATED_CODES` set → `cgw_generated`
3. **CG / NWL division** — `classifyDivision()` returns `'cg'` or `'nwl'` → `cg_nwl`
4. **Pest, recurring** — `isRecurring()` true AND `classifyDivision()` = `'pest-commerc'` → `recurring_commercial`
5. **Pest, recurring** — `isRecurring()` true AND `'pest-resi'` → `recurring_residential`
6. **Pest, non-recurring** (default) → `pest_rodent_initial`

---

## 4. Computed metrics

### MTD Field Production (the Catseye Techs / USX Pest Techs `Completed $ MTD` column)
- Sum of `t.data.completed` per tech, where each invoice contributes `SubTotal` to the tech who performed the work (Tech field), via `attribute()` in `renderTechView_()`.
- For CG/NWL invoices with two techs, revenue splits 50/50.
- For pest invoices with two techs, full revenue goes to Tech1 (Tech2 is typically a trainee/check-in).
- Includes plat_nonbillable (techs still get utilization credit).

### Completed vs Budget Card — Actual line
- Sum of `t.data.completed` per branch **minus** `mtdByBranchCategory[branch][plat_nonbillable]`.
- Date range defaults to MTD (1st of month through yesterday); user-customizable via the From/To picker on the card.
- Custom range path recomputes per-branch totals from `productionInvoices_()` filtered to the chosen window, with the same plat_nonbillable exclusion.

### Completed vs Budget — On Pace lines
- **On Pace** = `(Actual − cgw_generated_actual) ÷ workingElapsed × workingTotal`
  - Production-side projection through end-of-month
  - Uses working days only (Mon–Fri, excludes the six holidays defined in `config.js → workingDaysInMonth_()`)
- **On Pace w/ CGW** = `On Pace + enhancedCgw_budget`
  - CGW is treated as a guaranteed pre-billed monthly amount (not projected from MTD pace) because customers are pre-billed for the annual amount at install time.

### Completed vs Budget — Budget lines
- **Budget (no CGW)** = sum of 4 ENHANCED budget categories: `cg_nwl + pest_rodent_initial + recurring_residential + recurring_commercial` (from `budgets.json`).
- **Budget w/ CGW** = above plus `cgw_generated` ENHANCED.

### Daily Production Needed (top of card)
- Per company: `(Budget w/ CGW total for current month) ÷ total working days in month`
- Compared against `Actual ÷ working days elapsed in selected range` to show pace vs need.

---

## 5. Reconciliation against Daily Recap Dashboard

The Daily Recap Dashboard (separate project, `catseye-internal/catseye-daily-recaps`) is the authoritative source for MTD Production reported up to leadership. Our dashboard's Completed vs Budget card is methodology-aligned to match.

**Production Dashboard ↔ Daily Recap rule mapping:**

| Daily Recap rule | Production Dashboard equivalent |
|---|---|
| Production XLS (IN+PR+CM) — service-class-mapped → included | `classifyProductionCategory()` → one of 5 categories |
| Production XLS — service classes outside the mapped set (BEES, etc.) → silently suppressed | `classifyProductionCategory()` → `'other'` bucket (effectively excluded from card; sum is always near-zero) |
| Prebill XLS — IN at exactly $960 → `plat_1st_yr` (INCLUDED) | Tagged via Service Class + recurring flag → `recurring_residential` (INCLUDED) |
| Prebill XLS — IN ≠ $960 → `residential_recurring` (INCLUDED) | Same → `recurring_residential` (INCLUDED) |
| Prebill XLS — PR on PG CG / PG CG PRE → `plat_nonbillable` (EXCLUDED) | Same — explicit check in `classifyProductionCategory()` |
| Prebill XLS — PI (any) → EXCLUDED | Same — production lens excludes PI |
| Estimate ES → EXCLUDED | Same |

**Validated 2026-05-23 (data through 5/21):**
- 489 of 489 prebill invoices in Daily Recap source XLS match our cache by InvoiceNumber
- Per-branch prebill subset totals match the Daily Recap doc's worked example to the dollar
- Catseye MTD total: dashboard $901K vs Recap $897K — **$4K delta is data-freshness only** (Recap was generated from a 5/21 snapshot of PestPac; cache was reconciled at 5/23 and has $3,955 of CT invoices added retroactively between those dates)

---

## 6. Why the $960 threshold is NOT used here

The Daily Recap script uses `if subtotal == 960` to distinguish `plat_1st_yr` from `residential_recurring` because the XLS export it reads has limited fields. The Production Dashboard does NOT use this threshold:

- Our cache has full `ServiceClass`, `ServiceCode`, `Frequency`, and `Origin` fields per record
- We classify by ServiceClass + recurring flag, which is more robust
- A dollar threshold silently misclassifies records billed at non-standard amounts (special pricing, customer concessions, regional variants)
- If Catseye changes platinum pricing in the future, the threshold would silently break; our classification keeps working

The $960 is a deferred-revenue carve-out from the original CatGuard install fee, not a unique billing amount. Treating it as identification key is fragile.

---

## 7. Working day calculation

Defined in `config.js → workingDaysInMonth_()`:

- Monday through Friday only
- Federal holidays excluded:
  - New Year's Day (observed on nearest weekday if Jan 1 falls Sat/Sun)
  - Memorial Day (last Monday of May)
  - Independence Day (only counted as holiday if July 4 falls Mon–Fri; no weekend shift per Joe directive)
  - Labor Day (first Monday of September)
  - Thanksgiving (4th Thursday of November)
  - Christmas Day (observed on nearest weekday if Dec 25 falls Sat/Sun)

Used by:
- MTD Production card's working-day % indicator at top
- On Pace projection multiplier
- Per-tech $/Day MTD column (working days elapsed only)

---

## 8. Data freshness

The Completed vs Budget card shows a freshness indicator in its header:
- **Gray "Source data Xm/Xh ago"** — within 24 hours, cache is fresh
- **Yellow "⚠ Source data Xh ago"** — 24–72 hours old, run a reconciliation soon
- **Red "⚠ Source data Xd ago"** — >72 hours old, cache is stale

Hover the indicator for the exact timestamp + the merge command to reconcile.

Reconciliation is triggered by:
1. **PestPac webhooks** — real-time updates as invoices are created/edited. Covers 90%+ of cases.
2. **Manual `merge_invoices.py`** — run weekly (or as drift suggests) against a fresh PestPac "Invoice List" Detail-format XLS export to catch webhook misses + retroactive entries.

---

## 9. Change log

| Date | Change | Author |
|---|---|---|
| 2026-05-23 | Initial methodology doc | Joe + AI assistant |
| 2026-05-23 | Added `plat_nonbillable` exclusion to Completed vs Budget card (PR on PG CG / PG CG PRE) | Joe directive |
| 2026-05-23 | Switched On Pace w/ CGW from MTD-actual add to enhanced-budget add (CGW treated as guaranteed pre-bill) | Joe directive |
| 2026-05-23 | Backfilled cache from PestPac export (+515 records across YTD); cache reconciled to current state | One-time |

---

## 10. Open issues / known gaps

- **PR on service classes other than PG CG / PG CG PRE**: Not yet investigated whether these should also be excluded. Current treatment: included. Daily Recap appears to include them too based on category-level reconciliation. Revisit if a new service class is introduced.
- **Source-of-report flag**: PestPac's `/Invoices` API doesn't expose whether a record came through the Production report vs the Prebill report. Workaround: we use ServiceClass + InvoiceType + isRecurring to derive equivalent classification. Has matched 100% of validated test records to date.
- **Estimates (ES)**: Currently excluded everywhere. Confirm with Joe if any ES records should be tracked elsewhere (e.g., sales pipeline view).
