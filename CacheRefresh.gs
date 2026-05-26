/**
 * Production Dashboard Cache Refresh — Standalone Apps Script
 *
 * Writes TWO files:
 *   • cache.json      — curated dashboard payload, refreshed every 10 minutes
 *   • cache-raw.json  — full PestPac API payload, refreshed once per day
 *
 * Why two files: the curated cache stays small for fast page loads and 60s refresh
 * cycles. The raw cache is the analytical safety net — when we want to add a new
 * column or metric, we can do it without re-engineering the pipeline. Same API
 * cost (fetch is fetch), separate persistence policies.
 *
 * SETUP
 *   1. script.google.com → New project (separate from BDC Cache Refresh)
 *   2. Paste this entire file
 *   3. Script Properties:
 *        GITHUB_TOKEN = <fine-grained PAT with Contents:write on Production-Dashboard repo>
 *   4. Run → refreshProductionCache (authorize on first run)
 *   5. Triggers (clock icon) → refreshProductionCache, Time-driven, every 10 min
 *      Stagger from BDC: BDC runs :00/:10/:20/..., this should run :05/:15/:25/...
 *
 * The raw write is gated by RAW_REFRESH_MIN_HOURS — the first refresh after that
 * window writes cache-raw.json. So a single trigger handles both cadences.
 *
 * BEFORE ENABLING TRIGGER
 *   Run PestPacDiscovery.gs first. It confirms:
 *     • the correct /Invoices query params (startDate vs startInvoiceDate vs fromDate)
 *     • all OrderType values in the wild
 *     • projected cache file sizes at YTD scale
 *   Then update CURATED_FIELDS_ORDER / CURATED_FIELDS_INVOICE below if needed.
 */

// ── PestPac credentials (same as BDC CacheRefresh) ──
const PP_CLIENT_ID     = 'OjCMV6522ip62LlhU08LrG5U61oa';
const PP_CLIENT_SECRET = 'MicEfYLkplnarU18fHLH3VCfxhMa';
const PP_USERNAME      = 'jdingwall@catseyepest.com';
const PP_PASSWORD      = 'C@ts3y3!!';
const PP_API_KEY       = 'IJ4Goon7ZW9EbvAvPdO33Q6Vtnt5oysT';
const PP_TENANT_ID     = '103012';
const PP_TOKEN_URL     = 'https://is.workwave.com/oauth2/token?scope=openid';
const PP_API_BASE      = 'https://api.workwave.com/pestpac/v1';

// ── GitHub config (Production repo) ──
const GH_OWNER  = 'catseye-internal';
const GH_REPO   = 'Production-Dashboard';
const GH_BRANCH = 'main';
const GH_PATH_CURATED   = 'cache.json';
const GH_PATH_RAW       = 'cache-raw.json';
const GH_PATH_LOCATIONS = 'cache-locations.json';
const GH_PATH_SETUPS    = 'cache-setups.json';

// ── Raw refresh cadence ──
const RAW_REFRESH_MIN_HOURS = 20;          // ≥ this many hours since last raw write → write again
const RAW_REFRESH_KEY = 'lastRawWriteAt';  // Script Properties key holding ISO timestamp

// ── Order types ──
// Unfiltered /ServiceOrders calls return a SLIM record subset (~12 per month,
// missing OrderType/Tech/status fields). To get the full payload we must query
// each orderType explicitly. Confirmed 2026-05-20.
const ORDER_TYPES_INCLUDED = ['ServiceOrder', 'CallBack', 'Production'];
const ORDER_TYPES_EXCLUDED = ['Estimate'];  // BDC handles these

// ── Curated field whitelists ──
// Confirmed against live API (PestPacDiscovery.gs run on 2026-05-20).
// Anything NOT in these arrays gets stripped from cache.json (kept in cache-raw.json).
const CURATED_FIELDS_ORDER = [
  // Identity & links
  'OrderID', 'OrderNumber', 'ParentOrderID', 'LeadID', 'SetupID',
  // Classification
  'OrderType', 'Origin', 'ServiceClass',
  // Location / branch
  'Branch', 'BranchID', 'LocationID', 'BillToID', 'Route',
  // Work scheduling
  'WorkDate', 'Duration', 'EarliestTime', 'LatestTime', 'TimeRange',
  // Service detail
  'ServiceCode', 'Description',
  // Money
  'SubTotal', 'Tax', 'Total',
  // Status & technicians (Tech2/TechID2 populated via enrichment from /id Technicians array)
  'Tech1', 'TechID1', 'Tech2', 'TechID2', 'InProgress', 'Locked', 'Posted',
  // Notes — truncated below to avoid blowing up the cache
  'TechnicianComment'
];

// Enrichment window — orders within this many days from today get full
// /ServiceOrders/{id} lookups for their complete field set. Past this horizon,
// records stay slim (smaller cache, faster refresh).
//
// Cut from 14 → 7 on 2026-05-21 to stay under the Apps Script 100K/day
// premium urlfetch quota. Joe confirmed 7-day is the high-leverage window
// for CSR ops; 14-day was secondary. Tradeoff: Tech 2 / SubTotal / full
// enrichment only populate for orders 0-7 days out, not 0-14.
const ENRICH_WINDOW_DAYS = 7;
const ENRICH_MAX_RECORDS = 1500;   // safety cap — large enough to cover all 7-day candidates
const ENRICH_BATCH_SIZE  = 30;     // PARALLEL calls per batch via UrlFetchApp.fetchAll
const ENRICH_BATCH_PAUSE_MS = 200; // small pause between batches (rate-limit friendly)
// Invoices: still pending /Invoices endpoint discovery — placeholders only.
const CURATED_FIELDS_INVOICE = [
  'InvoiceNumber', 'InvoiceDate', 'Branch',
  'CustomerID', 'LocationID', 'OrderID',
  'Total', 'Subtotal', 'TaxTotal', 'BalanceDue',
  'Status',
];

// Curated Location whitelist — what survives into cache-locations.json
// Captured from /Locations/{id} 2026-05-20 (60-field response). Excludes
// Fax/Title/Salutation/UserDefinedFields etc. that don't aid the dashboard.
const CURATED_FIELDS_LOCATION = [
  // Identity
  'LocationID', 'LocationCode', 'BillToID',
  // Customer name (residential vs commercial)
  'Company', 'FirstName', 'LastName',
  // Address
  'Address', 'Address2', 'City', 'State', 'Zip', 'County', 'Country',
  // Contact
  'Phone', 'MobilePhone', 'EMail',
  // Geocoding (for future drive-time analysis)
  'Latitude', 'Longitude', 'RooftopLatitude', 'RooftopLongitude',
  // Classification
  'AccountType', 'Type', 'Source',
  // Status
  'Active', 'Prospect',
  // Branch
  'Branch', 'BranchID',
  // Tax
  'TaxCode', 'TaxRate',
  // Audit
  'EnteredDate', 'ContactDate'
];

// Curated ServiceSetup whitelist — what survives into cache-setups.json
// Field names CONFIRMED via test10/refreshSetupsCache log on 2026-05-21:
//   Schedule              = "BM2MO" (the schedule code itself, not an ID)
//   FrequencyCode         = "BI-MONTHLY" (machine-friendly)
//   FrequencyDescription  = "Bi-Monthly Services" (user-friendly)
//   Description           = "Platinum Service" (PestPac uses "Description", not "ServiceDescription")
// Earlier whitelist used wrong names and silently dropped the frequency data.
const CURATED_FIELDS_SETUP = [
  // Identity & links
  'SetupID', 'LocationID', 'BillToID',
  // What this setup covers
  'ServiceCode', 'Description', 'SetupType',
  // The two fields we care about most for the dashboard
  'Schedule', 'FrequencyCode', 'FrequencyDescription',
  // Billing variants (sometimes diverge from service Schedule/Frequency)
  'BillingFrequencyCode', 'BillingFrequencyDescription', 'BillingSchedule', 'BillingAmount',
  // Status & lifecycle
  'Active', 'Locked', 'StartDate', 'CancelDate', 'CancelReason', 'ExpirationDate', 'RenewalDate',
  // Creation moment — AddDate is the timestamp the setup was created; EnteredBy
  // is the CSR who created it (extracted from Technicians[3] in fetchSetups_ below).
  // These two power the "new business written" + "per-CSR attribution" cards
  // on the Pest view. Joe directive 2026-05-25.
  'AddDate',
  // Lead source ("INTERNET", "REFERRAL", etc.) — for source attribution analysis
  'Source',
  // Initial-service flags — useful for distinguishing brand-new accounts from
  // historical setups that just got a new schedule
  'HasInitialService', 'InitialServiceComplete',
  // Branch & route
  'Branch', 'BranchID', 'Route',
  // Money
  'SubTotal', 'Total', 'AnnualValue', 'FirstYearValue',
  // Billing
  'AutoBill', 'AutoBillThroughDate', 'CardOnFile'
];

// TechnicianComment can be a paragraph — cap to keep cache.json under control.
const TECH_COMMENT_MAX_CHARS = 200;

// ──────────────────────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────────────────────
function ppToken_() {
  const creds = Utilities.base64Encode(PP_CLIENT_ID + ':' + PP_CLIENT_SECRET);
  const resp = UrlFetchApp.fetch(PP_TOKEN_URL, {
    method: 'post',
    headers: { 'Authorization': 'Basic ' + creds },
    contentType: 'application/x-www-form-urlencoded',
    payload: 'grant_type=password&username=' + encodeURIComponent(PP_USERNAME) +
             '&password=' + encodeURIComponent(PP_PASSWORD),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('PestPac token HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0, 200));
  }
  return JSON.parse(resp.getContentText()).access_token;
}

function ppGet_(token, path) {
  const resp = UrlFetchApp.fetch(PP_API_BASE + path, {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + token,
      'apikey': PP_API_KEY,
      'tenant-id': PP_TENANT_ID
    },
    muteHttpExceptions: true
  });
  return { code: resp.getResponseCode(), text: resp.getContentText() };
}

// ──────────────────────────────────────────────────────────────
// Date helpers
// ──────────────────────────────────────────────────────────────
function pad_(n) { return String(n).padStart(2, '0'); }
function fmt_(d) { return d.getFullYear() + '-' + pad_(d.getMonth() + 1) + '-' + pad_(d.getDate()); }

// ──────────────────────────────────────────────────────────────
// Fetch helpers — pull RAW (all fields) — chunked by 31-day windows
// ──────────────────────────────────────────────────────────────
function fetchServiceOrdersRaw_(token, startDate, endDate) {
  // PestPac quirks discovered 2026-05-20:
  // 1. /ServiceOrders returns OPEN orders only — completed orders move to /Invoices.
  //    So use a FORWARD-LOOKING window (today-7d → today+90d), not YTD historical.
  // 2. Unfiltered queries return a SLIM record subset; filtered queries also
  //    return slim records but strip OrderType from the response — so we stamp
  //    it back on from the query value.
  var all = [];
  for (var i = 0; i < ORDER_TYPES_INCLUDED.length; i++) {
    var ot = ORDER_TYPES_INCLUDED[i];
    var r = ppGet_(token, '/ServiceOrders?orderType=' + encodeURIComponent(ot) +
                          '&startWorkDate=' + startDate + '&endWorkDate=' + endDate);
    if (r.code !== 200) {
      Logger.log('  ServiceOrders ' + ot + ' ' + startDate + '→' + endDate +
                 ' HTTP ' + r.code + ': ' + r.text.substring(0, 200));
      continue;
    }
    var orders = JSON.parse(r.text);
    Logger.log('    ' + ot + ' ' + startDate + '→' + endDate + ' → ' + orders.length + ' records');
    // Stamp OrderType — PestPac strips it from filtered responses
    for (var j = 0; j < orders.length; j++) {
      if (!orders[j].OrderType) orders[j].OrderType = ot;
      all.push(orders[j]);
    }
  }
  return all;
}

// PestPac's /Invoices is a keyed-lookup endpoint, NOT a list endpoint.
// Confirmed via InvoicesProbe.gs (2026-05-20): the only accepted query params
// are orderId, orderNumber, invoiceNumber, externalIdentifier. There's no
// "list all invoices in a date range" call.
//
// To fetch invoices we MUST iterate over orders and query per-order:
//   /Invoices?orderId={OrderID}     OR    /Invoices?orderNumber={OrderNumber}
//
// At YTD scale that's thousands of API calls per refresh. Not viable for the
// 10-min curated cache. Per-order invoice detail becomes a drill-down feature
// or a nightly batch into the raw cache.
//
// For Phase 1 we get billing-relevant signal directly from ServiceOrders:
//   Posted (boolean)   — order has been invoiced
//   SubTotal / Tax / Total — revenue amounts
// This covers list-view needs. Balance/payment/aging data — when needed —
// becomes a Phase 2 enhancement using the per-order pattern below.
function fetchInvoiceForOrder_(token, orderId) {
  var r = ppGet_(token, '/Invoices?orderId=' + encodeURIComponent(orderId));
  if (r.code !== 200) return null;
  return JSON.parse(r.text);
}

// ──────────────────────────────────────────────────────────────
// Enrichment — list endpoint returns slim records; fetch each near-term
// order individually via /ServiceOrders/{id} to get full 45-field detail.
//
// DIFFERENTIAL ENRICHMENT (added 2026-05-21 for quota relief):
// The list endpoint already returns most fields (WorkDate, Tech1, Locked,
// Posted, Duration, ServiceCode, SubTotal, etc.). The ONLY thing the per-id
// enrichment adds is Tech2/TechID2 extracted from the Technicians array
// (Position 2). Tech2 is set when the order is created and rarely changes —
// re-fetching every 15 min for 600+ orders was burning ~57K calls/day.
//
// New approach: load the previous cache.json. For each candidate, only fetch
// /ServiceOrders/{id} if the order is NEW (no previous record) OR if any of
// the slim-list key fields changed (WorkDate, Tech1, Locked, Posted,
// ServiceCode, Duration). Otherwise, copy Tech2/TechID2 forward from the
// previous record. Expected fetches per refresh: ~5-30 instead of ~600.
// ──────────────────────────────────────────────────────────────

// Read the live cache.json from GitHub Pages — used for differential
// enrichment to identify which orders actually need re-fetching.
function readOrdersCache_() {
  try {
    var resp = UrlFetchApp.fetch(
      'https://catseye-internal.github.io/Production-Dashboard/cache.json',
      { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } }
    );
    if (resp.getResponseCode() !== 200) return { orders: [] };
    return JSON.parse(resp.getContentText());
  } catch (e) {
    return { orders: [] };
  }
}

