/**
 * PestPac API Discovery — Production Dashboard Phase 1
 *
 * PURPOSE
 *   Pull a small sample of real records from each PestPac endpoint the Production
 *   Dashboard will need, log the FULL JSON of one record + the union of all field
 *   names, and (optionally) push a sample file to GitHub so the dashboard build
 *   session can read the exact field shape without re-running this.
 *
 * USAGE
 *   1. Open the existing BDC Cache Refresh Apps Script project
 *      (https://script.google.com/u/2/home/projects/1Cn0r0fi8uDiJYubWaopGO7qjUzcSVHle6Nv2G3qAkHMhDmN4oteyzwrQ/edit).
 *      All credentials (PP_USERNAME, PP_PASSWORD, GITHUB_TOKEN) are already there.
 *   2. File → New → Script — name it "Discovery". Paste this whole file.
 *   3. Run `discoverPestPac` (authorize if prompted on first run).
 *   4. View → Executions → open the latest run → copy the full log.
 *      Paste it back to Claude. (Or set WRITE_TO_GITHUB = true and Claude will
 *      pull it from the repo directly.)
 *
 * SAFETY
 *   Pulls only 3 days of data per endpoint to stay well under the shared
 *   PestPac/Sales Center rate limit. Read-only — no writes to PestPac.
 *   Will NOT touch BDC cache.json — it only logs and (optionally) writes a
 *   separate discovery file.
 */

// ── PestPac credentials (mirrors CacheRefresh.gs) ──
const PP_CLIENT_ID     = 'OjCMV6522ip62LlhU08LrG5U61oa';
const PP_CLIENT_SECRET = 'MicEfYLkplnarU18fHLH3VCfxhMa';
const PP_USERNAME      = 'jdingwall@catseyepest.com';
const PP_PASSWORD      = 'C@ts3y3!!';
const PP_API_KEY       = 'IJ4Goon7ZW9EbvAvPdO33Q6Vtnt5oysT';
const PP_TENANT_ID     = '103012';
const PP_TOKEN_URL     = 'https://is.workwave.com/oauth2/token?scope=openid';
const PP_API_BASE      = 'https://api.workwave.com/pestpac/v1';

// ── Discovery config ──
const DISC_DAYS_BACK   = 3;        // small window — keep API load minimal
const DISC_MAX_PRINT   = 2;        // # of full records to dump per endpoint
const WRITE_TO_GITHUB  = false;    // flip to true to also push pp-discovery.json
const GH_OWNER         = 'catseye-internal';
const GH_REPO          = 'BDC-Dashboard';   // pushes to BDC repo so the existing PAT works
const GH_PATH          = 'pp-discovery.json';
const GH_BRANCH        = 'main';

// ────────────────────────────────────────────────────────────────
// Auth
// ────────────────────────────────────────────────────────────────
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
    throw new Error('PestPac token failed: HTTP ' + resp.getResponseCode() +
                    ' — ' + resp.getContentText().substring(0, 200));
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

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────
function pad_(n) { return String(n).padStart(2, '0'); }
function fmt_(d) { return d.getFullYear() + '-' + pad_(d.getMonth() + 1) + '-' + pad_(d.getDate()); }

function summarizeFields_(arr) {
  // Returns map of fieldName → { type, examples: [up to 2 non-null values] }
  const out = {};
  arr.forEach(function(rec) {
    if (!rec || typeof rec !== 'object') return;
    Object.keys(rec).forEach(function(k) {
      const v = rec[k];
      const type = v === null ? 'null'
                 : Array.isArray(v) ? 'array'
                 : typeof v;
      if (!out[k]) out[k] = { types: {}, examples: [] };
      out[k].types[type] = (out[k].types[type] || 0) + 1;
      if (v !== null && v !== undefined && v !== '' && out[k].examples.length < 2) {
        const s = typeof v === 'object' ? JSON.stringify(v).substring(0, 120) : String(v).substring(0, 120);
        if (out[k].examples.indexOf(s) === -1) out[k].examples.push(s);
      }
    });
  });
  return out;
}

