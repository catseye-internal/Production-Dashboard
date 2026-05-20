#!/usr/bin/env python3
"""
Production Dashboard — Invoice CSV Loader (one-time seed)

Reads PestPac's "Invoice List" report export (tab-delimited despite .xls extension)
and writes a curated cache-invoices.json next to it.

USAGE
  python3 parse_invoices.py <input.xls> <output.json>

  # default — uses the YTD file Joe uploaded:
  python3 parse_invoices.py

DESIGN
  - Strips PestPac's Excel-protection wrappers: ="06281-1437" → "06281-1437"
  - Normalizes dates: 2026/01/01 → 2026-01-01 (matches API order WorkDate format)
  - Coerces numeric strings to numbers where useful
  - Keeps only the curated whitelist below (drops 90+ unused columns)
  - Writes a single JSON file the dashboard reads as cache-invoices.json
"""

import csv
import json
import sys
import re
from datetime import datetime
from pathlib import Path

# ── Curated whitelist (column-name → output-key) ──
# Mirrors the structure of cache.json's `orders` section so the dashboard can
# treat both feeds consistently.
FIELD_MAP = {
    'Invoice #':           'InvoiceNumber',
    'Invoice Type':        'InvoiceType',
    'Order #':             'OrderNumber',
    'Invoice Date':        'InvoiceDate',
    'Work Date':           'WorkDate',
    'Order Date':          'OrderDate',
    'Branch':              'Branch',
    'Branch Region':       'Region',
    'Branch Sub-Region':   'SubRegion',
    'Location':            'LocationCode',
    'Bill-To Code':        'BillToCode',
    'Name':                'CustomerName',
    'City':                'City',
    'State':               'State',
    'Zip code':            'Zip',
    'Tech':                'Tech',
    'Tech 2':              'Tech2',
    'Sales':               'Sales',
    'Entered':             'EnteredBy',
    'Service Class':       'ServiceClass',
    'Service Description': 'ServiceDescription',
    'Service':             'ServiceCode',
    'Route':               'Route',
    'Sub-Total':           'SubTotal',
    'Tax':                 'Tax',
    'Total':               'Total',
    'Balance':             'Balance',
    'Aging Days':          'AgingDays',
    'Net':                 'NetDays',
    'Sale Value':          'SaleValue',
    'Production Value':    'ProductionValue',
    'Taxable Amount':      'TaxableAmount',
    'Tax Rate':            'TaxRate',
    'Source':              'Source',
    'Origin':              'Origin',
    'Posted By':           'PostedBy',
    'Order Type':          'OrderType',
    'Duration':            'Duration',
    'Frequency':           'Frequency',
    'Schedule':            'Schedule',
    'Setup Type':          'SetupType',
    'GL Code':             'GLCode',
    'Invoice Batch':       'InvoiceBatch',
    'Consolidated Num':    'ConsolidatedNum',
    'Consolidated Date':   'ConsolidatedDate',
    'Credit Reason':       'CreditReason',
    'Tax Code':            'TaxCode',
    'Type':                'AccountType',   # R/C — Residential/Commercial
}

NUMERIC_FIELDS = {
    'SubTotal', 'Tax', 'Total', 'Balance', 'AgingDays', 'NetDays',
    'SaleValue', 'ProductionValue', 'TaxableAmount', 'TaxRate', 'Duration',
}

# Invoice Type lens (Joe's directive 2026-05-20):
# The cache keeps EVERY type. The dashboard toggles between three lenses at
# render time, so we don't have to re-pull the cache when switching views:
#   ALL         — every invoice type
#   PRODUCTION  — IN, PR, CM (production accounting basis)
#   REVENUE     — IN, PI, CM (revenue accounting basis)
# Drop only invoice types that are clearly not invoices at all (none currently).
COMPLETED_INVOICE_TYPES = None  # disabled — keep all types in cache

DATE_FIELDS = {
    'InvoiceDate', 'WorkDate', 'OrderDate', 'ConsolidatedDate',
}

# Excel anti-truncation wrapper: ="06281-1437"  →  06281-1437
EXCEL_WRAP = re.compile(r'^="(.*)"$')

def clean(v):
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return ''
    m = EXCEL_WRAP.match(s)
    if m:
        s = m.group(1)
    return s

def to_number(s):
    if s is None or s == '':
        return None
    try:
        return float(s.replace(',', ''))
    except (ValueError, AttributeError):
        return None