// Fields whose change signals "re-enrich this order". Anything not in this
// set (TechnicianComment, EarliestTime, etc.) is allowed to change without
// triggering a fresh /id fetch — the slim list already carries those values
// every refresh anyway.
var DIFF_ENRICH_KEY_FIELDS = ['WorkDate', 'Tech1', 'Locked', 'Posted', 'ServiceCode', 'Duration'];

function enrichNearTermOrders_(token, orders) {
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + ENRICH_WINDOW_DAYS);
  // Pick records within the enrichment window (and with a parseable date)
  var candidates = [];
  for (var i = 0; i < orders.length; i++) {
    var ws = String(orders[i].WorkDate || '');
    if (!ws) continue;
    var wd = new Date(ws);
    if (isNaN(wd.getTime())) continue;
    if (wd >= today && wd <= cutoff && orders[i].OrderID) candidates.push(orders[i]);
  }

  // Load previous cache to identify what actually needs re-fetching
  var previousMap = {};
  var previousLoadedCount = 0;
  try {
    var previousCache = readOrdersCache_();
    (previousCache.orders || []).forEach(function(o) {
      if (o.OrderID != null) {
        previousMap[String(o.OrderID)] = o;
        previousLoadedCount++;
      }
    });
  } catch (e) {
    Logger.log('  Previous cache load failed (' + e.message + ') — will full-enrich');
  }
  Logger.log('  Previous cache: ' + previousLoadedCount + ' orders | candidates in window: ' + candidates.length);

  // Partition candidates: needs-enrichment vs copy-forward
  var needsEnrichment = [];
  var copiedCount = 0;
  var copiedWithTech2 = 0;
  candidates.forEach(function(c) {
    var prev = previousMap[String(c.OrderID)];
    if (!prev) {
      // Brand-new order — must enrich to capture Tech2
      needsEnrichment.push(c);
      return;
    }
    // Compare slim-list key fields against prior cached values
    var changed = false;
    for (var k = 0; k < DIFF_ENRICH_KEY_FIELDS.length; k++) {
      var f = DIFF_ENRICH_KEY_FIELDS[k];
      var a = (typeof prev[f] === 'boolean') ? Boolean(prev[f]) : String(prev[f] == null ? '' : prev[f]);
      var b = (typeof c[f]    === 'boolean') ? Boolean(c[f])    : String(c[f]    == null ? '' : c[f]);
      if (a !== b) { changed = true; break; }
    }
    if (changed) {
      needsEnrichment.push(c);
      return;
    }
    // Unchanged — copy Tech2/TechID2 forward (the only fields enrichment adds)
    if (prev.Tech2)               { c.Tech2 = prev.Tech2; copiedWithTech2++; }
    if (prev.TechID2 != null)     c.TechID2 = prev.TechID2;
    copiedCount++;
  });

  Logger.log('  Differential: ' + needsEnrichment.length + ' to fetch, ' + copiedCount + ' copied forward (Tech2 carried on ' + copiedWithTech2 + ')');

  // Safety cap for cold-start refreshes (e.g., first run after a deploy when
  // the previous cache is empty and every candidate needs enrichment)
  if (needsEnrichment.length > ENRICH_MAX_RECORDS) {
    Logger.log('  Enrichment capped: ' + needsEnrichment.length + ' → ' + ENRICH_MAX_RECORDS);
    needsEnrichment = needsEnrichment.slice(0, ENRICH_MAX_RECORDS);
  }
  if (needsEnrichment.length === 0) {
    Logger.log('  ✓ No new/changed orders this cycle — skipping /ServiceOrders/{id} entirely');
    return;
  }

  Logger.log('  Enriching ' + needsEnrichment.length + ' orders via parallel fetchAll batches of ' + ENRICH_BATCH_SIZE + '...');
  var enrichedCount = 0;
  var failedCount = 0;
  var tech2Count = 0;
  var t0 = Date.now();
  var commonHeaders = {
    'Authorization': 'Bearer ' + token,
    'apikey': PP_API_KEY,
    'tenant-id': PP_TENANT_ID
  };
  for (var i = 0; i < needsEnrichment.length; i += ENRICH_BATCH_SIZE) {
    var slice = needsEnrichment.slice(i, i + ENRICH_BATCH_SIZE);
    var requests = slice.map(function(c) {
      return {
        url: PP_API_BASE + '/ServiceOrders/' + c.OrderID,
        method: 'get',
        headers: commonHeaders,
        muteHttpExceptions: true
      };
    });
    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      Logger.log('    Batch ' + i + ' failed entirely: ' + e.message);
      failedCount += slice.length;
      continue;
    }
    for (var k = 0; k < responses.length; k++) {
      var resp = responses[k];
      if (resp.getResponseCode() !== 200) { failedCount++; continue; }
      try {
        var full = JSON.parse(resp.getContentText());
        var slimOrderType = slice[k].OrderType;
        Object.keys(full).forEach(function(key) { slice[k][key] = full[key]; });
        if (!slice[k].OrderType && slimOrderType) slice[k].OrderType = slimOrderType;
        // Extract Tech2/TechID2 STRICTLY from Position 2 of the Technicians array.
        // PestPac's 4-position convention (verified 2026-05-20 with Joe):
        //   Position 1 = primary field tech (Tech 1)
        //   Position 2 = secondary field tech (Tech 2) — only populated on real 2-tech jobs
        //   Position 3-4 = sales/CSR/entered-by slots — NOT field techs
        // Earlier logic grabbed the second populated entry regardless of position,
        // which incorrectly pulled in sales people (BAG, VXR) and CSRs (MRS) from Position 4.
        if (Array.isArray(full.Technicians) && full.Technicians.length >= 2) {
          var pos2 = full.Technicians[1];  // array index 1 = Position 2
          if (pos2 && pos2.Code) {
            slice[k].Tech2 = pos2.Code;
            slice[k].TechID2 = pos2.TechID;
            tech2Count++;
          }
        }
        enrichedCount++;
      } catch (e) {
        failedCount++;
      }
    }
    if (i + ENRICH_BATCH_SIZE < needsEnrichment.length) Utilities.sleep(ENRICH_BATCH_PAUSE_MS);
  }
  var elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  Logger.log('  ✓ Enriched ' + enrichedCount + ' (' + failedCount + ' failed) in ' + elapsed + 's | Tech 2 found on ' + tech2Count + ' orders');
}

