/**
 * Production Dashboard — Weekly Invoice Merge (Apps Script port of merge_invoices.py)
 *
 * Fires every Monday morning after the PestPac Report Writer "ALL INVOICES (trailing
 * 60 days) - PRODUCTION DASHBOARD" email arrives at joe@catseyeusa.com.
 *
 * Pipeline (mirrors the Python merge_invoices.py exactly):
 *   1. Search Gmail for the most recent matching email (last 48h)
 *   2. Extract the CSV attachment
 *   3. Parse it via field-alias map (same logic as parse_invoices.py)
 *   4. Fetch the live cache-invoices.json from GitHub Pages
 *   5. Back up the live cache to a Drive folder (so we can roll back GAS-side too)
 *   6. Merge by InvoiceNumber (report wins on duplicates, nothing is removed)
 *   7. Run the 5-section sanity check suite
 *   8. Verdict:
 *        PASS → push to GitHub + send success email
 *        WARN → push to GitHub + send "verify this" email with flags
 *        STOP → DO NOT push, save the rejected cache to Drive, send loud-alert email
 *
 * Reuses pushToGitHub_() and readInvoicesCacheDirect_() from CacheRefresh.gs
 * (single Apps Script namespace — these are visible without imports).
 *
 * SETUP (one-time)
 *   1. Paste this file into the same Apps Script project that runs CacheRefresh.gs
 *   2. Script Properties (Project Settings → Script Properties):
 *        • GITHUB_TOKEN          — already set (used by CacheRefresh.gs)
 *        • MERGE_REPORT_RECIPIENT — joe@catseyeusa.com (where verdict emails go)
 *        • MERGE_BACKUP_FOLDER_ID — Drive folder ID for pre-merge backups + rejected caches
 *                                   Optional — if unset, files land at My Drive root
 *   3. Run installWeeklyMergeTrigger() ONCE — creates the Monday 6:15 AM ET trigger
 *   4. (Optional) Run testWeeklyInvoiceMerge() with the LIVE_RUN flag set to false
 *      to dry-run the parse + sanity check without touching GitHub or sending email
 */

// ── Config ──
const WIM_EMAIL_SUBJECT_QUERY = 'subject:"[Production Dashboard] Weekly Invoice Refresh" newer_than:2d';
const WIM_ATTACHMENT_NAME_PATTERN = /^Weekly Mon 6AM ET_ALL INVOICES.*\.csv$/i;
const WIM_CACHE_PATH = 'cache-invoices.json';
const WIM_RECIPIENT_PROP = 'MERGE_REPORT_RECIPIENT';
const WIM_BACKUP_FOLDER_PROP = 'MERGE_BACKUP_FOLDER_ID';
const WIM_LAST_RUN_PROP = 'lastWeeklyMergeAt';
const WIM_LAST_SUBJECT_PROP = 'lastWeeklyMergeSubject';  // dedup guard

// Sanity-check thresholds — keep these in sync with merge_invoices.py
const WIM_WARN_BRANCH_REV_DRIFT_PCT  = 5.0;
const WIM_WARN_TOTAL_REV_DRIFT_PCT   = 1.0;
const WIM_STOP_TOTAL_REV_DRIFT_PCT   = 10.0;
const WIM_WARN_RETRO_TOTAL_PCT       = 1.0;
const WIM_WARN_DATE_OUTSIDE_DAYS     = 90;

// ── Field-alias map (port of parse_invoices.FIELD_ALIASES) ──
// Order in each array = priority. First matching header in the CSV wins.
const WIM_FIELD_ALIASES = {
  'InvoiceNumber':      ['Invoice #', 'Invoice Number', 'InvoiceNumber'],
  'InvoiceType':        ['Invoice Type', 'InvoiceType'],
  'OrderNumber':        ['Order #', 'Order Number', 'OrderNumber'],
  'InvoiceDate':        ['Invoice Date', 'InvoiceDate'],
  'WorkDate':           ['Work Date', 'WorkDate'],
  'OrderDate':          ['Order Date', 'OrderDate'],
  'Branch':             ['Branch'],
  'Region':             ['Branch Region', 'Region'],
  'SubRegion':          ['Branch Sub-Region', 'SubRegion'],
  'LocationCode':       ['Location', 'Location Code', 'LocationCode', 'LocID'],
  'BillToCode':         ['Bill-To Code', 'BillToID', 'BillToCode', 'Bill To'],
  'CustomerName':       ['Name', 'Customer', 'Customer Name'],
  'City':               ['City'],
  'State':              ['State'],
  'Zip':                ['Zip code', 'Zip Code', 'Zip', 'ZIP'],
  'Tech':               ['Tech', 'Tech 1', 'Tech 1 Code - Tech', 'Tech 1 Code', 'Tech1'],
  'Tech2':              ['Tech 2', 'Tech 2 Code - Tech 2', 'Tech 2 Code', 'Tech2'],
  'Sales':              ['Sales', 'Tech 3 Code - Sales', 'Tech 3 Code'],
  'EnteredBy':          ['Entered', 'Tech 4 Code - Entered', 'Tech 4 Code', 'EnteredBy'],
  'ServiceClass':       ['Service Class', 'Service Class Code', 'ServiceClass'],
  'ServiceDescription': ['Service Description', 'Service Class Description', 'ServiceDescription'],
  'ServiceCode':        ['Service', 'Service Code', 'ServiceCode'],
  'Route':              ['Route'],
  'SubTotal':           ['Sub-Total', 'SubTotal', 'Sub Total'],
  'Tax':                ['Tax'],
  'Total':              ['Total'],
  'Balance':            ['Balance'],
  'AgingDays':          ['Aging Days', 'AgingDays'],
  'NetDays':            ['Net', 'Terms Net Days', 'NetDays', 'Net Days'],
  'SaleValue':          ['Sale Value', 'SaleValue'],
  'ProductionValue':    ['Production Value', 'ProductionValue'],
  'TaxableAmount':      ['Taxable Amount', 'TaxableAmount'],
  'TaxRate':            ['Tax Rate', 'TaxRate'],
  'Source':             ['Source'],
  'Origin':             ['Origin'],
  'PostedBy':           ['Posted By', 'PostedBy', 'Add User'],
  'OrderType':          ['Order Type', 'OrderType'],
  'Duration':           ['Duration'],
  'Frequency':          ['Frequency'],
  'Schedule':           ['Schedule'],
  'SetupType':          ['Setup Type', 'SetupType'],
  'GLCode':             ['GL Code', 'GLCode'],
  'InvoiceBatch':       ['Invoice Batch', 'InvoiceBatch'],
  'ConsolidatedNum':    ['Consolidated Num', 'Consolidated Invoice Number', 'ConsolidatedNum'],
  'ConsolidatedDate':   ['Consolidated Date', 'Consolidated Invoice Date', 'ConsolidatedDate'],
  'CreditReason':       ['Credit Reason', 'Credit Reason Code', 'CreditReason'],
  'TaxCode':            ['Tax Code', 'TaxCode'],
  'AccountType':        ['Type', 'AccountType']
};

