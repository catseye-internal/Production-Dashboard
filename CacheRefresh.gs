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
const GH_PATH_EMPLOYEES = 'cache-employees.json';
const GH_PATH_TIMEBLOCKS = 'cache-timeblocks.json';

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

// Curated Employee whitelist for /lookups/employees.
// Confirmed shape 2026-05-21 via first refresh run: PestPac uses `Username`
// (e.g., "ADMN", "GRA", "BAG2") as the 3-letter join key that matches
// ServiceOrders.Tech1, ServiceOrders.Tech2, and Invoice.Tech values.
const CURATED_FIELDS_EMPLOYEE = [
  // Identity / join keys
  'Username', 'EmployeeID', 'UserID', 'TechID', 'EmployeeNumber',
  // Name fields
  'FirstName', 'MiddleName', 'LastName',
  // Status / lifecycle
  'Active', 'IsUser', 'IsTech', 'HireDate', 'TerminationDate',
  // Context
  'DefaultBranch', 'JobTitle',
  // Contact (kept compact for size)
  'Email', 'Mobile', 'Phone'
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

    // ── MERGE recent SOs from prior cache (Joe directive 2026-05-27) ──
    // PestPac removes an SO from /ServiceOrders the moment a tech submits the
    // job (Posted=true) — even though the invoice hasn't been generated yet.
    // That leaves the record in a limbo state: not in cache.json, not in
    // cache-invoices.json. The dashboard's Yesterday card (and any other
    // recent-WorkDate view) bleeds out as more techs close out yesterday's
    // work. Fix: read the prior cache, KEEP any SO from the last 2 days
    // that's missing from the new response. They age out automatically
    // (anything older drops on next refresh).
    try {
      var priorResp = UrlFetchApp.fetch(
        'https://catseye-internal.github.io/Production-Dashboard/cache.json?v=' + Date.now(),
        { muteHttpExceptions: true }
      );
      if (priorResp.getResponseCode() === 200) {
        var priorCache = JSON.parse(priorResp.getContentText());
        var priorOrders = priorCache.orders || [];
        var newOrderIds = {};
        curatedOrders.forEach(function(o) {
          if (o.OrderID != null) newOrderIds[String(o.OrderID)] = true;
        });
        var keepCutoff = new Date(now);
        keepCutoff.setDate(keepCutoff.getDate() - 2);
        keepCutoff.setHours(0, 0, 0, 0);
        var retained = 0, retainedValue = 0;
        priorOrders.forEach(function(o) {
          if (o.OrderID == null) return;
          if (newOrderIds[String(o.OrderID)]) return; // already in new response
          var wd = String(o.WorkDate || '').substring(0, 10);
          if (!wd) return;
          var wdDate = new Date(wd);
          if (isNaN(wdDate.getTime())) return;
          if (wdDate < keepCutoff) return; // too old — let it drop
          // Retain — this SO dropped from /ServiceOrders but its WorkDate is
          // recent. Likely Posted=true awaiting invoice generation.
          curatedOrders.push(o);
          retained++;
          retainedValue += Number(o.SubTotal) || 0;
        });
        Logger.log('  Merge: retained ' + retained + ' recent SOs from prior cache ($' + Math.round(retainedValue).toLocaleString() + ')');
      }
    } catch (mergeErr) {
      Logger.log('  ⚠️ Merge skipped (prior cache read failed): ' + mergeErr.message);
    }

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
// One-time bulk backfill: fetch every Location referenced by an MTD invoice
// that isn't already in cache-locations.json. Uses /Locations/code/{code}
// because invoices carry LocationCode but not LocationID.
//
// USE WHEN: the Tech view's MTD Drive Dist column shows "—" for many techs
// because their service stops haven't been picked up by the regular
// 7-day-window refreshLocationsCache yet.
// ──────────────────────────────────────────────────────────────
function backfillLocationsForMtdInvoices() {
  var t0 = new Date();
  Logger.log('🩹 MTD location backfill — ' + t0.toISOString());
  try {
    var token = ppToken_();

    // Existing locations cache
    var existing = readLocationsCache_();
    var existingMap = {};
    var existingByCode = {};
    (existing.locations || []).forEach(function(l) {
      if (l.LocationID != null) existingMap[String(l.LocationID)] = l;
      if (l.LocationCode != null) existingByCode[String(l.LocationCode)] = l;
    });
    Logger.log('  Existing cache: ' + Object.keys(existingMap).length + ' locations');

    // Read live invoice cache from GitHub Pages
    var invResp = UrlFetchApp.fetch(
      'https://catseye-internal.github.io/Production-Dashboard/cache-invoices.json',
      { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } }
    );
    if (invResp.getResponseCode() !== 200) {
      throw new Error('cache-invoices.json fetch HTTP ' + invResp.getResponseCode());
    }
    var invData = JSON.parse(invResp.getContentText());

    // MTD range — 1st of current month through yesterday (matches dashboard)
    var now = new Date();
    var som = new Date(now.getFullYear(), now.getMonth(), 1);
    var yest = new Date(now); yest.setDate(yest.getDate() - 1); yest.setHours(0, 0, 0, 0);
    var somStr = fmt_(som);
    var yestStr = fmt_(yest);

    // Unique LocationCodes referenced by MTD non-ES invoices, not already in cache
    var needed = {};
    var mtdInvoiceCount = 0;
    (invData.invoices || []).forEach(function(inv) {
      if ((inv.InvoiceType || '') === 'ES') return;
      var date = String(inv.InvoiceDate || '').substring(0, 10);
      if (date < somStr || date > yestStr) return;
      mtdInvoiceCount++;
      var code = inv.LocationCode;
      if (code != null && !existingByCode[String(code)]) {
        needed[String(code)] = true;
      }
    });
    var codes = Object.keys(needed);
    Logger.log('  MTD invoices scanned: ' + mtdInvoiceCount);
    Logger.log('  Missing LocationCodes to fetch: ' + codes.length);
    if (codes.length === 0) {
      Logger.log('✅ All MTD invoice locations already in cache');
      return;
    }

    // Parallel fetch /Locations/code/{code} in batches of 30
    var BATCH = 30;
    var headers = {
      'Authorization': 'Bearer ' + token,
      'apikey': PP_API_KEY,
      'tenant-id': PP_TENANT_ID
    };
    var fetched = 0, failed = 0;
    for (var i = 0; i < codes.length; i += BATCH) {
      var slice = codes.slice(i, i + BATCH);
      var requests = slice.map(function(code) {
        return {
          url: PP_API_BASE + '/Locations/code/' + encodeURIComponent(code),
          method: 'get',
          headers: headers,
          muteHttpExceptions: true
        };
      });
      try {
        var responses = UrlFetchApp.fetchAll(requests);
        for (var k = 0; k < responses.length; k++) {
          if (responses[k].getResponseCode() !== 200) { failed++; continue; }
          try {
            var loc = JSON.parse(responses[k].getContentText());
            var curated = curate_(loc, CURATED_FIELDS_LOCATION);
            if (curated.LocationID != null) {
              existingMap[String(curated.LocationID)] = curated;
              fetched++;
            }
          } catch (e) { failed++; }
        }
      } catch (e) {
        Logger.log('    Batch ' + i + ' failed: ' + e.message);
        failed += slice.length;
      }
      if (i + BATCH < codes.length) Utilities.sleep(200);
    }
    Logger.log('  Fetched ' + fetched + ' new locations (' + failed + ' failed)');

    // Write merged cache
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
    var ok = pushToGitHub_(jsonStr, GH_PATH_LOCATIONS, 'MTD location backfill ' + new Date().toISOString());
    var elapsed = ((new Date() - t0) / 1000).toFixed(1);
    Logger.log('✅ Backfill complete in ' + elapsed + 's | push: ' + (ok ? 'OK' : 'FAIL'));
  } catch (err) {
    Logger.log('❌ Backfill error: ' + err.message + '\n' + err.stack);
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

    // ─── Safety guard (added 2026-05-26 after the 03:44 ET data-loss event) ───
    // Refuse to write a dramatically smaller file than what was on disk. This
    // catches edge cases where readSetupsCache_ would have returned a partial
    // result (network blip, GitHub Pages 5xx, etc.) and we'd otherwise destroy
    // the bootstrap-built historical setups. Threshold: if existing > 5K and
    // new < 50% of existing, abort. Use rebuildSetupsCache() for intentional
    // full rebuilds — that path sets forceFull=true and bypasses this guard.
    var existingCount = (existing.setups || []).length;
    var newCount = allSetups.length;
    if (!forceFull && existingCount > 5000 && newCount < existingCount * 0.5) {
      Logger.log('🛑 SAFETY ABORT: would shrink cache-setups.json from ' +
                 existingCount.toLocaleString() + ' to ' + newCount.toLocaleString() +
                 ' records (' + Math.round(newCount * 100 / existingCount) + '%). ' +
                 'Likely cause: readSetupsCache_ returned a partial result or this trigger fired during a Pages rebuild. ' +
                 'NOT writing. To force-rebuild intentionally, run rebuildSetupsCache() instead.');
      return;
    }

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

// ──────────────────────────────────────────────────────────────────────────
// refreshRecentCancellations — safety-net backfill for the Cancels view.
//
// PROBLEM: Cancellations are SUPPOSED to update in real-time via the Service
// Setup webhooks (see InvoiceWebhookHandler.gs). But webhook delivery isn't
// guaranteed — PestPac may drop events, Apps Script concurrency limits can
// reject, or PestPac API quota exhaustion can cause webhook handlers to
// silently fail to fetch detail. The Cancels dashboard view would then
// undercount.
//
// SOLUTION: Daily backfill. Re-fetch every setup with CancelDate in the last
// 14 days and upsert. Catches any webhook misses with a small recurring cost.
//
// QUOTA COST: Typical pest control business cancels ~50-300 setups per
// rolling 14-day window. That's ≤300 API calls per nightly run — well under
// 1% of the PestPac tenant daily quota. Far cheaper than re-running the
// bootstrap.
//
// SCHEDULE: Joe to add a daily time-based trigger pointed at this function,
// firing at 4:00 AM Pacific (7:00 AM ET) so it runs AFTER quota reset
// (midnight Pacific) and BEFORE the workday's normal traffic ramps up.
//
// Joe directive 2026-05-26.
// ──────────────────────────────────────────────────────────────────────────
function refreshRecentCancellations() {
  var t0 = new Date();
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🔁 Recent cancellations backfill — ' + t0.toISOString());
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  var LOOKBACK_DAYS = 14;  // Re-check setups cancelled in the last N days

  try {
    var token = ppToken_();

    // 1. Load current cache
    Logger.log('1. Loading cache-setups.json...');
    var existing = readSetupsCache_();
    var setups = existing.setups || [];
    Logger.log('   ' + setups.length.toLocaleString() + ' total setups in cache');

    // 2. Find setups with CancelDate in the lookback window
    var cutoff = new Date(t0.getTime() - LOOKBACK_DAYS * 86400000);
    var recentCancelIds = [];
    setups.forEach(function(s) {
      if (!s.CancelDate || !s.SetupID) return;
      var cd = new Date(String(s.CancelDate).split('.')[0]);
      if (!isNaN(cd.getTime()) && cd >= cutoff) {
        recentCancelIds.push(String(s.SetupID));
      }
    });
    Logger.log('2. Found ' + recentCancelIds.length.toLocaleString() +
               ' setups cancelled in the last ' + LOOKBACK_DAYS + ' days');

    if (recentCancelIds.length === 0) {
      Logger.log('✅ Nothing to backfill — no recent cancellations in cache.');
      Logger.log('   (This could mean webhooks are working perfectly, OR that');
      Logger.log('    cache has no recent cancels at all. Investigate if suspicious.)');
      return;
    }

    // 3. Re-fetch each via /ServiceSetups/{id}
    Logger.log('3. Re-fetching ' + recentCancelIds.length + ' setups to verify cache is current...');
    var refreshed = fetchSetups_(token, recentCancelIds);
    Logger.log('   ' + refreshed.length + ' successfully fetched (' +
               (recentCancelIds.length - refreshed.length) + ' failures)');

    if (refreshed.length === 0) {
      Logger.log('❌ All fetches failed — likely PestPac quota or auth issue. Aborting.');
      return;
    }

    // 4. Upsert into cache (overwrite by SetupID)
    var existingMap = {};
    setups.forEach(function(s) {
      if (s.SetupID != null) existingMap[String(s.SetupID)] = s;
    });

    var changed = 0;
    var newCancels = 0;  // setups where CancelDate flipped from null to populated
    refreshed.forEach(function(s) {
      if (s.SetupID == null) return;
      var key = String(s.SetupID);
      var prior = existingMap[key];
      // Detect any change worth logging — CancelDate flip is the big one
      if (!prior) {
        newCancels++;
      } else if (!prior.CancelDate && s.CancelDate) {
        newCancels++;
      } else if (prior.CancelReason !== s.CancelReason || prior.CancelDate !== s.CancelDate) {
        changed++;
      }
      existingMap[key] = s;
    });

    Logger.log('   Updated: ' + changed + ' · NEW cancellations caught: ' + newCancels);

    // 5. Write back if anything changed
    if (changed === 0 && newCancels === 0) {
      Logger.log('✅ Cache already current. No write needed.');
      Logger.log('   Total elapsed: ' + ((new Date() - t0) / 1000).toFixed(1) + 's');
      return;
    }

    // Build final array sorted by SetupID (same shape as other writers)
    var allSetups = [];
    Object.keys(existingMap).forEach(function(k) { allSetups.push(existingMap[k]); });
    allSetups.sort(function(a, b) { return Number(a.SetupID) - Number(b.SetupID); });

    // Safety guard: shouldn't shrink the cache
    if (allSetups.length < setups.length * 0.95) {
      Logger.log('🛑 SAFETY ABORT: cache would shrink from ' + setups.length +
                 ' to ' + allSetups.length + '. Not writing.');
      return;
    }

    var cache = {
      updated: new Date().toISOString(),
      recordCount: allSetups.length,
      setups: allSetups
    };
    var jsonStr = JSON.stringify(cache);
    Logger.log('4. Writing cache-setups.json: ' + Math.round(jsonStr.length / 1024) +
               ' KB, ' + allSetups.length.toLocaleString() + ' records');
    var ok = pushToGitHub_(jsonStr, GH_PATH_SETUPS,
                           'Recent cancellations backfill ' + new Date().toISOString());

    var elapsed = ((new Date() - t0) / 1000).toFixed(1);
    Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    Logger.log('✅ Backfill complete in ' + elapsed + 's | push: ' + (ok ? 'OK' : 'FAIL'));
    Logger.log('   Setups re-fetched: ' + refreshed.length);
    Logger.log('   New cancels caught by backfill: ' + newCancels +
               ' (these would have been MISSED by webhooks)');
    Logger.log('   Other updates: ' + changed);
  } catch (err) {
    Logger.log('❌ Backfill error: ' + err.message + '\n' + err.stack);
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

// ──────────────────────────────────────────────────────────────
// SEQUENTIAL INVOICENUMBER BACKFILL (Joe directive 2026-05-26)
// Walks forward from cache's highest InvoiceNumber, fetching each next number
// via /Invoices?invoiceNumber=N. Stops after CONSECUTIVE_MISSES consecutive
// 404s (assumes we've passed the latest issued invoice). Use when webhook
// delivery has lapsed and ServiceOrders-based backfill can't help because
// completed invoices have already left /ServiceOrders.
//
// Optional `startFrom` overrides the cache's max InvoiceNumber + 1 — useful
// if you know the gap-start more precisely.
// ──────────────────────────────────────────────────────────────
function backfillInvoicesByNumber(startFrom) {
  var t0 = new Date();
  Logger.log('🩹 Sequential InvoiceNumber backfill — ' + t0.toISOString());
  try {
    var cache = readInvoicesCacheDirect_();
    var existing = (cache.invoices || []).reduce(function(acc, inv) {
      var n = Number(inv.InvoiceNumber);
      if (n && n > acc) acc = n;
      return acc;
    }, 0);
    var nextNum = Number(startFrom) || (existing + 1);
    Logger.log('  Cache max InvoiceNumber: ' + existing + ' · starting from ' + nextNum);

    var token = ppToken_();
    var headers = {
      'Authorization': 'Bearer ' + token,
      'apikey': PP_API_KEY,
      'tenant-id': PP_TENANT_ID
    };
    var BATCH = 30;
    var CONSECUTIVE_MISSES_TO_STOP = 25;  // tolerate gaps from voided/skipped numbers
    var SAFETY_CAP = 5000;                // never walk more than this many numbers
    var fetched = [];
    var statsByCode = {};
    var consecutiveMisses = 0;
    var samples = { ok: [], notFound: [], error: [] };

    var num = nextNum;
    var walked = 0;
    while (walked < SAFETY_CAP) {
      var batchNums = [];
      for (var b = 0; b < BATCH && walked + b < SAFETY_CAP; b++) {
        batchNums.push(num + b);
      }
      var requests = batchNums.map(function(n) {
        return {
          url: PP_API_BASE + '/Invoices?invoiceNumber=' + n,
          method: 'get',
          headers: headers,
          muteHttpExceptions: true
        };
      });
      var responses;
      try { responses = UrlFetchApp.fetchAll(requests); }
      catch (e) { Logger.log('    batch starting ' + num + ' failed: ' + e.message); break; }

      var batchHits = 0;
      for (var k = 0; k < responses.length; k++) {
        var resp = responses[k];
        var code = resp.getResponseCode();
        var body = resp.getContentText() || '';
        var thisNum = batchNums[k];
        statsByCode[code] = (statsByCode[code] || 0) + 1;
        if (code !== 200) {
          consecutiveMisses++;
          if (samples.notFound.length < 3) samples.notFound.push({ num: thisNum, code: code });
          continue;
        }
        var inv = null;
        try {
          var parsed = JSON.parse(body);
          if (Array.isArray(parsed)) {
            if (parsed.length > 0 && parsed[0] && parsed[0].InvoiceNumber) inv = parsed[0];
          } else if (parsed && parsed.InvoiceNumber) {
            inv = parsed;
          }
        } catch (e) {
          if (samples.error.length < 3) samples.error.push({ num: thisNum, code: code, body: body.substring(0, 150) });
        }
        if (inv) {
          fetched.push(inv);
          consecutiveMisses = 0;
          batchHits++;
          if (samples.ok.length < 2) samples.ok.push({ num: thisNum, total: inv.Total, date: inv.InvoiceDate });
        } else {
          consecutiveMisses++;
          if (samples.notFound.length < 3) samples.notFound.push({ num: thisNum, code: code });
        }
      }
      num += batchNums.length;
      walked += batchNums.length;
      Logger.log('    Walked through ' + (num - 1) + ' — batch hits: ' + batchHits + ' · consecutive misses: ' + consecutiveMisses + ' · running total fetched: ' + fetched.length);
      if (consecutiveMisses >= CONSECUTIVE_MISSES_TO_STOP) {
        Logger.log('  Stop signal: ' + CONSECUTIVE_MISSES_TO_STOP + ' consecutive misses (latest invoice probably reached)');
        break;
      }
      Utilities.sleep(200);
    }

    Logger.log('  HTTP status breakdown: ' + JSON.stringify(statsByCode));
    if (samples.ok.length)       Logger.log('  Sample SUCCESS: ' + JSON.stringify(samples.ok));
    if (samples.notFound.length) Logger.log('  Sample NOT-FOUND: ' + JSON.stringify(samples.notFound));
    if (samples.error.length)    Logger.log('  Sample ERRORS: ' + JSON.stringify(samples.error));
    Logger.log('  Fetched ' + fetched.length + ' new invoice records');

    if (fetched.length === 0) {
      Logger.log('✅ Nothing new to backfill — cache is current');
      return;
    }

    // Merge — same shape as webhook-delivered records
    var curated = fetched.map(curateInvoiceForBackfill_);
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
    var merged = Object.keys(byKey).map(function(k) { return byKey[k]; });
    cache.invoices = merged;
    cache.updated = new Date().toISOString();
    cache.recordCount = merged.length;
    cache.lastBackfill = new Date().toISOString();
    var jsonStr = JSON.stringify(cache);
    Logger.log('  Writing cache-invoices.json: ' + Math.round(jsonStr.length / 1024) + ' KB | added ' + added + ', updated ' + updated);

    var ok = pushToGitHub_(jsonStr, GH_PATH_INVOICES_FOR_BACKFILL, 'Sequential InvoiceNumber backfill ' + new Date().toISOString());
    var elapsed = ((new Date() - t0) / 1000).toFixed(1);
    Logger.log('✅ Backfill complete in ' + elapsed + 's | push: ' + (ok ? 'OK' : 'FAIL'));
  } catch (err) {
    Logger.log('❌ Backfill error: ' + err.message + '\n' + err.stack);
  }
}

// ──────────────────────────────────────────────────────────────
// LIST-DRIVEN BACKFILL (Joe directive 2026-05-26)
// Takes an explicit list of InvoiceNumbers (string or numeric, "A"-prefixed
// allowed for CB/PR types), fetches each via /Invoices?invoiceNumber=X,
// curates, and merges into cache-invoices.json in one commit.
//
// Use when:
//   - InvoiceNumbers aren't sequential (PestPac issues in sparse blocks) so
//     a forward-walk by number can't find them
//   - You have a definitive list (e.g. from a PestPac PDF or Report Writer
//     export) of what needs to be in the cache
//
// Usage example:
//   backfillInvoicesByList_(['1340478','A1340024','1340524', ...])
//
// To run from the function dropdown, define a small wrapper:
//   function backfillTodaysInvoices_() {
//     return backfillInvoicesByList_(['1241396','1316461', ...]);
//   }
// ──────────────────────────────────────────────────────────────
function backfillInvoicesByList_(invoiceNumbers) {
  var t0 = new Date();
  Logger.log('🩹 List-driven invoice backfill — ' + (invoiceNumbers || []).length + ' invoice numbers');
  if (!invoiceNumbers || !invoiceNumbers.length) {
    Logger.log('  ⚠️ Empty list — nothing to do');
    return;
  }
  try {
    var token = ppToken_();
    var headers = {
      'Authorization': 'Bearer ' + token,
      'apikey': PP_API_KEY,
      'tenant-id': PP_TENANT_ID
    };
    var BATCH = 30;
    var fetched = [];
    var statsByCode = {};
    var samples = { ok: [], notFound: [], error: [] };

    for (var i = 0; i < invoiceNumbers.length; i += BATCH) {
      var slice = invoiceNumbers.slice(i, i + BATCH);
      var requests = slice.map(function(n) {
        return {
          url: PP_API_BASE + '/Invoices?invoiceNumber=' + encodeURIComponent(n),
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
        var thisNum = slice[k];
        statsByCode[code] = (statsByCode[code] || 0) + 1;
        if (code !== 200) {
          if (samples.notFound.length < 5) samples.notFound.push({ num: thisNum, code: code, body: body.substring(0, 120) });
          continue;
        }
        var inv = null;
        try {
          var parsed = JSON.parse(body);
          if (Array.isArray(parsed)) {
            if (parsed.length > 0 && parsed[0] && parsed[0].InvoiceNumber) inv = parsed[0];
          } else if (parsed && parsed.InvoiceNumber) {
            inv = parsed;
          }
        } catch (e) {
          if (samples.error.length < 3) samples.error.push({ num: thisNum, code: code, body: 'PARSE ERR: ' + body.substring(0, 120) });
        }
        if (inv) {
          fetched.push(inv);
          if (samples.ok.length < 3) samples.ok.push({ num: thisNum, total: inv.Total, date: inv.InvoiceDate, type: inv.InvoiceType });
        } else {
          if (samples.notFound.length < 5) samples.notFound.push({ num: thisNum, code: code, body: body.substring(0, 120) });
        }
      }
      if (i + BATCH < invoiceNumbers.length) Utilities.sleep(200);
    }

    Logger.log('  HTTP status breakdown: ' + JSON.stringify(statsByCode));
    if (samples.ok.length)       Logger.log('  Sample SUCCESS: ' + JSON.stringify(samples.ok));
    if (samples.notFound.length) Logger.log('  Sample NOT-FOUND: ' + JSON.stringify(samples.notFound));
    if (samples.error.length)    Logger.log('  Sample ERRORS: ' + JSON.stringify(samples.error));
    Logger.log('  Fetched ' + fetched.length + ' / ' + invoiceNumbers.length + ' invoices');

    if (fetched.length === 0) {
      Logger.log('  ❌ Nothing fetched — cache NOT updated');
      return;
    }

    // Merge into cache
    var cache = readInvoicesCacheDirect_();
    var curated = fetched.map(curateInvoiceForBackfill_);
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
    var merged = Object.keys(byKey).map(function(k) { return byKey[k]; });
    cache.invoices = merged;
    cache.updated = new Date().toISOString();
    cache.recordCount = merged.length;
    cache.lastBackfill = new Date().toISOString();
    var jsonStr = JSON.stringify(cache);
    Logger.log('  Writing cache-invoices.json: ' + Math.round(jsonStr.length / 1024) + ' KB | added ' + added + ', updated ' + updated);

    var ok = pushToGitHub_(jsonStr, GH_PATH_INVOICES_FOR_BACKFILL, 'List-driven invoice backfill (' + fetched.length + ' invoices) ' + new Date().toISOString());
    var elapsed = ((new Date() - t0) / 1000).toFixed(1);
    Logger.log('✅ Backfill complete in ' + elapsed + 's | push: ' + (ok ? 'OK' : 'FAIL'));
  } catch (err) {
    Logger.log('❌ Backfill error: ' + err.message + '\n' + err.stack);
  }
}

// Wrapper for today's 45 invoices from the 05/26/26 PestPac PDF.
// Run from the function dropdown (no trailing underscore — Apps Script hides
// _-suffixed functions from the dropdown as a private convention).
// DIAGNOSTIC — what fields does /Invoices?invoiceNumber=X actually return?
// We need to find which field carries the IN/CM/CB/PR type code so the
// production-lens filter on the dashboard can include backfilled invoices.
// Joe 2026-05-26.
function probeInvoiceShape() {
  var token = ppToken_();
  // Sample one of each type from today's PDF
  var samples = [
    { num: '1333637', expectedType: 'IN', note: 'plain IN' },
    { num: '1340478', expectedType: 'CM', note: 'credit memo' },
    { num: 'A1340024', expectedType: 'CB', note: 'callback (A-prefix)' },
    { num: 'A1332478', expectedType: 'PR', note: 'production (A-prefix)' }
  ];
  samples.forEach(function(s) {
    Logger.log('━━━ ' + s.num + ' (expected ' + s.expectedType + ' · ' + s.note + ') ━━━');
    var r = ppGet_(token, '/Invoices?invoiceNumber=' + encodeURIComponent(s.num));
    if (r.code !== 200) {
      Logger.log('  HTTP ' + r.code + ' — ' + r.text.substring(0, 200));
      return;
    }
    var parsed = JSON.parse(r.text);
    var inv = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!inv) { Logger.log('  Empty body'); return; }
    Logger.log('  All ' + Object.keys(inv).length + ' keys: ' + Object.keys(inv).sort().join(', '));
    // Log all fields that could plausibly hold a type code
    ['InvoiceType','Type','InvoiceTypeCode','InvoiceTypeID','InvoiceTypeName',
     'OrderType','TransactionType','InvType','Code','Status'].forEach(function(f) {
      if (f in inv) Logger.log('  → ' + f + ': "' + inv[f] + '" (type: ' + typeof inv[f] + ')');
    });
    Logger.log('  InvoiceNumber: "' + inv.InvoiceNumber + '"');
    Logger.log('  Total: ' + inv.Total + '  SubTotal: ' + inv.SubTotal);
  });
  Logger.log('━━━ PROBE COMPLETE ━━━');
}

// PATCH function — sets InvoiceType to the correct IN/CM/CB/PR code on the
// 45 records we just backfilled. The /Invoices?invoiceNumber=X endpoint
// returns InvoiceType="Invoice" literal, which makes records invisible to
// the dashboard's PRODUCTION lens filter. Joe 2026-05-26.
function patchTodaysInvoiceTypes() {
  var t0 = new Date();
  var TYPES = {
    '1241396': 'IN','1316461': 'IN','1333637': 'IN','1333714': 'IN','1333871': 'IN',
    '1333887': 'IN','1333909': 'IN','1334218': 'IN','1334972': 'IN','1335399': 'IN',
    '1335789': 'IN','1337443': 'IN','1337455': 'IN','1338855': 'IN','1338883': 'IN',
    '1338964': 'IN','1339268': 'IN','1339520': 'IN','1340185': 'IN','1340439': 'IN',
    '1340478': 'CM','1340481': 'CM','1340488': 'CM','1340496': 'CM','1340500': 'CM',
    '1340510': 'CM','1340516': 'CM','1340524': 'CM',
    'A1316960': 'CB','A1340024': 'CB','A1340073': 'CB','A1340151': 'CB','A1340249': 'CB',
    'A1332478': 'PR','A1332974': 'PR','A1333105': 'PR','A1333157': 'PR','A1339345': 'PR',
    'A1339393': 'PR','A1339745': 'PR','A1339841': 'PR','A1340009': 'PR','A1340119': 'PR',
    'A1340209': 'PR','A1340403': 'PR'
  };
  Logger.log('🛠️ Patching InvoiceType on ' + Object.keys(TYPES).length + ' records');
  var cache = readInvoicesCacheDirect_();
  var invs = cache.invoices || [];
  var patched = 0;
  invs.forEach(function(inv) {
    var k = String(inv.InvoiceNumber || '');
    if (TYPES[k]) {
      var prev = inv.InvoiceType;
      inv.InvoiceType = TYPES[k];
      patched++;
      if (patched <= 3) Logger.log('  ' + k + ': "' + prev + '" → "' + TYPES[k] + '"');
    }
  });
  Logger.log('  Patched ' + patched + ' / ' + Object.keys(TYPES).length);
  if (patched === 0) { Logger.log('  Nothing to patch — run backfillTodaysInvoices first'); return; }
  cache.invoices = invs;
  cache.updated = new Date().toISOString();
  cache.lastTypePatch = new Date().toISOString();
  var ok = pushToGitHub_(
    JSON.stringify(cache),
    GH_PATH_INVOICES_FOR_BACKFILL,
    'Patch InvoiceType on ' + patched + ' backfilled records ' + new Date().toISOString()
  );
  Logger.log('✅ Done in ' + ((new Date() - t0)/1000).toFixed(1) + 's | push: ' + (ok ? 'OK' : 'FAIL'));
}

function backfillTodaysInvoices() {
  // Atomic: backfill + type-patch in one call. Safe to re-run.
  // The /Invoices?invoiceNumber=X endpoint returns InvoiceType="Invoice" literal
  // instead of the IN/CM/CB/PR code, so we explicitly override here. Joe 2026-05-26.
  backfillInvoicesByList_([
    '1241396','1316461','1333637','1333714','1333871','1333887','1333909',
    '1334218','1334972','1335399','1335789','1337443','1337455','1338855',
    '1338883','1338964','1339268','1339520','1340185','1340439',
    '1340478','1340481','1340488','1340496','1340500','1340510','1340516','1340524',
    'A1316960','A1340024','A1340073','A1340151','A1340249',
    'A1332478','A1332974','A1333105','A1333157','A1339345','A1339393',
    'A1339745','A1339841','A1340009','A1340119','A1340209','A1340403'
  ]);
  // Apply type map regardless of whether fetch succeeded
  patchTodaysInvoiceTypes();
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

// readSetupsCache_ — fetch cache-setups.json from GitHub Pages.
//
// HISTORY: This used to silently return `{ setups: [] }` on any non-200 or
// parse error. That caused a catastrophic data loss on 2026-05-26 03:44 ET:
// GitHub Pages briefly failed to serve the file (likely during a Pages
// rebuild after the 34MB bootstrap push), this function returned empty, and
// `refreshSetupsCacheImpl_` then wrote a fresh 1,806-record file that
// clobbered the bootstrap's 49,310 historical setups. Recovery required
// restoring from git history.
//
// New contract: 3 attempts with exponential backoff. If all attempts fail,
// throw. Callers must handle the throw — silently writing on bad reads is
// what caused the prior outage.
function readSetupsCache_() {
  var lastError = null;
  var MAX_ATTEMPTS = 3;
  for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      var resp = UrlFetchApp.fetch(
        'https://catseye-internal.github.io/Production-Dashboard/cache-setups.json',
        { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } }
      );
      var code = resp.getResponseCode();
      if (code === 200) {
        var parsed = JSON.parse(resp.getContentText());
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.setups)) {
          throw new Error('cache-setups.json parsed but shape is wrong (no .setups array)');
        }
        return parsed;
      }
      lastError = 'HTTP ' + code;
      Logger.log('  ⚠️ readSetupsCache_ attempt ' + attempt + '/' + MAX_ATTEMPTS + ': ' + lastError);
    } catch (e) {
      lastError = e.message;
      Logger.log('  ⚠️ readSetupsCache_ attempt ' + attempt + '/' + MAX_ATTEMPTS + ': ' + e.message);
    }
    if (attempt < MAX_ATTEMPTS) Utilities.sleep(2000 * attempt);  // 2s, 4s
  }
  throw new Error('readSetupsCache_ failed after ' + MAX_ATTEMPTS + ' attempts. Last error: ' + lastError);
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

// Second probe: /Locations requires 'q' or 'ids'. Find out what 'q' accepts.
// ══════════════════════════════════════════════════════════════
// EXTENDED BOOTSTRAP — discover ALL customers via /Locations?q=...
// search (not just those in cache-locations.json) and pull their setups.
//
// Why: cache-locations.json only contains customers with orders in the
// 90-day forward window. Cancelled customers with no upcoming orders are
// missing entirely. The /Locations endpoint is a fulltext NAME search:
// q=a returns 8,178 results, q=Smith returns 380. By searching every letter
// of the alphabet and deduping by LocationID, we discover every customer
// whose name contains any letter (= ~all customers).
//
// Joe directive 2026-05-25 — pair with reenrichCancelledSetups to populate
// CancelReason on newly-discovered cancelled setups.

// Resume-friendly version of bootstrapAllSetupsFromSearch. Saves progress
// every 500 locations and writes cache to GitHub every 2,000 locations.
// On Apps Script timeout (30 min), all progress to the last write is preserved.
// Call bootstrapAllSetupsFromSearchResume() to continue.
//
// At ~15 calls/sec, expect ~21K locations per 25-min run. Full 49K = ~3 runs.

var BSS_BATCH_SIZE = 30;
var BSS_BATCH_PAUSE_MS = 100;
var BSS_PROGRESS_LOG_EVERY = 500;
var BSS_INCREMENTAL_WRITE_EVERY = 2000;
var BSS_SAFETY_STOP_SECONDS = 1500;  // 25 min — bail before Apps Script kills us
var BSS_CURSOR_KEY = 'bssCursor';
var BSS_LOCATION_IDS_KEY = 'bssLocationIds';  // serialized after discovery phase

function bootstrapAllSetupsFromSearchResumable() {
  return _bssImpl_(false);
}

function bootstrapAllSetupsFromSearchResume() {
  return _bssImpl_(true);
}

function clearBootstrapSearchCursor() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(BSS_CURSOR_KEY);
  props.deleteProperty(BSS_LOCATION_IDS_KEY);
  Logger.log('Cursor + cached LocationID list cleared. Next call will start from scratch.');
}

function _bssImpl_(resume) {
  var t0 = new Date();
  var props = PropertiesService.getScriptProperties();
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🌐 Extended bootstrap (RESUMABLE)' + (resume ? ' — RESUMING' : ' — fresh start') + ' — ' + t0.toISOString());
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  var token = ppToken_();
  var apiHeaders = {
    'Authorization': 'Bearer ' + token,
    'apikey': PP_API_KEY,
    'tenant-id': PP_TENANT_ID
  };

  // ── Phase 1: get the LocationID list ──
  // If resuming AND we have a cached list, use it. Otherwise run the alphabet search.
  var locationIdsJson = resume ? props.getProperty(BSS_LOCATION_IDS_KEY) : null;
  var missingIds;
  if (locationIdsJson) {
    Logger.log('1. Restoring LocationID list from prior run state...');
    missingIds = JSON.parse(locationIdsJson);
    Logger.log('   ' + missingIds.length.toLocaleString() + ' LocationIDs queued from prior search');
  } else {
    Logger.log('1. Discovering LocationIDs via /Locations?q=letter searches (26 letters)...');
    var allIds = {};
    var alphabet = 'abcdefghijklmnopqrstuvwxyz';
    for (var i = 0; i < alphabet.length; i++) {
      var ch = alphabet[i];
      var r = ppGet_(token, '/Locations?q=' + ch);
      if (r.code !== 200) continue;
      try {
        var locs = JSON.parse(r.text);
        if (Array.isArray(locs)) {
          locs.forEach(function(l) { if (l.LocationID) allIds[l.LocationID] = true; });
        }
      } catch (e) { /* skip */ }
      Utilities.sleep(150);
    }
    var totalIds = Object.keys(allIds);
    Logger.log('   Discovered ' + totalIds.length.toLocaleString() + ' unique LocationIDs');

    // Identify which aren't in setups cache
    var existingForDiff = readSetupsCache_();
    var setupsByLocation = {};
    (existingForDiff.setups || []).forEach(function(s) {
      if (s.LocationID != null) setupsByLocation[String(s.LocationID)] = true;
    });
    missingIds = totalIds.filter(function(id) { return !setupsByLocation[String(id)]; });
    Logger.log('   ' + missingIds.length.toLocaleString() + ' LocationIDs missing from setups cache');

    // Stash the list so Resume doesn't have to re-discover
    props.setProperty(BSS_LOCATION_IDS_KEY, JSON.stringify(missingIds));
  }

  if (missingIds.length === 0) {
    Logger.log('✅ Nothing to fetch.');
    return;
  }

  // ── Phase 2: load existing setups cache for merging ──
  Logger.log('2. Loading existing setups cache for merge...');
  var existing = readSetupsCache_();
  var setupsMap = {};
  (existing.setups || []).forEach(function(s) {
    if (s.SetupID != null) setupsMap[String(s.SetupID)] = s;
  });
  Logger.log('   ' + Object.keys(setupsMap).length.toLocaleString() + ' setups already cached');

  // ── Phase 3: fetch /Locations/{id}/serviceSetups in batches ──
  var startIdx = resume ? Number(props.getProperty(BSS_CURSOR_KEY) || 0) : 0;
  if (startIdx > 0) {
    Logger.log('3. Resuming from cursor index ' + startIdx.toLocaleString() + ' of ' + missingIds.length.toLocaleString());
  } else {
    Logger.log('3. Starting fresh from index 0 of ' + missingIds.length.toLocaleString());
  }

  var newSetupCount = 0;
  var cancelledFound = 0;
  var failedLocations = 0;
  var safetyTriggered = false;

  for (var b = startIdx; b < missingIds.length; b += BSS_BATCH_SIZE) {
    // Safety check — bail before Apps Script kills us
    var elapsedSec = (new Date() - t0) / 1000;
    if (elapsedSec >= BSS_SAFETY_STOP_SECONDS) {
      safetyTriggered = true;
      Logger.log('   ⏰ Safety stop at ' + elapsedSec.toFixed(0) + 's — saving progress and exiting cleanly');
      break;
    }

    var slice = missingIds.slice(b, b + BSS_BATCH_SIZE);
    var requests = slice.map(function(lid) {
      return {
        url: PP_API_BASE + '/Locations/' + lid + '/serviceSetups',
        method: 'get',
        headers: apiHeaders,
        muteHttpExceptions: true
      };
    });

    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
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
          var sid = String(curated.SetupID);
          if (!setupsMap[sid]) {
            newSetupCount++;
            if (curated.CancelDate) cancelledFound++;
          }
          setupsMap[sid] = curated;
        });
      } catch (e) { /* skip */ }
    }

    var done = b + slice.length;

    if (done % BSS_PROGRESS_LOG_EVERY === 0 || done >= missingIds.length) {
      Logger.log('   [' + done.toLocaleString() + ' / ' + missingIds.length.toLocaleString() + ']  ' +
                 'new setups: ' + newSetupCount.toLocaleString() + ' · cancelled in new: ' + cancelledFound.toLocaleString() +
                 ' · failed: ' + failedLocations + ' · elapsed: ' + elapsedSec.toFixed(0) + 's');
    }

    // Incremental cache write — flush to GitHub every N locations
    if (done > 0 && (done % BSS_INCREMENTAL_WRITE_EVERY === 0 || done >= missingIds.length)) {
      _bssFlushCache_(setupsMap, 'Bootstrap progress checkpoint ' + done + '/' + missingIds.length);
      props.setProperty(BSS_CURSOR_KEY, String(done));
    }

    if (b + BSS_BATCH_SIZE < missingIds.length) Utilities.sleep(BSS_BATCH_PAUSE_MS);
  }

  // Final flush + cursor save
  if (safetyTriggered) {
    var lastDone = Math.floor((Math.min(b, missingIds.length)) / BSS_INCREMENTAL_WRITE_EVERY) * BSS_INCREMENTAL_WRITE_EVERY;
    // Force a write right now so we save what's in memory
    _bssFlushCache_(setupsMap, 'Bootstrap safety-stop checkpoint');
    props.setProperty(BSS_CURSOR_KEY, String(b));
    Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    Logger.log('⏸  PAUSED for safety. Re-run bootstrapAllSetupsFromSearchResume() to continue.');
    Logger.log('   Cursor saved at index ' + b.toLocaleString());
    Logger.log('   New setups so far: ' + newSetupCount.toLocaleString() + ' · cancelled: ' + cancelledFound.toLocaleString());
    return;
  }

  // Completion — clean up cursor
  props.deleteProperty(BSS_CURSOR_KEY);
  props.deleteProperty(BSS_LOCATION_IDS_KEY);

  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ Extended bootstrap COMPLETE');
  Logger.log('   Locations processed: ' + missingIds.length.toLocaleString());
  Logger.log('   New setups discovered: ' + newSetupCount.toLocaleString());
  Logger.log('   Cancelled setups in new: ' + cancelledFound.toLocaleString());
  Logger.log('   Failed location calls: ' + failedLocations);
  Logger.log('   Total elapsed: ' + ((new Date() - t0) / 1000).toFixed(1) + 's');
  Logger.log('');
  Logger.log('NEXT: run reenrichCancelledSetups() to populate CancelReason on newly-discovered cancellations.');
}

