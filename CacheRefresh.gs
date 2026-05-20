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

// ── Order type filter ──
const ORDER_TYPES_EXCLUDED = ['Estimate'];

// ── Curated field whitelists ──
// Confirmed against live API (PestPacDiscovery.gs run on 2026-05-20).
// Anything NOT in these arrays gets stripped from cache.json (kept in cache-raw.json).
const CURATED_FIELDS_ORDER = [
  // Identity & links
  'OrderID', 'OrderNumber', 'ParentOrderID', 'LeadID', 'SetupID',
  // Classification
  'OrderType', 'Origin',
  // Location / branch
  'Branch', 'BranchID', 'LocationID', 'BillToID', 'Route',
  // Work scheduling
  'WorkDate', 'Duration', 'EarliestTime', 'LatestTime', 'TimeRange',
  // Service detail
  'ServiceCode', 'Description',
  // Money
  'SubTotal', 'Tax', 'Total',
  // Status & technician
  'Tech1', 'TechID1', 'InProgress', 'Locked', 'Posted',
  // Notes — truncated in slimOrder_ below to avoid blowing up the cache
  'TechnicianComment'
];
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
  var r = ppGet_(token, '/ServiceOrders?startWorkDate=' + startDate + '&endWorkDate=' + endDate);
  if (r.code !== 200) {
    Logger.log('  ServiceOrders ' + startDate + '→' + endDate + ' HTTP ' + r.code + ': ' + r.text.substring(0, 200));
    return [];
  }
  var orders = JSON.parse(r.text);
  return orders.filter(function(o) {
    var t = o.OrderType || o.orderType;
    return ORDER_TYPES_EXCLUDED.indexOf(t) === -1;
  });
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

function chunked31_(startDate, endDate, fn) {
  var out = [];
  var s = new Date(startDate);
  var e = new Date(endDate);
  var cursor = new Date(s);
  while (cursor <= e) {
    var chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + 30);
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
    var ytdStart = now.getFullYear() + '-01-01';
    var todayStr = fmt_(now);

    Logger.log('  Window: ' + ytdStart + ' → ' + todayStr);

    Logger.log('  Fetching ServiceOrders (non-estimate)...');
    var rawOrders = chunked31_(ytdStart, todayStr, function(s, e) {
      return fetchServiceOrdersRaw_(token, s, e);
    });
    Logger.log('  → ' + rawOrders.length + ' orders');

    // Invoices intentionally skipped — PestPac /Invoices is keyed-lookup only.
    // Billing signal comes from ServiceOrders (Posted, SubTotal, Tax, Total).

    // ── Build curated payload (every refresh) ──
    var curatedOrders = rawOrders.map(function(o) { return curate_(o, CURATED_FIELDS_ORDER); });

    var curatedCache = {
      updated: new Date().toISOString(),
      ytdStart: ytdStart,
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
        ytdStart: ytdStart,
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
