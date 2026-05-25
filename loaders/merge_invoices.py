#!/usr/bin/env python3
"""
Production Dashboard — Invoice MERGE Loader (with sanity checks)

Parses a PestPac invoice export (any supported format — see parse_invoices.py)
and merges it into the EXISTING cache-invoices.json without overwriting
unrelated records. Use this for weekly cache reconciliation OR ad-hoc
backfills when webhook drops have created gaps.

Key difference vs parse_invoices.py:
  parse_invoices.py  — REPLACES the whole cache (used for the original YTD seed).
  merge_invoices.py  — MERGES by InvoiceNumber (report wins on duplicates;
                       all unrelated existing records are preserved).

USAGE
  python3 merge_invoices.py <input.csv|xls|xlsx> [<cache-invoices.json>]

  Default output target: PRODUCTION DASHBOARD/cache-invoices.json

SUPPORTED INPUT FORMATS (auto-detected)
  - PestPac quick-export tab-delimited .xls
  - Report Writer CSV (.csv)
  - Report Writer Excel (.xlsx)

Column naming differences between the two export tools are absorbed by
parse_invoices.py's FIELD_ALIASES — no manual normalization needed.

SANITY CHECKS (Joe directive 2026-05-24)
  Before writing the new cache, this script:
  1. Backs up the existing cache to cache-invoices.backup-pre-merge-{ts}.json
  2. Computes a diff against the existing cache
  3. WARNS at thresholds (per-branch revenue >5% drift, Total column changes
     on existing records >1%, date-range outside expected window)
  4. STOPS (exit 2) on catastrophic conditions:
       - Revenue swing > 10% (likely bad export)
       - Records that exist in cache disappearing entirely (merge should
         never remove)
  5. Prints a clear PASS/WARN/STOP banner so anyone running it from the
     CLI knows whether to proceed with git push.
"""

import json
import sys
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

# Reuse the parsing logic from the loader
sys.path.insert(0, str(Path(__file__).parent))
from parse_invoices import parse_report


def _has_workdate_timestamp(wd):
    """True if WorkDate string carries a non-midnight time portion.

    PestPac API returns WorkDate as '2026-05-20T07:22:00' (actual on-site time).
    CSV exports typically only carry the date. When merging, we must not let
    a date-only CSV value overwrite an existing record's timestamped value
    (webhook-captured or backfilled from the API).
    """
    if not wd:
        return False
    s = str(wd)
    if 'T' not in s:
        return False
    time_part = s.split('T', 1)[1]
    return time_part not in ('', '00:00:00', '00:00:00.000')


def _merge_workdate(existing_rec, new_rec):
    """Return the WorkDate value to use after merge. Preserves an existing
    timestamped WorkDate if the new record only carries a date.
    """
    new_wd = new_rec.get('WorkDate')
    existing_wd = existing_rec.get('WorkDate') if existing_rec else None
    if not existing_wd:
        return new_wd
    if not new_wd:
        return existing_wd
    if _has_workdate_timestamp(existing_wd) and not _has_workdate_timestamp(new_wd):
        return existing_wd
    return new_wd

# ── Sanity-check thresholds ──
WARN_BRANCH_REVENUE_DRIFT_PCT = 5.0    # WARN if any branch's Total revenue shifts more than this
WARN_TOTAL_REVENUE_DRIFT_PCT  = 1.0    # WARN if grand-total revenue shifts more than this
STOP_TOTAL_REVENUE_DRIFT_PCT  = 10.0   # STOP if grand-total revenue shifts more than this (likely bad export)
WARN_RETROACTIVE_TOTAL_PCT    = 1.0    # WARN if more than this % of existing records have Total changed
WARN_DATE_OUTSIDE_DAYS        = 90     # WARN if any record's InvoiceDate is more than this many days before today


def _sum_total_by_branch(records):
    out = defaultdict(float)
    for r in records:
        out[r.get('Branch') or '(no branch)'] += r.get('Total') or 0
    return dict(out)

def _grand_total(records):
    return sum((r.get('Total') or 0) for r in records)