function _bssFlushCache_(setupsMap, commitMsg) {
  var allSetups = [];
  Object.keys(setupsMap).forEach(function(k) { allSetups.push(setupsMap[k]); });
  allSetups.sort(function(a, b) { return Number(a.SetupID) - Number(b.SetupID); });
  var cache = {
    updated: new Date().toISOString(),
    recordCount: allSetups.length,
    lastBootstrapCheckpoint: new Date().toISOString(),
    setups: allSetups
  };
  var jsonStr = JSON.stringify(cache);
  Logger.log('   💾 Flushing ' + allSetups.length.toLocaleString() + ' setups (' + Math.round(jsonStr.length / 1024) + ' KB) to GitHub...');
  var ok = pushToGitHub_(jsonStr, GH_PATH_SETUPS, commitMsg + ' ' + new Date().toISOString());
  Logger.log('   ' + (ok ? '✓ checkpoint saved' : '✗ checkpoint FAILED'));
}

// ─────────────────────────────────────────────────────────────────────────────
// bootstrapRetryUncoveredLocations  (task #151)
//
// After bootstrapAllSetupsFromSearchResumable completes, ~7K LocationIDs are
// "uncovered" — they were queued but their /Locations/{id}/serviceSetups call
// failed (transient throttling per pestpac_bootstrap_throttling memory). This
// pass diffs the full LocationID universe against IDs represented in
// cache-setups.json and retries the gap.
//
// Key difference vs the original bootstrap: a knownEmpty persistence layer.
// Some LocationIDs are legitimately childless — every retry would otherwise
// re-fetch them forever. When this function receives a 200 OK with [] body,
// the LocationID is added to BRT_EMPTY_KEY and excluded from future passes.
// Convergence: each retry pass shrinks the uncovered set toward only real
// transient failures, which the next pass will recover.
//
// Resumable: same checkpoint + 25-min safety-stop pattern as _bssImpl_.
// State keys are BRT_* (separate from BSS_*) so retry runs don't collide
// with an in-flight resumable bootstrap.
// ─────────────────────────────────────────────────────────────────────────────
var BRT_CURSOR_KEY     = 'brtCursor';
var BRT_MISSING_KEY    = 'brtMissingIds';     // serialized uncovered list
var BRT_EMPTY_KEY      = 'brtKnownEmptyIds';  // serialized confirmed-empty list