// Chunks the date range into 14-day windows. Confirmed via test1_windowSize
// (2026-05-20): PestPac returns full 45-field records for windows ≤ 14 days
// and HTTP 400 for windows ≥ 31 days. Some intermediate sizes return slim
// records (10 fields) — 14 days is the safe upper bound that guarantees
// full field shape every time.
function chunked14_(startDate, endDate, fn) {
  var out = [];
  var s = new Date(startDate);
  var e = new Date(endDate);
  var cursor = new Date(s);
  while (cursor <= e) {
    var chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + 13);  // 14-day window inclusive
    if (chunkEnd > e) chunkEnd = e;
    var rows = fn(fmt_(cursor), fmt_(chunkEnd));
    for (var i = 0; i < rows.length; i++) out.push(rows[i]);
    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// Curate — drop everything not on the whitelist
// ──────────────────────────────────────────────────────────────
function curate_(rec, whitelist) {
  var out = {};
  for (var i = 0; i < whitelist.length; i++) {
    var k = whitelist[i];
    if (rec[k] !== undefined) out[k] = rec[k];
  }
  // Truncate TechnicianComment to bound cache.json size
  if (out.TechnicianComment && typeof out.TechnicianComment === 'string' &&
      out.TechnicianComment.length > TECH_COMMENT_MAX_CHARS) {
    out.TechnicianComment = out.TechnicianComment.substring(0, TECH_COMMENT_MAX_CHARS) + '…';
  }
  return out;
}

// Extracts EnteredBy + SalesBy from the Technicians array on a setup payload.
// PestPac's 4-position convention (same as orders + invoices):
//   Position 1 (index 0) = Tech 1 (primary field tech — varies per visit)
//   Position 2 (index 1) = Tech 2 (secondary field tech)
//   Position 3 (index 2) = Sales (the closer / inspector who sold the setup)
//   Position 4 (index 3) = Entered (the CSR who created the setup)
//
// AddDate captures WHEN the setup was created; EnteredBy + SalesBy capture WHO.
// Together they power "new business written" + per-CSR attribution.
//
// Shared between the bulk pull (fetchSetups_) and the webhook handler
// (curateSetup_ in InvoiceWebhookHandler.gs) so the two paths stay in lockstep.
// Joe directive 2026-05-25.
function enrichSetupCreator_(curatedOut, rawSetup) {
  if (!rawSetup || !Array.isArray(rawSetup.Technicians)) return;
  var techs = rawSetup.Technicians;
  if (techs.length >= 4) {
    var enteredSlot = techs[3];
    if (enteredSlot && enteredSlot.Code) {
      curatedOut.EnteredBy = enteredSlot.Code;
      if (enteredSlot.TechID != null) curatedOut.EnteredByID = enteredSlot.TechID;
    }
  }
  if (techs.length >= 3) {
    var salesSlot = techs[2];
    if (salesSlot && salesSlot.Code) {
      curatedOut.SalesBy = salesSlot.Code;
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Raw refresh gate — has it been ≥ RAW_REFRESH_MIN_HOURS since last raw write?
// ──────────────────────────────────────────────────────────────
function rawWriteDue_() {
  var last = PropertiesService.getScriptProperties().getProperty(RAW_REFRESH_KEY);
  if (!last) return true;
  var lastDate = new Date(last);
  if (isNaN(lastDate.getTime())) return true;
  var hoursSince = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60);
  return hoursSince >= RAW_REFRESH_MIN_HOURS;
}

function markRawWritten_() {
  PropertiesService.getScriptProperties().setProperty(RAW_REFRESH_KEY, new Date().toISOString());
}

// ──────────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────────
function refreshProductionCache() {
  var t0 = new Date();
  Logger.log('🔄 Production cache refresh — ' + t0.toISOString());

  try {
    var token = ppToken_();
    var now = new Date();
    // /ServiceOrders returns OPEN orders only. Look forward, not backward.
    // 7 days back catches recently-completed-not-yet-invoiced; 90 days forward
    // catches upcoming scheduled work.
    var windowStart = new Date(now); windowStart.setDate(windowStart.getDate() - 7);
    var windowEnd   = new Date(now); windowEnd.setDate(windowEnd.getDate() + 90);
    var startStr = fmt_(windowStart);
    var endStr   = fmt_(windowEnd);

    Logger.log('  Window: ' + startStr + ' → ' + endStr);

    Logger.log('  Fetching ServiceOrders (non-estimate)...');
    var rawOrders = chunked14_(startStr, endStr, function(s, e) {
      return fetchServiceOrdersRaw_(token, s, e);
    });
    Logger.log('  → ' + rawOrders.length + ' orders');

    // Re-enabled 2026-05-20: enrichment fetches /ServiceOrders/{id} for near-term
    // orders to extract Tech2/TechID2 from the Technicians array (the list endpoint
    // doesn't return secondary techs). Capped at 350 orders × 14 days.
    enrichNearTermOrders_(token, rawOrders);

    // Invoices intentionally skipped — PestPac /Invoices is keyed-lookup only.
    // Billing signal arrives via webhooks (InvoiceWebhookHandler.gs).

    // ── Build curated payload (every refresh) ──
    var curatedOrders = rawOrders.map(function(o) { return curate_(o, CURATED_FIELDS_ORDER); });

    var curatedCache = {
      updated: new Date().toISOString(),
      windowStart: startStr, windowEnd: endStr,
      orders: curatedOrders
    };
    var curatedJson = JSON.stringify(curatedCache);
    Logger.log('  cache.json (curated): ' + curatedJson.length + ' chars (' + Math.round(curatedJson.length / 1024) + ' KB)');

    Logger.log('  Pushing cache.json...');
    var okCurated = pushToGitHub_(curatedJson, GH_PATH_CURATED, 'Production cache refresh ' + new Date().toISOString());

    // ── Build raw payload (only if due) ──
    var okRaw = null;
    if (rawWriteDue_()) {
      Logger.log('  Raw write due (≥' + RAW_REFRESH_MIN_HOURS + 'h since last) — building cache-raw.json...');
      var rawCache = {
        updated: new Date().toISOString(),
        windowStart: startStr, windowEnd: endStr,
        orders: rawOrders
      };
      var rawJson = JSON.stringify(rawCache);
      Logger.log('  cache-raw.json: ' + rawJson.length + ' chars (' + Math.round(rawJson.length / 1024) + ' KB)');
      okRaw = pushToGitHub_(rawJson, GH_PATH_RAW, 'Production raw snapshot ' + new Date().toISOString());
      if (okRaw) markRawWritten_();
    } else {
      var lastWrite = PropertiesService.getScriptProperties().getProperty(RAW_REFRESH_KEY);
      Logger.log('  Raw write skipped (last write: ' + lastWrite + ')');
    }

    var elapsed = ((new Date() - t0) / 1000).toFixed(1);
    Logger.log('✅ Refresh complete in ' + elapsed + 's | curated: ' + (okCurated ? 'OK' : 'FAIL') +
               ' | raw: ' + (okRaw === null ? 'SKIPPED' : (okRaw ? 'OK' : 'FAIL')));
  } catch (err) {
    Logger.log('❌ Refresh error: ' + err.message + '\n' + err.stack);
  }
}

// Force-write the raw snapshot regardless of cooldown — for manual runs only
function forceRawSnapshot() {
  PropertiesService.getScriptProperties().deleteProperty(RAW_REFRESH_KEY);
  refreshProductionCache();
}

// ══════════════════════════════════════════════════════════════
// LOCATIONS CACHE — separate file, incremental fetch
// ══════════════════════════════════════════════════════════════
// Lives at cache-locations.json on GitHub Pages. Keyed by LocationID.
// The dashboard joins service orders → locations at render time.
//
// First call = full backfill of all unique LocationIDs in cache.json (~2 min).
// Subsequent calls = incremental — only fetches LocationIDs not yet in the
// cache (typically 0–10 new per refresh).
//
// Recommend a daily time-driven trigger on this function (e.g., 4am ET)
// to pick up new customers and refresh stale records over time.
function refreshLocationsCache() {
  var t0 = new Date();
  Logger.log('🏠 Locations cache refresh — ' + t0.toISOString());
  try {
    var token = ppToken_();

    // Pull existing locations cache from GitHub Pages
    var existing = readLocationsCache_();
    var existingMap = {};
    (existing.locations || []).forEach(function(l) {
      if (l.LocationID) existingMap[l.LocationID] = l;
    });
    Logger.log('  Existing cache: ' + Object.keys(existingMap).length + ' locations');

    // Pull live cache.json to find which LocationIDs we currently need
    var ordersResp = UrlFetchApp.fetch(
      'https://catseye-internal.github.io/Production-Dashboard/cache.json',
      { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } }
    );
    if (ordersResp.getResponseCode() !== 200) {
      throw new Error('cache.json fetch HTTP ' + ordersResp.getResponseCode());
    }
    var ordersData = JSON.parse(ordersResp.getContentText());
    var seen = {};
    (ordersData.orders || []).forEach(function(o) {
      if (o.LocationID) seen[o.LocationID] = true;
    });
    var allLocIds = Object.keys(seen);
    Logger.log('  Unique LocationIDs in cache.json: ' + allLocIds.length);

    // Determine which to fetch (any LocationID not yet in the existing cache)
    var newLocIds = allLocIds.filter(function(lid) { return !existingMap[lid]; });
    Logger.log('  New LocationIDs to fetch: ' + newLocIds.length);

    if (newLocIds.length > 0) {
      var fetched = fetchLocations_(token, newLocIds);
      Logger.log('  Successfully fetched ' + fetched.length + ' new locations');
      fetched.forEach(function(loc) {
        if (loc.LocationID) existingMap[loc.LocationID] = loc;
      });
    } else {
      Logger.log('  ✓ Cache up to date — no new fetches needed');
    }

    // Build final array (sorted by LocationID for deterministic ordering)
    var allLocs = [];
    Object.keys(existingMap).forEach(function(k) { allLocs.push(existingMap[k]); });
    allLocs.sort(function(a, b) { return Number(a.LocationID) - Number(b.LocationID); });

    var cache = {
      updated: new Date().toISOString(),
      recordCount: allLocs.length,
      locations: allLocs
    };
    var jsonStr = JSON.stringify(cache);
    Logger.log('  cache-locations.json: ' + jsonStr.length + ' chars (' + Math.round(jsonStr.length / 1024) + ' KB, ' + allLocs.length + ' records)');

    var ok = pushToGitHub_(jsonStr, GH_PATH_LOCATIONS, 'Locations cache refresh ' + new Date().toISOString());
    var elapsed = ((new Date() - t0) / 1000).toFixed(1);
    Logger.log('✅ Locations refresh complete in ' + elapsed + 's | push: ' + (ok ? 'OK' : 'FAIL'));
  } catch (err) {
    Logger.log('❌ Locations refresh error: ' + err.message + '\n' + err.stack);
  }
}

// Parallel-fetch /Locations/{id} for a list of IDs. Returns curated records.
function fetchLocations_(token, locIds) {
  var out = [];
  var BATCH = 30;
  var headers = {
    'Authorization': 'Bearer ' + token,
    'apikey': PP_API_KEY,
    'tenant-id': PP_TENANT_ID
  };
  for (var i = 0; i < locIds.length; i += BATCH) {
    var slice = locIds.slice(i, i + BATCH);
    var requests = slice.map(function(lid) {
      return {
        url: PP_API_BASE + '/Locations/' + lid,
        method: 'get',
        headers: headers,
        muteHttpExceptions: true
      };
    });
    try {
      var responses = UrlFetchApp.fetchAll(requests);
      for (var k = 0; k < responses.length; k++) {
        if (responses[k].getResponseCode() !== 200) continue;
        try {
          var loc = JSON.parse(responses[k].getContentText());
          out.push(curate_(loc, CURATED_FIELDS_LOCATION));
        } catch (e) { /* skip parse error */ }
      }
    } catch (e) {
      Logger.log('    Locations batch starting at ' + i + ' failed: ' + e.message);
    }
    if (i + BATCH < locIds.length) Utilities.sleep(200);
  }
  return out;
}

function readLocationsCache_() {
  try {
    var resp = UrlFetchApp.fetch(
      'https://catseye-internal.github.io/Production-Dashboard/cache-locations.json',
      { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } }
    );
    if (resp.getResponseCode() !== 200) return { locations: [] };
    return JSON.parse(resp.getContentText());
  } catch (e) {
    return { locations: [] };
  }
}

// ──────────────────────────────────────────────────────────────
// Setups cache refresh — fetch /ServiceSetups/{id} for every unique
// SetupID referenced by orders in cache.json. Powers the Schedule +
// Frequency columns on both Service Orders and Invoices views.
//
// Strategy mirrors refreshLocationsCache: read the existing cache,
// only fetch SetupIDs we don't already have. Run as a separate trigger
// every 30–60 min (much less volatile than service orders).
// ──────────────────────────────────────────────────────────────
// Public entry — incremental refresh (only fetches SetupIDs not already cached).
// Use this as the regular trigger.
function refreshSetupsCache() { return refreshSetupsCacheImpl_(false); }

// Public entry — force full rebuild (re-fetches every SetupID, ignoring cache).
// Use this when the whitelist changes or when you suspect stale curated fields.
function rebuildSetupsCache() { return refreshSetupsCacheImpl_(true); }

function refreshSetupsCacheImpl_(forceFull) {
  var t0 = new Date();
  Logger.log('📋 Setups cache ' + (forceFull ? 'REBUILD (force full)' : 'refresh') + ' — ' + t0.toISOString());
  try {
    var token = ppToken_();

    // Existing setups cache — empty map when forcing full rebuild
    var existingMap = {};
    if (!forceFull) {
      var existing = readSetupsCache_();
      (existing.setups || []).forEach(function(s) {
        if (s.SetupID != null) existingMap[String(s.SetupID)] = s;
      });
    }
    Logger.log('  Existing cache: ' + Object.keys(existingMap).length + ' setups' + (forceFull ? ' (ignored — forcing rebuild)' : ''));

    // Pull live orders to find which SetupIDs we currently need
    var ordersResp = UrlFetchApp.fetch(
      'https://catseye-internal.github.io/Production-Dashboard/cache.json',
      { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } }
    );
    if (ordersResp.getResponseCode() !== 200) {
      throw new Error('cache.json fetch HTTP ' + ordersResp.getResponseCode());
    }
    var ordersData = JSON.parse(ordersResp.getContentText());
    var seen = {};
    (ordersData.orders || []).forEach(function(o) {
      if (o.SetupID) seen[String(o.SetupID)] = true;
    });
    var allSetupIds = Object.keys(seen);
    Logger.log('  Unique SetupIDs in cache.json: ' + allSetupIds.length);

    // Only fetch SetupIDs we don't already have
    var newSetupIds = allSetupIds.filter(function(sid) { return !existingMap[sid]; });
    Logger.log('  New SetupIDs to fetch: ' + newSetupIds.length);

    if (newSetupIds.length > 0) {
      var fetched = fetchSetups_(token, newSetupIds);
      Logger.log('  Successfully fetched ' + fetched.length + ' new setups');
      fetched.forEach(function(s) {
        if (s.SetupID != null) existingMap[String(s.SetupID)] = s;
      });
    } else {
      Logger.log('  ✓ Cache up to date — no new fetches needed');
    }

    // Build final array, sorted by SetupID
    var allSetups = [];
    Object.keys(existingMap).forEach(function(k) { allSetups.push(existingMap[k]); });
    allSetups.sort(function(a, b) { return Number(a.SetupID) - Number(b.SetupID); });

    var cache = {
      updated: new Date().toISOString(),
      recordCount: allSetups.length,
      setups: allSetups
    };
    var jsonStr = JSON.stringify(cache);
    Logger.log('  cache-setups.json: ' + jsonStr.length + ' chars (' + Math.round(jsonStr.length / 1024) + ' KB, ' + allSetups.length + ' records)');

    var ok = pushToGitHub_(jsonStr, GH_PATH_SETUPS, 'Setups cache refresh ' + new Date().toISOString());
    var elapsed = ((new Date() - t0) / 1000).toFixed(1);
    Logger.log('✅ Setups refresh complete in ' + elapsed + 's | push: ' + (ok ? 'OK' : 'FAIL'));
  } catch (err) {
    Logger.log('❌ Setups refresh error: ' + err.message + '\n' + err.stack);
  }
}