const WIM_NUMERIC_FIELDS = new Set([
  'SubTotal', 'Tax', 'Total', 'Balance', 'AgingDays', 'NetDays',
  'SaleValue', 'ProductionValue', 'TaxableAmount', 'TaxRate', 'Duration'
]);
const WIM_DATE_FIELDS = new Set(['InvoiceDate', 'OrderDate', 'ConsolidatedDate', 'AddDate']);
// WorkDate is treated as a DATETIME (preserve the timestamp portion if present).
// CSV exports from Exago typically only give us the date — but the merge logic
// below refuses to overwrite an existing record's timestamped WorkDate with a
// date-only one, so webhook-captured + backfilled timestamps survive.
const WIM_DATETIME_FIELDS = new Set(['WorkDate']);
const WIM_REQUIRED_FIELDS = ['InvoiceNumber', 'InvoiceType', 'Branch', 'InvoiceDate'];
const WIM_SPLIT_NAME_HEADERS = ['Company', 'First Name', 'Last Name'];
const WIM_KEY_HEADER_TOKENS = ['Invoice #', 'Invoice Number', 'InvoiceNumber'];

// Excel-protection wrapper: ="06281-1437" → 06281-1437
const WIM_EXCEL_WRAP = /^="(.*)"$/;


// ══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINTS
// ══════════════════════════════════════════════════════════════════════════

/**
 * PRIMARY trigger — Monday ~6:45 AM ET via installWeeklyMergeTrigger().
 * Silent on "no email found" so a slightly-delayed email doesn't trigger a
 * false-alarm alert — the backup at ~7:30 AM ET handles loud alerting.
 */
function weeklyInvoiceMerge() {
  _wimRun_({ live: true, alertOnNoEmail: false, label: 'PRIMARY' });
}

/**
 * BACKUP trigger — Monday ~7:30 AM ET. Runs the same pipeline as the primary.
 * If the primary already processed the email, the dedup guard makes this exit
 * silently. If neither attempt found the email, THIS one sends the loud alert
 * (so you only get noisy if the email is genuinely missing/late).
 */
function weeklyInvoiceMergeBackup() {
  _wimRun_({ live: true, alertOnNoEmail: true, label: 'BACKUP' });
}

/**
 * Dry-run — parses the latest email's CSV + runs sanity checks, but does NOT
 * push to GitHub or send the verdict email. Logs everything to the Apps Script
 * execution log. Use this to validate the build before letting the triggers fire.
 */
function testWeeklyInvoiceMerge() {
  _wimRun_({ live: false, alertOnNoEmail: false, label: 'DRY-RUN' });
}

/**
 * Force a re-run by clearing the dedup guard. Use if the trigger fired but
 * something went wrong and you want to re-process the same email.
 */
function clearWeeklyMergeDedupGuard() {
  PropertiesService.getScriptProperties().deleteProperty(WIM_LAST_SUBJECT_PROP);
  Logger.log('Dedup guard cleared. Next weeklyInvoiceMerge() run will re-process the latest email.');
}

/**
 * Install the Monday triggers (primary + backup). Run ONCE manually after
 * pasting this file into the Apps Script project.
 *
 * Primary  ~6:45 AM ET — covers normal-delivery emails (typical case)
 * Backup   ~7:30 AM ET — covers slow-delivery emails (rare case)
 *
 * Both call the same pipeline. Dedup guard ensures only one of them processes
 * any given email. Only the backup alerts on "no email found," so a slow
 * delivery doesn't trigger a false alarm — only a genuine missing email does.
 */
function installWeeklyMergeTrigger() {
  // Remove any existing triggers for these handlers to avoid duplicates
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'weeklyInvoiceMerge' || fn === 'weeklyInvoiceMergeBackup') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  if (removed > 0) Logger.log('Removed ' + removed + ' existing trigger(s).');

  // Primary: ~6:45 AM ET (fires somewhere in 6:38-6:52 window)
  ScriptApp.newTrigger('weeklyInvoiceMerge')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(6)
    .nearMinute(45)
    .inTimezone('America/New_York')
    .create();

  // Backup: ~7:30 AM ET (fires somewhere in 7:23-7:37 window)
  ScriptApp.newTrigger('weeklyInvoiceMergeBackup')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(7)
    .nearMinute(30)
    .inTimezone('America/New_York')
    .create();

  Logger.log('✅ Installed 2 triggers:');
  Logger.log('   Primary: weeklyInvoiceMerge       — Monday ~6:45 AM ET (silent on no-email)');
  Logger.log('   Backup:  weeklyInvoiceMergeBackup — Monday ~7:30 AM ET (alerts on no-email)');
}


// ══════════════════════════════════════════════════════════════════════════
// CORE PIPELINE
// ══════════════════════════════════════════════════════════════════════════