// Size projection helper — gives us a real cache.json size estimate at YTD scale.
function sizeProjection_(sampleArr, ytdEstimate) {
  if (!sampleArr || sampleArr.length === 0) return null;
  var totalBytes = 0;
  for (var i = 0; i < sampleArr.length; i++) {
    totalBytes += JSON.stringify(sampleArr[i]).length;
  }
  var avg = Math.round(totalBytes / sampleArr.length);
  // PestPac records are usually 30-40% non-null — assume curated subset = 35% of raw
  var curatedAvg = Math.round(avg * 0.35);
  return {
    avgBytesPerRecord: avg,
    curatedAvgBytesPerRecord: curatedAvg,
    projectedRawMB_low:   Math.round((avg * ytdEstimate.low) / 1024 / 1024 * 10) / 10,
    projectedRawMB_high:  Math.round((avg * ytdEstimate.high) / 1024 / 1024 * 10) / 10,
    projectedCuratedMB_low:  Math.round((curatedAvg * ytdEstimate.low) / 1024 / 1024 * 10) / 10,
    projectedCuratedMB_high: Math.round((curatedAvg * ytdEstimate.high) / 1024 / 1024 * 10) / 10,
    ytdRange: ytdEstimate
  };
}

function dumpSection_(title, sampleArr, fullRecCount, ytdEstimate) {
  Logger.log('\n══════════════════════════════════════════════════════════════');
  Logger.log(title + ' — count=' + (sampleArr ? sampleArr.length : 0));
  Logger.log('══════════════════════════════════════════════════════════════');
  if (!sampleArr || sampleArr.length === 0) {
    Logger.log('  (no records)');
    return null;
  }
  const fields = summarizeFields_(sampleArr);
  const fNames = Object.keys(fields).sort();
  Logger.log('FIELDS (' + fNames.length + '):');
  fNames.forEach(function(k) {
    const f = fields[k];
    const typeStr = Object.keys(f.types).join('|');
    const exStr = f.examples.length ? ' — eg ' + f.examples.join(' | ') : '';
    Logger.log('  ' + k + ' [' + typeStr + ']' + exStr);
  });

  // Size projection — what does this look like at YTD volume?
  var size = ytdEstimate ? sizeProjection_(sampleArr, ytdEstimate) : null;
  if (size) {
    Logger.log('\nSIZE PROJECTION (YTD volume ' + ytdEstimate.low + '–' + ytdEstimate.high + ' records):');
    Logger.log('  avg bytes/record (raw):     ' + size.avgBytesPerRecord);
    Logger.log('  avg bytes/record (curated): ' + size.curatedAvgBytesPerRecord + '  (~35% of raw)');
    Logger.log('  → cache-raw.json projection:  ' + size.projectedRawMB_low + '–' + size.projectedRawMB_high + ' MB');
    Logger.log('  → cache.json projection:      ' + size.projectedCuratedMB_low + '–' + size.projectedCuratedMB_high + ' MB');
  }

  Logger.log('\nFULL RECORDS (' + Math.min(fullRecCount, sampleArr.length) + '):');
  for (var i = 0; i < Math.min(fullRecCount, sampleArr.length); i++) {
    Logger.log('--- record ' + (i+1) + ' ---');
    Logger.log(JSON.stringify(sampleArr[i], null, 2));
  }
  return {
    count: sampleArr.length, fields: fNames,
    sampleRecords: sampleArr.slice(0, fullRecCount),
    size: size
  };
}