function bootstrapRetryUncoveredLocations() {
  return _brtImpl_(false, false);
}

function bootstrapRetryUncoveredLocationsResume() {
  return _brtImpl_(true, false);
}

// Override variant — bypasses the workday quota guard. Use ONLY if you've
// confirmed the URLfetch quota has plenty of headroom for the day.
// Safer alternative: just wait until after midnight Pacific (3 AM ET).
function bootstrapRetryUncoveredLocationsForce() {
  return _brtImpl_(false, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// bootstrapRetryUncoveredLocationsSlow — throttle-safe variant (Joe 2026-05-26)
//
// The fast variant trips PestPac's burst-rate ceiling after ~7K calls/30min.
// This variant stays well below it:
//   • Batch size 5     (vs 30) — fewer concurrent requests per second
//   • Pause 1500ms     (vs 100ms) — only ~3.3 calls/sec sustained = 200/min
//   • Safety stop 10m  (vs 25m) — shorter run, less sustained pressure
//
// At ~200 calls/min × 10 min = ~2000 locations per run. The ~7K uncovered
// pool finishes in ~4 runs. Schedule nightly at 4 AM ET trigger and it'll
// chip through within a week without ever tripping the throttle.
//
// Reuses the same BRT_* state keys + knownEmpty learning as the fast variant
// — Resume from either is interchangeable.
// ─────────────────────────────────────────────────────────────────────────────
function bootstrapRetryUncoveredLocationsSlow() {
  return _brtImpl_(false, false, {
    batchSize: 5,
    batchPauseMs: 1500,
    safetyStopSec: 600,         // 10 min vs 25 min default
    label: 'SLOW'
  });
}

function bootstrapRetryUncoveredLocationsSlowResume() {
  return _brtImpl_(true, false, {
    batchSize: 5,
    batchPauseMs: 1500,
    safetyStopSec: 600,
    label: 'SLOW'
  });
}

// ─────────────────────────────────────────────────────────────────────
// QUARTERLY BOOTSTRAP — date-gated daily wrapper
//
// Wire ONE daily Apps Script trigger to this function (suggested time:
// 2 AM Pacific = 5 AM Eastern). It's a no-op on 361 days a year, and on
// quarter-starts (Feb 1, May 1, Aug 1, Nov 1) it fires
// bootstrapRetryUncoveredLocationsSlow to catch newly-cancelled
// customers whose webhook delta updates have stopped.
//
// Why 4 dates a year: cache-setups.json drifts as customers cancel and
// PestPac stops including them in delta refreshes. A quarterly sweep
// keeps the Cancels view's ARR Lost number honest without burning
// URLfetch quota every night. After the first overnight run drains the
// backlog (~5,000+ uncovered LocationIDs), each quarterly top-up should
// be ~100-500 new LocationIDs — well within a single 10-min window.
// If a single pass isn't enough on a given quarter-start, Joe can
// manually fire bootstrapRetryUncoveredLocationsSlowResume the next
// night to drain BRT_MISSING_KEY.
//
// Why daily-with-date-check (not a single fixed-date trigger): Apps
// Script's UI trigger config supports "daily / weekly / monthly" but
// not "Feb 1 + May 1 + Aug 1 + Nov 1". Daily + early-exit on
// non-target days is the standard pattern.
//
// Joe directive 2026-05-26.
// ─────────────────────────────────────────────────────────────────────
function quarterlyBootstrapDaily() {
  var now = new Date();
  // Compare in Eastern Time (where Joe's company operates) so a Feb 1
  // run that fires at 2 AM Pacific = 5 AM Eastern correctly registers
  // as "Feb 1" rather than getting confused if the PT date shifted.
  var ymd = Utilities.formatDate(now, 'America/New_York', 'MM-dd');
  var QUARTERLY_DATES = ['02-01', '05-01', '08-01', '11-01'];
  if (QUARTERLY_DATES.indexOf(ymd) === -1) {
    // No-op day. Don't log noisily — daily triggers fire 365 times/yr.
    return;
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📅 QUARTERLY BOOTSTRAP — ' + ymd + ' triggered uncovered-location sweep');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  // Delegate to the existing throttle-safe slow variant. Quota guard
  // inside _brtImpl_ will still refuse if the trigger somehow fires
  // outside the midnight-5 AM PT window.
  return bootstrapRetryUncoveredLocationsSlow();
}

function clearBootstrapRetryState() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(BRT_CURSOR_KEY);
  props.deleteProperty(BRT_MISSING_KEY);
  // Note: BRT_EMPTY_KEY intentionally preserved — it's a cumulative learning
  // across retry passes. Use clearKnownEmptyLocations() to nuke it explicitly.
  Logger.log('Retry cursor + missing list cleared. knownEmpty preserved.');
}

function clearKnownEmptyLocations() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(BRT_EMPTY_KEY);
  Logger.log('knownEmpty list cleared. Next retry pass will re-confirm empty locations.');
}

function _brtImpl_(resume, forceOverride, overrides) {
  var t0 = new Date();
  var props = PropertiesService.getScriptProperties();

  // Throttle overrides — Slow variant passes smaller batch + longer pause +
  // shorter safety stop. Defaults fall back to module constants.
  overrides = overrides || {};
  var BATCH_SIZE     = overrides.batchSize     || BSS_BATCH_SIZE;
  var BATCH_PAUSE_MS = overrides.batchPauseMs  || BSS_BATCH_PAUSE_MS;
  var SAFETY_STOP_SEC = overrides.safetyStopSec || BSS_SAFETY_STOP_SECONDS;
  var RUN_LABEL      = overrides.label         || '';

  // ─── Quota safety guard (added 2026-05-26) ───
  // This retry burns ~50K URLfetch calls in a full run, which is half the
  // 100K daily Workspace quota. Running during the workday starves the
  // 10-min refreshCache + webhook handlers, freezing the dashboard. Window
  // is midnight–5 AM Pacific (= 3 AM–8 AM ET), AFTER the daily quota reset
  // and BEFORE the workday's normal traffic ramps up.
  if (!forceOverride) {
    var hourPT = parseInt(Utilities.formatDate(t0, 'America/Los_Angeles', 'HH'), 10);
    if (hourPT >= 5) {
      Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      Logger.log('🚫 REFUSING TO START — currently hour ' + hourPT + ' Pacific Time.');
      Logger.log('   The bootstrap retry must run between midnight and 5 AM Pacific');
      Logger.log('   (= 3 AM to 8 AM Eastern) to avoid burning URLfetch quota during');
      Logger.log('   the workday. Options:');
      Logger.log('   1. Wait until after midnight Pacific (3 AM ET) and run again.');
      Logger.log('   2. Set up a time-based trigger for 4 AM Pacific (7 AM ET).');
      Logger.log('   3. Run bootstrapRetryUncoveredLocationsForce() ONLY if you have');
      Logger.log('      verified URLfetch quota headroom for the day.');
      Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      return;
    }
  }

  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🔁 Retry uncovered locations' + (resume ? ' — RESUMING' : ' — fresh start') +
             (RUN_LABEL ? ' — ' + RUN_LABEL : '') +
             (forceOverride ? ' — FORCE OVERRIDE' : '') + ' — ' + t0.toISOString());
  Logger.log('   Throttle: batchSize=' + BATCH_SIZE + ' · pauseMs=' + BATCH_PAUSE_MS +
             ' · safetyStop=' + SAFETY_STOP_SEC + 's' +
             ' · sustained=~' + Math.round((BATCH_SIZE / (BATCH_PAUSE_MS / 1000 + 0.1)) * 60) + ' calls/min');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  var token = ppToken_();
  var apiHeaders = {
    'Authorization': 'Bearer ' + token,
    'apikey': PP_API_KEY,
    'tenant-id': PP_TENANT_ID
  };

  // Load the persistent knownEmpty set (cumulative across retry passes)
  var knownEmptyJson = props.getProperty(BRT_EMPTY_KEY);
  var knownEmpty = {};
  if (knownEmptyJson) {
    try {
      JSON.parse(knownEmptyJson).forEach(function(id) { knownEmpty[String(id)] = true; });
    } catch (e) { knownEmpty = {}; }
  }
  Logger.log('   knownEmpty set: ' + Object.keys(knownEmpty).length.toLocaleString() + ' LocationIDs cached as legitimately empty');

  // ── Phase 1: get the uncovered LocationID list ──
  var missingIdsJson = resume ? props.getProperty(BRT_MISSING_KEY) : null;
  var missingIds;
  if (missingIdsJson) {
    Logger.log('1. Restoring uncovered LocationID list from prior retry run...');
    missingIds = JSON.parse(missingIdsJson);
    Logger.log('   ' + missingIds.length.toLocaleString() + ' LocationIDs queued for retry');
  } else {
    Logger.log('1. Discovering full LocationID universe via /Locations?q=letter searches (26 letters)...');
    var allIds = {};
    var alphabet = 'abcdefghijklmnopqrstuvwxyz';
    for (var i = 0; i < alphabet.length; i++) {
      var ch = alphabet[i];
      var r = ppGet_(token, '/Locations?q=' + ch);
      if (r.code !== 200) continue;
      try {
        var locs = JSON.parse(r.text);
        if (Array.isArray(locs)) {
          locs.forEach(function(l) { if (l.LocationID) allIds[l.LocationID] = true; });
        }
      } catch (e) { /* skip */ }
      Utilities.sleep(150);
    }
    var totalIds = Object.keys(allIds);
    Logger.log('   Discovered ' + totalIds.length.toLocaleString() + ' unique LocationIDs in universe');

    // Build the "covered" set from cache-setups.json — any LocationID with at
    // least one setup record is considered covered.
    var existingForDiff = readSetupsCache_();
    var covered = {};
    (existingForDiff.setups || []).forEach(function(s) {
      if (s.LocationID != null) covered[String(s.LocationID)] = true;
    });
    Logger.log('   ' + Object.keys(covered).length.toLocaleString() + ' LocationIDs already represented in cache');

    // Uncovered = in universe AND not in covered AND not knownEmpty
    missingIds = totalIds.filter(function(id) {
      var s = String(id);
      return !covered[s] && !knownEmpty[s];
    });
    Logger.log('   ' + missingIds.length.toLocaleString() + ' LocationIDs uncovered (after excluding knownEmpty)');

    props.setProperty(BRT_MISSING_KEY, JSON.stringify(missingIds));
  }

  if (missingIds.length === 0) {
    Logger.log('✅ Nothing to retry — all LocationIDs either covered or knownEmpty.');
    props.deleteProperty(BRT_CURSOR_KEY);
    props.deleteProperty(BRT_MISSING_KEY);
    return;
  }

  // ── Phase 2: load existing setups cache for merge ──
  Logger.log('2. Loading existing setups cache for merge...');
  var existing = readSetupsCache_();
  var setupsMap = {};
  (existing.setups || []).forEach(function(s) {
    if (s.SetupID != null) setupsMap[String(s.SetupID)] = s;
  });
  Logger.log('   ' + Object.keys(setupsMap).length.toLocaleString() + ' setups already cached');

  // ── Phase 3: batched retry against /Locations/{id}/serviceSetups ──
  var startIdx = resume ? Number(props.getProperty(BRT_CURSOR_KEY) || 0) : 0;
  if (startIdx > 0) {
    Logger.log('3. Resuming from cursor index ' + startIdx.toLocaleString() + ' of ' + missingIds.length.toLocaleString());
  } else {
    Logger.log('3. Starting fresh from index 0 of ' + missingIds.length.toLocaleString());
  }

  var newSetupCount = 0;
  var cancelledFound = 0;
  var failedLocations = 0;        // 200-but-bad-body or non-200 — eligible for next retry pass
  var confirmedEmptyThisRun = 0;  // 200 + [] body — moved to knownEmpty
  var recoveredLocations = 0;     // 200 + non-empty body — pulled setups in
  var safetyTriggered = false;
  var b = startIdx;

  for (b = startIdx; b < missingIds.length; b += BATCH_SIZE) {
    var elapsedSec = (new Date() - t0) / 1000;
    if (elapsedSec >= SAFETY_STOP_SEC) {
      safetyTriggered = true;
      Logger.log('   ⏰ Safety stop at ' + elapsedSec.toFixed(0) + 's — saving progress and exiting cleanly');
      break;
    }

    var slice = missingIds.slice(b, b + BATCH_SIZE);
    var requests = slice.map(function(lid) {
      return {
        url: PP_API_BASE + '/Locations/' + lid + '/serviceSetups',
        method: 'get',
        headers: apiHeaders,
        muteHttpExceptions: true
      };
    });

    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      failedLocations += slice.length;
      continue;
    }

    for (var k = 0; k < responses.length; k++) {
      var resp = responses[k];
      var lid = slice[k];
      if (resp.getResponseCode() !== 200) { failedLocations++; continue; }
      try {
        var setups = JSON.parse(resp.getContentText());
        if (!Array.isArray(setups)) { failedLocations++; continue; }
        if (setups.length === 0) {
          // Legitimately empty — record so future retries skip it
          knownEmpty[String(lid)] = true;
          confirmedEmptyThisRun++;
          continue;
        }
        recoveredLocations++;
        setups.forEach(function(rawSetup) {
          if (!rawSetup || rawSetup.SetupID == null) return;
          var curated = curate_(rawSetup, CURATED_FIELDS_SETUP);
          enrichSetupCreator_(curated, rawSetup);
          var sid = String(curated.SetupID);
          if (!setupsMap[sid]) {
            newSetupCount++;
            if (curated.CancelDate) cancelledFound++;
          }
          setupsMap[sid] = curated;
        });
      } catch (e) {
        failedLocations++;
      }
    }

    var done = b + slice.length;

    if (done % BSS_PROGRESS_LOG_EVERY === 0 || done >= missingIds.length) {
      Logger.log('   [' + done.toLocaleString() + ' / ' + missingIds.length.toLocaleString() + ']  ' +
                 'recovered: ' + recoveredLocations.toLocaleString() + ' · empty: ' + confirmedEmptyThisRun.toLocaleString() +
                 ' · new setups: ' + newSetupCount.toLocaleString() +
                 ' · failed: ' + failedLocations + ' · elapsed: ' + elapsedSec.toFixed(0) + 's');
    }

    // Incremental flush — cache + knownEmpty + cursor
    if (done > 0 && (done % BSS_INCREMENTAL_WRITE_EVERY === 0 || done >= missingIds.length)) {
      _bssFlushCache_(setupsMap, 'Retry uncovered checkpoint ' + done + '/' + missingIds.length);
      props.setProperty(BRT_CURSOR_KEY, String(done));
      props.setProperty(BRT_EMPTY_KEY, JSON.stringify(Object.keys(knownEmpty)));
    }

    if (b + BATCH_SIZE < missingIds.length) Utilities.sleep(BATCH_PAUSE_MS);
  }

  // Safety-stop branch: write what we have, keep state for resume
  if (safetyTriggered) {
    _bssFlushCache_(setupsMap, 'Retry uncovered safety-stop checkpoint');
    props.setProperty(BRT_CURSOR_KEY, String(b));
    props.setProperty(BRT_EMPTY_KEY, JSON.stringify(Object.keys(knownEmpty)));
    Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    Logger.log('⏸  PAUSED for safety. Re-run ' +
               (RUN_LABEL === 'SLOW' ? 'bootstrapRetryUncoveredLocationsSlowResume()' : 'bootstrapRetryUncoveredLocationsResume()') +
               ' to continue.');
    Logger.log('   Cursor saved at index ' + b.toLocaleString() + ' of ' + missingIds.length.toLocaleString());
    Logger.log('   Recovered locations so far: ' + recoveredLocations.toLocaleString() +
               ' · confirmed empty: ' + confirmedEmptyThisRun.toLocaleString() +
               ' · still failing: ' + failedLocations.toLocaleString());
    return;
  }

  // Completion — write final state, clean retry cursor/missing, preserve knownEmpty
  props.setProperty(BRT_EMPTY_KEY, JSON.stringify(Object.keys(knownEmpty)));
  props.deleteProperty(BRT_CURSOR_KEY);
  props.deleteProperty(BRT_MISSING_KEY);

  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ Retry pass COMPLETE');
  Logger.log('   Locations retried:       ' + missingIds.length.toLocaleString());
  Logger.log('   Recovered (had setups):  ' + recoveredLocations.toLocaleString());
  Logger.log('   Confirmed empty:         ' + confirmedEmptyThisRun.toLocaleString() + ' (added to knownEmpty)');
  Logger.log('   Still failing:           ' + failedLocations.toLocaleString() + ' (eligible for next retry pass)');
  Logger.log('   New setups discovered:   ' + newSetupCount.toLocaleString());
  Logger.log('   Cancelled in new:        ' + cancelledFound.toLocaleString());
  Logger.log('   knownEmpty cumulative:   ' + Object.keys(knownEmpty).length.toLocaleString());
  Logger.log('   Total elapsed:           ' + ((new Date() - t0) / 1000).toFixed(1) + 's');
  Logger.log('');
  if (failedLocations > 0) {
    Logger.log('NEXT: re-run bootstrapRetryUncoveredLocations() to chip at the remaining ' +
               failedLocations.toLocaleString() + ' transient failures.');
  } else {
    Logger.log('NEXT: run reenrichCancelledSetups() to backfill CancelReason on newly-discovered cancellations.');
  }
}