function _wimRun_(opts) {
  var live = !!opts.live;
  var alertOnNoEmail = !!opts.alertOnNoEmail;
  var label = opts.label || (live ? 'LIVE' : 'DRY-RUN');
  var t0 = new Date();
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log((live ? '🚀 Weekly Invoice Merge — ' + label : '🧪 Weekly Invoice Merge — ' + label) + ' — ' + t0.toISOString());
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  var recipient = PropertiesService.getScriptProperties().getProperty(WIM_RECIPIENT_PROP) || '';
  if (live && !recipient) {
    Logger.log('❌ Aborting: Script Property ' + WIM_RECIPIENT_PROP + ' is not set.');
    return;
  }

  try {
    // 1. Find the email
    Logger.log('1. Searching Gmail: ' + WIM_EMAIL_SUBJECT_QUERY);
    var emailHit = _wimFindLatestEmail_();
    if (!emailHit) {
      var msg = 'No matching email found in the last 48 hours.';
      Logger.log((alertOnNoEmail ? '❌ ' : 'ℹ️  ') + msg + (alertOnNoEmail ? '' : ' (silent — primary attempt; backup will retry if needed)'));
      if (live && alertOnNoEmail) {
        _wimSendAlertEmail_(
          recipient,
          '🛑 Weekly Invoice Merge — NO EMAIL FOUND (both attempts)',
          'The primary trigger (~6:45 AM ET) and the backup trigger (~7:30 AM ET) both ran and neither found a matching email.\n\n' +
          'Search query: ' + WIM_EMAIL_SUBJECT_QUERY + '\n\n' +
          'Possible causes:\n' +
          '  • Exago/PestPac failed to send this week\n' +
          '  • Email landed in a different account or got filtered\n' +
          '  • Subject line on the schedule was changed\n\n' +
          'Action: check Gmail manually. If the email arrives later today, you can run weeklyInvoiceMerge() manually from the Apps Script editor.'
        );
      }
      return;
    }
    Logger.log('   Found: "' + emailHit.subject + '" from ' + emailHit.from + ' at ' + emailHit.date.toISOString());

    // Dedup guard — don't re-process the same email if the trigger somehow fires twice
    if (live) {
      var lastSubjectStamp = PropertiesService.getScriptProperties().getProperty(WIM_LAST_SUBJECT_PROP) || '';
      var thisStamp = emailHit.subject + '|' + emailHit.date.toISOString();
      if (lastSubjectStamp === thisStamp) {
        Logger.log('   ↩︎  Already processed this exact email. Skipping (use clearWeeklyMergeDedupGuard() to force re-run).');
        return;
      }
    }

    // 2. Pull the CSV attachment
    Logger.log('2. Extracting CSV attachment...');
    var attachment = _wimFindCsvAttachment_(emailHit.message);
    if (!attachment) {
      var msg2 = 'Email found but no attachment matching ' + WIM_ATTACHMENT_NAME_PATTERN + '.';
      Logger.log('❌ ' + msg2);
      if (live) _wimSendAlertEmail_(recipient, '🛑 Weekly Invoice Merge — NO ATTACHMENT', msg2);
      return;
    }
    Logger.log('   Attachment: ' + attachment.getName() + ' (' + Math.round(attachment.getSize() / 1024) + ' KB)');
    var csvText = attachment.getDataAsString('UTF-8');

    // 3. Parse CSV
    Logger.log('3. Parsing CSV...');
    var parsed = _wimParseInvoiceCsv_(csvText);
    Logger.log('   Parsed ' + parsed.records.length + ' records | ' + parsed.matchedFields.length + ' fields matched / ' + Object.keys(WIM_FIELD_ALIASES).length);
    if (parsed.records.length === 0) {
      var msg3 = 'CSV parsed but 0 records emerged. Check the CSV format and header row.';
      Logger.log('❌ ' + msg3);
      if (live) _wimSendAlertEmail_(recipient, '🛑 Weekly Invoice Merge — EMPTY PARSE', msg3);
      return;
    }
    Logger.log('   Date range: ' + parsed.dateRange.min + ' → ' + parsed.dateRange.max);
    Logger.log('   Invoice types: ' + parsed.typesBreakdown);

    // 4. Fetch live cache
    Logger.log('4. Fetching live cache from GitHub Pages...');
    var liveCache = readInvoicesCacheDirect_();
    var existing = liveCache.invoices || [];
    Logger.log('   Existing cache: ' + existing.length + ' invoices');

    // 5. Merge
    Logger.log('5. Merging by InvoiceNumber (report wins on duplicates)...');
    var mergeResult = _wimMergeByInvoiceNumber_(existing, parsed.records);
    Logger.log('   Added ' + mergeResult.added + ', updated ' + mergeResult.updated + ', no-key skipped ' + mergeResult.noKey);

    // 6. Sanity checks
    Logger.log('6. Running sanity checks...');
    var sanity = _wimRunSanityChecks_(existing, mergeResult.merged, parsed.dateRange);
    Logger.log('   Verdict: ' + sanity.verdict + ' | ' + sanity.warnings.length + ' warnings, ' + sanity.stops.length + ' stops');

    // 7. Build the new cache payload
    var newCache = {
      updated: new Date().toISOString(),
      recordCount: mergeResult.merged.length,
      lastBackfillFile: attachment.getName(),
      lastBackfillAt: new Date().toISOString(),
      lastMergeVerdict: sanity.verdict,
      invoices: mergeResult.merged
    };
    var newCacheJson = JSON.stringify(newCache);
    Logger.log('   New cache size: ' + Math.round(newCacheJson.length / 1024) + ' KB');

    // 8. Save backup of EXISTING cache to Drive
    var backupFolderId = PropertiesService.getScriptProperties().getProperty(WIM_BACKUP_FOLDER_PROP) || '';
    var preMergeBackupUrl = null;
    if (live) {
      Logger.log('7. Backing up existing cache to Drive...');
      var existingCacheJson = JSON.stringify(liveCache);
      preMergeBackupUrl = _wimSaveToDrive_(
        existingCacheJson,
        _wimTimestampedName_('cache-invoices.backup-pre-merge'),
        backupFolderId
      );
      Logger.log('   Backup saved: ' + preMergeBackupUrl);
    }

    // 9. Verdict-driven side effects
    var commitSha = null;
    var rejectedCacheUrl = null;
    if (sanity.verdict === 'STOP') {
      Logger.log('🛑 STOP — refusing to push.');
      if (live) {
        rejectedCacheUrl = _wimSaveToDrive_(
          newCacheJson,
          _wimTimestampedName_('cache-invoices.REJECTED'),
          backupFolderId
        );
        Logger.log('   Rejected cache saved: ' + rejectedCacheUrl);
      }
    } else {
      if (live) {
        Logger.log('8. Pushing cache to GitHub...');
        var commitMsg = '[auto-merge] ' + sanity.verdict + ' — ' + attachment.getName() + ' (' + new Date().toISOString() + ')';
        var pushed = pushToGitHub_(newCacheJson, WIM_CACHE_PATH, commitMsg);
        if (!pushed) {
          Logger.log('❌ GitHub push failed.');
          _wimSendAlertEmail_(
            recipient,
            '🛑 Weekly Invoice Merge — GITHUB PUSH FAILED',
            'Sanity checks ' + sanity.verdict + ', but the GitHub push failed.\n\n' +
            'Pre-merge backup: ' + preMergeBackupUrl + '\n\n' +
            'Cache content was also lost — try re-running clearWeeklyMergeDedupGuard() then weeklyInvoiceMerge().'
          );
          return;
        }
        Logger.log('   ✅ Pushed.');
        // Try to fetch the latest commit SHA so we can link to it in the email
        commitSha = _wimReadLatestCommitSha_();
      }
    }

    // 10. Email the verdict
    if (live) {
      Logger.log('9. Sending verdict email to ' + recipient + '...');
      _wimSendVerdictEmail_(recipient, {
        verdict: sanity.verdict,
        attachmentName: attachment.getName(),
        mergeResult: mergeResult,
        sanity: sanity,
        parsed: parsed,
        existingCount: existing.length,
        commitSha: commitSha,
        preMergeBackupUrl: preMergeBackupUrl,
        rejectedCacheUrl: rejectedCacheUrl,
        elapsedSec: ((new Date() - t0) / 1000).toFixed(1)
      });
      PropertiesService.getScriptProperties().setProperty(WIM_LAST_SUBJECT_PROP, emailHit.subject + '|' + emailHit.date.toISOString());
      PropertiesService.getScriptProperties().setProperty(WIM_LAST_RUN_PROP, new Date().toISOString());
    } else {
      Logger.log('   (Dry-run — no email sent.)');
      // Print the email body to logs for inspection
      Logger.log('--- Dry-run email body preview ---');
      Logger.log(_wimBuildVerdictEmailBody_({
        verdict: sanity.verdict,
        attachmentName: attachment.getName(),
        mergeResult: mergeResult,
        sanity: sanity,
        parsed: parsed,
        existingCount: existing.length,
        commitSha: 'DRY-RUN-NO-COMMIT',
        preMergeBackupUrl: 'DRY-RUN-NO-BACKUP',
        rejectedCacheUrl: null,
        elapsedSec: ((new Date() - t0) / 1000).toFixed(1)
      }));
    }

    Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    Logger.log('✅ Done in ' + ((new Date() - t0) / 1000).toFixed(1) + 's | Verdict: ' + sanity.verdict);
    Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (err) {
    Logger.log('❌ FATAL: ' + err.message + '\n' + err.stack);
    if (live) {
      _wimSendAlertEmail_(
        recipient,
        '🛑 Weekly Invoice Merge — FATAL ERROR',
        'The merge job threw an uncaught exception:\n\n' + err.message + '\n\n' + err.stack
      );
    }
  }
}


// ══════════════════════════════════════════════════════════════════════════
// GMAIL HELPERS
// ══════════════════════════════════════════════════════════════════════════

function _wimFindLatestEmail_() {
  var threads = GmailApp.search(WIM_EMAIL_SUBJECT_QUERY, 0, 10);
  if (!threads || threads.length === 0) return null;
  // Pick the most recent message across the most recent threads
  var bestMsg = null;
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var m = msgs[j];
      // Subject filter (extra safety on top of the search query)
      if (m.getSubject().indexOf('[Production Dashboard] Weekly Invoice Refresh') === -1) continue;
      if (!bestMsg || m.getDate().getTime() > bestMsg.getDate().getTime()) {
        bestMsg = m;
      }
    }
  }
  if (!bestMsg) return null;
  return {
    message: bestMsg,
    subject: bestMsg.getSubject(),
    from: bestMsg.getFrom(),
    date: bestMsg.getDate()
  };
}

