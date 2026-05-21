/**
 * Production Dashboard — Diagnostics
 *
 * Read-only test suite for investigating PestPac API response shape.
 * These functions share globals (ppToken_, ppGet_, fmt_, PP_API_BASE,
 * PP_API_KEY, PP_TENANT_ID, ORDER_TYPES_INCLUDED) with Code.gs — they
 * MUST live in the same Apps Script project as Code.gs.
 *
 * Safe to delete this entire file at any time. Removing it has no
 * effect on refreshProductionCache, triggers, or webhooks.
 */

// TEST 1 — Does window size change field richness?
// Hypothesis: smaller windows may return full records, larger windows truncate.
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

  var extras = fullKeys.filter(function(k) { return slimKeys.indexOf(k) === -1; });
  Logger.log('  EXTRAS only in /id: ' + extras.join(', '));
}

// TEST 5 — Fetch the LIVE cache.json from GitHub and log what's actually there.
// Definitive test for "did the new cache get the full fields?"
function test5_liveCacheContents() {
  Logger.log('🧪 TEST 5 — Live cache.json contents');
  var url = 'https://catseye-internal.github.io/Production-Dashboard/cache.json';
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('  HTTP ' + resp.getResponseCode());
  if (resp.getResponseCode() !== 200) {
    Logger.log('  Body: ' + resp.getContentText().substring(0, 400));
    return;
  }
  var d = JSON.parse(resp.getContentText());
  Logger.log('  Updated: ' + d.updated);
  Logger.log('  Window: ' + d.windowStart + ' → ' + d.windowEnd);
  var orders = d.orders || [];
  Logger.log('  Total orders: ' + orders.length);
  // Sample first 3 records
  for (var i = 0; i < Math.min(3, orders.length); i++) {
    var o = orders[i];
    var keys = Object.keys(o).sort();
    Logger.log('  Order ' + i + ': ' + keys.length + ' fields | OrderID=' + o.OrderID + ' OrderType=' + o.OrderType + ' Tech1=' + o.Tech1 + ' Locked=' + o.Locked);
    Logger.log('    Keys: ' + keys.join(', '));
  }
  // Coverage stats
  var fields = ['OrderType','Tech1','Description','Duration','Locked','InProgress','Posted'];
  Logger.log('  Field coverage across all ' + orders.length + ' orders:');
  fields.forEach(function(fld) {
    var present = 0;
    for (var j = 0; j < orders.length; j++) if (fld in orders[j]) present++;
    var pct = orders.length ? Math.round(100 * present / orders.length) : 0;
    Logger.log('    ' + fld + ': ' + present + ' (' + pct + '%)');
  });
}

// TEST 6 — Raw API call with the SAME parameters chunked14_ uses, log the raw response shape.
// If this returns 45 fields but cache has 10, the curate_ step is broken.
// If this returns 10 fields, PestPac is returning slim even at 14 days.
function test6_rawFetchShape() {
  Logger.log('🧪 TEST 6 — Raw fetchServiceOrdersRaw_ output shape');
  var token = ppToken_();
  // Replicate the first chunk refreshProductionCache uses
  var now = new Date();
  var start = new Date(now); start.setDate(start.getDate() - 7);
  var end = new Date(start); end.setDate(end.getDate() + 13);
  var s = fmt_(start);
  var e = fmt_(end);
  Logger.log('  Calling: /ServiceOrders?orderType=ServiceOrder&startWorkDate=' + s + '&endWorkDate=' + e);
  var orders = fetchServiceOrdersRaw_(token, s, e);
  Logger.log('  Returned: ' + orders.length + ' orders');
  if (orders.length > 0) {
    var keys = Object.keys(orders[0]).sort();
    Logger.log('  First order: ' + keys.length + ' fields');
    Logger.log('    Keys: ' + keys.join(', '));
    Logger.log('    Tech1=' + orders[0].Tech1 + ' Description=' + orders[0].Description + ' Duration=' + orders[0].Duration + ' Locked=' + orders[0].Locked);
  }
}

