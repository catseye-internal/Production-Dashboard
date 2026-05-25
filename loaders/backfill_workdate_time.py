#!/usr/bin/env python3
"""
Production Dashboard — Historical WorkDate Timestamp Backfill (ONE-TIME script)

The PestPac /Invoices API returns WorkDate as a full ISO timestamp
("2026-05-20T07:22:00") which represents the actual on-site time of the tech
visit. Our CSV loaders historically stripped the time portion, so most invoices
in the cache currently have date-only WorkDate values.

This script fixes that retroactively by:
  1. Reading cache-invoices.json
  2. For each invoice missing a timestamp on WorkDate, hitting
     /Invoices?invoiceNumber={n} to fetch the full record
  3. Patching ONLY the WorkDate field (surgical, no other field touched)
  4. Writing the new cache + sanity checking
  5. Optionally pushing to GitHub

USAGE
  cd "/Users/joedingwall/Desktop/Claude Assets/PRODUCTION DASHBOARD/PRODUCTION DASHBOARD"
  python3 loaders/backfill_workdate_time.py

  # Resume an interrupted run:
  python3 loaders/backfill_workdate_time.py --resume

  # Dry-run — process 100 records, do NOT save:
  python3 loaders/backfill_workdate_time.py --limit 100 --dry-run

DESIGN NOTES
  - Idempotent: re-running skips records already patched. Safe to resume.
  - Auto-backup: writes a copy of the live cache before mutating.
  - Progress checkpoint every 500 records: state saved to a sidecar file so
    a crash mid-run doesn't lose all progress.
  - Rate-limited: 25 parallel API calls per batch + 200ms pause between batches.
    Keeps PestPac happy and stays well under the daily quota.
"""

import json
import sys
import time
import base64
import urllib.request
import urllib.parse
from datetime import datetime
from pathlib import Path
import argparse
import shutil
import concurrent.futures

# ── PestPac credentials (same as CacheRefresh.gs) ──
PP_CLIENT_ID     = 'OjCMV6522ip62LlhU08LrG5U61oa'
PP_CLIENT_SECRET = 'MicEfYLkplnarU18fHLH3VCfxhMa'
PP_USERNAME      = 'jdingwall@catseyepest.com'
PP_PASSWORD      = 'C@ts3y3!!'
PP_API_KEY       = 'IJ4Goon7ZW9EbvAvPdO33Q6Vtnt5oysT'
PP_TENANT_ID     = '103012'
PP_TOKEN_URL     = 'https://is.workwave.com/oauth2/token?scope=openid'
PP_API_BASE      = 'https://api.workwave.com/pestpac/v1'

DEFAULT_CACHE_PATH = '/Users/joedingwall/Desktop/Claude Assets/PRODUCTION DASHBOARD/PRODUCTION DASHBOARD/cache-invoices.json'
CHECKPOINT_SUFFIX = '.workdate-backfill-checkpoint.json'

# Concurrency & rate limiting
BATCH_SIZE = 25
BATCH_PAUSE_S = 0.2
CHECKPOINT_EVERY = 500
PROGRESS_LOG_EVERY = 100


# ── PestPac auth + fetch helpers ──

def get_token():
    creds = base64.b64encode(f'{PP_CLIENT_ID}:{PP_CLIENT_SECRET}'.encode()).decode()
    payload = urllib.parse.urlencode({
        'grant_type': 'password',
        'username': PP_USERNAME,
        'password': PP_PASSWORD
    }).encode()
    req = urllib.request.Request(PP_TOKEN_URL, data=payload, method='POST')
    req.add_header('Authorization', 'Basic ' + creds)
    req.add_header('Content-Type', 'application/x-www-form-urlencoded')
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())['access_token']


def fetch_invoice_workdate(token, invoice_number):
    """Returns the full WorkDate timestamp string for the given invoice, or None."""
    url = PP_API_BASE + '/Invoices?invoiceNumber=' + urllib.parse.quote(str(invoice_number))
    req = urllib.request.Request(url)
    req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('apikey', PP_API_KEY)
    req.add_header('tenant-id', PP_TENANT_ID)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        return None
    inv = data[0] if isinstance(data, list) else data
    if not inv:
        return None
    return inv.get('WorkDate') or None


