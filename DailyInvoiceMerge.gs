/**
 * DailyInvoiceMerge.gs — daily companion to WeeklyInvoiceMerge.gs
 *
 * Fires every weekday morning (Mon-Fri ~6:45 AM ET) after the PestPac Report
 * Writer "Daily 6AM ET" delivery lands. Reads the latest "[Production Dashboard]
 * Daily" email, downloads its ALL INVOICES CSV, runs the same parse + sanity
 * pipeline as the weekly script, and pushes the merged cache-invoices.json.
 *
 * Result: cache stays within ~24 hours of perfect against PestPac, eliminating
 * the manual merge_invoices.py runs Joe had to do mid-week for accuracy.
 *
 * Architecture notes — shares the same pipeline as WeeklyInvoiceMerge.gs.
 * Apps Script projects share global scope across .gs files, so all _wim* helpers
 * (parser, sanity checks, GitHub push, email verdict, etc.) are reused as-is.
 * Only two functions need daily-specific versions: the email search and the
 * top-level entry point that passes daily config into the pipeline.
 *
 * SETUP STEPS (one-time):
 *   1. Confirm PestPac Report Writer "Daily 6AM ET" is sending the CSV to
 *      joe@catseyeusa.com on weekdays.
 *   2. Paste this file into the Apps Script project (alongside WeeklyInvoiceMerge.gs).
 *   3. Run installDailyMergeTrigger() ONCE — creates the weekday 6:45 AM ET trigger.
 *
 * Joe directive 2026-05-28 — eliminates mid-week manual merge chore.
 */


// ══════════════════════════════════════════════════════════════════════════
// CONFIG — daily-specific (everything else reused from WeeklyInvoiceMerge.gs)
// ══════════════════════════════════════════════════════════════════════════

// Gmail search — broad query, refined by _dimSubjectMatches_ inside the loop.
// `newer_than:1d` keeps the search cheap (we expect today's email).
const DIM_EMAIL_SUBJECT_QUERY = 'subject:"[Production Dashboard] Daily" newer_than:1d';

// Attachment matcher — picks the CSV PestPac produces from the "Daily 6AM ET"
// Report Writer schedule. Falls back to any .csv if pattern doesn't match.
const DIM_ATTACHMENT_NAME_PATTERN = /^Daily 6AM ET_ALL INVOICES.*\.csv$/i;

// Subject pattern — extra safety on top of the Gmail search query
const DIM_SUBJECT_SUBSTR = '[Production Dashboard] Daily';

// Script Property keys (separate from weekly so dedup guards don't collide)
const DIM_LAST_RUN_PROP     = 'lastDailyMergeAt';
const DIM_LAST_SUBJECT_PROP = 'lastDailyMergeSubject';


// ══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINTS
// ══════════════════════════════════════════════════════════════════════════

/**
 * PRIMARY trigger — weekdays ~6:45 AM ET via installDailyMergeTrigger().
 * Silent on "no email found" (handles slow PestPac delivery). The next day's
 * trigger will catch any genuinely missed email when looking at fresh data.
 */
function dailyInvoiceMerge() {
  _dimRun_({ live: true, alertOnNoEmail: false, label: 'DAILY' });
}

/**
 * Dry-run — parses the latest daily email's CSV + runs sanity checks, but
 * does NOT push to GitHub or send the verdict email. Use this to validate
 * the build before letting the trigger fire.
 */
function testDailyInvoiceMerge() {
  _dimRun_({ live: false, alertOnNoEmail: false, label: 'DRY-RUN' });
}

/**
 * Force a re-run by clearing the daily dedup guard. Use if the trigger fired
 * but something went wrong and you want to re-process today's email.
 */
function clearDailyMergeDedupGuard() {
  PropertiesService.getScriptProperties().deleteProperty(DIM_LAST_SUBJECT_PROP);
  Logger.log('Daily dedup guard cleared. Next dailyInvoiceMerge() will re-process the latest email.');
}

/**
 * Install the weekday trigger. Run ONCE manually after pasting this file.
 * Fires Mon-Fri at ~6:45 AM ET — gives PestPac's 6 AM Report Writer email
 * a 45-minute landing window. (WeeklyInvoiceMerge.gs at 6:45 AM Monday still
 * runs in parallel as defensive redundancy — both pipelines have dedup guards
 * so the cache won't double-merge.)
 */