function _wimFindCsvAttachment_(message) {
  var attachments = message.getAttachments({ includeInlineImages: false, includeAttachments: true });
  for (var i = 0; i < attachments.length; i++) {
    if (WIM_ATTACHMENT_NAME_PATTERN.test(attachments[i].getName())) {
      return attachments[i];
    }
  }
  // Fallback: any .csv attachment
  for (var k = 0; k < attachments.length; k++) {
    if (/\.csv$/i.test(attachments[k].getName())) {
      Logger.log('   (Using fallback .csv attachment: ' + attachments[k].getName() + ')');
      return attachments[k];
    }
  }
  return null;
}


// ══════════════════════════════════════════════════════════════════════════
// CSV PARSER (port of parse_invoices.parse_report)
// ══════════════════════════════════════════════════════════════════════════

function _wimParseInvoiceCsv_(csvText) {
  // Utilities.parseCsv handles quoted fields correctly
  var rows = Utilities.parseCsv(csvText, ',');

  // Find the header row (Exago sometimes prepends report-title rows)
  var headerIdx = -1;
  for (var i = 0; i < Math.min(rows.length, 50); i++) {
    var cells = rows[i].map(function(c) { return String(c || '').trim(); });
    for (var t = 0; t < WIM_KEY_HEADER_TOKENS.length; t++) {
      if (cells.indexOf(WIM_KEY_HEADER_TOKENS[t]) >= 0) { headerIdx = i; break; }
    }
    if (headerIdx >= 0) break;
  }
  if (headerIdx < 0) throw new Error('Could not locate header row in CSV (looking for "Invoice Number" or "Invoice #").');
  var headers = rows[headerIdx].map(function(c) { return String(c || '').trim(); });
  Logger.log('   Header row index: ' + headerIdx + ' | ' + headers.length + ' columns');

  // Resolve column indices via alias map
  var idxByName = {};
  headers.forEach(function(h, i) {
    if (h) {
      if (!(h in idxByName)) idxByName[h] = i;
      var lower = h.toLowerCase();
      if (!(lower in idxByName)) idxByName[lower] = i;
    }
  });

  var keep = [];  // [{idx, outKey}]
  var matchedKeys = {};
  Object.keys(WIM_FIELD_ALIASES).forEach(function(outKey) {
    var aliases = WIM_FIELD_ALIASES[outKey];
    for (var a = 0; a < aliases.length; a++) {
      var alias = aliases[a];
      var found = idxByName[alias];
      if (found === undefined) found = idxByName[alias.toLowerCase()];
      if (found !== undefined) {
        keep.push({ idx: found, outKey: outKey });
        matchedKeys[outKey] = true;
        break;
      }
    }
  });

  // Set up CustomerName synthesis if no single Name/Customer column was matched
  var splitNameIdx = {};
  if (!matchedKeys['CustomerName']) {
    WIM_SPLIT_NAME_HEADERS.forEach(function(h) {
      if (idxByName[h] !== undefined) splitNameIdx[h] = idxByName[h];
    });
  }

  var maxKeepIdx = -1;
  keep.forEach(function(k) { if (k.idx > maxKeepIdx) maxKeepIdx = k.idx; });

  // Iterate data rows
  var records = [];
  var skippedShort = 0;
  var skippedMissingRequired = 0;

  for (var r = headerIdx + 1; r < rows.length; r++) {
    var row = rows[r];
    if (!row || row.length === 0) continue;
    // Skip fully empty rows
    var anyNonEmpty = false;
    for (var c = 0; c < row.length; c++) {
      if (String(row[c] || '').trim() !== '') { anyNonEmpty = true; break; }
    }
    if (!anyNonEmpty) continue;
    if (row.length < maxKeepIdx + 1) { skippedShort++; continue; }
    var first = String(row[0] || '').trim();
    if (first.indexOf('Invoice Date:') === 0 || first.indexOf('Total:') === 0 ||
        first.indexOf('Branch:') === 0 || first.indexOf('Subtotal') === 0) continue;

    var rec = {};
    keep.forEach(function(k) {
      var raw = row[k.idx];
      var val = _wimClean_(raw);
      if (WIM_NUMERIC_FIELDS.has(k.outKey)) {
        var n = _wimToNumber_(val);
        if (n === null) return;
        if (n === 0 && k.outKey !== 'Total') return;
        rec[k.outKey] = n;
      } else if (WIM_DATE_FIELDS.has(k.outKey)) {
        var d = _wimToIsoDate_(val);
        if (d) rec[k.outKey] = d;
      } else if (WIM_DATETIME_FIELDS.has(k.outKey)) {
        var dt = _wimToIsoDatetime_(val);
        if (dt) rec[k.outKey] = dt;
      } else {
        if (val) rec[k.outKey] = val;
      }
    });

    // Synthesize CustomerName if needed
    if (!rec['CustomerName'] && Object.keys(splitNameIdx).length > 0) {
      var cn = _wimSynthCustomerName_(row, splitNameIdx);
      if (cn) rec['CustomerName'] = cn;
    }

    // Drop rows without required fields
    var ok = true;
    for (var q = 0; q < WIM_REQUIRED_FIELDS.length; q++) {
      if (!(WIM_REQUIRED_FIELDS[q] in rec)) { ok = false; break; }
    }
    if (!ok) { skippedMissingRequired++; continue; }
    records.push(rec);
  }

  // Stats
  var dates = [];
  var typesCount = {};
  for (var x = 0; x < records.length; x++) {
    var d = records[x].InvoiceDate;
    if (d) dates.push(d);
    var t = records[x].InvoiceType;
    if (t) typesCount[t] = (typesCount[t] || 0) + 1;
  }
  dates.sort();
  var typesBreakdown = Object.keys(typesCount).sort().map(function(t) { return t + ':' + typesCount[t]; }).join(', ');

  return {
    records: records,
    matchedFields: Object.keys(matchedKeys),
    skippedShort: skippedShort,
    skippedMissingRequired: skippedMissingRequired,
    dateRange: {
      min: dates[0] || '',
      max: dates[dates.length - 1] || ''
    },
    typesBreakdown: typesBreakdown,
    typesCount: typesCount
  };
}