function bootstrapAllSetupsFromSearch() {
  var t0 = new Date();
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🌐 Extended bootstrap — discover ALL setups via name search');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  var token = ppToken_();
  var apiHeaders = {
    'Authorization': 'Bearer ' + token,
    'apikey': PP_API_KEY,
    'tenant-id': PP_TENANT_ID
  };

  // ── Phase 1: enumerate LocationIDs via letter searches ──
  Logger.log('1. Discovering LocationIDs via /Locations?q=letter searches...');
  var allIds = {};   // LocationID → true
  var alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (var i = 0; i < alphabet.length; i++) {
    var ch = alphabet[i];
    var r = ppGet_(token, '/Locations?q=' + ch);
    if (r.code !== 200) {
      Logger.log('   q=' + ch + ' → HTTP ' + r.code);
      continue;
    }
    try {
      var locs = JSON.parse(r.text);
      if (Array.isArray(locs)) {
        var newCount = 0;
        locs.forEach(function(l) {
          if (l.LocationID && !allIds[l.LocationID]) {
            allIds[l.LocationID] = true;
            newCount++;
          }
        });
        Logger.log('   q=' + ch + ' → ' + locs.length + ' results · ' + newCount + ' new · ' + Object.keys(allIds).length + ' total unique');
      }
    } catch (e) { /* skip */ }
    Utilities.sleep(200);
  }
  var totalIds = Object.keys(allIds);
  Logger.log('   ✓ Discovered ' + totalIds.length.toLocaleString() + ' unique LocationIDs across all letter searches');

  // ── Phase 2: identify which LocationIDs aren't currently in our setups cache ──
  Logger.log('');
  Logger.log('2. Loading current cache-setups.json to identify which locations we already have...');
  var existing = readSetupsCache_();
  var setupsByLocation = {};
  (existing.setups || []).forEach(function(s) {
    if (s.LocationID != null) {
      if (!setupsByLocation[String(s.LocationID)]) setupsByLocation[String(s.LocationID)] = [];
      setupsByLocation[String(s.LocationID)].push(s);
    }
  });
  var cachedLocationCount = Object.keys(setupsByLocation).length;
  Logger.log('   Setups cache covers ' + cachedLocationCount.toLocaleString() + ' unique locations');

  var missingIds = totalIds.filter(function(id) { return !setupsByLocation[String(id)]; });
  Logger.log('   ' + missingIds.length.toLocaleString() + ' LocationIDs in PestPac but NOT in setups cache → these are our target');

  if (missingIds.length === 0) {
    Logger.log('✅ Nothing to discover. Setups cache is fully synced with name-search results.');
    return;
  }

  // ── Phase 3: fetch /Locations/{id}/serviceSetups for each missing LocationID ──
  Logger.log('');
  Logger.log('3. Fetching setups for missing locations in batches of 25...');
  var setupsMap = {};
  // Preserve all existing setups (we're ADDING, not replacing)
  (existing.setups || []).forEach(function(s) {
    if (s.SetupID != null) setupsMap[String(s.SetupID)] = s;
  });

  var newSetupCount = 0;
  var cancelledFound = 0;
  var failedLocations = 0;
  var BATCH = 25;

  for (var b = 0; b < missingIds.length; b += BATCH) {
    var slice = missingIds.slice(b, b + BATCH);
    var requests = slice.map(function(lid) {
      return {
        url: PP_API_BASE + '/Locations/' + lid + '/serviceSetups',
        method: 'get',
        headers: apiHeaders,
        muteHttpExceptions: true
      };
    });
    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
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
          var sid = String(curated.SetupID);
          if (!setupsMap[sid]) {
            newSetupCount++;
            if (curated.CancelDate) cancelledFound++;
          }
          setupsMap[sid] = curated;
        });
      } catch (e) { /* skip */ }
    }
    var done = b + slice.length;
    if (done % 200 === 0 || done === missingIds.length) {
      var elapsed = ((new Date() - t0) / 1000);
      Logger.log('   [' + done.toLocaleString() + ' / ' + missingIds.length.toLocaleString() + ']  new setups: ' + newSetupCount.toLocaleString() + ' · cancelled in new: ' + cancelledFound.toLocaleString() + ' · failed: ' + failedLocations + ' · elapsed: ' + elapsed.toFixed(0) + 's');
    }
    if (b + BATCH < missingIds.length) Utilities.sleep(200);
  }

  // ── Phase 4: write merged cache back to GitHub ──
  var allSetups = [];
  Object.keys(setupsMap).forEach(function(k) { allSetups.push(setupsMap[k]); });
  allSetups.sort(function(a, b) { return Number(a.SetupID) - Number(b.SetupID); });

  Logger.log('');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('SUMMARY');
  Logger.log('   Unique LocationIDs from search: ' + totalIds.length.toLocaleString());
  Logger.log('   Missing from setups cache:      ' + missingIds.length.toLocaleString());
  Logger.log('   New setups discovered:          ' + newSetupCount.toLocaleString());
  Logger.log('   Cancelled (CancelDate populated) in new: ' + cancelledFound.toLocaleString());
  Logger.log('   Failed location calls:          ' + failedLocations);
  Logger.log('   Total setups in cache (post):   ' + allSetups.length.toLocaleString());

  var cache = {
    updated: new Date().toISOString(),
    recordCount: allSetups.length,
    lastExtendedBootstrapAt: new Date().toISOString(),
    setups: allSetups
  };
  var jsonStr = JSON.stringify(cache);
  Logger.log('');
  Logger.log('4. Writing cache-setups.json: ' + Math.round(jsonStr.length / 1024) + ' KB');
  var ok = pushToGitHub_(jsonStr, GH_PATH_SETUPS, 'Extended bootstrap setups ' + new Date().toISOString());
  Logger.log('   push: ' + (ok ? 'OK' : 'FAIL'));

  var totalElapsed = ((new Date() - t0) / 1000).toFixed(1);
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ Extended bootstrap complete in ' + totalElapsed + 's');
  Logger.log('');
  Logger.log('NEXT: run reenrichCancelledSetups() to populate CancelReason on the newly-discovered cancellations.');
}

