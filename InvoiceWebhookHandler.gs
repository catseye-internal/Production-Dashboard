/**
 * Production Dashboard — Invoice Webhook Handler
 *
 * Apps Script Web App that receives PestPac webhook POSTs for invoice events
 * and keeps cache-invoices.json on GitHub Pages up-to-date in near-real-time.
 *
 * Subscribed events (registered via WebhookRegistration.gs):
 *   - Invoice.Create        → fetch + upsert into cache
 *   - Invoice.Update        → fetch + upsert into cache
 *   - Invoice.Void          → mark voided in cache (kept for audit)
 *   - Credit Memo.Create    → fetch + upsert (treated as another invoice type)
 *   - Credit Memo.Update    → fetch + upsert
 *   - Credit Memo.Apply     → re-fetch the credit memo (balance changed)
 *   - Payment.Apply         → re-fetch the affected invoice (balance changed)
 *
 * PestPac event payload (POST body):
 *   { "EntityType": "Invoice", "EntityId": 1234, "Url": "https://api.workwave.com/pestpac/v1/Invoices/1234" }
 *
 * SECURITY NOTES
 * Apps Script web apps don't expose request headers, so HMAC signature verification
 * (the standard webhook authenticity pattern) isn't directly available. We rely on:
 *   1. URL secrecy — the deployed Web App URL is the secret
 *   2. EntityId verification — every event triggers a fresh API call to PestPac,
 *      so an attacker can't fake invoice data, only force a refresh of real data
 *   3. EntityType allowlist — we ignore anything not in EXPECTED_TYPES
 *
 * DEPLOYMENT
 *   1. Save this file in the same Apps Script project as CacheRefresh.gs
 *   2. Deploy → New deployment → Type: Web app
 *      - Execute as: Me
 *      - Who has access: Anyone (PestPac needs to POST without auth)
 *   3. Copy the /exec URL
 *   4. Run registerAllWebhooks_(webhookUrl) from WebhookRegistration.gs
 */

// ── Configuration ──
// Reuses PestPac credentials defined in CacheRefresh.gs (same project, shared globals)

// GitHub config — must match CacheRefresh.gs
// (declared there: GH_OWNER, GH_REPO, GH_BRANCH)
const GH_PATH_INVOICES = 'cache-invoices.json';

// Curated whitelist for invoice records arriving via webhook.
// Mirrors the seed loader (loaders/parse_invoices.py FIELD_MAP) so the schema matches.
const CURATED_INV_KEYS = [
  // Identity & relationships
  'InvoiceNumber', 'InvoiceType', 'OrderNumber', 'OrderID', 'InvoiceID',
  // Dates
  'InvoiceDate', 'WorkDate', 'OrderDate',
  // Location / branch
  'Branch', 'BranchID', 'LocationID', 'BillToID',
  // Service detail
  'ServiceClass', 'ServiceDescription', 'ServiceCode', 'Route',
  // People
  'Tech', 'Tech2', 'Sales', 'EnteredBy',
  // Money
  'SubTotal', 'Tax', 'Total', 'Balance', 'AgingDays', 'NetDays',
  'SaleValue', 'ProductionValue', 'TaxableAmount', 'TaxRate',
  // Origin
  'Source', 'Origin', 'PostedBy',
  // Status
  'Voided'
];

// Event types we care about
const EXPECTED_TYPES = ['Invoice', 'Credit Memo', 'CreditMemo', 'Payment'];

