#!/usr/bin/env python3
"""
Production Dashboard — Invoice MERGE Loader

Parses a PestPac "Invoice List" report (tab-delimited despite .xls extension)
and merges it into the EXISTING cache-invoices.json without overwriting
unrelated records. Use this for one-time backfills when webhook drops have
created gaps.

Key difference vs parse_invoices.py:
  parse_invoices.py  — REPLACES the whole cache (used for the original YTD seed).
  merge_invoices.py  — MERGES by InvoiceNumber (report wins on duplicates;
                       all unrelated existing records are preserved).

USAGE
  python3 merge_invoices.py <input.xls> [<cache-invoices.json>]

  Default output target: PRODUCTION DASHBOARD/cache-invoices.json
"""

import json
import sys
from datetime import datetime
from pathlib import Path

# Reuse all the parsing logic from the original loader
sys.path.insert(0, str(Path(__file__).parent))
from parse_invoices import find_header_row, clean, to_number, to_iso_date, FIELD_MAP, NUMERIC_FIELDS, DATE_FIELDS
import csv

def parse_report(input_path):
    """Returns a list of curated invoice dicts."""
    header_row = find_header_row(input_path)
    print(f"  Header detected at row {header_row + 1}")

    with open(input_path, 'r', encoding='utf-8', errors='replace', newline='') as f:
        for _ in range(header_row):
            f.readline()
        reader = csv.reader(f, delimiter='\t')
        headers = [h.strip() for h in next(reader)]

        keep = []
        for i, h in enumerate(headers):
            if h in FIELD_MAP:
                keep.append((i, FIELD_MAP[h]))
        print(f"  Source columns: {len(headers)}  →  curated: {len(keep)}")

        records = []
        skipped = 0
        for row in reader:
            if not row or all(not c.strip() for c in row):
                continue
            if len(row) < max(i for i, _ in keep) + 1:
                skipped += 1
                continue
            rec = {}
            for i, out_key in keep:
                val = clean(row[i])
                if out_key in NUMERIC_FIELDS:
                    n = to_number(val)
                    if n is None or (n == 0 and out_key not in ('Total',)):
                        continue
                    rec[out_key] = n
                elif out_key in DATE_FIELDS:
                    d = to_iso_date(val)
                    if d:
                        rec[out_key] = d
                else:
                    if val:
                        rec[out_key] = val
            records.append(rec)
        print(f"  Parsed: {len(records):,} records  (skipped {skipped} short rows)")
        return records


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

    # Build lookup of existing by InvoiceNumber
    by_key = {}
    for inv in existing:
        k = inv.get('InvoiceNumber')
        if k:
            by_key[str(k)] = inv

    # Merge — report wins on duplicates
    added = 0
    updated = 0
    no_key = 0
    for rec in new_records:
        k = rec.get('InvoiceNumber')
        if not k:
            no_key += 1
            continue
        key = str(k)
        if key in by_key:
            by_key[key] = rec
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
    print(f"  Added new:       {added:,}")
    print(f"  Updated existing:{updated:,}")
    if no_key:
        print(f"  Skipped (no InvoiceNumber): {no_key}")
    print(f"  Final cache:     {len(merged):,} invoices  ({size_mb:.2f} MB)")
    print(f"\n📊 Final count per date in report window:")
    for d in target_dates:
        print(f"  {d}: {counts_by_date.get(d, 0)}")
    print(f"\n✅ Wrote {cache_path}")
    return len(merged)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 merge_invoices.py <input.xls> [<cache.json>]")
        sys.exit(1)
    in_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) >= 3 else \
        '/Users/joedingwall/Desktop/Claude Assets/PRODUCTION DASHBOARD/PRODUCTION DASHBOARD/cache-invoices.json'
    merge(in_path, out_path)
