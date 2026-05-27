/**
 * Device-Scan Endpoint Probe
 *
 * Catseye techs barcode-scan IPM devices (rodent stations, traps) on the
 * mobile app. Goal: find which PestPac endpoint exposes the per-device
 * scan log so we can build a "Device Scanned %" tech leaderboard.
 *
 * USAGE
 *   1. Paste this file into the Production Dashboard Pipeline Apps Script project
 *   2. (Optional) Edit PROBE_INVOICE_NUMBER + PROBE_LOCATION_ID below to
 *      a commercial visit you know was scanned — the defaults pick the
 *      most recent IN invoice from cache-invoices.json with InvoiceType=IN
 *      on a commercial service class.
 *   3. In the function dropdown pick `probeDeviceScan`, click Run
 *   4. Copy the execution log back to Claude
 */

// Paste in a recent commercial invoice that was scanned (or leave 0 to auto-pick).
const PROBE_INVOICE_NUMBER = 0;   // e.g. 1340315
const PROBE_LOCATION_ID    = 0;   // e.g. 127034 (a commercial location ID)

function probeDeviceScan() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🔍 Device-Scan Endpoint Probe — ' + new Date().toISOString());
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ── 1. Pick a target invoice + location ──
  var invoiceNum = PROBE_INVOICE_NUMBER;
  var locationId = PROBE_LOCATION_ID;

  if (!invoiceNum || !locationId) {
    Logger.log('1. Auto-picking a recent commercial IN invoice from cache-invoices.json...');
    var cacheUrl = 'https://raw.githubusercontent.com/catseye-internal/Production-Dashboard/main/cache-invoices.json?v=' + Date.now();
    var resp = UrlFetchApp.fetch(cacheUrl, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      Logger.log('   ✗ Failed to fetch cache-invoices.json: HTTP ' + resp.getResponseCode());
      return;
    }
    var cache = JSON.parse(resp.getContentText());
    var invoices = cache.invoices || [];
    // Find most recent commercial IN invoice (heuristic: ServiceClass contains COMM or PG SERVICE)
    var picked = null;
    for (var i = invoices.length - 1; i >= 0 && i > invoices.length - 200; i--) {
      var inv = invoices[i];
      if ((inv.InvoiceType || '') !== 'IN') continue;
      var sc = String(inv.ServiceClass || '').toUpperCase();
      if (sc.indexOf('COMM') === -1 && sc.indexOf('PG SERVICE') === -1) continue;
      picked = inv;
      break;
    }
    if (!picked) {
      Logger.log('   ✗ No commercial IN invoice found in last 200 cache records — please set PROBE_INVOICE_NUMBER manually');
      return;
    }
    if (!invoiceNum) invoiceNum = picked.InvoiceNumber;
    if (!locationId) {
      // Need to look up LocationID from cache-locations using LocationCode
      var locCode = picked.LocationCode;
      var locUrl = 'https://raw.githubusercontent.com/catseye-internal/Production-Dashboard/main/cache-locations.json?v=' + Date.now();
      var locResp = UrlFetchApp.fetch(locUrl, { muteHttpExceptions: true });
      var locCache = JSON.parse(locResp.getContentText());
      var locArr = locCache.locations || [];
      for (var j = 0; j < locArr.length; j++) {
        if (String(locArr[j].LocationCode) === String(locCode)) {
          locationId = locArr[j].LocationID;
          break;
        }
      }
    }
    Logger.log('   Picked invoice ' + invoiceNum + ' / LocationID ' + locationId +
               ' / ServiceClass ' + picked.ServiceClass + ' / Tech ' + picked.Tech +
               ' / WorkDate ' + picked.WorkDate);
  }

  if (!invoiceNum || !locationId) {
    Logger.log('   ✗ Could not resolve invoice + location — aborting');
    return;
  }

  var token = ppToken_();
  var headers = {
    'Authorization': 'Bearer ' + token,
    'apikey': PP_API_KEY,
    'tenant-id': PP_TENANT_ID
  };

  // ── 2. Endpoints to probe ──
  // First need InvoiceID (the numeric internal ID) — the invoice number is
  // human-facing; many sub-endpoints want the internal ID. Try the search
  // variant first.
  Logger.log('\n2. Resolving InvoiceID for InvoiceNumber=' + invoiceNum + '...');
  var searchResp = UrlFetchApp.fetch(PP_API_BASE + '/Invoices?invoiceNumber=' + invoiceNum, {
    headers: headers, muteHttpExceptions: true
  });
  Logger.log('   GET /Invoices?invoiceNumber=' + invoiceNum + ' → HTTP ' + searchResp.getResponseCode());
  var invoiceId = null;
  if (searchResp.getResponseCode() === 200) {
    try {
      var data = JSON.parse(searchResp.getContentText());
      invoiceId = data.InvoiceID || data.invoiceId || (data[0] && data[0].InvoiceID);
      Logger.log('   Resolved InvoiceID = ' + invoiceId);
    } catch (e) { Logger.log('   parse error: ' + e); }
  }

  var endpointsToTry = [
    { name: '/Invoices/{id}/conditions',     path: '/Invoices/' + invoiceId + '/conditions' },
    { name: '/Invoices/{id}/unitSummary',    path: '/Invoices/' + invoiceId + '/unitSummary' },
    { name: '/Invoices/{id}/attributes',     path: '/Invoices/' + invoiceId + '/attributes' },
    { name: '/Locations/{id}/devices',       path: '/Locations/' + locationId + '/devices' },
    { name: '/Locations/{id}/areas',         path: '/Locations/' + locationId + '/areas' },
    { name: '/Locations/{id}/flattenedAreas',path: '/Locations/' + locationId + '/flattenedAreas' },
    { name: '/Devices?locationID=X',         path: '/Devices?locationID=' + locationId },
    { name: '/Devices?invoiceID=X',          path: '/Devices?invoiceID=' + invoiceId },
  ];

  Logger.log('\n3. Probing ' + endpointsToTry.length + ' endpoints...\n');
  endpointsToTry.forEach(function(ep) {
    Logger.log('━━━ ' + ep.name + ' ━━━');
    Logger.log('GET ' + ep.path);
    try {
      var resp = UrlFetchApp.fetch(PP_API_BASE + ep.path, { headers: headers, muteHttpExceptions: true });
      var code = resp.getResponseCode();
      Logger.log('  HTTP ' + code);
      if (code !== 200) {
        Logger.log('  body: ' + resp.getContentText().substring(0, 300));
        return;
      }
      var body = resp.getContentText();
      // Try to parse + show structure
      try {
        var json = JSON.parse(body);
        var arr = Array.isArray(json) ? json : (json.items || json.data || [json]);
        var count = Array.isArray(arr) ? arr.length : 1;
        Logger.log('  records: ' + count);
        if (count > 0) {
          var sample = arr[0];
          var keys = Object.keys(sample).sort();
          Logger.log('  fields: ' + keys.join(', '));
          // Highlight fields that smell like scan data
          var scanLike = keys.filter(function(k) {
            return /scan|barcode|inspect|condition|status|last|date|tech/i.test(k);
          });
          if (scanLike.length > 0) {
            Logger.log('  📡 scan-like fields: ' + scanLike.join(', '));
            scanLike.forEach(function(k) {
              Logger.log('     ' + k + ' = ' + JSON.stringify(sample[k]).substring(0, 150));
            });
          }
        } else {
          Logger.log('  (empty array)');
        }
      } catch (e) {
        // Not JSON — probably the inspectionReport PDF
        Logger.log('  non-JSON response, first 200 chars: ' + body.substring(0, 200).replace(/[^\x20-\x7e]/g, '.'));
      }
    } catch (e) {
      Logger.log('  ✗ exception: ' + e);
    }
    Utilities.sleep(300);
  });

  Logger.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✓ Probe complete. Copy entire log to Claude.');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}