function _wimClean_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v).trim();
  if (!s) return '';
  var m = WIM_EXCEL_WRAP.exec(s);
  if (m) s = m[1];
  return s;
}

function _wimToNumber_(s) {
  if (s === null || s === undefined || s === '') return null;
  var cleaned = String(s).replace(/,/g, '').replace(/\$/g, '');
  var n = Number(cleaned);
  if (isNaN(n)) return null;
  return n;
}

function _wimToIsoDatetime_(s) {
  // Preserve full ISO timestamp when present (PestPac API style: 2026-05-20T07:22:00).
  // For inputs that only have a date, fall back to date-only parsing.
  if (!s) return '';
  var raw = String(s).trim();
  // Already ISO with T-separator → validate + keep
  if (raw.indexOf('T') >= 0) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)) {
      return raw.split('.')[0];  // strip fractional seconds if present
    }
  }
  // M/D/Y H:MM:SS or Y-M-D H:MM:SS style
  var dtPatterns = [
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
    /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/
  ];
  for (var i = 0; i < dtPatterns.length; i++) {
    var m = dtPatterns[i].exec(raw);
    if (m) {
      var year, month, day;
      if (i === 1) { year = m[3]; month = m[1]; day = m[2]; }
      else         { year = m[1]; month = m[2]; day = m[3]; }
      var hh = m[4], mm = m[5], ss = m[6] || '00';
      return year + '-' + _wimPad_(month) + '-' + _wimPad_(day) + 'T' + _wimPad_(hh) + ':' + _wimPad_(mm) + ':' + _wimPad_(ss);
    }
  }
  // No time portion — defer to date-only logic
  return _wimToIsoDate_(raw);
}