// ────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────
function discoverPestPac() {
  const t0 = new Date();
  Logger.log('🔍 PestPac discovery — ' + t0.toISOString());

  const end = new Date();
  const start = new Date(); start.setDate(start.getDate() - DISC_DAYS_BACK);
  const startStr = fmt_(start), endStr = fmt_(end);
  Logger.log('Window: ' + startStr + ' → ' + endStr + ' (' + DISC_DAYS_BACK + ' days)');

  const token = ppToken_();
  Logger.log('✓ OAuth token acquired');

  const summary = { window: { start: startStr, end: endStr }, sections: {} };

  // 1) ServiceOrders — no orderType filter. We want to see EVERY value of orderType in the wild.
  Logger.log('\n→ GET /ServiceOrders (no orderType filter)');
  var r = ppGet_(token, '/ServiceOrders?startWorkDate=' + startStr + '&endWorkDate=' + endStr);
  Logger.log('  HTTP ' + r.code);
  if (r.code === 200) {
    var allOrders = JSON.parse(r.text);
    // Distinct orderType values
    var typeCount = {};
    allOrders.forEach(function(o) {
      var t = o.OrderType || o.orderType || '(missing)';
      typeCount[t] = (typeCount[t] || 0) + 1;
    });
    Logger.log('orderType distribution: ' + JSON.stringify(typeCount));
    // YTD estimate for ServiceOrders: brief estimates 6,000–15,000 records (mid-year)
    summary.sections.serviceOrders_all = dumpSection_('ServiceOrders — ALL types',
      allOrders.slice(0, 10), DISC_MAX_PRINT, { low: 6000, high: 15000 });
    summary.orderTypeCounts = typeCount;

    // 2) ServiceOrders — by each non-Estimate type, in case the API tolerates a specific filter
    Object.keys(typeCount).forEach(function(tp) {
      if (tp && tp !== 'Estimate' && tp !== '(missing)') {
        var rr = ppGet_(token, '/ServiceOrders?orderType=' + encodeURIComponent(tp) +
                              '&startWorkDate=' + startStr + '&endWorkDate=' + endStr);
        if (rr.code === 200) {
          var sub = JSON.parse(rr.text);
          summary.sections['serviceOrders_' + tp] = dumpSection_('ServiceOrders — type=' + tp,
            sub.slice(0, 5), 1, null);
        } else {
          Logger.log('  ServiceOrders type=' + tp + ' → HTTP ' + rr.code + ': ' + rr.text.substring(0, 200));
        }
      }
    });
  } else {
    Logger.log('  body: ' + r.text.substring(0, 400));
  }

  // 3) Invoices — try GET /Invoices with same window. Also try a couple alternative param names.
  Logger.log('\n→ GET /Invoices');
  var invTries = [
    '/Invoices?startDate=' + startStr + '&endDate=' + endStr,
    '/Invoices?startInvoiceDate=' + startStr + '&endInvoiceDate=' + endStr,
    '/Invoices?fromDate=' + startStr + '&toDate=' + endStr,
    '/Invoices'  // unfiltered, as a last resort — may return 400 if required params
  ];
  for (var i = 0; i < invTries.length; i++) {
    var ir = ppGet_(token, invTries[i]);
    Logger.log('  ' + invTries[i] + ' → HTTP ' + ir.code);
    if (ir.code === 200) {
      var inv = JSON.parse(ir.text);
      // Brief notes invoices are roughly 1:1 with service orders (incl. partials), so same YTD range
      summary.sections.invoices = dumpSection_('Invoices (' + invTries[i] + ')',
        inv.slice(0, 10), DISC_MAX_PRINT, { low: 6000, high: 18000 });
      summary.invoicesQueryUsed = invTries[i];
      break;
    } else if (ir.code !== 400) {
      Logger.log('    body: ' + ir.text.substring(0, 300));
    }
  }

  // 4) Locations/{id} — pick an ID from the first ServiceOrders sample
  Logger.log('\n→ GET /Locations/{id} (sample lookup)');
  try {
    var firstOrders = (summary.sections.serviceOrders_all && summary.sections.serviceOrders_all.sampleRecords) || [];
    if (firstOrders.length > 0) {
      var locId = firstOrders[0].LocationID || firstOrders[0].locationId;
      if (locId) {
        var lr = ppGet_(token, '/Locations/' + locId);
        Logger.log('  /Locations/' + locId + ' → HTTP ' + lr.code);
        if (lr.code === 200) {
          var loc = JSON.parse(lr.text);
          summary.sections.location_sample = dumpSection_('Locations/{id} — single', [loc], 1, null);
        } else {
          Logger.log('    body: ' + lr.text.substring(0, 300));
        }
      }
    }
  } catch (e) {
    Logger.log('  location lookup error: ' + e.message);
  }

  // 5) Routes — check if endpoint exists
  Logger.log('\n→ GET /Routes (probe)');
  var rt = ppGet_(token, '/Routes?startDate=' + startStr + '&endDate=' + endStr);
  Logger.log('  HTTP ' + rt.code);
  if (rt.code === 200) {
    try {
      var routes = JSON.parse(rt.text);
      summary.sections.routes = dumpSection_('Routes', Array.isArray(routes) ? routes.slice(0, 5) : [routes], 1, null);
    } catch(e) { Logger.log('  body (raw): ' + rt.text.substring(0, 400)); }
  } else {
    Logger.log('  body: ' + rt.text.substring(0, 300));
  }

  // 6) Customers — probe
  Logger.log('\n→ GET /Customers (probe)');
  var cu = ppGet_(token, '/Customers?pageSize=5');
  Logger.log('  HTTP ' + cu.code);
  if (cu.code === 200) {
    try {
      var custs = JSON.parse(cu.text);
      var arr = Array.isArray(custs) ? custs : (custs.items || custs.results || [custs]);
      summary.sections.customers = dumpSection_('Customers', arr.slice(0, 3), 1, null);
    } catch(e) { Logger.log('  body (raw): ' + cu.text.substring(0, 400)); }
  } else {
    Logger.log('  body: ' + cu.text.substring(0, 300));
  }

  // ── Roll-up sizing summary ──
  Logger.log('\n══════════════════════════════════════════════════════════════');
  Logger.log('SIZING SUMMARY — guide for curated vs raw cache decisions');
  Logger.log('══════════════════════════════════════════════════════════════');
  var so = summary.sections.serviceOrders_all && summary.sections.serviceOrders_all.size;
  var inv = summary.sections.invoices && summary.sections.invoices.size;
  if (so) {
    Logger.log('ServiceOrders @ YTD:');
    Logger.log('  raw:     ' + so.projectedRawMB_low + '–' + so.projectedRawMB_high + ' MB');
    Logger.log('  curated: ' + so.projectedCuratedMB_low + '–' + so.projectedCuratedMB_high + ' MB');
  }
  if (inv) {
    Logger.log('Invoices @ YTD:');
    Logger.log('  raw:     ' + inv.projectedRawMB_low + '–' + inv.projectedRawMB_high + ' MB');
    Logger.log('  curated: ' + inv.projectedCuratedMB_low + '–' + inv.projectedCuratedMB_high + ' MB');
  }
  if (so && inv) {
    var combinedRawHi = so.projectedRawMB_high + inv.projectedRawMB_high;
    var combinedCurHi = so.projectedCuratedMB_high + inv.projectedCuratedMB_high;
    Logger.log('Combined cache size (high estimate):');
    Logger.log('  cache-raw.json:  ~' + Math.round(combinedRawHi * 10) / 10 + ' MB  → nightly refresh');
    Logger.log('  cache.json:      ~' + Math.round(combinedCurHi * 10) / 10 + ' MB  → 10-min refresh');
    Logger.log('  Rule of thumb: keep 10-min cache.json under 5 MB. If curated is heavy, slim further or split per domain.');
  }

  var elapsed = ((new Date() - t0) / 1000).toFixed(1);
  Logger.log('\n✅ Discovery complete in ' + elapsed + 's');

  if (WRITE_TO_GITHUB) {
    Logger.log('\n→ Pushing pp-discovery.json to GitHub (' + GH_OWNER + '/' + GH_REPO + ')');
    pushToGitHub_(JSON.stringify(summary, null, 2));
  } else {
    Logger.log('\nℹ️  WRITE_TO_GITHUB is false — paste the log above back to Claude.');
  }
}