function installDailyMergeTrigger() {
  // Remove any existing daily triggers
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'dailyInvoiceMerge') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  if (removed > 0) Logger.log('Removed ' + removed + ' existing daily trigger(s).');

  // One trigger per weekday — Apps Script doesn't have an "every weekday" option;
  // create five individual triggers (Mon through Fri).
  var weekdays = [
    ScriptApp.WeekDay.MONDAY,
    ScriptApp.WeekDay.TUESDAY,
    ScriptApp.WeekDay.WEDNESDAY,
    ScriptApp.WeekDay.THURSDAY,
    ScriptApp.WeekDay.FRIDAY
  ];
  weekdays.forEach(function(wd) {
    ScriptApp.newTrigger('dailyInvoiceMerge')
      .timeBased()
      .onWeekDay(wd)
      .atHour(6)
      .nearMinute(45)
      .inTimezone('America/New_York')
      .create();
  });

  Logger.log('✅ Installed 5 weekday triggers:');
  Logger.log('   dailyInvoiceMerge — Mon-Fri ~6:45 AM ET');
  Logger.log('   (Weekly Monday backup at 7:30 AM ET still in place as redundancy)');
}


// ══════════════════════════════════════════════════════════════════════════
// CORE PIPELINE — wraps _wimRun_ pattern but uses DIM_ config
// ══════════════════════════════════════════════════════════════════════════