function _wimToIsoDate_(s) {
  if (!s) return '';
  var raw = String(s).trim();
  // Strip time portion
  if (raw.indexOf('T') >= 0) raw = raw.split('T')[0];
  if (raw.indexOf(' ') >= 0 && raw.indexOf(':') >= 0) raw = raw.split(' ')[0];
  // Try Y/M/D, M/D/Y, Y-M-D, M/D/YY
  var formats = [
    { re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,  fn: function(m) { return m[1] + '-' + _wimPad_(m[2]) + '-' + _wimPad_(m[3]); } },
    { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,  fn: function(m) { return m[3] + '-' + _wimPad_(m[1]) + '-' + _wimPad_(m[2]); } },
    { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,    fn: function(m) { return m[1] + '-' + _wimPad_(m[2]) + '-' + _wimPad_(m[3]); } },
    { re: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/,  fn: function(m) {
      var yr = Number(m[3]);
      // 2-digit year: <50 = 20xx, ≥50 = 19xx
      var full = (yr < 50) ? (2000 + yr) : (1900 + yr);
      return full + '-' + _wimPad_(m[1]) + '-' + _wimPad_(m[2]);
    } }
  ];
  for (var i = 0; i < formats.length; i++) {
    var match = formats[i].re.exec(raw);
    if (match) return formats[i].fn(match);
  }
  return raw;
}

function _wimPad_(s) {
  s = String(s);
  return s.length === 1 ? '0' + s : s;
}

function _wimSynthCustomerName_(row, splitNameIdx) {
  var company = ('Company' in splitNameIdx) ? _wimClean_(row[splitNameIdx['Company']]) : '';
  if (company) return company;
  var first = ('First Name' in splitNameIdx) ? _wimClean_(row[splitNameIdx['First Name']]) : '';
  var last  = ('Last Name'  in splitNameIdx) ? _wimClean_(row[splitNameIdx['Last Name']])  : '';
  var parts = [];
  if (first) parts.push(first);
  if (last) parts.push(last);
  return parts.join(' ');
}


// ══════════════════════════════════════════════════════════════════════════
// MERGE
// ══════════════════════════════════════════════════════════════════════════

function _wimHasWorkDateTimestamp_(wd) {
  if (!wd) return false;
  var s = String(wd);
  if (s.indexOf('T') < 0) return false;
  var timePart = s.split('T')[1] || '';
  return timePart !== '' && timePart !== '00:00:00' && timePart !== '00:00:00.000';
}

function _wimMergeByInvoiceNumber_(existing, newRecords) {
  var byKey = {};
  existing.forEach(function(inv) {
    var k = inv.InvoiceNumber;
    if (k !== undefined && k !== null && k !== '') byKey[String(k)] = inv;
  });

  var added = 0, updated = 0, noKey = 0, workdatePreserved = 0;
  newRecords.forEach(function(rec) {
    var k = rec.InvoiceNumber;
    if (k === undefined || k === null || k === '') { noKey++; return; }
    var key = String(k);
    if (key in byKey) {
      // Preserve WorkDate timestamp from existing record if new CSV row is
      // date-only. CSV exports from Exago usually lose the time portion,
      // but the cache has it from webhook delivery / backfill. Don't let
      // the weekly merge clobber that.
      var existingRec = byKey[key];
      if (_wimHasWorkDateTimestamp_(existingRec.WorkDate) && !_wimHasWorkDateTimestamp_(rec.WorkDate)) {
        rec.WorkDate = existingRec.WorkDate;
        workdatePreserved++;
      }
      byKey[key] = rec;
      updated++;
    } else {
      byKey[key] = rec;
      added++;
    }
  });

  var merged = [];
  Object.keys(byKey).forEach(function(k) { merged.push(byKey[k]); });
  // Sort: InvoiceDate desc, then InvoiceNumber desc — deterministic file order
  merged.sort(function(a, b) {
    var da = a.InvoiceDate || '';
    var db = b.InvoiceDate || '';
    if (da !== db) return db < da ? -1 : 1;
    var ka = String(a.InvoiceNumber || '');
    var kb = String(b.InvoiceNumber || '');
    return kb < ka ? -1 : 1;
  });

  return { merged: merged, added: added, updated: updated, noKey: noKey, workdatePreserved: workdatePreserved };
}


// ══════════════════════════════════════════════════════════════════════════
// SANITY CHECKS (port of merge_invoices.py verdict logic)
// ══════════════════════════════════════════════════════════════════════════