// ────────────────────────────────────────────────────────────────
// Optional: push discovery JSON to GitHub via Git Data API
// (reuses existing GITHUB_TOKEN from Script Properties)
// ────────────────────────────────────────────────────────────────
function pushToGitHub_(jsonStr) {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) { Logger.log('  ⚠️ GITHUB_TOKEN not set — skip'); return; }
  var apiBase = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO;
  var headers = { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json' };

  var blob = UrlFetchApp.fetch(apiBase + '/git/blobs', {
    method: 'post', headers: headers, contentType: 'application/json',
    payload: JSON.stringify({ content: Utilities.base64Encode(jsonStr, Utilities.Charset.UTF_8), encoding: 'base64' }),
    muteHttpExceptions: true
  });
  if (blob.getResponseCode() !== 201) { Logger.log('  blob fail: ' + blob.getContentText().substring(0, 200)); return; }
  var blobSha = JSON.parse(blob.getContentText()).sha;

  var ref = UrlFetchApp.fetch(apiBase + '/git/ref/heads/' + GH_BRANCH, { headers: headers, muteHttpExceptions: true });
  var refSha = JSON.parse(ref.getContentText()).object.sha;
  var commit = UrlFetchApp.fetch(apiBase + '/git/commits/' + refSha, { headers: headers, muteHttpExceptions: true });
  var treeSha = JSON.parse(commit.getContentText()).tree.sha;

  var newTree = UrlFetchApp.fetch(apiBase + '/git/trees', {
    method: 'post', headers: headers, contentType: 'application/json',
    payload: JSON.stringify({ base_tree: treeSha, tree: [{ path: GH_PATH, mode: '100644', type: 'blob', sha: blobSha }] }),
    muteHttpExceptions: true
  });
  var newTreeSha = JSON.parse(newTree.getContentText()).sha;

  var newCommit = UrlFetchApp.fetch(apiBase + '/git/commits', {
    method: 'post', headers: headers, contentType: 'application/json',
    payload: JSON.stringify({ message: 'PestPac discovery sample', tree: newTreeSha, parents: [refSha] }),
    muteHttpExceptions: true
  });
  var newCommitSha = JSON.parse(newCommit.getContentText()).sha;

  var upd = UrlFetchApp.fetch(apiBase + '/git/refs/heads/' + GH_BRANCH, {
    method: 'patch', headers: headers, contentType: 'application/json',
    payload: JSON.stringify({ sha: newCommitSha }),
    muteHttpExceptions: true
  });
  Logger.log('  pushed: HTTP ' + upd.getResponseCode() + ' commit=' + newCommitSha.substring(0, 7));
}