// Parallel-fetch /ServiceSetups/{id} for a list of IDs. Returns curated records.
// Dumps the first successful response's keys to the log so we can adjust
// CURATED_FIELDS_SETUP if PestPac returns unexpected field names.
function fetchSetups_(token, setupIds) {
  var out = [];
  var BATCH = 30;
  var headers = {
    'Authorization': 'Bearer ' + token,
    'apikey': PP_API_KEY,
    'tenant-id': PP_TENANT_ID
  };
  var loggedShape = false;
  for (var i = 0; i < setupIds.length; i += BATCH) {
    var slice = setupIds.slice(i, i + BATCH);
    var requests = slice.map(function(sid) {
      return {
        url: PP_API_BASE + '/ServiceSetups/' + sid,
        method: 'get',
        headers: headers,
        muteHttpExceptions: true
      };
    });
    try {
      var responses = UrlFetchApp.fetchAll(requests);
      for (var k = 0; k < responses.length; k++) {
        if (responses[k].getResponseCode() !== 200) continue;
        try {
          var setup = JSON.parse(responses[k].getContentText());
          if (!loggedShape) {
            Logger.log('    /ServiceSetups/{id} response keys (' + Object.keys(setup).length + '): ' + Object.keys(setup).sort().join(', '));
            Logger.log('    Sample JSON: ' + JSON.stringify(setup).substring(0, 800));
            loggedShape = true;
          }
          var curatedSetup = curate_(setup, CURATED_FIELDS_SETUP);
          enrichSetupCreator_(curatedSetup, setup);
          out.push(curatedSetup);
        } catch (e) { /* skip parse error */ }
      }
    } catch (e) {
      Logger.log('    Setups batch starting at ' + i + ' failed: ' + e.message);
    }
    if (i + BATCH < setupIds.length) Utilities.sleep(200);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// Invoice backfill — fix gaps left by webhook race-condition drops.
//
// Strategy: for every Service Order in the date window that's marked Posted
// (or that has SubTotal > 0), check if the cache has an invoice matching
// that OrderNumber. If not, fetch /Invoices?orderNumber={OrderNumber} and
// upsert into the cache. Also catches callbacks (OrderType='CallBack' →
// CB-typed invoices).
//
// USAGE:
//   backfillInvoicesForDays(1)   — yesterday only
//   backfillInvoicesForDays(7)   — last 7 days
//   backfillInvoicesForDays(30)  — last 30 days (safer for catch-up)
// ──────────────────────────────────────────────────────────────
function backfillInvoicesForYesterday() { return backfillInvoicesForDays(1); }
function backfillInvoicesForWeek()      { return backfillInvoicesForDays(7); }
function backfillInvoicesForMonth()     { return backfillInvoicesForDays(30); }

function backfillInvoicesForDays(daysBack) {
  var t0 = new Date();
  Logger.log('🩹 Invoice backfill — last ' + daysBack + ' day(s) — ' + t0.toISOString());
  try {
    var token = ppToken_();
    var end = new Date(); end.setHours(0, 0, 0, 0);
    var start = new Date(end); start.setDate(start.getDate() - daysBack);
    // Service orders for the window (chunked 14d under the hood)
    Logger.log('  Window: ' + fmt_(start) + ' → ' + fmt_(end));
    var orders = [];
    chunked14_(start, end, function(s, e) {
      var page = fetchServiceOrdersRaw_(token, s, e);
      for (var i = 0; i < page.length; i++) orders.push(page[i]);
      return [];
    });
    Logger.log('  Service orders in window: ' + orders.length);

    // Don't filter by Posted/SubTotal — the slim service-order records returned
    // by the list endpoint don't reliably populate those fields. Just keep every
    // order with an OrderID and let the missing-from-cache check below do the
    // filtering. (We use OrderID, not OrderNumber, because the existing
    // fetchInvoiceForOrder_ helper proved orderId is the working query param.)
    var candidates = orders.filter(function(o) { return o.OrderID; });
    Logger.log('  Candidates with OrderID: ' + candidates.length);

    // Read existing cache. Index by BOTH OrderID and OrderNumber so we don't
    // re-fetch invoices we already have under either key.
    var cache = readInvoicesCacheDirect_();
    var haveOrderID = {}, haveOrderNumber = {};
    (cache.invoices || []).forEach(function(inv) {
      if (inv.OrderID != null)     haveOrderID[String(inv.OrderID)]         = true;
      if (inv.OrderNumber != null) haveOrderNumber[String(inv.OrderNumber)] = true;
    });
    Logger.log('  Invoices already in cache: ' + (cache.invoices || []).length);

    // Missing orders (no invoice yet in cache under either key)
    var missing = candidates.filter(function(o) {
      if (o.OrderID != null     && haveOrderID[String(o.OrderID)])         return false;
      if (o.OrderNumber != null && haveOrderNumber[String(o.OrderNumber)]) return false;
      return true;
    });
    Logger.log('  Missing orders to fetch: ' + missing.length);
    if (missing.length === 0) {
      Logger.log('✅ Nothing to backfill');
      return;
    }

    // Fetch each /Invoices?orderId=X in parallel batches of 30
    var headers = {
      'Authorization': 'Bearer ' + token,
      'apikey': PP_API_KEY,
      'tenant-id': PP_TENANT_ID
    };
    var BATCH = 30;
    var fetched = [];
    var statsByCode = {};
    var samples = { ok: [], notFound: [], error: [] };
    for (var i = 0; i < missing.length; i += BATCH) {
      var slice = missing.slice(i, i + BATCH);
      var requests = slice.map(function(o) {
        return {
          url: PP_API_BASE + '/Invoices?orderId=' + encodeURIComponent(o.OrderID),
          method: 'get',
          headers: headers,
          muteHttpExceptions: true
        };
      });
      var responses;
      try { responses = UrlFetchApp.fetchAll(requests); }
      catch (e) { Logger.log('    batch ' + i + ' failed: ' + e.message); continue; }
      for (var k = 0; k < responses.length; k++) {
        var resp = responses[k];
        var code = resp.getResponseCode();
        var body = resp.getContentText() || '';
        statsByCode[code] = (statsByCode[code] || 0) + 1;
        if (code !== 200) {
          if (samples.error.length < 3) samples.error.push({ orderId: slice[k].OrderID, code: code, body: body.substring(0, 200) });
          continue;
        }
        var inv = null;
        try {
          var parsed = JSON.parse(body);
          // PestPac may return a single object OR a 1-element array — handle both
          if (Array.isArray(parsed)) {
            if (parsed.length > 0 && parsed[0] && parsed[0].InvoiceNumber) inv = parsed[0];
          } else if (parsed && parsed.InvoiceNumber) {
            inv = parsed;
          }
        } catch (e) {
          if (samples.error.length < 3) samples.error.push({ orderId: slice[k].OrderID, code: code, body: 'PARSE ERR: ' + body.substring(0, 200) });
        }
        if (inv) {
          fetched.push(inv);
          if (samples.ok.length < 2) samples.ok.push({ orderId: slice[k].OrderID, invNum: inv.InvoiceNumber, keyCount: Object.keys(inv).length });
        } else {
          if (samples.notFound.length < 3) samples.notFound.push({ orderId: slice[k].OrderID, code: code, body: body.substring(0, 200) });
        }
      }
      if (i + BATCH < missing.length) Utilities.sleep(200);
    }
    Logger.log('  HTTP status breakdown: ' + JSON.stringify(statsByCode));
    if (samples.ok.length)       Logger.log('  Sample SUCCESS: ' + JSON.stringify(samples.ok));
    if (samples.notFound.length) Logger.log('  Sample NOT-FOUND (200 but no InvoiceNumber): ' + JSON.stringify(samples.notFound));
    if (samples.error.length)    Logger.log('  Sample ERRORS: ' + JSON.stringify(samples.error));
    Logger.log('  Fetched ' + fetched.length + ' invoice records from PestPac');

    if (fetched.length === 0) {
      Logger.log('✅ No invoices returned (orders may not be posted yet)');
      return;
    }

    // Curate and merge — same shape as webhook-delivered records
    var curated = fetched.map(curateInvoiceForBackfill_);

    // Single batched write to cache-invoices.json via pushToGitHub_
    var byKey = {};
    (cache.invoices || []).forEach(function(inv) {
      if (inv.InvoiceNumber) byKey[String(inv.InvoiceNumber)] = inv;
    });
    var added = 0, updated = 0;
    curated.forEach(function(inv) {
      var k = String(inv.InvoiceNumber);
      if (byKey[k]) { byKey[k] = inv; updated++; }
      else          { byKey[k] = inv; added++; }
    });
    var merged = [];
    Object.keys(byKey).forEach(function(k) { merged.push(byKey[k]); });

    cache.invoices = merged;
    cache.updated = new Date().toISOString();
    cache.recordCount = merged.length;
    cache.lastBackfill = new Date().toISOString();
    var jsonStr = JSON.stringify(cache);
    Logger.log('  Writing cache-invoices.json: ' + Math.round(jsonStr.length / 1024) + ' KB | added ' + added + ', updated ' + updated);

    var ok = pushToGitHub_(jsonStr, GH_PATH_INVOICES_FOR_BACKFILL, 'Invoice backfill ' + daysBack + 'd ' + new Date().toISOString());
    var elapsed = ((new Date() - t0) / 1000).toFixed(1);
    Logger.log('✅ Backfill complete in ' + elapsed + 's | push: ' + (ok ? 'OK' : 'FAIL'));
  } catch (err) {
    Logger.log('❌ Backfill error: ' + err.message + '\n' + err.stack);
  }
}

// Read cache-invoices.json directly from GitHub Pages (raw mirror is the same)
function readInvoicesCacheDirect_() {
  try {
    var resp = UrlFetchApp.fetch(
      'https://catseye-internal.github.io/Production-Dashboard/cache-invoices.json',
      { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } }
    );
    if (resp.getResponseCode() !== 200) return { invoices: [] };
    return JSON.parse(resp.getContentText());
  } catch (e) {
    return { invoices: [] };
  }
}

// Curate to the same shape webhook upserts produce. Mirrors CURATED_INV_KEYS
// in InvoiceWebhookHandler.gs. Inlined here so backfill doesn't depend on
// load order of the two files (Apps Script global namespace is single-bin).
const BACKFILL_INV_KEYS = [
  'InvoiceNumber', 'InvoiceType', 'OrderNumber', 'OrderID', 'InvoiceID',
  'InvoiceDate', 'WorkDate', 'OrderDate',
  'Branch', 'BranchID', 'LocationID', 'BillToID',
  'ServiceClass', 'ServiceDescription', 'ServiceCode', 'Route',
  'Tech', 'Tech2', 'Sales', 'EnteredBy',
  'SubTotal', 'Tax', 'Total', 'Balance', 'AgingDays', 'NetDays',
  'SaleValue', 'ProductionValue', 'TaxableAmount', 'TaxRate',
  'Source', 'Origin', 'PostedBy',
  'Voided'
];
function curateInvoiceForBackfill_(rec) {
  var out = {};
  for (var i = 0; i < BACKFILL_INV_KEYS.length; i++) {
    var k = BACKFILL_INV_KEYS[i];
    var v = rec[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v === '') continue;
    if (typeof v === 'number' && v === 0 && k !== 'Total') continue;
    out[k] = v;
  }
  return out;
}
const GH_PATH_INVOICES_FOR_BACKFILL = 'cache-invoices.json';

function readSetupsCache_() {
  try {
    var resp = UrlFetchApp.fetch(
      'https://catseye-internal.github.io/Production-Dashboard/cache-setups.json',
      { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } }
    );
    if (resp.getResponseCode() !== 200) return { setups: [] };
    return JSON.parse(resp.getContentText());
  } catch (e) {
    return { setups: [] };
  }
}

