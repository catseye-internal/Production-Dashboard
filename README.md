# Production Dashboard — Catseye & USX Pest

Companion to the BDC Dashboard. Where BDC tracks the sales funnel (Inbound → Booked → Run → Won), this tracks what happens after the sale: service execution, technician performance, route efficiency, budget pacing.

## Status — Phase 1 (May 20, 2026)

| Piece | State |
|---|---|
| Project brief read & internalized | ✅ |
| BDC visual language mirrored (#1C1A18 / #F47B20, Inter, KPI + table patterns) | ✅ |
| **ServiceOrders discovery complete** — 45 fields confirmed, 4 OrderTypes | ✅ |
| **Invoices discovery complete** — endpoint is keyed-lookup, NOT a list call | ✅ |
| List view: All Orders / Callbacks / Production (tab-filtered) | ✅ |
| Dynamic branch handling — auto-discovers new branches as Catseye grows | ✅ |
| `PestPacDiscovery.gs` + `InvoicesProbe.gs` | ✅ both run successfully |
| `OrderInvoicesProbe.gs` (per-order invoice access — for future drill-down) | ✅ written, run when needed |
| `CacheRefresh.gs` — ServiceOrders only, trigger NOT yet enabled | ✅ |
| GitHub repo `catseye-internal/Production-Dashboard` | ⏳ to create |

## Discovery findings (2026-05-20)

**OrderType universe** — 3-day window had: `Estimate` (97, excluded), `ServiceOrder` (168), `CallBack` (21), `Production` (100). These are the only four values PestPac returns.

**Strategic wins from the field inventory:**
- `Duration` — minutes per job. Capacity & route efficiency analysis is now possible without /Routes.
- `Route` — territory grouping (e.g., "MA02", "MACOM-NORT") already populated inside ServiceOrders. /Routes endpoint not needed.
- `InProgress` / `Locked` / `Posted` — live status flags rendered as colored dots in the list view.
- `TechnicianComment` — qualitative service notes (capped at 200 chars in curated cache).
- `LeadID` / `ParentOrderID` / `SetupID` — relationship pointers. Lets us link callbacks back to original work and connect orders to recurring contracts.
- `EarliestTime` / `LatestTime` — customer scheduling windows when set.
- `/Locations/{id}` returns **`Latitude` + `Longitude`**. This is huge: the drive-time analysis the brief originally pushed to Phase 5 ("the most complex feature") is unblocked — we don't need Google Maps Distance Matrix to begin.

**404s that don't matter:** `/Routes` and `/Customers` don't exist as endpoints. The data is already in `/ServiceOrders` (Route field) and `/Locations/{id}` (full customer record).

**Invoices access pattern (resolved):** `/Invoices` is keyed-lookup only. The error body says it all: "You must specify an orderId, orderNumber, invoiceNumber, or externalIdentifier." There is no date-range list call. Implications:

- A standalone Invoices list view doesn't make sense — building one would require ~3,000-5,000 extra API calls per YTD refresh (one per Posted order).
- ServiceOrders already carries the billing-relevant signal we need for list views: `Posted` (boolean — has been invoiced), `SubTotal` / `Tax` / `Total` (amounts).
- Per-order invoice detail (balance, payment status, A/R aging) becomes a Phase 2 drill-down feature, fetched on demand via `/Invoices?orderId={OrderID}`. `OrderInvoicesProbe.gs` is ready to verify that pattern when we're there.

**Phase 1 tab structure** (pivoted from "Orders + Invoices" to three pre-filtered views of ServiceOrders):

- **All Orders** — every non-Estimate order. OrderType filter shown.
- **Callbacks** — `OrderType = CallBack`. Pre-filtered.
- **Production** — `OrderType = Production`. Pre-filtered (Cat-Guard / NWL execution work).

Each tab shows a count badge so you can see today's callback/production load at a glance without switching tabs.

**Dynamic branch handling:** the branch dropdown is the union of `BRANCH_ALL` (known set) + every branch seen in the actual data. New branches added in PestPac as Catseye grows automatically appear in the dropdown with no code change. `BRANCH_DISPLAY` provides short labels for known branches; unknown branches show their full name.

**Size projection** (curated, ServiceOrders only, YTD): 2.9–7.2 MB. Within tolerance for a 10-min refresh cycle. No combined cache size to worry about since invoices aren't fetched in bulk.

## Files

| File | Purpose |
|---|---|
| `index.html` | Single-file dashboard. All HTML/CSS/inline JS. Mirrors BDC visual language. |
| `config.js` | Branches, period labels, color tokens, list-view column defs. Edit here when constants change. |
| `cache.json` | Curated dashboard payload. Written every 10 min by `CacheRefresh.gs`. Small + fast — only the fields the dashboard renders. |
| `cache-raw.json` | Full PestPac API payload (every field). Refreshed once per day. Analytical safety net — when we want to add a new column we don't have to re-engineer the pipeline. |
| `sw.js` | Service worker — stale-while-revalidate caching for `cache.json`. Same pattern as BDC. |
| `PestPacDiscovery.gs` | One-shot Apps Script probe. Confirms field shapes for ServiceOrders / Invoices / Locations / Routes / Customers, and projects cache file sizes at YTD scale. Read-only. |
| `CacheRefresh.gs` | Production data pipeline. Pulls FULL API responses, writes a curated `cache.json` every 10 min and a raw `cache-raw.json` once per day (gated by Script Property timestamp). Do NOT enable trigger until Invoices field names are locked. |

## Two-cache strategy

| | `cache.json` | `cache-raw.json` |
|---|---|---|
| Refresh cadence | Every 10 min | Once per day (≥20h gate) |
| Contents | Curated whitelist of fields the dashboard actually renders | Every field PestPac returns |
| Target size | < 5 MB (fast page load) | Whatever it is — read on demand only |
| Read pattern | Dashboard loads on every page open + 60s auto-refresh | Ad-hoc analysis, schema review |
| Why | Curated stays small for snappy UX | Future-proof: new column requests don't require pipeline changes |

Same API call cost for both (you've already fetched the record), separate persistence policies.

## Reference data (manual layer)

PestPac doesn't own everything we need. A small **Production Reference Data** Google Sheet should hold the things the API can't provide:

- Monthly budget targets per branch / per service category
- Tech roster + aliases (canonical names per branch)
- Callback definitions (until we confirm PestPac surfaces these natively)
- Pre-Sold Cat-Guard pipeline status updates from production scheduling

**Do NOT reuse the BDC Master Leads Log.** That sheet exists because BDC's inbound calls/texts/forms aren't in any API — Production data is entirely API-sourced, so the use case is fundamentally different.

## Deployment — fully automated, zero manual maintenance

The pipeline is **two-sided**: Service Orders are polled on a 10-min timer; Invoices arrive via PestPac WebHooks (event-driven, near-real-time). Both write to GitHub Pages, which serves the dashboard.

### Step 1 — Create the GitHub repo (5 min)

1. github.com → New repo → `catseye-internal/Production-Dashboard` (private OK)
2. Settings → Pages → Branch: `main`, folder: `/` → Save
3. Generate a fine-grained Personal Access Token with **Contents: write** on this repo. Save the token — needed in Step 3.

### Step 2 — Push the local files to the repo (3 min)

```bash
cd ~/Desktop/Claude\ Assets/PRODUCTION\ DASHBOARD/PRODUCTION\ DASHBOARD
git init
git add index.html config.js cache.json cache-invoices.json sw.js README.md
git commit -m "Initial commit"
git remote add origin git@github.com:catseye-internal/Production-Dashboard.git
git push -u origin main
```

Dashboard is now live at `https://catseye-internal.github.io/Production-Dashboard/`.

### Step 3 — Set up the Apps Script project (10 min)

1. script.google.com → New project → name it **Production Dashboard Pipeline**
2. Create three script files inside:
   - `CacheRefresh.gs` (paste from this folder) — ServiceOrders polling, every 10 min
   - `InvoiceWebhookHandler.gs` (paste from this folder) — webhook receiver
   - `WebhookRegistration.gs` (paste from this folder) — one-time setup helper
3. Project Settings → Script Properties → add **GITHUB_TOKEN** with the token from Step 1.
4. Run → `refreshProductionCache` once manually to test. Watch the log. First run authorizes the script and pushes a fresh `cache.json`.
5. Triggers (clock icon) → Add Trigger → `refreshProductionCache` → Time-driven → Minutes timer → Every 10 minutes. Set the first fire at :05 so it staggers off BDC's :00 cycle.

### Step 4 — Deploy the webhook handler (5 min)

1. In the same Apps Script project: **Deploy → New deployment**
   - Type: **Web app**
   - Execute as: **Me (your account)**
   - Who has access: **Anyone** (PestPac needs to POST without auth — the URL itself is the secret)
2. Click Deploy → copy the `/exec` URL (looks like `https://script.google.com/macros/s/AKfycb…/exec`)
3. Test it: paste the URL in a browser. You should see a JSON status response.

### Step 5 — Register the webhooks (2 min)

1. Open `WebhookRegistration.gs` in the Apps Script editor
2. Edit `WEBHOOK_RECEIVER_URL` at the top to the `/exec` URL from Step 4
3. Save (Cmd+S)
4. Function dropdown → `setupAllWebhooks` → Run
5. Check the log — should see HTTP 200 (or 201) for each of 7 subscriptions
6. Verify with `listWebhooks` — should show all 7 active

**You're live.** Every invoice change in PestPac now triggers a webhook → fetches the full invoice → upserts into `cache-invoices.json` → the dashboard reflects it on next refresh (within 60s).

## Status — Phase 2 (May 20, 2026)

## Design principles inherited from BDC

- **Never show zeros during refresh.** If an API call fails, keep displayed data. Show a stale-age indicator instead.
- **Use `var` for globals.** Avoids temporal-dead-zone errors that silently break the refresh pipeline.
- **Wrap refresh in try/finally.** Reset `isRefreshing` no matter what — an unhandled throw permanently blocks the loop.
- **`cache.json` is the source of truth.** Browser never calls PestPac directly (no CORS). Apps Script writes; dashboard reads.
- **Single-file deploy.** Each push is one or two files. No build step.

## Deploy sequence (mirrors BDC pattern)

```bash
cd ~/Desktop/Claude\ Assets/PRODUCTION\ DASHBOARD/PRODUCTION\ DASHBOARD
git add index.html config.js sw.js
git stash
git pull origin main --rebase   # in case CacheRefresh pushed cache.json mid-edit
git stash pop
git add index.html config.js sw.js
git commit -m "your message"
git push origin main
```