function probeLocationsQueryParam() {
  var token = ppToken_();
  Logger.log('🧪 PROBE — /Locations?q=... query syntax');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Try various q-parameter syntaxes
  var paths = [
    '/Locations?q=',
    '/Locations?q=*',
    '/Locations?q=%2A',
    '/Locations?q=a',
    '/Locations?q=Smith',
    '/Locations?q=BranchID:10',
    '/Locations?q=Branch:Eastern%20Mass',
    '/Locations?q=Active:false',
    '/Locations?q=Active:true',
    '/Locations?q=Active=false',
    '/Locations?q=CancelDate>=2026-05-01',
    '/Locations?q=ModifiedDate>=2026-05-01',
    '/Locations?q=AddDate>=2026-05-01',
    // ids parameter — provide a known LocationID
    '/Locations?ids=75108',
    '/Locations?ids=75108,74960'
  ];

  paths.forEach(function(p) {
    var r = ppGet_(token, p);
    var label = p.length > 55 ? p.substring(0, 55) + '...' : p;
    if (r.code !== 200) {
      var snippet = r.text.length < 200 ? r.text : r.text.substring(0, 200);
      Logger.log('  ' + label + '  →  HTTP ' + r.code + ' :: ' + snippet);
      return;
    }
    try {
      var parsed = JSON.parse(r.text);
      if (Array.isArray(parsed)) {
        Logger.log('  ' + label + '  →  ARRAY (' + parsed.length + ' items)');
        if (parsed.length > 0 && parsed.length <= 3) {
          // Tiny return — show keys
          Logger.log('     Sample LocationID=' + parsed[0].LocationID + ' Active=' + parsed[0].Active);
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
  Logger.log('Goal: find a q= pattern that lets us discover locations beyond');
  Logger.log("       what's currently in cache-locations.json (cancelled customers).");
}

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

// ──────────────────────────────────────────────────────────────
// Employees cache refresh — pulls /lookups/employees once a day and writes
// cache-employees.json. The dashboard joins this onto every Tech1/Tech2/Tech
// code at render time to show full names instead of 3-letter codes.
//
// /lookups/employees returns the union of Users + Technicians. We keep every
// record (so even office staff entered on invoices as EnteredBy get resolved
// if we ever need it) and let the front end filter by IsTechnician.
//
// Designed to be safe to run daily even on small quotas: one GET per refresh.
// ──────────────────────────────────────────────────────────────
function refreshEmployeesCache() {
  var t0 = new Date();
  Logger.log('👥 Employees cache refresh — ' + t0.toISOString());
  try {
    var token = ppToken_();
    var r = ppGet_(token, '/lookups/employees');
    if (r.code !== 200) {
      Logger.log('  ❌ /lookups/employees HTTP ' + r.code + ': ' + r.text.substring(0, 300));
      return;
    }
    var raw = JSON.parse(r.text);
    // PestPac lookup endpoints sometimes return an array, sometimes { Items: [...] }
    var list = Array.isArray(raw) ? raw : (raw.Items || raw.items || raw.results || raw.Results || []);
    Logger.log('  Returned ' + list.length + ' records');
    if (list.length === 0) {
      Logger.log('  Body sample: ' + r.text.substring(0, 500));
      return;
    }
    // Log the first record's full shape so we can refine the whitelist
    Logger.log('  First record keys (' + Object.keys(list[0]).length + '): ' + Object.keys(list[0]).sort().join(', '));
    Logger.log('  First record JSON: ' + JSON.stringify(list[0]).substring(0, 600));

    var curated = list.map(function(emp) { return curate_(emp, CURATED_FIELDS_EMPLOYEE); });
    // Sort by Code for deterministic file ordering
    curated.sort(function(a, b) { return String(a.Code || '').localeCompare(String(b.Code || '')); });

    var cache = {
      updated: new Date().toISOString(),
      recordCount: curated.length,
      employees: curated
    };
    var jsonStr = JSON.stringify(cache);
    Logger.log('  cache-employees.json: ' + jsonStr.length + ' chars (' + Math.round(jsonStr.length / 1024) + ' KB, ' + curated.length + ' records)');

    var ok = pushToGitHub_(jsonStr, GH_PATH_EMPLOYEES, 'Employees cache refresh ' + new Date().toISOString());
    var elapsed = ((new Date() - t0) / 1000).toFixed(1);
    Logger.log('✅ Employees refresh complete in ' + elapsed + 's | push: ' + (ok ? 'OK' : 'FAIL'));
  } catch (err) {
    Logger.log('❌ Employees refresh error: ' + err.message + '\n' + err.stack);
  }
}

function readEmployeesCache_() {
  try {
    var resp = UrlFetchApp.fetch(
      'https://catseye-internal.github.io/Production-Dashboard/cache-employees.json',
      { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } }
    );
    if (resp.getResponseCode() !== 200) return { employees: [] };
    return JSON.parse(resp.getContentText());
  } catch (e) {
    return { employees: [] };
  }
}

// ══════════════════════════════════════════════════════════════
// TIME BLOCKS CACHE — PTO / vacation / off-day blocks
// ══════════════════════════════════════════════════════════════
// Joe directive 2026-05-26: dispatch puts an "Appointment time block" on the
// PestPac schedule when a tech is off (PTO, vacation, training, sick day).
// These blocks DO NOT show up in /ServiceOrders — they live on /TimeBlocks.
//
// Endpoint: GET /TimeBlocks?techId=<EmployeeID>&startDate=<iso>&endDate=<iso>
// Returns array of: { timeBlockID, technician, startDate, endDate, dayOfWeek,
//                     duration, reason, description, leadID }
//
// Window: today 00:00 ET → today+4 23:59 ET (covers the 4-day Dashboard forecast).
// Quota: ~33 techs × 1 call = ~33 calls per refresh. Daily trigger is plenty.
// Throttle: 200 ms pause between per-tech calls to stay friendly to the API.
//
// Front-end use (Dashboard view capacity calc): for each pest tech on a given
// day, subtract the total blocked minutes from NET_DAY_MIN BEFORE subtracting
// scheduled order/drive minutes. A fully-blocked tech ends up with openMin=0
// and falls out of capacityTechsFree automatically. See [[pestpac-timeblocks]].
// ══════════════════════════════════════════════════════════════
function refreshTimeBlocksCache() {
  var t0 = new Date();
  Logger.log('🛑 Time Blocks cache refresh — ' + t0.toISOString());
  try {
    var empCache = readEmployeesCache_();
    var employees = (empCache && empCache.employees) || [];
    // Only ACTIVE techs are relevant for time blocks. The employees cache
    // contains every employee ever — including terminated/legacy — so without
    // an Active filter we'd poll ~845 records. With Active=true it's ~33-50.
    // EmployeeID must also be present (TechID is the param for the API).
    var techs = employees.filter(function(e) {
      return e && e.IsTech === true && e.Active === true && e.EmployeeID;
    });
    Logger.log('  Polling ' + techs.length + ' techs (IsTech=true, Active=true, has EmployeeID)');
    if (techs.length === 0) {
      Logger.log('  ⚠️ No techs found in cache-employees.json — refresh employees first?');
      return;
    }

    // PestPac /TimeBlocks ENDPOINT BUGS (confirmed 2026-05-26 via probe):
    //   1. The endDate query param triggers HTTP 500 ("1901-01-01T was not
    //      recognized as a valid DateTime") — every format we tried. Drop it.
    //   2. The startDate filter appears to be strict > (not >=). A block
    //      starting at 00:00 on `startDate` gets excluded. So we anchor
    //      startDate to Jan 1 of current year (Joe directive: "this year is
    //      more than enough") — wide enough to catch any active block, scoped
    //      enough to avoid pulling decades of history.
    // Client-side: filter to only the 5-day Dashboard forecast window so the
    // cache stays small (a year of API blocks → ~5 days persisted).
    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var windowEnd  = new Date(todayStart);
    windowEnd.setDate(windowEnd.getDate() + 5);
    var startStr   = now.getFullYear() + '-01-01';   // YTD query
    var todayMs    = todayStart.getTime();
    var endCutoffMs = windowEnd.getTime();

    var token = ppToken_();
    var allBlocks = [];
    var techsWithBlocks = 0;
    var firstError = null;
    var consecutiveErrors = 0;
    var firstErrorMsg = '';

    for (var i = 0; i < techs.length; i++) {
      var t = techs[i];
      // NO endDate param — see bug note above. Filter end-of-window client-side.
      var path = '/TimeBlocks?techId=' + t.EmployeeID + '&startDate=' + startStr;
      var r = ppGet_(token, path);
      if (r.code === 401 && /quota/i.test(r.text)) {
        Logger.log('  ❌ PestPac tenant quota exhausted at tech #' + (i+1) + ' (' + t.Username + '). Aborting.');
        firstError = 'QUOTA_EXHAUSTED';
        break;
      }
      if (r.code !== 200) {
        Logger.log('  ' + t.Username + ' (TechID ' + t.EmployeeID + '): HTTP ' + r.code + ' — ' + r.text.substring(0, 150));
        if (consecutiveErrors === 0) firstErrorMsg = 'HTTP ' + r.code + ' — ' + r.text.substring(0, 150);
        consecutiveErrors++;
        // Bail fast if the very first calls all error identically — likely a
        // schema mismatch, not a per-tech issue. Saves chewing through 33+ calls.
        if (consecutiveErrors >= 5 && techsWithBlocks === 0 && allBlocks.length === 0) {
          Logger.log('  ❌ 5 consecutive errors with no successes. Bailing. First error: ' + firstErrorMsg);
          firstError = 'EARLY_BAIL';
          break;
        }
        continue;
      }
      consecutiveErrors = 0;
      var arr;
      try { arr = JSON.parse(r.text); } catch (e) { arr = []; }
      if (!Array.isArray(arr) || arr.length === 0) {
        Utilities.sleep(200);
        continue;
      }
      // Client-side window filter — response is unbounded on the back end
      // because we couldn't send endDate (PestPac bug). Keep only blocks that
      // overlap our window. Response uses PascalCase keys (TimeBlockID,
      // Technician, StartDate, EndDate, DayOfWeek, Duration, Reason,
      // Description, Color, Address) — confirmed via /TimeBlocks/1 probe.
      var kept = 0;
      for (var j = 0; j < arr.length; j++) {
        var bk = arr[j];
        var sd = bk.StartDate || bk.startDate;
        var ed = bk.EndDate   || bk.endDate;
        if (!sd || !ed) continue;
        var sdMs = new Date(sd).getTime();
        var edMs = new Date(ed).getTime();
        if (isNaN(sdMs) || isNaN(edMs)) continue;
        // Discard blocks entirely before our window or entirely after it
        if (edMs < todayMs)     continue;
        if (sdMs > endCutoffMs) continue;
        bk.techUsername   = t.Username;
        bk.techEmployeeID = t.EmployeeID;
        allBlocks.push(bk);
        kept++;
      }
      if (kept > 0) techsWithBlocks++;
      Utilities.sleep(200);
    }

    if (firstError === 'QUOTA_EXHAUSTED') {
      // Bail without writing — partial writes can mask reality on the dashboard
      Logger.log('  Aborted due to quota. Cache file NOT updated.');
      return;
    }
    if (firstError === 'EARLY_BAIL') {
      Logger.log('  Aborted due to consecutive API errors. Cache file NOT updated.');
      return;
    }

    Logger.log('  Collected ' + allBlocks.length + ' blocks across ' + techsWithBlocks + ' techs');

    var cache = {
      updated:      new Date().toISOString(),
      apiStartDate: startStr,            // Wide YTD query (server-side)
      windowStart:  fmt_(todayStart),    // Client-side window kept in cache
      windowEnd:    fmt_(windowEnd),
      recordCount:  allBlocks.length,
      techsCovered: techs.length,
      techsWithBlocks: techsWithBlocks,
      blocks: allBlocks
    };
    var jsonStr = JSON.stringify(cache);
    Logger.log('  cache-timeblocks.json: ' + jsonStr.length + ' chars (' + Math.round(jsonStr.length / 1024) + ' KB)');

    var ok = pushToGitHub_(jsonStr, GH_PATH_TIMEBLOCKS, 'Time blocks cache refresh ' + new Date().toISOString());
    var elapsed = ((new Date() - t0) / 1000).toFixed(1);
    Logger.log('✅ Time blocks refresh complete in ' + elapsed + 's | push: ' + (ok ? 'OK' : 'FAIL'));
  } catch (err) {
    Logger.log('❌ Time blocks refresh error: ' + err.message + '\n' + err.stack);
  }
}

// ──────────────────────────────────────────────────────────────
// DIAGNOSTIC — try 6 date-format × 2 tech-ID combinations to find what
// PestPac /TimeBlocks actually accepts. Each call is independent; no cache
// is written. 12 API calls total. Run once, read the log, then we lock in
// the working format in refreshTimeBlocksCache. Joe 2026-05-26.
// ──────────────────────────────────────────────────────────────
function probeTimeBlocksFormats() {
  Logger.log('🔬 PROBE /TimeBlocks date-format compatibility');
  var token = ppToken_();
  var techs = [
    { id: 1,   name: 'ADMN (system account)' },
    { id: 304, name: 'CXL — Cody Lahey (real tech, known block today)' }
  ];
  // All formats encode for today only — single-day window
  var formats = [
    { label: 'date-only',           start: '2026-05-26',                end: '2026-05-26' },
    { label: 'ISO no-Z no-ms',      start: '2026-05-26T00:00:00',       end: '2026-05-26T23:59:59' },
    { label: 'ISO with Z',          start: '2026-05-26T00:00:00Z',      end: '2026-05-26T23:59:59Z' },
    { label: 'ISO with ms+Z',       start: '2026-05-26T00:00:00.000Z',  end: '2026-05-26T23:59:59.999Z' },
    { label: 'US slash',            start: '05/26/2026',                end: '05/26/2026' },
    { label: 'ISO UTC offset (-04)',start: '2026-05-26T00:00:00-04:00', end: '2026-05-26T23:59:59-04:00' }
  ];
  techs.forEach(function(t) {
    Logger.log('── Tech ' + t.id + ' — ' + t.name + ' ──');
    formats.forEach(function(f) {
      var path = '/TimeBlocks?techId=' + t.id +
                 '&startDate=' + encodeURIComponent(f.start) +
                 '&endDate='   + encodeURIComponent(f.end);
      var r = ppGet_(token, path);
      var preview = r.text.substring(0, 200).replace(/\n/g, ' ');
      Logger.log('  [' + f.label + '] HTTP ' + r.code + ' — ' + preview);
      Utilities.sleep(300);
    });
  });
  Logger.log('🔬 PROBE complete');
}

// ──────────────────────────────────────────────────────────────
// DIAGNOSTIC v2 — narrow down the param shape, not the date format.
// First probe proved all 6 date formats fail identically. So the issue is
// upstream: wrong param name, wrong ID source, missing required param, OR
// the endpoint is fundamentally broken for our tenant.
// This probe tries: (a) different ID sources from cache-employees.json,
// (b) param-name casing, (c) omitting params one at a time, (d) path-style
// vs query-style. Logs each combo. Joe 2026-05-26.
// ──────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────
// DIAGNOSTIC v3 — Joe says 10-15 time blocks exist per day, but listing
// returns []. So either (a) listing filters something we can't see, or
// (b) recent blocks live at high TimeBlockIDs and we need to walk by ID.
// This probe: try wider startDate ranges + probe specific IDs at scale.
// Joe 2026-05-26.
// ──────────────────────────────────────────────────────────────
function probeTimeBlocksHistorical() {
  Logger.log('🔬 PROBE v3 — wider date ranges + ID walk');
  var token = ppToken_();
  var emp = readEmployeesCache_();
  var cxl = (emp.employees || []).filter(function(e) {
    return e && String(e.Username || '').toUpperCase() === 'CXL';
  })[0];
  if (!cxl) { Logger.log('  ❌ CXL not found'); return; }

  function attempt(label, path) {
    var r = ppGet_(token, path);
    var preview = r.text.substring(0, 300).replace(/\n/g, ' ');
    var len = r.text.length;
    Logger.log('  [' + label + '] HTTP ' + r.code + ' (' + len + ' chars) — ' + preview);
    Utilities.sleep(300);
  }

  // ── A. Wider startDate ranges (per-tech, CXL=764) ──
  Logger.log('── A. CXL with progressively earlier startDate (no endDate) ──');
  attempt('A1: startDate=2026-05-25 (yesterday)', '/TimeBlocks?techId=' + cxl.EmployeeID + '&startDate=2026-05-25');
  attempt('A2: startDate=2026-05-01',              '/TimeBlocks?techId=' + cxl.EmployeeID + '&startDate=2026-05-01');
  attempt('A3: startDate=2025-01-01',              '/TimeBlocks?techId=' + cxl.EmployeeID + '&startDate=2025-01-01');
  attempt('A4: startDate=2020-01-01',              '/TimeBlocks?techId=' + cxl.EmployeeID + '&startDate=2020-01-01');
  attempt('A5: startDate=2000-01-01',              '/TimeBlocks?techId=' + cxl.EmployeeID + '&startDate=2000-01-01');

  // ── B. Tech-less listing with same wider dates ──
  Logger.log('── B. No techId, wider startDate (does ANYTHING list?) ──');
  attempt('B1: startDate=2026-05-26', '/TimeBlocks?startDate=2026-05-26');
  attempt('B2: startDate=2020-01-01', '/TimeBlocks?startDate=2020-01-01');
  attempt('B3: startDate=1990-01-01', '/TimeBlocks?startDate=1990-01-01');

  // ── C. Walk TimeBlockID range to find recent records ──
  Logger.log('── C. ID walk — sample blocks at increasing IDs ──');
  var ids = [1, 1000, 5000, 10000, 25000, 50000, 100000, 150000, 200000, 250000, 300000];
  ids.forEach(function(id) { attempt('C: /TimeBlocks/' + id, '/TimeBlocks/' + id); });

  Logger.log('🔬 PROBE v3 complete — look for any non-empty list OR recent dated /{id} record');
}

function probeTimeBlocksParams() {
  Logger.log('🔬 PROBE v2 — /TimeBlocks param shape');
  var token = ppToken_();
  // Pull Cody's full employee record so we can compare EmployeeID vs TechID vs UserID
  var emp = readEmployeesCache_();
  var cxl = (emp.employees || []).filter(function(e) {
    return e && String(e.Username || '').toUpperCase() === 'CXL';
  })[0];
  if (!cxl) {
    Logger.log('  ❌ CXL not found in cache-employees.json — refresh employees first?');
    return;
  }
  Logger.log('CXL record: EmployeeID=' + cxl.EmployeeID + ', UserID=' + cxl.UserID +
             ', TechID=' + cxl.TechID + ', EmployeeNumber=' + cxl.EmployeeNumber +
             ', Username=' + cxl.Username);

  var s = '2026-05-26';
  var e = '2026-05-26';

  function attempt(label, path) {
    var r = ppGet_(token, path);
    var preview = r.text.substring(0, 200).replace(/\n/g, ' ');
    Logger.log('  [' + label + '] HTTP ' + r.code + ' — ' + path + ' → ' + preview);
    Utilities.sleep(300);
  }

  // ── A. Different ID sources for techId ──
  Logger.log('── A. ID source variations (param=techId, dates=date-only) ──');
  attempt('A1: EmployeeID=' + cxl.EmployeeID, '/TimeBlocks?techId=' + cxl.EmployeeID + '&startDate=' + s + '&endDate=' + e);
  if (cxl.UserID)     attempt('A2: UserID=' + cxl.UserID,       '/TimeBlocks?techId=' + cxl.UserID + '&startDate=' + s + '&endDate=' + e);
  if (cxl.TechID)     attempt('A3: TechID=' + cxl.TechID,       '/TimeBlocks?techId=' + cxl.TechID + '&startDate=' + s + '&endDate=' + e);
  attempt('A4: Username=CXL (string)', '/TimeBlocks?techId=CXL&startDate=' + s + '&endDate=' + e);

  // ── B. Param-name casing variations (using EmployeeID) ──
  Logger.log('── B. Param-name casing (EmployeeID=' + cxl.EmployeeID + ', date-only) ──');
  attempt('B1: TechId',       '/TimeBlocks?TechId='       + cxl.EmployeeID + '&StartDate=' + s + '&EndDate=' + e);
  attempt('B2: TechID',       '/TimeBlocks?TechID='       + cxl.EmployeeID + '&StartDate=' + s + '&EndDate=' + e);
  attempt('B3: technicianId', '/TimeBlocks?technicianId=' + cxl.EmployeeID + '&startDate=' + s + '&endDate=' + e);
  attempt('B4: technicianID', '/TimeBlocks?technicianID=' + cxl.EmployeeID + '&startDate=' + s + '&endDate=' + e);

  // ── C. Omit params one at a time ──
  Logger.log('── C. Omit-one-at-a-time (EmployeeID=' + cxl.EmployeeID + ') ──');
  attempt('C1: only techId',    '/TimeBlocks?techId=' + cxl.EmployeeID);
  attempt('C2: no techId',      '/TimeBlocks?startDate=' + s + '&endDate=' + e);
  attempt('C3: only startDate', '/TimeBlocks?techId=' + cxl.EmployeeID + '&startDate=' + s);
  attempt('C4: only endDate',   '/TimeBlocks?techId=' + cxl.EmployeeID + '&endDate=' + e);
  attempt('C5: no params',      '/TimeBlocks');

  // ── D. Path variant (some PestPac endpoints accept /Resource/{id} ──
  Logger.log('── D. Path/alt variants ──');
  attempt('D1: /TimeBlocks/1',                  '/TimeBlocks/1');
  attempt('D2: /TimeBlocks/reservations/CXL',   '/TimeBlocks/reservations/CXL');
  attempt('D3: /TimeBlocks/reservations/' + cxl.UserID, '/TimeBlocks/reservations/' + cxl.UserID);

  Logger.log('🔬 PROBE v2 complete — read log to find HTTP 200 line(s)');
}

function readTimeBlocksCache_() {
  try {
    var resp = UrlFetchApp.fetch(
      'https://catseye-internal.github.io/Production-Dashboard/cache-timeblocks.json',
      { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } }
    );
    if (resp.getResponseCode() !== 200) return { blocks: [] };
    return JSON.parse(resp.getContentText());
  } catch (e) {
    return { blocks: [] };
  }
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
