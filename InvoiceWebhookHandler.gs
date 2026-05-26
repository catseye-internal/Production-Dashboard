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
const EXPECTED_TYPES = [
  'Invoice', 'Credit Memo', 'CreditMemo', 'Payment',
  // ServiceSetup added 2026-05-25 — drives cache-setups.json for the
  // "New Setups This Week" + "Cancellations This Week" cards. Subscribed
  // to both spaced + un-spaced variants in WebhookRegistration.gs.
  'Service Setup', 'ServiceSetup'
];

// Path for cache-setups.json on GitHub
const GH_PATH_SETUPS_WEBHOOK = 'cache-setups.json';

// ──────────────────────────────────────────────────────────────
// Web App entry point — receives PestPac webhook POSTs
// ──────────────────────────────────────────────────────────────
function doPost(e) {
  var t0 = new Date();
  try {
    var body = JSON.parse(e.postData.contents || '{}');

    // ─── Admin save route (Joe directive 2026-05-23) ───
    // admin.html POSTs { action: "saveBudgets", password, branch, month, data }
    // to update budgets.json. Distinct from PestPac webhooks below.
    if (body.action === 'saveBudgets') {
      return handleSaveBudgets_(body);
    }

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
        if (inv) upsertInvoice_(curateInvoice_(inv));
      }
    } else if (entityType === 'Payment') {
      // Payment.Apply changes balance on the affected invoice(s).
      // Fetch the payment record to identify which invoices were touched.
      var payment = fetchPayment_(token, entityId);
      if (payment && payment.Applications) {
        payment.Applications.forEach(function(app) {
          if (app.ApplyToType === 'Invoice' && app.ApplyToID) {
            var inv = fetchInvoice_(token, app.ApplyToID);
            if (inv) upsertInvoice_(curateInvoice_(inv));
          }
        });
      }
    } else if (entityType === 'Service Setup' || entityType === 'ServiceSetup') {
      // Service Setup webhook handler. PestPac fires Create / Update / Delete.
      //   Create  → CSR booked a new setup (new business written)
      //   Update  → field changed; commonly the CancelDate getting populated
      //             (which = a cancellation in our model)
      //   Delete  → hard-delete (rare). Remove from cache.
      // Joe directive 2026-05-25.
      if (action === 'Delete') {
        deleteSetup_(entityId);
      } else {
        var setup = fetchSetup_(token, entityId);
        if (setup) upsertSetup_(curateSetup_(setup));
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
// Renamed from curate_ to curateInvoice_ on 2026-05-20 to avoid colliding
// with curate_(rec, whitelist) in CacheRefresh.gs (Apps Script projects
// share a single global namespace across .gs files; the later-loaded
// definition silently wins, which was the cause of the slim-cache bug).
// ──────────────────────────────────────────────────────────────
function curateInvoice_(rec) {
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
//
// CONCURRENCY: PestPac fires Invoice.Create and Invoice.Update at nearly the
// same moment when an invoice is posted (and Credit Memo / Payment events can
// pile on top of those). Without serialization, parallel doPost executions
// both read the same SHA, both PUT back, and one gets HTTP 409 silently
// dropped — which is what caused the 5/20 yesterday-undercount (30 of 273).
//
// Fixes:
//   1. LockService.getScriptLock() serializes ALL concurrent webhook upserts
//      across the script. Wait up to 90s (PestPac retries are 15s spaced).
//   2. Retry on HTTP 409 (3 attempts, exponential backoff). Catches the rare
//      race against CacheRefresh.gs writes which use a different code path.
// ──────────────────────────────────────────────────────────────
function upsertInvoice_(curated) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(90000);
  } catch (e) {
    Logger.log('  ⚠️ Lock timeout — could not serialize upsert for ' + curated.InvoiceNumber);
    return;
  }
  try {
    var ok = upsertInvoiceOnce_(curated, 1);
    var attempt = 2;
    while (!ok && attempt <= 3) {
      Utilities.sleep(400 * attempt);
      ok = upsertInvoiceOnce_(curated, attempt);
      attempt++;
    }
    if (!ok) Logger.log('  ⚠️ Gave up on invoice ' + curated.InvoiceNumber + ' after ' + (attempt - 1) + ' attempts');
  } finally {
    lock.releaseLock();
  }
}

// Single upsert attempt. Returns true if cache write succeeded, false on 409
// (caller will retry). Other HTTP failures also return false — those aren't
// worth retrying on but the bool keeps the contract simple.
function upsertInvoiceOnce_(curated, attempt) {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) { Logger.log('  ⚠️ GITHUB_TOKEN missing'); return false; }
  var apiBase = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO;
  var headers = { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json' };

  // Step 1: read current cache file via the contents API (smaller than git data API for reads)
  var getResp = UrlFetchApp.fetch(apiBase + '/contents/' + GH_PATH_INVOICES + '?ref=' + GH_BRANCH, {
    headers: headers, muteHttpExceptions: true
  });
  if (getResp.getResponseCode() !== 200) {
    Logger.log('  Cache read HTTP ' + getResp.getResponseCode());
    return false;
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
    Logger.log('  Updated invoice ' + key + (attempt > 1 ? ' (retry ' + attempt + ')' : ''));
  } else {
    invs.push(curated);
    Logger.log('  Added invoice ' + key + (attempt > 1 ? ' (retry ' + attempt + ')' : ''));
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
  var code = putResp.getResponseCode();
  if (code === 200 || code === 201) {
    Logger.log('  ✅ Cache updated');
    return true;
  }
  if (code === 409) {
    Logger.log('  ⏪ 409 conflict — will retry with fresh SHA');
    return false;
  }
  Logger.log('  Cache write HTTP ' + code + ': ' + putResp.getContentText().substring(0, 300));
  return false;
}

// Mark an invoice voided in the cache (kept for audit). Same lock as upsert.
function markInvoiceVoided_(invoiceId) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(90000); } catch (e) {
    Logger.log('  ⚠️ Lock timeout — could not mark voided invoice ID ' + invoiceId);
    return;
  }
  try {
    _markInvoiceVoidedInner_(invoiceId);
  } finally {
    lock.releaseLock();
  }
}