// ══════════════════════════════════════════════════════════════
// SETUP BOOTSTRAP — one-time pull of every setup tied to active customers
// ══════════════════════════════════════════════════════════════
// Captures setups that aren't linked to current orders in cache.json (e.g.,
// setups whose next service is >90 days out, recently cancelled setups, or
// setups for new customers whose first SO hasn't been created yet).
//
// Strategy: probe the endpoint patterns first (probeLocationSetupsEndpoint),
// then iterate every Active location and pull its setups via whichever pattern
// PestPac supports. Idempotent — safe to re-run.

// One-time bootstrap. Iterates every location in cache-locations.json, fetches
// /Locations/{id}/serviceSetups for each, curates the returned setups + enriches
// EnteredBy/SalesBy via the shared helper, and merges everything into
// cache-setups.json. Captures setups that the incremental refresh misses
// (setups whose first SO is far in the future, recently cancelled setups with
// no remaining orders, etc.).
//
// Idempotent. Backs up cache before writing. Resume-friendly via Script Property.
// Manual-run only (might exceed the 6-min trigger limit at full scale).
//
// USAGE
//   bootstrapAllSetups()          — full run, fresh start (clears resume state)
//   bootstrapAllSetupsResume()    — pick up from last resume checkpoint
//   bootstrapAllSetupsTest(50)    — test against first N locations, write nothing
//
// Joe directive 2026-05-25.

var BOOTSTRAP_BATCH_SIZE = 25;
var BOOTSTRAP_BATCH_PAUSE_MS = 200;
var BOOTSTRAP_CHECKPOINT_EVERY = 200;  // save resume state every N locations
var BOOTSTRAP_RESUME_KEY = 'bootstrapSetupsCursor';
var BOOTSTRAP_PENDING_KEY = 'bootstrapSetupsPending';  // JSON blob: { setups: [...] }

function bootstrapAllSetups() {
  PropertiesService.getScriptProperties().deleteProperty(BOOTSTRAP_RESUME_KEY);
  PropertiesService.getScriptProperties().deleteProperty(BOOTSTRAP_PENDING_KEY);
  return _bootstrapImpl_(false, null);
}

function bootstrapAllSetupsResume() {
  return _bootstrapImpl_(true, null);
}

function bootstrapAllSetupsTest(limit) {
  PropertiesService.getScriptProperties().deleteProperty(BOOTSTRAP_RESUME_KEY);
  PropertiesService.getScriptProperties().deleteProperty(BOOTSTRAP_PENDING_KEY);
  return _bootstrapImpl_(false, limit || 50, /*dryRun=*/true);
}

function _bootstrapImpl_(resume, limit, dryRun) {
  var t0 = new Date();
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log((dryRun ? '🧪 DRY RUN — Bootstrap setups' : '📦 Bootstrap setups') +
             (resume ? ' (RESUMING)' : '') + ' — ' + t0.toISOString());
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Load locations from GitHub Pages
  Logger.log('1. Loading cache-locations.json...');
  var locResp = UrlFetchApp.fetch(
    'https://catseye-internal.github.io/Production-Dashboard/cache-locations.json',
    { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } }
  );
  if (locResp.getResponseCode() !== 200) {
    Logger.log('❌ cache-locations.json fetch HTTP ' + locResp.getResponseCode());
    return;
  }
  var allLocs = (JSON.parse(locResp.getContentText()).locations || [])
    .filter(function(l) { return l.LocationID; });
  Logger.log('   ' + allLocs.length.toLocaleString() + ' locations in cache');

  // 2. Load existing setups (so we merge instead of overwrite)
  Logger.log('2. Loading existing cache-setups.json...');
  var existing = readSetupsCache_();
  var setupsMap = {};
  (existing.setups || []).forEach(function(s) {
    if (s.SetupID != null) setupsMap[String(s.SetupID)] = s;
  });
  Logger.log('   ' + Object.keys(setupsMap).length.toLocaleString() + ' setups already cached');

  // 3. Apply resume state — start from last checkpoint
  var props = PropertiesService.getScriptProperties();
  var startIdx = 0;
  if (resume) {
    var cursor = Number(props.getProperty(BOOTSTRAP_RESUME_KEY) || 0);
    if (cursor > 0 && cursor < allLocs.length) {
      startIdx = cursor;
      Logger.log('   Resuming from index ' + startIdx.toLocaleString());
    }
    // Reload pending setups from prior run
    var pendingStr = props.getProperty(BOOTSTRAP_PENDING_KEY);
    if (pendingStr) {
      try {
        var pending = JSON.parse(pendingStr).setups || [];
        pending.forEach(function(s) {
          if (s.SetupID != null) setupsMap[String(s.SetupID)] = s;
        });
        Logger.log('   Restored ' + pending.length.toLocaleString() + ' pending setups from checkpoint');
      } catch (e) { /* ignore */ }
    }
  }

  // 4. Apply limit (test mode)
  var locList = allLocs;
  if (limit) {
    locList = allLocs.slice(0, limit);
    Logger.log('   Limited to first ' + locList.length + ' locations (test mode)');
  }

  // 5. Auth + iterate
  Logger.log('3. Fetching PestPac token...');
  var token = ppToken_();
  var apiHeaders = {
    'Authorization': 'Bearer ' + token,
    'apikey': PP_API_KEY,
    'tenant-id': PP_TENANT_ID
  };

  Logger.log('4. Iterating locations in batches of ' + BOOTSTRAP_BATCH_SIZE + '...');
  var processed = startIdx;
  var newSetupCount = 0;
  var updatedSetupCount = 0;
  var failedLocations = 0;

  for (var i = startIdx; i < locList.length; i += BOOTSTRAP_BATCH_SIZE) {
    var slice = locList.slice(i, i + BOOTSTRAP_BATCH_SIZE);
    var requests = slice.map(function(l) {
      return {
        url: PP_API_BASE + '/Locations/' + l.LocationID + '/serviceSetups',
        method: 'get',
        headers: apiHeaders,
        muteHttpExceptions: true
      };
    });

    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      Logger.log('   Batch starting at ' + i + ' failed entirely: ' + e.message);
      failedLocations += slice.length;
      continue;
    }

    for (var k = 0; k < responses.length; k++) {
      var resp = responses[k];
      if (resp.getResponseCode() !== 200) { failedLocations++; continue; }
      try {
        var setups = JSON.parse(resp.getContentText());
        if (!Array.isArray(setups)) continue;
        setups.forEach(function(rawSetup) {
          if (!rawSetup || rawSetup.SetupID == null) return;
          var curated = curate_(rawSetup, CURATED_FIELDS_SETUP);
          enrichSetupCreator_(curated, rawSetup);
          var key = String(curated.SetupID);
          // CRITICAL: the list endpoint /Locations/{id}/serviceSetups does NOT
          // return the Technicians array, so EnteredBy + SalesBy will be missing
          // on the curated record. Preserve any existing values from the cache
          // (which were populated by /ServiceSetups/{id} detail pulls or webhook
          // events) so we don't clobber good data with nothing.
          if (setupsMap[key]) {
            var prev = setupsMap[key];
            if (!curated.EnteredBy && prev.EnteredBy) {
              curated.EnteredBy = prev.EnteredBy;
              if (prev.EnteredByID != null) curated.EnteredByID = prev.EnteredByID;
            }
            if (!curated.SalesBy && prev.SalesBy) curated.SalesBy = prev.SalesBy;
            updatedSetupCount++;
          } else {
            newSetupCount++;
          }
          setupsMap[key] = curated;
        });
      } catch (e) { /* skip parse error */ }
    }

    processed += slice.length;

    // Progress + checkpoint
    if (processed % 100 === 0 || processed === locList.length) {
      var elapsed = ((new Date() - t0) / 1000);
      var rate = processed > startIdx ? (processed - startIdx) / elapsed : 0;
      var remaining = locList.length - processed;
      var etaMin = rate > 0 ? (remaining / rate / 60).toFixed(1) : '?';
      Logger.log('   [' + processed.toLocaleString() + ' / ' + locList.length.toLocaleString() + ']  ' +
                 'setups: ' + (newSetupCount + Object.keys(setupsMap).length - (existing.setups || []).length).toLocaleString() + ' new, ' +
                 updatedSetupCount.toLocaleString() + ' refreshed · ' +
                 failedLocations + ' failed locations · ' +
                 rate.toFixed(0) + '/s · eta ' + etaMin + 'm');
    }

    // Save checkpoint
    if (!dryRun && processed % BOOTSTRAP_CHECKPOINT_EVERY === 0) {
      props.setProperty(BOOTSTRAP_RESUME_KEY, String(processed));
      var pendingArr = [];
      Object.keys(setupsMap).forEach(function(k) { pendingArr.push(setupsMap[k]); });
      // Don't try to serialize giant blobs to ScriptProperties (50KB limit) —
      // just save the cursor. If interrupted, resume will reload from GitHub
      // cache + pick up new setups from the resume cursor onward.
    }

    if (i + BOOTSTRAP_BATCH_SIZE < locList.length) Utilities.sleep(BOOTSTRAP_BATCH_PAUSE_MS);
  }

  // 6. Write the merged cache back to GitHub
  var allSetups = [];
  Object.keys(setupsMap).forEach(function(k) { allSetups.push(setupsMap[k]); });
  allSetups.sort(function(a, b) { return Number(a.SetupID) - Number(b.SetupID); });

  Logger.log('');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('SUMMARY');
  Logger.log('   Locations processed:   ' + processed.toLocaleString());
  Logger.log('   Failed location calls: ' + failedLocations.toLocaleString());
  Logger.log('   Setups before:         ' + (existing.setups || []).length.toLocaleString());
  Logger.log('   Setups after:          ' + allSetups.length.toLocaleString());
  Logger.log('   Net new:               ' + (allSetups.length - (existing.setups || []).length).toLocaleString());
  Logger.log('   Refreshed (duplicate): ' + updatedSetupCount.toLocaleString());

  if (dryRun) {
    Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    Logger.log('🧪 DRY RUN — cache NOT written');
    return;
  }

  // Write back via the existing pushToGitHub_ helper (same as refreshSetupsCache)
  var cache = {
    updated: new Date().toISOString(),
    recordCount: allSetups.length,
    lastBootstrapAt: new Date().toISOString(),
    setups: allSetups
  };
  var jsonStr = JSON.stringify(cache);
  Logger.log('');
  Logger.log('5. Writing cache-setups.json: ' + Math.round(jsonStr.length / 1024) + ' KB, ' +
             allSetups.length + ' records');
  var ok = pushToGitHub_(jsonStr, GH_PATH_SETUPS, 'Bootstrap setups refresh ' + new Date().toISOString());
  Logger.log('   push: ' + (ok ? 'OK' : 'FAIL'));

  // Clear resume state on successful completion
  if (ok) {
    props.deleteProperty(BOOTSTRAP_RESUME_KEY);
    props.deleteProperty(BOOTSTRAP_PENDING_KEY);
  }

  var totalElapsed = ((new Date() - t0) / 1000).toFixed(1);
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ Bootstrap complete in ' + totalElapsed + 's');
}