function _wimRunSanityChecks_(existing, merged, dateRange) {
  var warnings = [];
  var stops = [];

  // Index by InvoiceNumber for record-level comparisons
  var preIdx = {}, postIdx = {};
  existing.forEach(function(r) { if (r.InvoiceNumber) preIdx[String(r.InvoiceNumber)] = r; });
  merged.forEach(function(r) { if (r.InvoiceNumber) postIdx[String(r.InvoiceNumber)] = r; });
  var preKeys = Object.keys(preIdx);
  var postKeys = Object.keys(postIdx);

  // ── 1. Record delta ──
  var preSet = {};
  preKeys.forEach(function(k) { preSet[k] = true; });
  var removedKeys = [];
  preKeys.forEach(function(k) { if (!(k in postIdx)) removedKeys.push(k); });
  if (removedKeys.length > 0) {
    stops.push('FATAL: ' + removedKeys.length + ' records present pre-merge are missing post-merge. Merge should never remove. Aborting.');
  }

  // ── 2. Total revenue drift ──
  var preRev = 0, postRev = 0;
  existing.forEach(function(r) { preRev += (Number(r.Total) || 0); });
  merged.forEach(function(r) { postRev += (Number(r.Total) || 0); });
  var diffRev = postRev - preRev;
  var diffPct = preRev > 0 ? (diffRev / preRev * 100) : 0;
  if (Math.abs(diffPct) >= WIM_STOP_TOTAL_REV_DRIFT_PCT) {
    stops.push('FATAL: total revenue shifted by ' + diffPct.toFixed(2) + '% — exceeds STOP threshold (' + WIM_STOP_TOTAL_REV_DRIFT_PCT + '%). Likely a bad export.');
  } else if (Math.abs(diffPct) >= WIM_WARN_TOTAL_REV_DRIFT_PCT) {
    warnings.push('Total revenue shifted ' + diffPct.toFixed(2) + '% — exceeds WARN threshold (' + WIM_WARN_TOTAL_REV_DRIFT_PCT + '%).');
  }

  // ── 3. Per-branch revenue drift ──
  var preByBranch = {}, postByBranch = {};
  existing.forEach(function(r) {
    var b = r.Branch || '(no branch)';
    preByBranch[b] = (preByBranch[b] || 0) + (Number(r.Total) || 0);
  });
  merged.forEach(function(r) {
    var b = r.Branch || '(no branch)';
    postByBranch[b] = (postByBranch[b] || 0) + (Number(r.Total) || 0);
  });
  var allBranches = {};
  Object.keys(preByBranch).forEach(function(b) { allBranches[b] = true; });
  Object.keys(postByBranch).forEach(function(b) { allBranches[b] = true; });
  var branchDrift = [];
  Object.keys(allBranches).sort().forEach(function(b) {
    var a = preByBranch[b] || 0;
    var z = postByBranch[b] || 0;
    var pct = a > 0 ? ((z - a) / a * 100) : (z === 0 ? 0 : 100);
    branchDrift.push({ branch: b, pre: a, post: z, diff: z - a, pct: pct });
    if (Math.abs(pct) >= WIM_WARN_BRANCH_REV_DRIFT_PCT) {
      warnings.push("Branch '" + b + "': revenue shifted " + pct.toFixed(2) + "% ($" + _wimFmtMoney_(a) + ' → $' + _wimFmtMoney_(z) + ')');
    }
  });

  // ── 4. Retroactive edits in common records ──
  var commonKeys = [];
  preKeys.forEach(function(k) { if (k in postIdx) commonKeys.push(k); });
  var retroTotal = 0, retroSub = 0, retroTech = 0;
  commonKeys.forEach(function(k) {
    var a = preIdx[k], z = postIdx[k];
    if ((Number(a.Total) || 0) !== (Number(z.Total) || 0)) retroTotal++;
    if ((Number(a.SubTotal) || 0) !== (Number(z.SubTotal) || 0)) retroSub++;
    if ((a.Tech || '') !== (z.Tech || '')) retroTech++;
  });
  var retroPct = commonKeys.length > 0 ? (retroTotal / commonKeys.length * 100) : 0;
  if (retroPct > WIM_WARN_RETRO_TOTAL_PCT) {
    warnings.push(retroPct.toFixed(2) + '% of existing records had Total changed — PestPac retroactively edited bills (or stale export). Verify.');
  }

  // ── 5. Date range sanity ──
  var today = new Date();
  var cutoffOld = new Date(today.getTime() - WIM_WARN_DATE_OUTSIDE_DAYS * 86400000);
  var cutoffFuture = new Date(today.getTime() + 7 * 86400000);
  var cutoffOldStr = _wimFmtDate_(cutoffOld);
  var cutoffFutureStr = _wimFmtDate_(cutoffFuture);
  if (dateRange.min && dateRange.min < cutoffOldStr) {
    warnings.push('Report contains invoice dates older than ' + WIM_WARN_DATE_OUTSIDE_DAYS + ' days (min=' + dateRange.min + '). Verify date filter.');
  }
  if (dateRange.max && dateRange.max > cutoffFutureStr) {
    warnings.push('Report contains future invoice dates (max=' + dateRange.max + '). Verify export.');
  }

  // ── Verdict ──
  var verdict;
  if (stops.length > 0) verdict = 'STOP';
  else if (warnings.length > 0) verdict = 'WARN';
  else verdict = 'PASS';

  return {
    verdict: verdict,
    warnings: warnings,
    stops: stops,
    stats: {
      preCount: preKeys.length,
      postCount: postKeys.length,
      removedCount: removedKeys.length,
      preRev: preRev,
      postRev: postRev,
      diffRev: diffRev,
      diffPct: diffPct,
      branchDrift: branchDrift,
      retroTotal: retroTotal,
      retroSub: retroSub,
      retroTech: retroTech,
      retroPct: retroPct,
      commonN: commonKeys.length,
      dateRange: dateRange
    }
  };
}


// ══════════════════════════════════════════════════════════════════════════
// DRIVE BACKUP
// ══════════════════════════════════════════════════════════════════════════

function _wimSaveToDrive_(content, filename, folderId) {
  var blob = Utilities.newBlob(content, 'application/json', filename);
  var file;
  if (folderId) {
    var folder = DriveApp.getFolderById(folderId);
    file = folder.createFile(blob);
  } else {
    file = DriveApp.createFile(blob);
  }
  return file.getUrl();
}

function _wimTimestampedName_(prefix) {
  var d = new Date();
  var ts = d.getFullYear() + _wimPad_(d.getMonth() + 1) + _wimPad_(d.getDate()) + '-' +
           _wimPad_(d.getHours()) + _wimPad_(d.getMinutes()) + _wimPad_(d.getSeconds());
  return prefix + '-' + ts + '.json';
}


// ══════════════════════════════════════════════════════════════════════════
// GITHUB HELPERS
// ══════════════════════════════════════════════════════════════════════════