# ── Helpers ──

def has_timestamp(workdate_str):
    """True if the WorkDate string includes a non-midnight time portion."""
    if not workdate_str:
        return False
    s = str(workdate_str)
    if 'T' not in s:
        return False
    time_part = s.split('T', 1)[1]
    return time_part not in ('', '00:00:00', '00:00:00.000')


def write_checkpoint(path, processed_keys):
    """Save progress so a crash doesn't lose everything."""
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'processed': list(processed_keys), 'savedAt': datetime.utcnow().isoformat() + 'Z'}, f)


def load_checkpoint(path):
    if not Path(path).exists():
        return set()
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return set(data.get('processed', []))
    except Exception:
        return set()


# ── Main backfill ──

def backfill(cache_path, limit=None, dry_run=False, resume=False):
    cache_path = Path(cache_path)
    checkpoint_path = Path(str(cache_path) + CHECKPOINT_SUFFIX)

    print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"📦 WorkDate Timestamp Backfill")
    print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"  Cache: {cache_path}")
    print(f"  Mode:  {'DRY-RUN' if dry_run else 'LIVE'}{'  (resuming from checkpoint)' if resume else ''}")
    if limit:
        print(f"  Limit: {limit} records (testing)")

    # 1. Load cache
    with open(cache_path, 'r', encoding='utf-8') as f:
        cache = json.load(f)
    invs = cache.get('invoices', [])
    print(f"  Total invoices in cache: {len(invs):,}")

    # 2. Identify records that need backfill (WorkDate is date-only or missing time)
    candidates_idx = []
    already_has_time = 0
    no_invoice_number = 0
    for i, inv in enumerate(invs):
        if not inv.get('InvoiceNumber'):
            no_invoice_number += 1
            continue
        if has_timestamp(inv.get('WorkDate')):
            already_has_time += 1
            continue
        candidates_idx.append(i)
    print(f"  Records already with timestamp (skip):  {already_has_time:,}")
    print(f"  Records without InvoiceNumber (skip):   {no_invoice_number:,}")
    print(f"  Candidates for backfill:                {len(candidates_idx):,}")

    # 3. Load checkpoint (resume)
    processed_keys = load_checkpoint(checkpoint_path) if resume else set()
    if processed_keys:
        print(f"  Checkpoint loaded: {len(processed_keys):,} already processed in prior run")
        candidates_idx = [i for i in candidates_idx if str(invs[i]['InvoiceNumber']) not in processed_keys]
        print(f"  Remaining to process: {len(candidates_idx):,}")

    # 4. Apply limit (for dry-runs)
    if limit:
        candidates_idx = candidates_idx[:limit]
        print(f"  Limited to first {len(candidates_idx)} for this run")

    if len(candidates_idx) == 0:
        print("\n✅ Nothing to backfill — every invoice already has a timestamp.")
        if checkpoint_path.exists() and not dry_run:
            checkpoint_path.unlink()
            print(f"   Removed stale checkpoint file: {checkpoint_path.name}")
        return

    # 5. Pre-flight backup of the cache
    backup_path = None
    if not dry_run:
        ts = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup_path = cache_path.parent / f"cache-invoices.backup-pre-workdate-backfill-{ts}.json"
        shutil.copy2(cache_path, backup_path)
        print(f"💾 Backup: {backup_path.name}")

    # 6. Auth
    print(f"🔑 Fetching PestPac access token...")
    token = get_token()
    print(f"   Token acquired (len={len(token)})")

    # 7. Process in parallel batches
    print(f"\n🚀 Starting backfill — {len(candidates_idx):,} records in batches of {BATCH_SIZE}...")
    print(f"   ETA: ~{(len(candidates_idx) * 1.5 / BATCH_SIZE):.0f}s ({(len(candidates_idx) * 1.5 / BATCH_SIZE / 60):.1f} min)")
    print()

    t0 = time.time()
    patched = 0
    missed = 0   # API returned but no WorkDate
    failed = 0   # API call itself failed
    last_log_at = 0

    def fetch_one(idx):
        inv_num = invs[idx]['InvoiceNumber']
        wd = fetch_invoice_workdate(token, inv_num)
        return (idx, inv_num, wd)

    for batch_start in range(0, len(candidates_idx), BATCH_SIZE):
        batch = candidates_idx[batch_start:batch_start + BATCH_SIZE]
        with concurrent.futures.ThreadPoolExecutor(max_workers=BATCH_SIZE) as ex:
            results = list(ex.map(fetch_one, batch))

        for idx, inv_num, wd in results:
            if wd is None:
                failed += 1
                continue
            if not has_timestamp(wd):
                # API returned, but the WorkDate has no time portion either
                missed += 1
                processed_keys.add(str(inv_num))
                continue
            invs[idx]['WorkDate'] = wd
            patched += 1
            processed_keys.add(str(inv_num))

        # Progress logging
        done = batch_start + len(batch)
        if done - last_log_at >= PROGRESS_LOG_EVERY:
            elapsed = time.time() - t0
            rate = done / elapsed if elapsed > 0 else 0
            remaining = len(candidates_idx) - done
            eta_s = remaining / rate if rate > 0 else 0
            print(f"  [{done:>6,} / {len(candidates_idx):,}]  patched={patched:>6,}  missed={missed:>5,}  failed={failed:>4,}  rate={rate:.0f}/s  eta={eta_s/60:.1f}m")
            last_log_at = done

        # Checkpoint every CHECKPOINT_EVERY records
        if not dry_run and done % CHECKPOINT_EVERY == 0:
            write_checkpoint(checkpoint_path, processed_keys)

        # Rate-limit pause
        time.sleep(BATCH_PAUSE_S)

    elapsed = time.time() - t0
    print()
    print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"✅ Backfill complete in {elapsed:.1f}s ({elapsed/60:.1f} min)")
    print(f"   Patched:  {patched:,}")
    print(f"   Missed:   {missed:,}  (API returned record but WorkDate had no time)")
    print(f"   Failed:   {failed:,}  (API call itself failed — retry later)")
    print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    if dry_run:
        print(f"\n⚠️  DRY-RUN — cache NOT written. Patched values were computed but discarded.")
        return

    # 8. Write the patched cache
    cache['invoices'] = invs
    cache['lastWorkdateBackfillAt'] = datetime.utcnow().isoformat() + 'Z'
    with open(cache_path, 'w', encoding='utf-8') as f:
        json.dump(cache, f, separators=(',', ':'))
    size_mb = cache_path.stat().st_size / 1024 / 1024
    print(f"\n✅ Wrote {cache_path}  ({size_mb:.2f} MB)")

    # 9. Final checkpoint write + cleanup if all candidates processed
    write_checkpoint(checkpoint_path, processed_keys)
    print(f"   Checkpoint: {checkpoint_path.name}")

    # 10. Sanity verification — spot-check a few patched records
    print(f"\n🔎 Sanity check — sampling 5 patched records:")
    sampled = 0
    for inv in invs:
        if sampled >= 5:
            break
        if has_timestamp(inv.get('WorkDate')):
            sampled += 1
            print(f"  Invoice {inv.get('InvoiceNumber')}: WorkDate = {inv.get('WorkDate')} | Tech = {inv.get('Tech') or '-'} | {inv.get('Branch') or '-'}")

    print(f"\n💡 Next steps:")
    print(f"     1. Spot-check the cache in a JSON viewer (or grep for '\"WorkDate\":\"2026-')")
    print(f"     2. If satisfied, commit + push:")
    print(f"        cd \"{cache_path.parent}\" && git add cache-invoices.json && git commit -m \"Backfill WorkDate timestamps from PestPac API\" && git pull --rebase --autostash origin main && git push origin main")
    print(f"     3. Backup file is at: {backup_path}")
    print(f"     4. (Optional) Re-run with --resume to fix any 'failed' records (network blips, retry later)")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', default=DEFAULT_CACHE_PATH, help='Path to cache-invoices.json')
    parser.add_argument('--limit', type=int, default=None, help='Cap the number of records (for testing)')
    parser.add_argument('--dry-run', action='store_true', help='Compute timestamps but do not write')
    parser.add_argument('--resume', action='store_true', help='Skip records already processed (from checkpoint)')
    args = parser.parse_args()
    backfill(args.cache, limit=args.limit, dry_run=args.dry_run, resume=args.resume)