function _markInvoiceVoidedInner_(invoiceId) {
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

// ══════════════════════════════════════════════════════════════
// SERVICE SETUP WEBHOOK HANDLERS  (Joe directive 2026-05-25)
// ══════════════════════════════════════════════════════════════
// Drives cache-setups.json updates from real-time PestPac events.
// Same lock + retry pattern as the invoice handler. Same curate logic as
// the bulk pull in CacheRefresh.gs (shares enrichSetupCreator_).

function fetchSetup_(token, setupId) {
  var r = ppGet_(token, '/ServiceSetups/' + setupId);
  if (r.code !== 200) {
    Logger.log('  fetchSetup ' + setupId + ' → HTTP ' + r.code);
    return null;
  }
  return JSON.parse(r.text);
}

// Apply CURATED_FIELDS_SETUP whitelist + extract EnteredBy/SalesBy from
// Technicians. Mirrors the bulk-pull curation in fetchSetups_ exactly so
// webhook-delivered records and bulk-fetched records have identical shape.
function curateSetup_(setup) {
  var curated = curate_(setup, CURATED_FIELDS_SETUP);
  enrichSetupCreator_(curated, setup);
  return curated;
}

// Upsert into cache-setups.json — same concurrency pattern as upsertInvoice_.
// LockService serializes concurrent webhook deliveries; retry-on-409 catches
// the rare race with another writer (e.g., a CacheRefresh.gs bulk refresh
// happening at the same moment).
function upsertSetup_(curated) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(90000);
  } catch (e) {
    Logger.log('  ⚠️ Lock timeout — could not serialize setup upsert for ' + curated.SetupID);
    return;
  }
  try {
    var ok = upsertSetupOnce_(curated, 1);
    var attempt = 2;
    while (!ok && attempt <= 3) {
      Utilities.sleep(400 * attempt);
      ok = upsertSetupOnce_(curated, attempt);
      attempt++;
    }
    if (!ok) Logger.log('  ⚠️ Gave up on setup ' + curated.SetupID + ' after ' + (attempt - 1) + ' attempts');
  } finally {
    lock.releaseLock();
  }
}