function _wimReadLatestCommitSha_() {
  try {
    var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
    if (!token) return null;
    var resp = UrlFetchApp.fetch(
      'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/commits/' + GH_BRANCH,
      { headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json' }, muteHttpExceptions: true }
    );
    if (resp.getResponseCode() !== 200) return null;
    return JSON.parse(resp.getContentText()).sha;
  } catch (e) {
    return null;
  }
}


// ══════════════════════════════════════════════════════════════════════════
// EMAIL
// ══════════════════════════════════════════════════════════════════════════

function _wimSendVerdictEmail_(recipient, ctx) {
  var emoji = ctx.verdict === 'PASS' ? '✅' : (ctx.verdict === 'WARN' ? '⚠️' : '🛑');
  var subject = emoji + ' Weekly Invoice Merge ' + ctx.verdict +
                ' — ' + ctx.mergeResult.merged.length.toLocaleString() + ' invoices' +
                (ctx.verdict === 'STOP' ? ' (NOT PUSHED)' : '');
  var body = _wimBuildVerdictEmailBody_(ctx);
  MailApp.sendEmail({
    to: recipient,
    subject: subject,
    body: body
  });
}

function _wimBuildVerdictEmailBody_(ctx) {
  var s = ctx.sanity.stats;
  var lines = [];
  lines.push('Verdict: ' + ctx.verdict);
  lines.push('Source:  ' + ctx.attachmentName);
  lines.push('Elapsed: ' + ctx.elapsedSec + 's');
  lines.push('');

  if (ctx.verdict === 'STOP') {
    lines.push('🛑 NOT PUSHED. The proposed cache failed sanity checks.');
    lines.push('');
    lines.push('Rejected cache saved to Drive:');
    lines.push('  ' + (ctx.rejectedCacheUrl || '(save failed)'));
    lines.push('');
    lines.push('Pre-merge backup of LIVE cache (for safety):');
    lines.push('  ' + (ctx.preMergeBackupUrl || '(save failed)'));
    lines.push('');
    lines.push('FATAL ISSUES:');
    ctx.sanity.stops.forEach(function(x) { lines.push('  • ' + x); });
    lines.push('');
  } else {
    if (ctx.commitSha) {
      lines.push('Pushed to GitHub:');
      lines.push('  Commit: ' + ctx.commitSha.substring(0, 7));
      lines.push('  https://github.com/' + GH_OWNER + '/' + GH_REPO + '/commit/' + ctx.commitSha);
    } else {
      lines.push('Pushed to GitHub (commit SHA lookup failed — push itself succeeded).');
    }
    lines.push('');
    lines.push('Pre-merge backup of prior cache:');
    lines.push('  ' + (ctx.preMergeBackupUrl || '(save failed)'));
    lines.push('');
  }

  if (ctx.verdict === 'WARN') {
    lines.push('⚠️  Warnings (verify before next refresh):');
    ctx.sanity.warnings.forEach(function(w) { lines.push('  • ' + w); });
    lines.push('');
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('MERGE STATS');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  Added new:        ' + ctx.mergeResult.added.toLocaleString());
  lines.push('  Updated existing: ' + ctx.mergeResult.updated.toLocaleString());
  if (ctx.mergeResult.workdatePreserved) lines.push('  WorkDate times preserved: ' + ctx.mergeResult.workdatePreserved.toLocaleString() + ' (CSV was date-only; existing API timestamp kept)');
  if (ctx.mergeResult.noKey) lines.push('  Skipped no-key:   ' + ctx.mergeResult.noKey.toLocaleString());
  lines.push('  Pre → Post:       ' + s.preCount.toLocaleString() + ' → ' + s.postCount.toLocaleString());
  if (s.removedCount > 0) lines.push('  Removed:          ' + s.removedCount + ' (UNEXPECTED)');
  lines.push('');
  lines.push('REVENUE');
  lines.push('  Pre:   $' + _wimFmtMoney_(s.preRev));
  lines.push('  Post:  $' + _wimFmtMoney_(s.postRev));
  lines.push('  Diff:  ' + (s.diffRev >= 0 ? '+' : '') + '$' + _wimFmtMoney_(s.diffRev) + '  (' + (s.diffPct >= 0 ? '+' : '') + s.diffPct.toFixed(2) + '%)');
  lines.push('');
  lines.push('PER-BRANCH REVENUE DRIFT');
  s.branchDrift.forEach(function(b) {
    var flag = (Math.abs(b.pct) >= WIM_WARN_BRANCH_REV_DRIFT_PCT) ? ' ⚠️' : '';
    var name = _wimRPad_(b.branch, 28);
    lines.push('  ' + name + '  $' + _wimLPad_(_wimFmtMoney_(b.pre), 13) + ' → $' + _wimLPad_(_wimFmtMoney_(b.post), 13) + '  (' + (b.pct >= 0 ? '+' : '') + b.pct.toFixed(2) + '%)' + flag);
  });
  lines.push('');
  lines.push('RETROACTIVE EDITS');
  lines.push('  Total changed:    ' + s.retroTotal.toLocaleString() + ' of ' + s.commonN.toLocaleString() + ' (' + s.retroPct.toFixed(2) + '%)');
  lines.push('  SubTotal changed: ' + s.retroSub.toLocaleString());
  lines.push('  Tech changed:     ' + s.retroTech.toLocaleString());
  lines.push('');
  lines.push('REPORT DATE WINDOW');
  lines.push('  ' + (s.dateRange.min || '?') + ' → ' + (s.dateRange.max || '?'));
  lines.push('');
  lines.push('INVOICE TYPES IN REPORT');
  lines.push('  ' + (ctx.parsed.typesBreakdown || '(none)'));
  lines.push('');
  if (ctx.parsed.skippedShort || ctx.parsed.skippedMissingRequired) {
    lines.push('PARSER SKIPS (informational)');
    if (ctx.parsed.skippedShort) lines.push('  Short rows:       ' + ctx.parsed.skippedShort);
    if (ctx.parsed.skippedMissingRequired) lines.push('  Missing required: ' + ctx.parsed.skippedMissingRequired);
    lines.push('');
  }

  if (ctx.verdict === 'STOP') {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('TO ROLL BACK MANUALLY');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('Nothing was pushed. The live dashboard is still using the pre-merge cache.');
    lines.push('If the rejected cache turns out to be correct after inspection, you can:');
    lines.push('  1. Download the rejected cache from the Drive link above');
    lines.push('  2. Save it locally as cache-invoices.json');
    lines.push('  3. cd into the repo folder and git add/commit/push it manually');
  }

  return lines.join('\n');
}

function _wimSendAlertEmail_(recipient, subject, body) {
  if (!recipient) return;
  MailApp.sendEmail({ to: recipient, subject: subject, body: body });
}

function _wimFmtMoney_(n) {
  var v = Math.round(Number(n) || 0);
  var s = String(Math.abs(v));
  var parts = [];
  while (s.length > 3) { parts.unshift(s.slice(-3)); s = s.slice(0, -3); }
  parts.unshift(s);
  return (v < 0 ? '-' : '') + parts.join(',');
}

function _wimFmtDate_(d) {
  return d.getFullYear() + '-' + _wimPad_(d.getMonth() + 1) + '-' + _wimPad_(d.getDate());
}

function _wimLPad_(s, n) {
  s = String(s);
  while (s.length < n) s = ' ' + s;
  return s;
}

function _wimRPad_(s, n) {
  s = String(s);
  while (s.length < n) s = s + ' ';
  return s;
}