// Repair function — iterates every cached setup, re-fetches via /ServiceSetups/{id}
// to pull the Technicians array, runs enrichSetupCreator_ to extract EnteredBy + SalesBy,
// merges back into cache-setups.json.
//
// Why this exists: the bootstrap above uses /Locations/{id}/serviceSetups for fast
// SetupID discovery, BUT that list endpoint doesn't include the Technicians array.
// So bootstrap-pulled records had no creator info. This function fills the gap.
//
// Resume-friendly via Script Property cursor. Safe to re-run.
//
// USAGE
//   reenrichAllSetupsCreators()           — full run, fresh start
//   reenrichAllSetupsCreatorsResume()     — pick up from last checkpoint
//   reenrichAllSetupsCreatorsTest(50)     — dry run, first 50 setups, no write

var RE_BATCH_SIZE = 25;
var RE_BATCH_PAUSE_MS = 200;
var RE_CHECKPOINT_EVERY = 500;
var RE_CURSOR_KEY = 'reenrichCreatorsCursor';

function reenrichAllSetupsCreators() {
  PropertiesService.getScriptProperties().deleteProperty(RE_CURSOR_KEY);
  return _reenrichImpl_(false, null);
}

function reenrichAllSetupsCreatorsResume() {
  return _reenrichImpl_(true, null);
}

function reenrichAllSetupsCreatorsTest(limit) {
  PropertiesService.getScriptProperties().deleteProperty(RE_CURSOR_KEY);
  return _reenrichImpl_(false, limit || 50, /*dryRun=*/true);
}

function _reenrichImpl_(resume, limit, dryRun) {
  var t0 = new Date();
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log((dryRun ? '🧪 DRY RUN — Re-enrich setup creators' : '🔧 Re-enrich setup creators') +
             (resume ? ' (RESUMING)' : '') + ' — ' + t0.toISOString());
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Load existing setups
  Logger.log('1. Loading cache-setups.json...');
  var existing = readSetupsCache_();
  var setupsArr = existing.setups || [];
  Logger.log('   ' + setupsArr.length.toLocaleString() + ' setups in cache');

  // 2. Find candidates (setups missing EnteredBy) — or all if --force flag would exist
  var candidates = setupsArr.filter(function(s) { return !s.EnteredBy; });
  Logger.log('   ' + candidates.length.toLocaleString() + ' candidates missing EnteredBy');

  // 3. Apply resume cursor
  var props = PropertiesService.getScriptProperties();
  var startIdx = 0;
  if (resume) {
    var cursor = Number(props.getProperty(RE_CURSOR_KEY) || 0);
    if (cursor > 0 && cursor < candidates.length) {
      startIdx = cursor;
      Logger.log('   Resuming from index ' + startIdx.toLocaleString());
    }
  }

  // 4. Apply limit
  if (limit && candidates.length - startIdx > limit) {
    candidates = candidates.slice(startIdx, startIdx + limit);
    Logger.log('   Limited to ' + candidates.length + ' for this run');
  } else if (startIdx > 0) {
    candidates = candidates.slice(startIdx);
  }

  if (candidates.length === 0) {
    Logger.log('✅ Nothing to re-enrich.');
    return;
  }

  // 5. Build a SetupID → setup index for fast patching
  var setupIdx = {};
  setupsArr.forEach(function(s, i) {
    if (s.SetupID != null) setupIdx[String(s.SetupID)] = i;
  });

  // 6. Auth
  Logger.log('2. Fetching PestPac token...');
  var token = ppToken_();
  var apiHeaders = {
    'Authorization': 'Bearer ' + token,
    'apikey': PP_API_KEY,
    'tenant-id': PP_TENANT_ID
  };

  // 7. Iterate
  Logger.log('3. Re-enriching ' + candidates.length.toLocaleString() + ' setups in batches of ' + RE_BATCH_SIZE + '...');
  var enriched = 0;
  var missing = 0;     // /ServiceSetups/{id} returned but no Technicians
  var failed = 0;      // API call itself failed

  for (var i = 0; i < candidates.length; i += RE_BATCH_SIZE) {
    var slice = candidates.slice(i, i + RE_BATCH_SIZE);
    var requests = slice.map(function(s) {
      return {
        url: PP_API_BASE + '/ServiceSetups/' + s.SetupID,
        method: 'get',
        headers: apiHeaders,
        muteHttpExceptions: true
      };
    });

    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      failed += slice.length;
      continue;
    }

    for (var k = 0; k < responses.length; k++) {
      var resp = responses[k];
      if (resp.getResponseCode() !== 200) { failed++; continue; }
      try {
        var fullSetup = JSON.parse(resp.getContentText());
        var sid = String(slice[k].SetupID);
        var idx = setupIdx[sid];
        if (idx == null) continue;
        // Only patch the creator fields onto the existing cached record —
        // leave everything else alone so we don't accidentally clobber data
        // that other code already filled in.
        var beforeEntered = setupsArr[idx].EnteredBy;
        enrichSetupCreator_(setupsArr[idx], fullSetup);
        if (setupsArr[idx].EnteredBy) {
          enriched++;
        } else {
          missing++;
        }
      } catch (e) { failed++; }
    }

    var done = i + slice.length;
    if (done % 200 === 0 || done === candidates.length) {
      var elapsed = ((new Date() - t0) / 1000);
      var rate = done / elapsed;
      var remaining = candidates.length - done;
      var etaMin = (remaining / rate / 60).toFixed(1);
      Logger.log('   [' + done.toLocaleString() + ' / ' + candidates.length.toLocaleString() + ']  ' +
                 'enriched: ' + enriched.toLocaleString() + ' · ' +
                 'missing: ' + missing.toLocaleString() + ' · ' +
                 'failed: ' + failed.toLocaleString() + ' · ' +
                 rate.toFixed(0) + '/s · eta ' + etaMin + 'm');
    }

    // Save cursor for resume
    if (!dryRun && (done % RE_CHECKPOINT_EVERY === 0)) {
      props.setProperty(RE_CURSOR_KEY, String(startIdx + done));
    }

    if (i + RE_BATCH_SIZE < candidates.length) Utilities.sleep(RE_BATCH_PAUSE_MS);
  }

  Logger.log('');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('SUMMARY');
  Logger.log('   Setups re-enriched: ' + enriched.toLocaleString());
  Logger.log('   Missing Technicians: ' + missing.toLocaleString() + ' (API returned but no creator data)');
  Logger.log('   Failed calls:        ' + failed.toLocaleString());

  if (dryRun) {
    Logger.log('🧪 DRY RUN — cache NOT written');
    return;
  }

  // 8. Write back
  var cache = {
    updated: new Date().toISOString(),
    recordCount: setupsArr.length,
    lastReenrichAt: new Date().toISOString(),
    setups: setupsArr
  };
  var jsonStr = JSON.stringify(cache);
  Logger.log('');
  Logger.log('4. Writing cache-setups.json: ' + Math.round(jsonStr.length / 1024) + ' KB');
  var ok = pushToGitHub_(jsonStr, GH_PATH_SETUPS, 'Re-enrich setup creators ' + new Date().toISOString());
  Logger.log('   push: ' + (ok ? 'OK' : 'FAIL'));
  if (ok) props.deleteProperty(RE_CURSOR_KEY);

  var totalElapsed = ((new Date() - t0) / 1000).toFixed(1);
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ Re-enrich complete in ' + totalElapsed + 's');
}

// Repair function — re-fetch every Active=false (or CancelDate-populated) setup
// via /ServiceSetups/{id} to pull CancelDate + CancelReason. These fields are
// often missing from the bootstrap-cached records because the list endpoint
// /Locations/{id}/serviceSetups returns slim data on cancelled setups.
//
// Joe directive 2026-05-25 — CancelReason is required in PestPac but our cache
// shows 0 setups with it populated. And there's an Active=False vs CancelDate
// gap (618 vs 380) suggesting some cancelled setups don't have CancelDate either.
//
// Resume-friendly via Script Property cursor. Safe to re-run.
//
// USAGE
//   reenrichCancelledSetups()           — full run, fresh start
//   reenrichCancelledSetupsResume()     — pick up from last checkpoint
//   reenrichCancelledSetupsTest(50)     — dry run, first 50, no write

var REC_BATCH_SIZE = 25;
var REC_BATCH_PAUSE_MS = 200;
var REC_CHECKPOINT_EVERY = 200;
var REC_CURSOR_KEY = 'reenrichCancelledCursor';

function reenrichCancelledSetups() {
  PropertiesService.getScriptProperties().deleteProperty(REC_CURSOR_KEY);
  return _reenrichCancelledImpl_(false, null, false);
}

function reenrichCancelledSetupsResume() {
  return _reenrichCancelledImpl_(true, null, false);
}

function reenrichCancelledSetupsTest(limit) {
  PropertiesService.getScriptProperties().deleteProperty(REC_CURSOR_KEY);
  return _reenrichCancelledImpl_(false, limit || 50, true);
}