def to_iso_date(s):
    if not s:
        return ''
    s = s.strip()
    # PestPac format: 2026/01/01  →  2026-01-01
    for fmt in ('%Y/%m/%d', '%m/%d/%Y', '%Y-%m-%d'):
        try:
            return datetime.strptime(s, fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue
    return s  # leave as-is if unparseable

def find_header_row(path, max_scan=50):
    """PestPac exports have a metadata block before the column header row.
    We detect the real header by looking for the row with the most fields
    that contains 'Invoice #'."""
    best = (0, -1)  # (col count, row index)
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for i, line in enumerate(f):
            if i >= max_scan:
                break
            cells = line.rstrip('\r\n').split('\t')
            if 'Invoice #' in cells and len(cells) > best[0]:
                best = (len(cells), i)
    if best[1] < 0:
        raise RuntimeError(f"Could not locate header row in {path}")
    return best[1]

def parse(input_path, output_path):
    header_row = find_header_row(input_path)
    print(f"  Header detected at row {header_row + 1}")

    with open(input_path, 'r', encoding='utf-8', errors='replace', newline='') as f:
        # Skip pre-header metadata
        for _ in range(header_row):
            f.readline()
        reader = csv.reader(f, delimiter='\t')
        headers = [h.strip() for h in next(reader)]

        # Build the column index map: only keep columns we care about
        keep = []
        for i, h in enumerate(headers):
            if h in FIELD_MAP:
                keep.append((i, FIELD_MAP[h]))

        print(f"  Total source columns: {len(headers)}  →  curated: {len(keep)}")

        records = []
        skipped = 0
        excluded_type = 0
        # Find the InvoiceType column index for early filtering
        inv_type_idx = next((i for i, h in enumerate(headers) if h == 'Invoice Type'), -1)
        for row in reader:
            if not row or all(not c.strip() for c in row):
                continue
            if len(row) < max(i for i, _ in keep) + 1:
                skipped += 1
                continue
            # Early type filter (disabled — dashboard handles the lens at render time)
            if COMPLETED_INVOICE_TYPES is not None and inv_type_idx >= 0:
                t = clean(row[inv_type_idx])
                if t and t not in COMPLETED_INVOICE_TYPES:
                    excluded_type += 1
                    continue

            rec = {}
            for i, out_key in keep:
                val = clean(row[i])
                if out_key in NUMERIC_FIELDS:
                    n = to_number(val)
                    # Skip zero/null numeric fields except Total (always keep for sum reliability)
                    if n is None or (n == 0 and out_key not in ('Total',)):
                        continue
                    rec[out_key] = n
                elif out_key in DATE_FIELDS:
                    d = to_iso_date(val)
                    if d:
                        rec[out_key] = d
                else:
                    # Skip empty strings — saves significant cache bytes
                    if val:
                        rec[out_key] = val
            records.append(rec)

        print(f"  Parsed: {len(records):,} records  (skipped {skipped} short rows, {excluded_type:,} non-completed invoice types)")

    # Stats
    branches = sorted({r.get('Branch','') for r in records if r.get('Branch')})
    types    = sorted({r.get('InvoiceType','') for r in records if r.get('InvoiceType')})
    by_branch = {b: sum(1 for r in records if r.get('Branch') == b) for b in branches}
    total_balance = sum(r.get('Balance') or 0 for r in records)
    total_revenue = sum(r.get('Total') or 0 for r in records)

    print(f"  Branches: {branches}")
    print(f"  Invoice types: {types}")
    print(f"  Records by branch: {by_branch}")
    print(f"  YTD revenue (sum of Total): ${total_revenue:,.2f}")
    print(f"  Outstanding balance: ${total_balance:,.2f}")

    payload = {
        'updated': datetime.utcnow().isoformat() + 'Z',
        'source':  'seed-from-pestpac-report',
        'sourceFile': Path(input_path).name,
        'recordCount': len(records),
        'invoices': records,
    }

    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as out:
        json.dump(payload, out, separators=(',', ':'))
    size_mb = out_path.stat().st_size / 1024 / 1024
    print(f"  Wrote {out_path}  ({size_mb:.2f} MB)")
    return len(records)


if __name__ == '__main__':
    if len(sys.argv) >= 3:
        in_path, out_path = sys.argv[1], sys.argv[2]
    else:
        # Defaults — workspace paths
        in_path = '/Users/joedingwall/Desktop/Claude Assets/PRODUCTION DASHBOARD/Invoices 1.1.2026-5.19.2026.xls'
        out_path = '/Users/joedingwall/Desktop/Claude Assets/PRODUCTION DASHBOARD/PRODUCTION DASHBOARD/cache-invoices.json'

    print(f"🧾 Invoice loader")
    print(f"   in:  {in_path}")
    print(f"   out: {out_path}")
    n = parse(in_path, out_path)
    print(f"✅ Done — {n:,} invoices loaded")