// ──────────────────────────────────────────────────────────────
// Web App entry point — receives PestPac webhook POSTs
// ──────────────────────────────────────────────────────────────
function doPost(e) {
  var t0 = new Date();
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var entityType = body.EntityType || '';
    var entityId   = body.EntityId;
    var action     = body.Action || ''; // not always present

    Logger.log('🔔 ' + entityType + ' #' + entityId + (action ? ' (' + action + ')' : ''));

    if (EXPECTED_TYPES.indexOf(entityType) === -1) {
      Logger.log('  Ignored — not in EXPECTED_TYPES');
      return ContentService.createTextOutput(JSON.stringify({ ok: true, ignored: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var token = ppToken_();

    if (entityType === 'Invoice' || entityType === 'Credit Memo' || entityType === 'CreditMemo') {
      if (action === 'Void') {
        markInvoiceVoided_(entityId);
      } else {
        var inv = fetchInvoice_(token, entityId);
        if (inv) upsertInvoice_(curate_(inv));
      }
    } else if (entityType === 'Payment') {
      // Payment.Apply changes balance on the affected invoice(s).
      // Fetch the payment record to identify which invoices were touched.
      var payment = fetchPayment_(token, entityId);
      if (payment && payment.Applications) {
        payment.Applications.forEach(function(app) {
          if (app.ApplyToType === 'Invoice' && app.ApplyToID) {
            var inv = fetchInvoice_(token, app.ApplyToID);
            if (inv) upsertInvoice_(curate_(inv));
          }
        });
      }
    }

    var elapsed = ((new Date() - t0) / 1000).toFixed(1);
    Logger.log('✅ Processed in ' + elapsed + 's');
    return ContentService.createTextOutput(JSON.stringify({ ok: true, elapsed: elapsed }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('❌ Webhook error: ' + err.message + '\n' + err.stack);
    // Return 200 anyway — we don't want PestPac to retry indefinitely on our bugs
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Friendly GET handler — useful for "is the web app live?" checks
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    service: 'Production Dashboard — Invoice Webhook Handler',
    ok: true,
    timestamp: new Date().toISOString(),
    expectedTypes: EXPECTED_TYPES
  })).setMimeType(ContentService.MimeType.JSON);
}

// ──────────────────────────────────────────────────────────────
// PestPac fetchers
// ──────────────────────────────────────────────────────────────
function fetchInvoice_(token, invoiceId) {
  var r = ppGet_(token, '/Invoices/' + invoiceId);
  if (r.code !== 200) {
    Logger.log('  fetchInvoice ' + invoiceId + ' → HTTP ' + r.code);
    return null;
  }
  return JSON.parse(r.text);
}

function fetchPayment_(token, paymentId) {
  var r = ppGet_(token, '/Payments/' + paymentId);
  if (r.code !== 200) {
    Logger.log('  fetchPayment ' + paymentId + ' → HTTP ' + r.code);
    return null;
  }
  return JSON.parse(r.text);
}

// ──────────────────────────────────────────────────────────────
// Curate invoice — strip to whitelisted fields, drop empties
// ──────────────────────────────────────────────────────────────
function curate_(rec) {
  var out = {};
  for (var i = 0; i < CURATED_INV_KEYS.length; i++) {
    var k = CURATED_INV_KEYS[i];
    var v = rec[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v === '') continue;
    if (typeof v === 'number' && v === 0 && k !== 'Total') continue;
    out[k] = v;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// Cache upsert — read cache-invoices.json from GitHub, mutate, write back
// ──────────────────────────────────────────────────────────────
function upsertInvoice_(curated) {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) { Logger.log('  ⚠️ GITHUB_TOKEN missing'); return; }
  var apiBase = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO;
  var headers = { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json' };

  // Step 1: read current cache file via the contents API (smaller than git data API for reads)
  var getResp = UrlFetchApp.fetch(apiBase + '/contents/' + GH_PATH_INVOICES + '?ref=' + GH_BRANCH, {
    headers: headers, muteHttpExceptions: true
  });
  if (getResp.getResponseCode() !== 200) {
    Logger.log('  Cache read HTTP ' + getResp.getResponseCode());
    return;
  }
  var meta = JSON.parse(getResp.getContentText());
  var jsonStr = Utilities.newBlob(Utilities.base64Decode(meta.content), 'application/json').getDataAsString();
  var cache = JSON.parse(jsonStr);

  // Step 2: upsert by InvoiceNumber
  var invs = cache.invoices || [];
  var key = String(curated.InvoiceNumber);
  var idx = -1;
  for (var i = 0; i < invs.length; i++) {
    if (String(invs[i].InvoiceNumber) === key) { idx = i; break; }
  }
  if (idx >= 0) {
    invs[idx] = curated;
    Logger.log('  Updated invoice ' + key);
  } else {
    invs.push(curated);
    Logger.log('  Added invoice ' + key);
  }
  cache.invoices = invs;
  cache.updated = new Date().toISOString();
  cache.recordCount = invs.length;
  cache.lastWebhookUpdate = new Date().toISOString();

  // Step 3: write back via contents API (uses the existing sha)
  var newContent = Utilities.base64Encode(JSON.stringify(cache), Utilities.Charset.UTF_8);
  var putResp = UrlFetchApp.fetch(apiBase + '/contents/' + GH_PATH_INVOICES, {
    method: 'put', headers: headers, contentType: 'application/json',
    payload: JSON.stringify({
      message: 'Webhook upsert invoice ' + key + ' ' + new Date().toISOString(),
      content: newContent,
      sha: meta.sha,
      branch: GH_BRANCH
    }),
    muteHttpExceptions: true
  });
  if (putResp.getResponseCode() !== 200 && putResp.getResponseCode() !== 201) {
    Logger.log('  Cache write HTTP ' + putResp.getResponseCode() + ': ' + putResp.getContentText().substring(0, 300));
  } else {
    Logger.log('  ✅ Cache updated');
  }
}

// Mark an invoice voided in the cache (kept for audit)
function markInvoiceVoided_(invoiceId) {
  // For void events we don't get InvoiceNumber directly — use InvoiceID lookup.
  // Read cache, find by InvoiceID, set Voided=true.
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) return;
  var apiBase = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO;
  var headers = { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json' };
  var getResp = UrlFetchApp.fetch(apiBase + '/contents/' + GH_PATH_INVOICES + '?ref=' + GH_BRANCH, {
    headers: headers, muteHttpExceptions: true
  });
  if (getResp.getResponseCode() !== 200) return;
  var meta = JSON.parse(getResp.getContentText());
  var jsonStr = Utilities.newBlob(Utilities.base64Decode(meta.content), 'application/json').getDataAsString();
  var cache = JSON.parse(jsonStr);
  var found = false;
  for (var i = 0; i < (cache.invoices || []).length; i++) {
    if (String(cache.invoices[i].InvoiceID) === String(invoiceId)) {
      cache.invoices[i].Voided = true;
      found = true;
      Logger.log('  Marked invoice ID ' + invoiceId + ' as voided');
      break;
    }
  }
  if (!found) {
    Logger.log('  Void event for unknown InvoiceID ' + invoiceId + ' — ignoring');
    return;
  }
  cache.updated = new Date().toISOString();
  cache.lastWebhookUpdate = new Date().toISOString();
  var newContent = Utilities.base64Encode(JSON.stringify(cache), Utilities.Charset.UTF_8);
  UrlFetchApp.fetch(apiBase + '/contents/' + GH_PATH_INVOICES, {
    method: 'put', headers: headers, contentType: 'application/json',
    payload: JSON.stringify({
      message: 'Webhook void invoice ID ' + invoiceId,
      content: newContent, sha: meta.sha, branch: GH_BRANCH
    }),
    muteHttpExceptions: true
  });
}
