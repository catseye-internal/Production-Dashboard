/**
 * Production Dashboard — WebHook Subscription Registration
 *
 * One-time setup that registers PestPac webhook subscriptions to fire
 * against the deployed InvoiceWebhookHandler Web App.
 *
 * RUN ORDER
 *   1. Deploy InvoiceWebhookHandler.gs as a Web App (see deployment notes there).
 *   2. Copy the deployment /exec URL.
 *   3. Edit WEBHOOK_RECEIVER_URL below to that URL.
 *   4. Run setupAllWebhooks() once. Check the log to confirm each subscription succeeded.
 *
 * UPDATING
 *   If the Web App URL changes (e.g. you create a new version), run replaceAllWebhooks()
 *   to delete the old subscriptions and register fresh ones pointing at the new URL.
 *
 * DEBUGGING
 *   - listWebhooks()      — see what's currently registered
 *   - deleteAllWebhooks() — wipe all subscriptions (clean slate)
 *   - generateNewSecret() — rotate the HMAC signing key
 */

// ⬇️ EDIT THIS to your deployed Web App /exec URL before running setupAllWebhooks()
const WEBHOOK_RECEIVER_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';

// Events to subscribe to — every invoice-affecting event
const SUBSCRIPTIONS = [
  { EntityType: 'Invoice',     Action: 'Create' },
  { EntityType: 'Invoice',     Action: 'Update' },
  { EntityType: 'Invoice',     Action: 'Void'   },
  { EntityType: 'Credit Memo', Action: 'Create' },
  { EntityType: 'Credit Memo', Action: 'Update' },
  { EntityType: 'Credit Memo', Action: 'Apply'  },
  { EntityType: 'Payment',     Action: 'Apply'  },  // balance updates on linked invoices
];

// ──────────────────────────────────────────────────────────────
// MAIN — register all subscriptions
// ──────────────────────────────────────────────────────────────
function setupAllWebhooks() {
  if (WEBHOOK_RECEIVER_URL.indexOf('YOUR_DEPLOYMENT_ID') >= 0) {
    throw new Error('Set WEBHOOK_RECEIVER_URL at the top of this file before running.');
  }
  Logger.log('📡 Registering ' + SUBSCRIPTIONS.length + ' subscriptions → ' + WEBHOOK_RECEIVER_URL);
  var token = ppToken_();
  var results = [];
  SUBSCRIPTIONS.forEach(function(sub) {
    var r = createWebhook_(token, sub.EntityType, sub.Action, WEBHOOK_RECEIVER_URL);
    results.push({ sub: sub, code: r.code, body: r.text.substring(0, 200) });
    Logger.log('  ' + sub.EntityType + '.' + sub.Action + ' → HTTP ' + r.code);
    Utilities.sleep(300);
  });
  Logger.log('\n✅ Setup complete');
  Logger.log('Run listWebhooks() to verify.');
  return results;
}

function createWebhook_(token, entityType, action, url) {
  var resp = UrlFetchApp.fetch(PP_API_BASE + '/WebHooks', {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + token,
      'apikey': PP_API_KEY,
      'tenant-id': PP_TENANT_ID
    },
    contentType: 'application/json',
    payload: JSON.stringify({
      EntityType: entityType,
      Action: action,
      PostToUrl: url
    }),
    muteHttpExceptions: true
  });
  return { code: resp.getResponseCode(), text: resp.getContentText() };
}

// ──────────────────────────────────────────────────────────────
// DEBUGGING / UTILITIES
// ──────────────────────────────────────────────────────────────
function listWebhooks() {
  var token = ppToken_();
  var r = ppGet_(token, '/WebHooks');
  Logger.log('HTTP ' + r.code);
  if (r.code === 200) {
    var list = JSON.parse(r.text);
    Logger.log('Subscriptions: ' + list.length);
    list.forEach(function(w) {
      Logger.log('  #' + w.WebHookID + ': ' + w.EntityType + '.' + w.Action + ' → ' + w.PostToUrl);
    });
    return list;
  }
  Logger.log(r.text.substring(0, 500));
}

function deleteAllWebhooks() {
  var token = ppToken_();
  var r = ppGet_(token, '/WebHooks');
  if (r.code !== 200) { Logger.log('Could not list: HTTP ' + r.code); return; }
  var list = JSON.parse(r.text);
  Logger.log('Deleting ' + list.length + ' subscription(s)...');
  list.forEach(function(w) {
    var del = UrlFetchApp.fetch(PP_API_BASE + '/WebHooks/' + w.WebHookID, {
      method: 'delete',
      headers: {
        'Authorization': 'Bearer ' + token,
        'apikey': PP_API_KEY,
        'tenant-id': PP_TENANT_ID
      },
      muteHttpExceptions: true
    });
    Logger.log('  Deleted #' + w.WebHookID + ' (' + w.EntityType + '.' + w.Action + ') → HTTP ' + del.getResponseCode());
    Utilities.sleep(200);
  });
}

function replaceAllWebhooks() {
  deleteAllWebhooks();
  Utilities.sleep(1000);
  setupAllWebhooks();
}

function generateNewSecret() {
  var token = ppToken_();
  var resp = UrlFetchApp.fetch(PP_API_BASE + '/WebHooks/generateSecretKey', {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + token,
      'apikey': PP_API_KEY,
      'tenant-id': PP_TENANT_ID
    },
    muteHttpExceptions: true
  });
  Logger.log('Generated secret HTTP ' + resp.getResponseCode());
  Logger.log(resp.getContentText());
  // PestPac stores the secret server-side; the response contains the key value.
  // Apps Script web apps don't expose request headers (where the signature would
  // travel), so we can't verify HMAC right now. Secret key is stored for future
  // use if/when PestPac adds signature-in-query-param or similar support.
}

function listSecretKeys() {
  var token = ppToken_();
  var r = ppGet_(token, '/WebHooks/secretKeys');
  Logger.log('HTTP ' + r.code);
  Logger.log(r.text);
}
