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
const GH_PATH_CURATED = 'cache.json';
const GH_PATH_RAW     = 'cache-raw.json';

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
const ENRICH_WINDOW_DAYS = 14;
const ENRICH_MAX_RECORDS = 3000;   // safety cap — large enough to cover all 14-day candidates
const ENRICH_BATCH_SIZE  = 30;     // PARALLEL calls per batch via UrlFetchApp.fetchAll
const ENRICH_BATCH_PAUSE_MS = 200; // small pause between batches (rate-limit friendly)
// Invoices: still pending /Invoices endpoint discovery — placeholders only.
const CURATED_FIELDS_INVOICE = [
  'InvoiceNumber', 'InvoiceDate', 'Branch',
  'CustomerID', 'LocationID', 'OrderID',
  'Total', 'Subtotal', 'TaxTotal', 'BalanceDue',
  'Status',
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
// ──────────────────────────────────────────────────────────────
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
  // Cap to keep refresh under the Apps Script execution limit
  if (candidates.length > ENRICH_MAX_RECORDS) {
    Logger.log('  Enrichment capped: ' + candidates.length + ' candidates → ' + ENRICH_MAX_RECORDS);
    candidates = candidates.slice(0, ENRICH_MAX_RECORDS);
  }
  Logger.log('  Enriching ' + candidates.length + ' near-term orders (next ' + ENRICH_WINDOW_DAYS + ' days) via parallel fetchAll batches of ' + ENRICH_BATCH_SIZE + '...');
  var enrichedCount = 0;
  var failedCount = 0;
  var tech2Count = 0;
  var t0 = Date.now();
  var commonHeaders = {
    'Authorization': 'Bearer ' + token,
    'apikey': PP_API_KEY,
    'tenant-id': PP_TENANT_ID
  };
  for (var i = 0; i < candidates.length; i += ENRICH_BATCH_SIZE) {
    var slice = candidates.slice(i, i + ENRICH_BATCH_SIZE);
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
    if (i + ENRICH_BATCH_SIZE < candidates.length) Utilities.sleep(ENRICH_BATCH_PAUSE_MS);
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