// TEST 9 — Inspect /Locations/{id} response to plan the locations cache.
// Picks 3 LocationIDs from cache.json and dumps the full response shape.
function test9_locationsShape() {
  Logger.log('🧪 TEST 9 — /Locations/{id} shape');
  var token = ppToken_();
  // Grab a few LocationIDs from the live cache
  var resp = UrlFetchApp.fetch('https://catseye-internal.github.io/Production-Dashboard/cache.json', { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) { Logger.log('  cache.json fetch failed'); return; }
  var d = JSON.parse(resp.getContentText());
  var seen = {};
  var samples = [];
  for (var i = 0; i < (d.orders || []).length && samples.length < 3; i++) {
    var lid = d.orders[i].LocationID;
    if (lid && !seen[lid]) { seen[lid] = true; samples.push(lid); }
  }
  Logger.log('  Testing LocationIDs: ' + samples.join(', '));
  samples.forEach(function(lid) {
    var r = ppGet_(token, '/Locations/' + lid);
    Logger.log('\n  /Locations/' + lid + ' → HTTP ' + r.code);
    if (r.code !== 200) { Logger.log('  Body: ' + r.text.substring(0, 300)); return; }
    var loc = JSON.parse(r.text);
    var keys = Object.keys(loc).sort();
    Logger.log('    Keys (' + keys.length + '): ' + keys.join(', '));
    Logger.log('    JSON: ' + JSON.stringify(loc).substring(0, 1200));
    Utilities.sleep(200);
  });
}

// TEST 8 — Inspect the Technicians array shape from /ServiceOrders/{id}.
// Needed to write Tech2 extraction logic correctly.
function test8_techniciansShape() {
  Logger.log('🧪 TEST 8 — /ServiceOrders/{id} Technicians shape');
  var token = ppToken_();
  var now = new Date();
  var s = new Date(now); s.setDate(s.getDate() - 1);
  var e = new Date(s);   e.setDate(e.getDate() + 13);
  var orders = fetchServiceOrdersRaw_(token, fmt_(s), fmt_(e));
  Logger.log('  Searching ' + orders.length + ' orders for one with multiple techs...');
  var found = 0;
  for (var i = 0; i < orders.length && found < 5; i++) {
    var detail = ppGet_(token, '/ServiceOrders/' + orders[i].OrderID);
    if (detail.code !== 200) continue;
    var d = JSON.parse(detail.text);
    var techs = d.Technicians;
    if (!techs || !techs.length) continue;
    Logger.log('  OrderID ' + d.OrderID + ' — Technicians (' + techs.length + '): ' + JSON.stringify(techs));
    found++;
    if (techs.length > 1) {
      Logger.log('    ☝️ MULTI-TECH ORDER (good sample)');
    }
    Utilities.sleep(200);
  }
  if (found === 0) Logger.log('  No orders with Technicians populated in this window');
}

// TEST 7 — Trace fetch → curate → output path step-by-step.
// Catches any discrepancy between what fetchServiceOrdersRaw_ returns and what
// curate_ keeps. Also logs CURATED_FIELDS_ORDER so we can verify the constant
// in Apps Script matches the local file.
function test7_curatePath() {
  Logger.log('🧪 TEST 7 — Trace fetch → curate → output');
  Logger.log('  CURATED_FIELDS_ORDER (' + CURATED_FIELDS_ORDER.length + ' fields): ' + CURATED_FIELDS_ORDER.join(', '));
  var token = ppToken_();
  var now = new Date();
  var start = new Date(now); start.setDate(start.getDate() - 7);
  var end = new Date(start); end.setDate(end.getDate() + 13);
  var orders = fetchServiceOrdersRaw_(token, fmt_(start), fmt_(end));
  if (orders.length === 0) { Logger.log('  No orders'); return; }
  var first = orders[0];
  var firstKeys = Object.keys(first).sort();
  Logger.log('  RAW first order: ' + firstKeys.length + ' fields');
  Logger.log('    Keys: ' + firstKeys.join(', '));
  Logger.log('    Tech1=' + first.Tech1 + ' Description=' + first.Description + ' Duration=' + first.Duration + ' Locked=' + first.Locked + ' OrderType=' + first.OrderType);

  var curated = curate_(first, CURATED_FIELDS_ORDER);
  var curatedKeys = Object.keys(curated).sort();
  Logger.log('  CURATED first order: ' + curatedKeys.length + ' fields');
  Logger.log('    Keys: ' + curatedKeys.join(', '));
  Logger.log('    Tech1=' + curated.Tech1 + ' Description=' + curated.Description + ' Duration=' + curated.Duration + ' Locked=' + curated.Locked + ' OrderType=' + curated.OrderType);

  // Stringify roundtrip — match what gets written to cache.json
  var roundtrip = JSON.parse(JSON.stringify(curated));
  var rtKeys = Object.keys(roundtrip).sort();
  Logger.log('  ROUNDTRIP after JSON.stringify→parse: ' + rtKeys.length + ' fields');
  Logger.log('    Keys: ' + rtKeys.join(', '));
}

// TEST 4 — Try $expand / Accept-header variations
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
      var resp = UrlFetchApp.fetch(PP_API_BASE + v.path, opts);
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