function _reenrichCancelledImpl_(resume, limit, dryRun) {
  var t0 = new Date();
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log((dryRun ? '🧪 DRY RUN — Re-enrich cancelled setups' : '🔧 Re-enrich cancelled setups') +
             (resume ? ' (RESUMING)' : '') + ' — ' + t0.toISOString());
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  Logger.log('1. Loading cache-setups.json...');
  var existing = readSetupsCache_();
  var setupsArr = existing.setups || [];
  Logger.log('   ' + setupsArr.length.toLocaleString() + ' setups in cache');

  // Candidates: any setup that's Active=false OR has CancelDate populated.
  // We want to fully refresh these because the bootstrap might have skipped
  // their CancelDate / CancelReason fields.
  var candidates = setupsArr.filter(function(s) {
    return s.Active === false || s.CancelDate;
  });
  Logger.log('   ' + candidates.length.toLocaleString() + ' candidates (Active=false OR CancelDate populated)');

  var props = PropertiesService.getScriptProperties();
  var startIdx = 0;
  if (resume) {
    var cursor = Number(props.getProperty(REC_CURSOR_KEY) || 0);
    if (cursor > 0 && cursor < candidates.length) {
      startIdx = cursor;
      Logger.log('   Resuming from index ' + startIdx.toLocaleString());
    }
  }
  if (limit && candidates.length - startIdx > limit) {
    candidates = candidates.slice(startIdx, startIdx + limit);
  } else if (startIdx > 0) {
    candidates = candidates.slice(startIdx);
  }

  if (candidates.length === 0) {
    Logger.log('✅ Nothing to re-enrich.');
    return;
  }

  // Build a SetupID → index map for fast patching
  var setupIdx = {};
  setupsArr.forEach(function(s, i) {
    if (s.SetupID != null) setupIdx[String(s.SetupID)] = i;
  });

  Logger.log('2. Fetching PestPac token...');
  var token = ppToken_();
  var apiHeaders = {
    'Authorization': 'Bearer ' + token,
    'apikey': PP_API_KEY,
    'tenant-id': PP_TENANT_ID
  };

  Logger.log('3. Re-fetching ' + candidates.length.toLocaleString() + ' cancelled setups in batches of ' + REC_BATCH_SIZE + '...');
  var refreshed = 0;
  var withCancelDate = 0;
  var withCancelReason = 0;
  var failed = 0;

  for (var i = 0; i < candidates.length; i += REC_BATCH_SIZE) {
    var slice = candidates.slice(i, i + REC_BATCH_SIZE);
    var requests = slice.map(function(s) {
      return {
        url: PP_API_BASE + '/ServiceSetups/' + s.SetupID,
        method: 'get',
        headers: apiHeaders,
        muteHttpExceptions: true
      };
    });

    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      failed += slice.length;
      continue;
    }

    for (var k = 0; k < responses.length; k++) {
      var resp = responses[k];
      if (resp.getResponseCode() !== 200) { failed++; continue; }
      try {
        var fullSetup = JSON.parse(resp.getContentText());
        var sid = String(slice[k].SetupID);
        var idx = setupIdx[sid];
        if (idx == null) continue;
        // Full re-curate so all whitelist fields get refreshed from the detail
        // endpoint (which DOES return CancelReason, full Technicians array, etc.)
        var refreshedCurated = curate_(fullSetup, CURATED_FIELDS_SETUP);
        enrichSetupCreator_(refreshedCurated, fullSetup);
        // Preserve any existing EnteredBy if somehow not on the new record
        if (!refreshedCurated.EnteredBy && setupsArr[idx].EnteredBy) {
          refreshedCurated.EnteredBy = setupsArr[idx].EnteredBy;
          if (setupsArr[idx].EnteredByID != null) refreshedCurated.EnteredByID = setupsArr[idx].EnteredByID;
        }
        setupsArr[idx] = refreshedCurated;
        refreshed++;
        if (refreshedCurated.CancelDate) withCancelDate++;
        if (refreshedCurated.CancelReason && String(refreshedCurated.CancelReason).trim()) withCancelReason++;
      } catch (e) { failed++; }
    }

    var done = i + slice.length;
    if (done % 100 === 0 || done === candidates.length) {
      var elapsed = ((new Date() - t0) / 1000);
      var rate = done / elapsed;
      var remaining = candidates.length - done;
      var etaMin = (remaining / rate / 60).toFixed(1);
      Logger.log('   [' + done.toLocaleString() + ' / ' + candidates.length.toLocaleString() + ']  ' +
                 'refreshed: ' + refreshed.toLocaleString() + ' · ' +
                 'with CancelDate: ' + withCancelDate.toLocaleString() + ' · ' +
                 'with CancelReason: ' + withCancelReason.toLocaleString() + ' · ' +
                 'failed: ' + failed + ' · ' +
                 rate.toFixed(0) + '/s · eta ' + etaMin + 'm');
    }

    if (!dryRun && (done % REC_CHECKPOINT_EVERY === 0)) {
      props.setProperty(REC_CURSOR_KEY, String(startIdx + done));
    }

    if (i + REC_BATCH_SIZE < candidates.length) Utilities.sleep(REC_BATCH_PAUSE_MS);
  }

  Logger.log('');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('SUMMARY');
  Logger.log('   Refreshed:           ' + refreshed.toLocaleString());
  Logger.log('   With CancelDate:     ' + withCancelDate.toLocaleString());
  Logger.log('   With CancelReason:   ' + withCancelReason.toLocaleString());
  Logger.log('   Failed calls:        ' + failed);

  if (dryRun) {
    Logger.log('🧪 DRY RUN — cache NOT written');
    return;
  }

  var cache = {
    updated: new Date().toISOString(),
    recordCount: setupsArr.length,
    lastCancelReenrichAt: new Date().toISOString(),
    setups: setupsArr
  };
  var jsonStr = JSON.stringify(cache);
  Logger.log('');
  Logger.log('4. Writing cache-setups.json: ' + Math.round(jsonStr.length / 1024) + ' KB');
  var ok = pushToGitHub_(jsonStr, GH_PATH_SETUPS, 'Re-enrich cancelled setups ' + new Date().toISOString());
  Logger.log('   push: ' + (ok ? 'OK' : 'FAIL'));
  if (ok) props.deleteProperty(REC_CURSOR_KEY);

  var totalElapsed = ((new Date() - t0) / 1000).toFixed(1);
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ Re-enrich cancelled complete in ' + totalElapsed + 's');
}

// Probe /Locations list-endpoint patterns to discover ALL locations
// (including cancelled customers not currently in cache-locations.json).
// The current cache-locations.json is populated from cache.json's 90-day
// forward window — so it misses customers with no recent orders. We need
// a way to discover cancelled customers' setups, which means finding all
// LocationIDs that aren't in our cache.
//
// Joe directive 2026-05-25 — paired with discovering the missing ~37 MTD
// cancellations not currently in cache.

function probeAllLocationsEndpoint() {
  var token = ppToken_();
  Logger.log('🧪 PROBE — /Locations list-endpoint shape');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  var paths = [
    '/Locations',
    '/Locations?active=true',
    '/Locations?active=false',
    '/Locations?top=5',
    '/Locations?pageSize=5',
    '/Locations?$top=5',
    '/Locations?limit=5',
    '/Locations?modifiedSince=2026-05-01',
    '/Locations?addDateSince=2026-05-01',
    '/Locations?addedAfter=2026-01-01',
    '/Locations?startDate=2026-05-01&endDate=2026-05-25'
  ];

  paths.forEach(function(p) {
    var r = ppGet_(token, p);
    var label = p.length > 50 ? p.substring(0, 50) + '...' : p;
    if (r.code !== 200) {
      Logger.log('  ' + label + '  →  HTTP ' + r.code +
                 (r.text.length < 200 ? ' ' + r.text : ''));
      return;
    }
    try {
      var parsed = JSON.parse(r.text);
      if (Array.isArray(parsed)) {
        var sample = parsed[0];
        var keyCount = sample ? Object.keys(sample).length : 0;
        Logger.log('  ' + label + '  →  ARRAY (' + parsed.length + ' items, sample has ' + keyCount + ' fields)');
        if (parsed.length > 0 && parsed.length < 50) {
          // Small return — show a sample
          Logger.log('     Sample keys: ' + Object.keys(parsed[0]).slice(0, 10).join(', ') + '...');
        }
      } else if (parsed && typeof parsed === 'object') {
        Logger.log('  ' + label + '  →  OBJECT (' + Object.keys(parsed).length + ' fields)');
      }
    } catch (e) {
      Logger.log('  ' + label + '  →  200 non-JSON');
    }
    Utilities.sleep(300);
  });

  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('Goal: find a pattern that returns an ARRAY of locations.');
  Logger.log('If "/Locations" by itself works, we can paginate through every location.');
  Logger.log('If date filters work, we can pull recently-modified-or-cancelled locations.');
}

function probeLocationSetupsEndpoint() {
  var token = ppToken_();
  // Grab a known LocationID from cache-locations.json
  var locResp = UrlFetchApp.fetch(
    'https://catseye-internal.github.io/Production-Dashboard/cache-locations.json',
    { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } }
  );
  var locCache = JSON.parse(locResp.getContentText());
  var sampleLoc = (locCache.locations || []).filter(function(l) { return l.Active && l.LocationID; })[0];
  if (!sampleLoc) { Logger.log('No active location found'); return; }
  var lid = sampleLoc.LocationID;
  Logger.log('🧪 Probing setup-discovery patterns for LocationID=' + lid + ' (' + (sampleLoc.Company || sampleLoc.LastName) + ')');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  var paths = [
    '/Locations/' + lid + '/serviceSetups',
    '/Locations/' + lid + '/ServiceSetups',
    '/Locations/' + lid + '/setups',
    '/ServiceSetups?locationId=' + lid,
    '/ServiceSetups?locationID=' + lid,
    '/ServiceSetups?LocationID=' + lid
  ];

  paths.forEach(function(p) {
    var r = ppGet_(token, p);
    var label = p.length > 50 ? p.substring(0, 50) + '...' : p;
    if (r.code !== 200) {
      Logger.log('  ' + label + '  →  HTTP ' + r.code);
      return;
    }
    try {
      var parsed = JSON.parse(r.text);
      if (Array.isArray(parsed)) {
        Logger.log('  ' + label + '  →  ARRAY (' + parsed.length + ' setups)');
        if (parsed.length > 0) {
          Logger.log('     Sample keys: ' + Object.keys(parsed[0]).slice(0, 10).join(', ') + '...');
        }
      } else if (parsed && typeof parsed === 'object') {
        Logger.log('  ' + label + '  →  OBJECT (' + Object.keys(parsed).length + ' fields)');
      }
    } catch (e) {
      Logger.log('  ' + label + '  →  200 non-JSON');
    }
    Utilities.sleep(250);
  });

  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('Pick the pattern that returns an ARRAY of setups. Then build bootstrapAllSetups()');
  Logger.log('against that pattern.');
}

// ══════════════════════════════════════════════════════════════
// DIAGNOSTIC SUITE — investigate slim-record behavior
// Run from the Apps Script dropdown one at a time. All write to Logger.
// ══════════════════════════════════════════════════════════════

// TEST 1 — Does window size change field richness?
// Hypothesis: smaller windows may return full records, large windows truncate.
function test1_windowSize() {
  var token = ppToken_();
  var today = new Date();
  var ranges = [
    { name: '1d',  end: 1 },
    { name: '3d',  end: 3 },
    { name: '7d',  end: 7 },
    { name: '14d', end: 14 },
    { name: '31d', end: 31 },
    { name: '60d', end: 60 },
    { name: '90d', end: 90 }
  ];
  Logger.log('🧪 TEST 1 — Window size vs field richness');
  ranges.forEach(function(rg) {
    var s = new Date(today); s.setDate(s.getDate() - 1);
    var e = new Date(today); e.setDate(e.getDate() + rg.end);
    var path = '/ServiceOrders?orderType=ServiceOrder&startWorkDate=' + fmt_(s) + '&endWorkDate=' + fmt_(e);
    var r = ppGet_(token, path);
    if (r.code !== 200) {
      Logger.log('  ' + rg.name + ': HTTP ' + r.code);
      return;
    }
    var orders = JSON.parse(r.text);
    var sample = orders[0] || {};
    var keyCount = Object.keys(sample).length;
    var hasTech = sample.Tech1 !== undefined;
    var hasDesc = sample.Description !== undefined;
    var hasDur  = sample.Duration !== undefined;
    var hasLock = sample.Locked !== undefined;
    Logger.log('  ' + rg.name + ': ' + orders.length + ' records, ' + keyCount + ' fields | Tech1=' + hasTech + ' Description=' + hasDesc + ' Duration=' + hasDur + ' Locked=' + hasLock);
  });
}

// TEST 2 — Unfiltered /ServiceOrders (no params at all)
// This is what /PestPacDiscovery did — see if removing all filters changes the shape.
function test2_unfiltered() {
  var token = ppToken_();
  Logger.log('🧪 TEST 2 — Unfiltered /ServiceOrders');
  var r = ppGet_(token, '/ServiceOrders');
  Logger.log('  HTTP ' + r.code + ', body len: ' + r.text.length);
  if (r.code !== 200) { Logger.log('  Body: ' + r.text.substring(0, 400)); return; }
  var orders = JSON.parse(r.text);
  Logger.log('  Records: ' + orders.length);
  if (orders.length > 0) {
    var sample = orders[0];
    Logger.log('  Sample (first record):');
    Logger.log('    Keys (' + Object.keys(sample).length + '): ' + Object.keys(sample).sort().join(', '));
    Logger.log('    JSON: ' + JSON.stringify(sample).substring(0, 800));
  }
}