function _dimRun_(opts) {
  var live = !!opts.live;
  var alertOnNoEmail = !!opts.alertOnNoEmail;
  var label = opts.label || (live ? 'LIVE' : 'DRY-RUN');
  var t0 = new Date();
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log((live ? '🚀 Daily Invoice Merge — ' + label : '🧪 Daily Invoice Merge — ' + label) + ' — ' + t0.toISOString());
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  var recipient = PropertiesService.getScriptProperties().getProperty(WIM_RECIPIENT_PROP) || '';
  if (live && !recipient) {
    Logger.log('❌ Aborting: Script Property ' + WIM_RECIPIENT_PROP + ' is not set.');
    return;
  }

  try {
    // 1. Find the email — daily search
    Logger.log('1. Searching Gmail: ' + DIM_EMAIL_SUBJECT_QUERY);
    var emailHit = _dimFindLatestEmail_();
    if (!emailHit) {
      var msg = 'No matching daily email found in the last 24 hours.';
      Logger.log((alertOnNoEmail ? '❌ ' : 'ℹ️  ') + msg);
      if (live && alertOnNoEmail) {
        _wimSendAlertEmail_(recipient,
          '⚠️ Daily Invoice Merge — no email',
          'The daily merge job ran at ' + t0.toString() + ' but found no matching email. Check PestPac Report Writer.');
      }
      return;
    }
    Logger.log('   Found: "' + emailHit.subject + '" from ' + emailHit.from + ' @ ' + emailHit.date.toISOString());

    // Dedup guard — separate from weekly's guard
    var lastSubj = PropertiesService.getScriptProperties().getProperty(DIM_LAST_SUBJECT_PROP) || '';
    var thisSubj = emailHit.subject + '|' + emailHit.date.toISOString();
    if (lastSubj === thisSubj) {
      Logger.log('ℹ️  Already processed this email (dedup guard). Exiting silently.');
      return;
    }

    // 2. Pull CSV attachment
    Logger.log('2. Extracting CSV attachment...');
    var attachment = _wimFindCsvAttachment_(emailHit.message);
    if (!attachment) {
      throw new Error('No CSV attachment found in matching email.');
    }
    Logger.log('   Attachment: ' + attachment.getName() + ' (' + attachment.getSize() + ' bytes)');

    // 3. Parse the CSV — reuses WIM parser
    Logger.log('3. Parsing CSV with _wimParseInvoiceCsv_...');
    var parsed = _wimParseInvoiceCsv_(attachment.getDataAsString());
    Logger.log('   Parsed ' + parsed.records.length + ' records (' + (parsed.typesBreakdown || '') + ')');
    Logger.log('   Date range: ' + parsed.dateRange.min + ' → ' + parsed.dateRange.max);

    // 4. Read existing cache
    Logger.log('4. Reading existing cache-invoices.json...');
    var cacheResp = UrlFetchApp.fetch(
      'https://catseye-internal.github.io/Production-Dashboard/cache-invoices.json?v=' + Date.now(),
      { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } }
    );
    if (cacheResp.getResponseCode() !== 200) {
      throw new Error('Cache fetch failed: HTTP ' + cacheResp.getResponseCode());
    }
    var cache = JSON.parse(cacheResp.getContentText());
    var existing = cache.invoices || [];
    Logger.log('   Existing cache: ' + existing.length.toLocaleString() + ' invoices');

    // 5. Merge — reuses WIM merger
    Logger.log('5. Merging by InvoiceNumber...');
    var mergeResult = _wimMergeByInvoiceNumber_(existing, parsed.records);
    Logger.log('   Added new: ' + mergeResult.added + ' · Updated: ' + mergeResult.updated);
    Logger.log('   Final cache: ' + mergeResult.merged.length.toLocaleString() + ' invoices');

    // 6. Sanity checks — reuses WIM checks
    Logger.log('6. Running sanity checks...');
    var sanity = _wimRunSanityChecks_(existing, mergeResult.merged, parsed.dateRange);
    Logger.log('   Verdict: ' + sanity.verdict);
    (sanity.stops || []).forEach(function(f) { Logger.log('   🛑 ' + f); });
    (sanity.warnings || []).forEach(function(f) { Logger.log('   ⚠️  ' + f); });
    if (sanity.verdict === 'STOP') {
      Logger.log('🛑 STOP verdict — not pushing.');
      if (live) {
        _wimSendVerdictEmail_(recipient, {
          label: 'DAILY ' + label, verdict: 'STOP', sanity: sanity,
          mergeResult: mergeResult, parsed: parsed, t0: t0, attachment: attachment, commitSha: null
        });
      }
      return;
    }

    if (!live) {
      Logger.log('🧪 DRY-RUN — skipping GitHub push + verdict email.');
      return;
    }

    // 7. Push to GitHub — reuses CacheRefresh.gs::pushToGitHub_
    Logger.log('7. Pushing merged cache to GitHub...');
    cache.invoices = mergeResult.merged;
    cache.updated = new Date().toISOString();
    cache.recordCount = mergeResult.merged.length;
    cache.lastDailyMergeAt = new Date().toISOString();
    var jsonStr = JSON.stringify(cache);
    var ok = pushToGitHub_(jsonStr, WIM_CACHE_PATH,
      'Daily invoice merge — ' + parsed.dateRange.min + '→' + parsed.dateRange.max +
      ' (+' + mergeResult.added + ' new, ' + mergeResult.updated + ' updated)'
    );
    if (!ok) {
      throw new Error('GitHub push failed.');
    }
    Logger.log('   ✅ Push OK');

    // 8. Mark dedup + record last run
    PropertiesService.getScriptProperties().setProperty(DIM_LAST_SUBJECT_PROP, thisSubj);
    PropertiesService.getScriptProperties().setProperty(DIM_LAST_RUN_PROP, t0.toISOString());

    // 9. Send verdict email — reuses WIM template
    var commitSha = _wimReadLatestCommitSha_();
    _wimSendVerdictEmail_(recipient, {
      label: 'DAILY ' + label, verdict: sanity.verdict, sanity: sanity,
      mergeResult: mergeResult, parsed: parsed, t0: t0, attachment: attachment, commitSha: commitSha
    });

    Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    Logger.log('✅ Daily merge complete in ' + ((new Date() - t0) / 1000).toFixed(1) + 's | verdict: ' + sanity.verdict);
  } catch (err) {
    Logger.log('❌ Error: ' + err.message + '\n' + err.stack);
    if (live && recipient) {
      _wimSendAlertEmail_(recipient,
        '❌ Daily Invoice Merge — error',
        'The daily merge job failed at ' + t0.toString() + ':\n\n' + err.message + '\n\n' + err.stack);
    }
  }
}

/**
 * Daily-specific email finder — searches for emails matching the daily
 * Report Writer subject pattern in the last 24 hours.
 */
function _dimFindLatestEmail_() {
  var threads = GmailApp.search(DIM_EMAIL_SUBJECT_QUERY, 0, 10);
  if (!threads || threads.length === 0) return null;
  var bestMsg = null;
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var m = msgs[j];
      if (m.getSubject().indexOf(DIM_SUBJECT_SUBSTR) === -1) continue;
      // Belt-and-suspenders: skip the Weekly emails that might share part of the prefix
      if (m.getSubject().indexOf('Weekly') !== -1) continue;
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