function upsertSetupOnce_(curated, attempt) {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) { Logger.log('  ⚠️ GITHUB_TOKEN missing'); return false; }
  var apiBase = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO;
  var headers = { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json' };

  // 1. Read current cache-setups.json
  var getResp = UrlFetchApp.fetch(apiBase + '/contents/' + GH_PATH_SETUPS_WEBHOOK + '?ref=' + GH_BRANCH, {
    headers: headers, muteHttpExceptions: true
  });
  if (getResp.getResponseCode() !== 200) {
    Logger.log('  Setup cache read HTTP ' + getResp.getResponseCode());
    return false;
  }
  var meta = JSON.parse(getResp.getContentText());
  var jsonStr = Utilities.newBlob(Utilities.base64Decode(meta.content), 'application/json').getDataAsString();
  var cache = JSON.parse(jsonStr);

  // 2. Upsert by SetupID
  var setups = cache.setups || [];
  var key = String(curated.SetupID);
  var idx = -1;
  for (var i = 0; i < setups.length; i++) {
    if (String(setups[i].SetupID) === key) { idx = i; break; }
  }
  if (idx >= 0) {
    setups[idx] = curated;
    Logger.log('  Updated setup ' + key + (attempt > 1 ? ' (retry ' + attempt + ')' : '') +
               (curated.CancelDate ? ' [CANCELLED]' : ''));
  } else {
    setups.push(curated);
    Logger.log('  Added setup ' + key + ' (NEW BUSINESS)' + (attempt > 1 ? ' (retry ' + attempt + ')' : ''));
  }
  cache.setups = setups;
  cache.updated = new Date().toISOString();
  cache.recordCount = setups.length;
  cache.lastWebhookUpdate = new Date().toISOString();

  // 3. Write back
  var newContent = Utilities.base64Encode(JSON.stringify(cache), Utilities.Charset.UTF_8);
  var putResp = UrlFetchApp.fetch(apiBase + '/contents/' + GH_PATH_SETUPS_WEBHOOK, {
    method: 'put', headers: headers, contentType: 'application/json',
    payload: JSON.stringify({
      message: 'Webhook upsert setup ' + key + ' ' + new Date().toISOString(),
      content: newContent,
      sha: meta.sha,
      branch: GH_BRANCH
    }),
    muteHttpExceptions: true
  });
  var code = putResp.getResponseCode();
  if (code === 200 || code === 201) {
    Logger.log('  ✅ Setup cache updated');
    return true;
  }
  if (code === 409) {
    Logger.log('  ⏪ 409 conflict — will retry with fresh SHA');
    return false;
  }
  Logger.log('  Setup cache write HTTP ' + code + ': ' + putResp.getContentText().substring(0, 300));
  return false;
}

// Delete a setup from the cache. Service Setup.Delete events are rare —
// usually setups get cancelled (CancelDate populated) rather than hard-deleted.
function deleteSetup_(setupId) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(90000); } catch (e) {
    Logger.log('  ⚠️ Lock timeout — could not delete setup ID ' + setupId);
    return;
  }
  try {
    var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
    if (!token) return;
    var apiBase = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO;
    var headers = { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json' };
    var getResp = UrlFetchApp.fetch(apiBase + '/contents/' + GH_PATH_SETUPS_WEBHOOK + '?ref=' + GH_BRANCH, {
      headers: headers, muteHttpExceptions: true
    });
    if (getResp.getResponseCode() !== 200) return;
    var meta = JSON.parse(getResp.getContentText());
    var jsonStr = Utilities.newBlob(Utilities.base64Decode(meta.content), 'application/json').getDataAsString();
    var cache = JSON.parse(jsonStr);
    var filtered = (cache.setups || []).filter(function(s) {
      return String(s.SetupID) !== String(setupId);
    });
    if (filtered.length === (cache.setups || []).length) {
      Logger.log('  Delete event for setup ID ' + setupId + ' — not in cache, ignoring');
      return;
    }
    cache.setups = filtered;
    cache.updated = new Date().toISOString();
    cache.recordCount = filtered.length;
    cache.lastWebhookUpdate = new Date().toISOString();
    var newContent = Utilities.base64Encode(JSON.stringify(cache), Utilities.Charset.UTF_8);
    UrlFetchApp.fetch(apiBase + '/contents/' + GH_PATH_SETUPS_WEBHOOK, {
      method: 'put', headers: headers, contentType: 'application/json',
      payload: JSON.stringify({
        message: 'Webhook delete setup ID ' + setupId,
        content: newContent, sha: meta.sha, branch: GH_BRANCH
      }),
      muteHttpExceptions: true
    });
    Logger.log('  ❌ Deleted setup ID ' + setupId + ' from cache');
  } finally {
    lock.releaseLock();
  }
}