// TEST 3 — Direct /ServiceOrders/{id} lookup for a known OrderID
// Pulls a recent OrderID from the list endpoint, then fetches it by ID.
// Compares field counts side-by-side.
function test3_directIdLookup() {
  var token = ppToken_();
  Logger.log('🧪 TEST 3 — Direct /ServiceOrders/{id} lookup');
  var today = new Date();
  var s = new Date(today); s.setDate(s.getDate() - 1);
  var e = new Date(today); e.setDate(e.getDate() + 3);
  var listR = ppGet_(token, '/ServiceOrders?orderType=ServiceOrder&startWorkDate=' + fmt_(s) + '&endWorkDate=' + fmt_(e));
  if (listR.code !== 200) { Logger.log('  list HTTP ' + listR.code); return; }
  var orders = JSON.parse(listR.text);
  if (orders.length === 0) { Logger.log('  No orders in window'); return; }
  var slim = orders[0];
  var slimKeys = Object.keys(slim).sort();
  Logger.log('  SLIM (from list): ' + slimKeys.length + ' fields, OrderID=' + slim.OrderID);
  Logger.log('    Keys: ' + slimKeys.join(', '));
  Logger.log('    JSON: ' + JSON.stringify(slim));

  var idR = ppGet_(token, '/ServiceOrders/' + slim.OrderID);
  Logger.log('  /ServiceOrders/' + slim.OrderID + ' → HTTP ' + idR.code);
  if (idR.code !== 200) { Logger.log('  Body: ' + idR.text.substring(0, 400)); return; }
  var full = JSON.parse(idR.text);
  var fullKeys = Object.keys(full).sort();
  Logger.log('  FULL (from /id): ' + fullKeys.length + ' fields');
  Logger.log('    Keys: ' + fullKeys.join(', '));
  Logger.log('    JSON: ' + JSON.stringify(full).substring(0, 1500));

  // Diff: what does /id give us that list doesn't?
  var extras = fullKeys.filter(function(k) { return slimKeys.indexOf(k) === -1; });
  Logger.log('  EXTRAS only in /id: ' + extras.join(', '));
}

// TEST 4 — Try $expand / Accept-header variations
// PestPac may support deep-fetch via header or query param.
function test4_expandVariations() {
  var token = ppToken_();
  Logger.log('🧪 TEST 4 — Header / query-param variations');
  var today = new Date();
  var s = new Date(today); s.setDate(s.getDate() - 1);
  var e = new Date(today); e.setDate(e.getDate() + 3);
  var qs = 'orderType=ServiceOrder&startWorkDate=' + fmt_(s) + '&endWorkDate=' + fmt_(e);
  var variations = [
    { name: 'baseline',           path: '/ServiceOrders?' + qs,                       headers: null },
    { name: '$expand=*',          path: '/ServiceOrders?' + qs + '&$expand=*',        headers: null },
    { name: '$select=*',          path: '/ServiceOrders?' + qs + '&$select=*',        headers: null },
    { name: 'expand=all',         path: '/ServiceOrders?' + qs + '&expand=all',       headers: null },
    { name: 'detail=full',        path: '/ServiceOrders?' + qs + '&detail=full',      headers: null },
    { name: 'view=full',          path: '/ServiceOrders?' + qs + '&view=full',        headers: null },
    { name: 'Accept full',        path: '/ServiceOrders?' + qs,                       headers: { 'Accept': 'application/vnd.workwave.full+json' } },
    { name: 'Accept v2',          path: '/ServiceOrders?' + qs,                       headers: { 'Accept': 'application/vnd.workwave.v2+json' } },
    { name: 'Prefer return=rep',  path: '/ServiceOrders?' + qs,                       headers: { 'Prefer': 'return=representation' } }
  ];
  variations.forEach(function(v) {
    var resp;
    try {
      var opts = {
        method: 'get',
        headers: Object.assign({
          'Authorization': 'Bearer ' + token,
          'apikey': PP_API_KEY,
          'tenant-id': PP_TENANT_ID
        }, v.headers || {}),
        muteHttpExceptions: true
      };
      resp = UrlFetchApp.fetch(PP_API_BASE + v.path, opts);
      var code = resp.getResponseCode();
      var text = resp.getContentText();
      if (code !== 200) { Logger.log('  ' + v.name + ': HTTP ' + code); return; }
      var orders = JSON.parse(text);
      var keys = orders[0] ? Object.keys(orders[0]).length : 0;
      var hasTech = orders[0] && orders[0].Tech1 !== undefined;
      Logger.log('  ' + v.name + ': ' + orders.length + ' rec, ' + keys + ' fields, Tech1=' + hasTech);
    } catch (e) {
      Logger.log('  ' + v.name + ': error ' + e.message);
    }
  });
}

// TEST 5 — Alternative endpoints that may carry richer data
// /Locations/{id}/serviceHistory, /Routes, /ServiceSetups, etc.
function test5_alternativeEndpoints() {
  var token = ppToken_();
  Logger.log('🧪 TEST 5 — Alternative endpoints');
  var endpoints = [
    '/ServiceOrders/queue',
    '/ServiceOrders/upcoming',
    '/ServiceOrders/scheduled',
    '/ServiceSetups',
    '/Routes',
    '/Schedule',
    '/Appointments',
    '/Visits'
  ];
  endpoints.forEach(function(ep) {
    var r = ppGet_(token, ep);
    if (r.code === 200) {
      try {
        var data = JSON.parse(r.text);
        var len = Array.isArray(data) ? data.length : (data && typeof data === 'object' ? Object.keys(data).length : 0);
        var sample = Array.isArray(data) ? data[0] : data;
        var keys = sample ? Object.keys(sample).length : 0;
        Logger.log('  ' + ep + ': HTTP 200, len=' + len + ', sample-fields=' + keys);
      } catch (e) { Logger.log('  ' + ep + ': HTTP 200, non-JSON'); }
    } else {
      Logger.log('  ' + ep + ': HTTP ' + r.code);
    }
  });
}

// TEST 6 — Replicate the original discovery query that returned 45-field records
// PestPacDiscovery.gs ran 2026-05-20 and identified 4 OrderTypes — implying it saw
// the OrderType field on responses. Reproduce its exact call shape.
function test6_replicateDiscovery() {
  var token = ppToken_();
  Logger.log('🧪 TEST 6 — Replicate discovery query patterns');
  // Likely call patterns the discovery used:
  var paths = [
    '/ServiceOrders?pageSize=1',
    '/ServiceOrders?limit=1',
    '/ServiceOrders?top=1',
    '/ServiceOrders?$top=1',
    '/ServiceOrders?startWorkDate=2026-01-01&endWorkDate=2026-12-31',
    '/ServiceOrders?orderType=ServiceOrder',
    '/ServiceOrders?orderType=ServiceOrder&pageSize=5'
  ];
  paths.forEach(function(p) {
    var r = ppGet_(token, p);
    if (r.code !== 200) { Logger.log('  ' + p + ': HTTP ' + r.code); return; }
    var data = JSON.parse(r.text);
    var sample = Array.isArray(data) ? data[0] : data;
    var keys = sample ? Object.keys(sample).length : 0;
    var hasTech = sample && sample.Tech1 !== undefined;
    Logger.log('  ' + p + ': ' + (Array.isArray(data) ? data.length : '?') + ' rec, ' + keys + ' fields, Tech1=' + hasTech);
  });
}

// TEST 7 — Full record dump for a known order
// Hard-coded OrderID variant — try a few different IDs across the window
// to see if specific orders carry full data while others don't.
function test7_idVariation() {
  var token = ppToken_();
  Logger.log('🧪 TEST 7 — Field count variance by OrderID');
  var today = new Date();
  var s = new Date(today); s.setDate(s.getDate() - 1);
  var e = new Date(today); e.setDate(e.getDate() + 14);
  var listR = ppGet_(token, '/ServiceOrders?orderType=ServiceOrder&startWorkDate=' + fmt_(s) + '&endWorkDate=' + fmt_(e));
  if (listR.code !== 200) return;
  var orders = JSON.parse(listR.text);
  Logger.log('  Sampling ' + Math.min(10, orders.length) + ' of ' + orders.length + ' orders');
  for (var i = 0; i < Math.min(10, orders.length); i++) {
    var oid = orders[i].OrderID;
    var detail = ppGet_(token, '/ServiceOrders/' + oid);
    if (detail.code !== 200) { Logger.log('  #' + oid + ': HTTP ' + detail.code); continue; }
    var d = JSON.parse(detail.text);
    var keys = Object.keys(d);
    Logger.log('  #' + oid + ': ' + keys.length + ' fields, Tech1=' + (d.Tech1 || 'null') + ', Desc=' + (d.Description ? d.Description.substring(0, 30) : 'null'));
    Utilities.sleep(200);
  }
}

// TEST 8 — Run all tests in sequence (use sparingly — heavy API load)
function testAllDiagnostics() {
  Logger.log('═══════════════════════════════════════════════');
  Logger.log('🧪 RUNNING FULL DIAGNOSTIC SUITE');
  Logger.log('═══════════════════════════════════════════════');
  test1_windowSize();
  Logger.log('');
  test2_unfiltered();
  Logger.log('');
  test3_directIdLookup();
  Logger.log('');
  test4_expandVariations();
  Logger.log('');
  test5_alternativeEndpoints();
  Logger.log('');
  test6_replicateDiscovery();
  Logger.log('');
  test7_idVariation();
  Logger.log('═══════════════════════════════════════════════');
  Logger.log('🧪 DIAGNOSTIC SUITE COMPLETE');
  Logger.log('═══════════════════════════════════════════════');
}

// ──────────────────────────────────────────────────────────────
// Git Data API push (blob → tree → commit → ref)
// Re-used for both cache.json and cache-raw.json
// ──────────────────────────────────────────────────────────────
function pushToGitHub_(jsonStr, filePath, commitMsg) {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) { Logger.log('  ⚠️ GITHUB_TOKEN not set'); return false; }
  var apiBase = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO;
  var headers = { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json' };

  try {
    var blob = UrlFetchApp.fetch(apiBase + '/git/blobs', {
      method: 'post', headers: headers, contentType: 'application/json',
      payload: JSON.stringify({ content: Utilities.base64Encode(jsonStr, Utilities.Charset.UTF_8), encoding: 'base64' }),
      muteHttpExceptions: true
    });
    if (blob.getResponseCode() !== 201) { Logger.log('  blob: ' + blob.getContentText().substring(0, 200)); return false; }
    var blobSha = JSON.parse(blob.getContentText()).sha;

    var ref = UrlFetchApp.fetch(apiBase + '/git/ref/heads/' + GH_BRANCH, { headers: headers, muteHttpExceptions: true });
    var refSha = JSON.parse(ref.getContentText()).object.sha;
    var commit = UrlFetchApp.fetch(apiBase + '/git/commits/' + refSha, { headers: headers, muteHttpExceptions: true });
    var treeSha = JSON.parse(commit.getContentText()).tree.sha;

    var newTree = UrlFetchApp.fetch(apiBase + '/git/trees', {
      method: 'post', headers: headers, contentType: 'application/json',
      payload: JSON.stringify({ base_tree: treeSha, tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blobSha }] }),
      muteHttpExceptions: true
    });
    var newTreeSha = JSON.parse(newTree.getContentText()).sha;

    var newCommit = UrlFetchApp.fetch(apiBase + '/git/commits', {
      method: 'post', headers: headers, contentType: 'application/json',
      payload: JSON.stringify({ message: commitMsg, tree: newTreeSha, parents: [refSha] }),
      muteHttpExceptions: true
    });
    var newCommitSha = JSON.parse(newCommit.getContentText()).sha;

    var upd = UrlFetchApp.fetch(apiBase + '/git/refs/heads/' + GH_BRANCH, {
      method: 'patch', headers: headers, contentType: 'application/json',
      payload: JSON.stringify({ sha: newCommitSha }),
      muteHttpExceptions: true
    });
    if (upd.getResponseCode() === 200) {
      Logger.log('  ✅ ' + filePath + ' → commit ' + newCommitSha.substring(0, 7));
      return true;
    }
    Logger.log('  ref update ' + filePath + ' HTTP ' + upd.getResponseCode());
    return false;
  } catch (err) {
    Logger.log('  GitHub error: ' + err.message);
    return false;
  }
}