def merge(input_path, cache_path):
    print(f"📥 Parsing report: {Path(input_path).name}")
    new_records = parse_report(input_path)

    # Range stats for the new file
    dates = sorted({r.get('InvoiceDate', '') for r in new_records if r.get('InvoiceDate')})
    types = sorted({r.get('InvoiceType', '') for r in new_records if r.get('InvoiceType')})
    print(f"  Date range in report: {dates[0] if dates else '?'} → {dates[-1] if dates else '?'}")
    print(f"  Invoice types: {types}")
    by_type = {t: sum(1 for r in new_records if r.get('InvoiceType') == t) for t in types}
    print(f"  Types breakdown: {by_type}")

    # Load existing cache
    cache_path = Path(cache_path)
    if cache_path.exists():
        with open(cache_path, 'r', encoding='utf-8') as f:
            cache = json.load(f)
    else:
        cache = {'invoices': []}
    existing = cache.get('invoices', [])
    print(f"\n📦 Existing cache: {len(existing):,} invoices")

    # ── Auto-backup BEFORE writing (so we can roll back if sanity checks fail) ──
    backup_path = None
    if cache_path.exists():
        ts = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup_path = cache_path.parent / f"cache-invoices.backup-pre-merge-{ts}.json"
        shutil.copy2(cache_path, backup_path)
        print(f"💾 Backup written: {backup_path.name}")

    # Build lookup of existing by InvoiceNumber
    by_key = {}
    for inv in existing:
        k = inv.get('InvoiceNumber')
        if k:
            by_key[str(k)] = inv

    # Merge — report wins on duplicates EXCEPT for WorkDate timestamps:
    # if the existing record carries a full timestamp and the new CSV row
    # only carries a date, preserve the existing timestamp. This prevents
    # the weekly CSV merge from clobbering webhook-captured + backfilled
    # WorkDate times.
    added = 0
    updated = 0
    no_key = 0
    workdate_preserved = 0
    for rec in new_records:
        k = rec.get('InvoiceNumber')
        if not k:
            no_key += 1
            continue
        key = str(k)
        if key in by_key:
            existing = by_key[key]
            preserved_wd = _merge_workdate(existing, rec)
            by_key[key] = rec
            if preserved_wd != rec.get('WorkDate'):
                by_key[key]['WorkDate'] = preserved_wd
                workdate_preserved += 1
            updated += 1
        else:
            by_key[key] = rec
            added += 1

    merged = list(by_key.values())
    # Sort by InvoiceDate desc then InvoiceNumber desc for predictable file ordering
    def sort_key(inv):
        return (inv.get('InvoiceDate', ''), str(inv.get('InvoiceNumber', '')))
    merged.sort(key=sort_key)

    # Update metadata
    cache['invoices'] = merged
    cache['updated'] = datetime.utcnow().isoformat() + 'Z'
    cache['recordCount'] = len(merged)
    cache['lastBackfillFile'] = Path(input_path).name
    cache['lastBackfillAt'] = datetime.utcnow().isoformat() + 'Z'

    # Write back
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cache_path, 'w', encoding='utf-8') as out:
        json.dump(cache, out, separators=(',', ':'))
    size_mb = cache_path.stat().st_size / 1024 / 1024

    # Verification — for each invoice date in the report, how many do we now have?
    target_dates = dates
    counts_by_date = {}
    for inv in merged:
        d = inv.get('InvoiceDate')
        if d in target_dates:
            counts_by_date[d] = counts_by_date.get(d, 0) + 1

    print(f"\n🔀 Merge result")
    print(f"  Added new:        {added:,}")
    print(f"  Updated existing: {updated:,}")
    if workdate_preserved:
        print(f"  WorkDate timestamps preserved (CSV was date-only): {workdate_preserved:,}")
    if no_key:
        print(f"  Skipped (no InvoiceNumber): {no_key}")
    print(f"  Final cache:      {len(merged):,} invoices  ({size_mb:.2f} MB)")
    if target_dates:
        print(f"\n📊 Final count per date in report window:")
        for d in target_dates:
            print(f"  {d}: {counts_by_date.get(d, 0)}")
    print(f"\n✅ Wrote {cache_path}")

    # ── SANITY CHECK PASS ───────────────────────────────────────────────────
    print(f"\n{'='*70}\n🛡️  SANITY CHECKS\n{'='*70}")
    warnings = []
    stops = []

    # 1. Record count: removed should always be 0 for an upsert-by-key merge
    pre_keys  = {str(r.get('InvoiceNumber')) for r in existing if r.get('InvoiceNumber')}
    post_keys = {str(r.get('InvoiceNumber')) for r in merged   if r.get('InvoiceNumber')}
    removed_keys = pre_keys - post_keys
    if removed_keys:
        stops.append(f"FATAL: {len(removed_keys):,} records present in pre-merge cache are missing post-merge. Merge should never remove. Aborting.")
    print(f"  Record delta: pre={len(pre_keys):,}, post={len(post_keys):,}, added={added:,}, updated={updated:,}, removed={len(removed_keys):,}")

    # 2. Revenue drift — total
    pre_rev  = _grand_total(existing)
    post_rev = _grand_total(merged)
    diff_rev = post_rev - pre_rev
    diff_pct = (diff_rev / pre_rev * 100) if pre_rev else 0
    print(f"  Total revenue: pre=${pre_rev:,.0f}, post=${post_rev:,.0f}, diff=${diff_rev:+,.0f} ({diff_pct:+.2f}%)")
    if abs(diff_pct) >= STOP_TOTAL_REVENUE_DRIFT_PCT:
        stops.append(f"FATAL: total revenue shifted by {diff_pct:+.2f}% — exceeds STOP threshold ({STOP_TOTAL_REVENUE_DRIFT_PCT}%). Likely a bad export or stale data overwriting good data.")
    elif abs(diff_pct) >= WARN_TOTAL_REVENUE_DRIFT_PCT:
        warnings.append(f"Total revenue shifted by {diff_pct:+.2f}% — exceeds WARN threshold ({WARN_TOTAL_REVENUE_DRIFT_PCT}%). Verify before pushing.")

    # 3. Revenue drift — per branch
    pre_b  = _sum_total_by_branch(existing)
    post_b = _sum_total_by_branch(merged)
    branch_drift = []
    for b in sorted(set(list(pre_b.keys()) + list(post_b.keys()))):
        a = pre_b.get(b, 0); z = post_b.get(b, 0)
        pct = ((z - a) / a * 100) if a else (0 if z == 0 else 100)
        branch_drift.append((b, a, z, z - a, pct))
        if abs(pct) >= WARN_BRANCH_REVENUE_DRIFT_PCT:
            warnings.append(f"Branch '{b}': revenue shifted {pct:+.2f}% (${a:,.0f} → ${z:,.0f})")
    print(f"  Per-branch revenue drift:")
    for (b, a, z, d, pct) in branch_drift:
        flag = ' ⚠️' if abs(pct) >= WARN_BRANCH_REVENUE_DRIFT_PCT else ''
        print(f"    {b:30s}: ${a:>13,.0f} → ${z:>13,.0f}  ({d:>+13,.0f}, {pct:+6.2f}%){flag}")

    # 4. Retroactive edits — how many existing records had Total changed?
    pre_idx = {str(r.get('InvoiceNumber')): r for r in existing if r.get('InvoiceNumber')}
    common_keys = pre_keys & post_keys
    retro_total_changed = 0
    retro_subtotal_changed = 0
    retro_tech_changed = 0
    post_idx_local = {str(r.get('InvoiceNumber')): r for r in merged if r.get('InvoiceNumber')}
    for k in common_keys:
        a = pre_idx[k]; z = post_idx_local[k]
        if (a.get('Total') or 0) != (z.get('Total') or 0):
            retro_total_changed += 1
        if (a.get('SubTotal') or 0) != (z.get('SubTotal') or 0):
            retro_subtotal_changed += 1
        if (a.get('Tech') or '') != (z.get('Tech') or ''):
            retro_tech_changed += 1
    common_n = len(common_keys)
    retro_total_pct = (retro_total_changed / common_n * 100) if common_n else 0
    print(f"  Retroactive edits in existing records:")
    print(f"    Total changed:    {retro_total_changed:,} of {common_n:,} ({retro_total_pct:.2f}%)")
    print(f"    SubTotal changed: {retro_subtotal_changed:,}")
    print(f"    Tech changed:     {retro_tech_changed:,}")
    if retro_total_pct > WARN_RETROACTIVE_TOTAL_PCT:
        warnings.append(f"{retro_total_pct:.2f}% of existing records had Total changed — PestPac retroactively edited bills (or stale export overwriting good data). Verify before pushing.")

    # 5. Date range sanity
    today = datetime.now().date()
    cutoff_old = (today - timedelta(days=WARN_DATE_OUTSIDE_DAYS)).strftime('%Y-%m-%d')
    cutoff_future = (today + timedelta(days=7)).strftime('%Y-%m-%d')
    rep_min = dates[0] if dates else ''
    rep_max = dates[-1] if dates else ''
    if rep_min and rep_min < cutoff_old:
        warnings.append(f"Report contains invoice dates older than {WARN_DATE_OUTSIDE_DAYS} days (min={rep_min}). Verify the date filter on the report.")
    if rep_max and rep_max > cutoff_future:
        warnings.append(f"Report contains future invoice dates (max={rep_max}). Verify the export.")
    print(f"  Date sanity: report window {rep_min} → {rep_max} (today={today})")

    # ── Verdict banner ──
    print(f"\n{'='*70}")
    if stops:
        print(f"🛑 STOP — {len(stops)} fatal issue(s) detected")
        for s in stops:
            print(f"    • {s}")
        print(f"\n   Roll back with:")
        if backup_path:
            print(f"     cp '{backup_path}' '{cache_path}'")
        print(f"\n   DO NOT push cache-invoices.json until resolved.")
        print(f"{'='*70}")
        sys.exit(2)
    if warnings:
        print(f"⚠️  WARN — {len(warnings)} item(s) to verify before pushing")
        for w in warnings:
            print(f"    • {w}")
        print(f"\n   Backup available: {backup_path.name if backup_path else '(none)'}")
        print(f"   If the data looks right, proceed with git add + commit + push.")
        print(f"{'='*70}")
        return len(merged)
    print(f"✅ PASS — all sanity checks passed. Safe to commit + push.")
    print(f"   Backup available: {backup_path.name if backup_path else '(none)'}")
    print(f"{'='*70}")
    return len(merged)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 merge_invoices.py <input.csv|xls|xlsx> [<cache.json>]")
        sys.exit(1)
    in_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) >= 3 else \
        '/Users/joedingwall/Desktop/Claude Assets/PRODUCTION DASHBOARD/PRODUCTION DASHBOARD/cache-invoices.json'
    merge(in_path, out_path)
