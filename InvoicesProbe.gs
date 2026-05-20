/**
 * PestPac /Invoices Endpoint Probe — Round 2
 *
 * First probe got HTTP 400 on all four query variants with empty error bodies.
 * This script tries 15+ variations of endpoint name, path casing, query params,
 * HTTP method, and date format — captures the full response body and status
 * for each, then prints a sorted table at the end.
 *
 * USAGE
 *   Run inside the same standalone "PestPac Discovery" Apps Script project.
 *   - Open the project
 *   - File → New script → name it "InvoicesProbe"
 *   - Paste this whole file
 *   - Save (Cmd+S)
 *   - In the function dropdown, pick probeInvoices
 *   - Click Run
 *   - Copy execution log back to me
 */

// Reuse the credentials already defined in PestPacDiscovery.gs (same project = shared globals).
// If you somehow run this outside that project, uncomment the block below:
/*
const PP_CLIENT_ID     = 'OjCMV6522ip62LlhU08LrG5U61oa';
const PP_CLIENT_SECRET = 'MicEfYLkplnarU18fHLH3VCfxhMa';
const PP_USERNAME      = 'jdingwall@catseyepest.com';
const PP_PASSWORD      = 'C@ts3y3!!';
const PP_API_KEY       = 'IJ4Goon7ZW9EbvAvPdO33Q6Vtnt5oysT';
const PP_TENANT_ID     = '103012';
const PP_TOKEN_URL     = 'https://is.workwave.com/oauth2/token?scope=openid';
const PP_API_BASE      = 'https://api.workwave.com/pestpac/v1';
*/

function probeInvoices() {
  Logger.log('🔍 Invoices probe — ' + new Date().toISOString());

  const token = ppToken_();  // ppToken_ is defined in PestPacDiscovery.gs
  Logger.log('✓ Token acquired');

  // Date range: same 3-day window
  const end = new Date();
  const start = new Date(); start.setDate(start.getDate() - 7);  // widen a bit
  const startStr = fmt_(start), endStr = fmt_(end);
  const startUS = (start.getMonth()+1) + '/' + start.getDate() + '/' + start.getFullYear();
  const endUS = (end.getMonth()+1) + '/' + end.getDate() + '/' + end.getFullYear();
  Logger.log('Window: ' + startStr + ' → ' + endStr);

  const tries = [
    // ── Endpoint name variants ──
    { method: 'GET', path: '/Invoices' },
    { method: 'GET', path: '/Invoice' },
    { method: 'GET', path: '/invoices' },
    { method: 'GET', path: '/Billing' },
    { method: 'GET', path: '/Billing/Invoices' },
    { method: 'GET', path: '/Invoicing' },

    // ── Date param variants ──
    { method: 'GET', path: '/Invoices?startInvoiceDate=' + startStr + '&endInvoiceDate=' + endStr },
    { method: 'GET', path: '/Invoices?invoiceStartDate=' + startStr + '&invoiceEndDate=' + endStr },
    { method: 'GET', path: '/Invoices?startWorkDate=' + startStr + '&endWorkDate=' + endStr }, // copy ServiceOrders pattern
    { method: 'GET', path: '/Invoices?startDate=' + startStr + '&endDate=' + endStr },
    { method: 'GET', path: '/Invoices?dateFrom=' + startStr + '&dateTo=' + endStr },
    { method: 'GET', path: '/Invoices?from=' + startStr + '&to=' + endStr },
    { method: 'GET', path: '/Invoices?dateRangeStart=' + startStr + '&dateRangeEnd=' + endStr },

    // ── US date format (PestPac sometimes accepts MM/DD/YYYY) ──
    { method: 'GET', path: '/Invoices?startDate=' + encodeURIComponent(startUS) + '&endDate=' + encodeURIComponent(endUS) },

    // ── OData-style filtering ──
    { method: 'GET', path: '/Invoices?$top=5' },
    { method: 'GET', path: '/Invoices?$filter=InvoiceDate%20ge%20' + startStr },

    // ── Single-record lookup (do we need an ID first?) ──
    { method: 'GET', path: '/Invoices/1' },

    // ── POST with body ──
    { method: 'POST', path: '/Invoices', body: JSON.stringify({ startDate: startStr, endDate: endStr }) },
    { method: 'POST', path: '/Invoices/search', body: JSON.stringify({ startDate: startStr, endDate: endStr }) },
    { method: 'POST', path: '/Invoices/list', body: JSON.stringify({ startDate: startStr, endDate: endStr }) },
  ];

  const summary = [];
  for (var i = 0; i < tries.length; i++) {
    var t = tries[i];
    var opts = {
      method: t.method.toLowerCase(),
      headers: {
        'Authorization': 'Bearer ' + token,
        'apikey': PP_API_KEY,
        'tenant-id': PP_TENANT_ID
      },
      muteHttpExceptions: true
    };
    if (t.body) { opts.payload = t.body; opts.contentType = 'application/json'; }

    try {
      var resp = UrlFetchApp.fetch(PP_API_BASE + t.path, opts);
      var code = resp.getResponseCode();
      var body = resp.getContentText();
      var headers = resp.getAllHeaders();
      var contentLen = body ? body.length : 0;

      Logger.log('\n─── ' + t.method + ' ' + t.path);
      Logger.log('   HTTP ' + code + '  (body ' + contentLen + ' bytes)');
      if (body && contentLen < 500) {
        Logger.log('   body: ' + body);
      } else if (body) {
        Logger.log('   body[0..500]: ' + body.substring(0, 500));
      }
      // Headers that often carry the actual error info
      ['x-error', 'x-error-message', 'x-warning', 'www-authenticate', 'WWW-Authenticate'].forEach(function(h) {
        if (headers[h]) Logger.log('   ' + h + ': ' + headers[h]);
      });

      summary.push({ method: t.method, path: t.path, code: code, len: contentLen });
    } catch (e) {
      Logger.log('   exception: ' + e.message);
      summary.push({ method: t.method, path: t.path, code: 'EXC', len: 0 });
    }

    // Tiny pause to be polite to the shared rate limit
    Utilities.sleep(250);
  }

  // ── Roll-up table ──
  Logger.log('\n══════════════════════════════════════════════════════════════');
  Logger.log('PROBE SUMMARY');
  Logger.log('══════════════════════════════════════════════════════════════');
  summary.sort(function(a, b) {
    var ac = typeof a.code === 'number' ? a.code : 999;
    var bc = typeof b.code === 'number' ? b.code : 999;
    return ac - bc;
  });
  summary.forEach(function(s) {
    Logger.log(String(s.code).padEnd(5) + ' ' + s.method.padEnd(5) + ' ' + s.path);
  });

  Logger.log('\n✅ Probe complete — paste this log back to Claude');
}