// ──────────────────────────────────────────────────────────────
// Admin budget-save handler (Joe directive 2026-05-23)
// admin.html POSTs JSON with action=saveBudgets. We validate the shared-
// secret password, read budgets.json from GitHub, merge the new branch+
// month data into it, and PUT the file back.
// ──────────────────────────────────────────────────────────────
const GH_PATH_BUDGETS = 'budgets.json';

function handleSaveBudgets_(body) {
  function reply(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 1. Password check
  var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_BUDGET_PASSWORD');
  if (!expected) {
    Logger.log('⛔ ADMIN_BUDGET_PASSWORD not set in Apps Script properties');
    return reply({ ok: false, error: 'admin password not configured' });
  }
  if (body.password !== expected) {
    Logger.log('⛔ Wrong admin password attempt');
    return reply({ ok: false, error: 'unauthorized' });
  }

  // 2. Validate payload
  var branch = String(body.branch || '').trim();
  var month  = String(body.month  || '').trim();
  var data   = body.data;
  if (!branch || !month || !data || typeof data !== 'object') {
    return reply({ ok: false, error: 'missing branch/month/data' });
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return reply({ ok: false, error: 'month must be YYYY-MM' });
  }
  if (!data['true'] || !data['enhanced']) {
    return reply({ ok: false, error: 'data must have true + enhanced tiers' });
  }

  // 3. Acquire lock so concurrent admin saves + webhook saves don't collide
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60 * 1000)) {
    return reply({ ok: false, error: 'busy — try again' });
  }

  try {
    var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
    if (!token) return reply({ ok: false, error: 'GITHUB_TOKEN not configured' });
    var headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
    var apiBase = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO;
    var getUrl  = apiBase + '/contents/' + GH_PATH_BUDGETS + '?ref=' + GH_BRANCH;

    // 4. Fetch current budgets.json + sha (or treat as empty if 404)
    var getResp = UrlFetchApp.fetch(getUrl, { method: 'get', headers: headers, muteHttpExceptions: true });
    var sha = null;
    var budgets = {};
    if (getResp.getResponseCode() === 200) {
      var meta = JSON.parse(getResp.getContentText());
      sha = meta.sha;
      var current = Utilities.newBlob(Utilities.base64Decode(meta.content)).getDataAsString();
      try { budgets = JSON.parse(current); } catch (e) { budgets = {}; }
    } else if (getResp.getResponseCode() !== 404) {
      return reply({ ok: false, error: 'github read failed: ' + getResp.getResponseCode() });
    }

    // 5. Merge the new entry
    if (!budgets[branch]) budgets[branch] = {};
    budgets[branch][month] = {
      'true':     data['true'],
      'enhanced': data['enhanced']
    };
    // Stamp metadata
    budgets._meta = budgets._meta || {};
    budgets._meta.updated   = new Date().toISOString();
    budgets._meta.updatedBy = body.user || 'admin';

    // 6. PUT back to GitHub
    var payloadStr = JSON.stringify(budgets, null, 2) + '\n';
    var newContent = Utilities.base64Encode(payloadStr, Utilities.Charset.UTF_8);
    var putBody = {
      message: 'Admin budget update: ' + branch + ' / ' + month,
      content: newContent,
      branch:  GH_BRANCH
    };
    if (sha) putBody.sha = sha;

    var putResp = UrlFetchApp.fetch(apiBase + '/contents/' + GH_PATH_BUDGETS, {
      method: 'put', headers: headers, contentType: 'application/json',
      payload: JSON.stringify(putBody), muteHttpExceptions: true
    });
    var putCode = putResp.getResponseCode();
    if (putCode >= 200 && putCode < 300) {
      Logger.log('✅ Saved budget: ' + branch + ' / ' + month);
      return reply({ ok: true, branch: branch, month: month });
    }
    Logger.log('❌ GitHub PUT failed: ' + putCode + ' ' + putResp.getContentText());
    return reply({ ok: false, error: 'github write failed: ' + putCode });
  } finally {
    lock.releaseLock();
  }
}

// Optional GET endpoint so we can sanity-check the admin endpoint from a browser
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    endpoint: 'Production Dashboard Apps Script',
    routes: ['POST { EntityType, EntityId, Action } — webhook handler', 'POST { action: "saveBudgets", password, branch, month, data } — admin save']
  })).setMimeType(ContentService.MimeType.JSON);
}
