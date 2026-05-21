// ═══════════════════════════════════════════════════════════════
// Production Dashboard — Configuration
// Catseye Pest Control & USX Pest Control
//
// Mirrors the structure of BDC-Dashboard/config.js. Edit this file
// when branches, techs, service categories, or endpoints change —
// no need to touch index.html.
// ═══════════════════════════════════════════════════════════════

// ── Cache endpoints (GitHub Pages, populated by Apps Script every 10m) ──
const CACHE_JSON_URL    = './cache.json';
const CACHE_ORDERS_URL  = './cache-orders.json';   // optional split — see brief §6.2
const CACHE_INVOICES_URL = './cache-invoices.json';
const CACHE_REFRESH_MS  = 60_000;  // dashboard auto-refresh cadence (60s)
const CACHE_STALE_MS    = 11 * 60 * 1000;  // 11 min — show "stale" badge past this

// ── Branch constants — match PestPac & Sales Center exactly ──
const BRANCH_CATSEYE = ['Eastern Mass', 'Connecticut', 'Rhode Island'];
const BRANCH_USX     = ['USX - Western Mass', 'USX - Upstate New York'];
const BRANCH_ALL     = [...BRANCH_CATSEYE, ...BRANCH_USX];

const BRANCH_DISPLAY = {
  'Eastern Mass':           'E. Mass',
  'Connecticut':            'CT',
  'Rhode Island':           'RI',
  'USX - Western Mass':     'W. Mass',
  'USX - Upstate New York': 'Upst. NY',
};

// ── ServiceOrders: orderType filtering ──
// Confirmed via PestPacDiscovery.gs run on 2026-05-20. PestPac returns exactly
// four OrderType values: Estimate (BDC territory — excluded), ServiceOrder,
// CallBack, Production. The last three are everything the Production Dashboard
// tracks.
const ORDER_TYPES_EXCLUDED = ['Estimate'];
const ORDER_TYPES_INCLUDED = ['ServiceOrder', 'CallBack', 'Production'];

// Friendly labels for the OrderType filter dropdown and badges
const ORDER_TYPE_LABEL = {
  'ServiceOrder': 'Service Order',
  'CallBack':     'Callback',
  'Production':   'Production',
  'Estimate':     'Estimate',  // displayed in tooltips only — never in list view
};

// Color tokens per OrderType (used for the OrderType badge)
const ORDER_TYPE_COLOR = {
  'ServiceOrder': '#60A5FA',  // blue — routine service execution
  'CallBack':     '#FBBF24',  // yellow — needs attention
  'Production':   '#A78BFA',  // purple — Cat-Guard / NWL execution
  'Estimate':     '#9CA3AF',  // gray
};

// Tech codes to exclude from production metrics. Empty unless we identify
// admin/internal-only techs from the data.
const PRODUCTION_TECH_EXCLUDE = [];

// Origin values to exclude (e.g., system-generated test orders). Discovery showed
// "OneTime", "Generated", "LinkedToSetup" — none look like exclusions today.
const PRODUCTION_ORIGIN_EXCLUDE = [];

// ── Service category map (placeholder — copy from BDC config.js once confirmed) ──
// See Open Question #3 in the brief: should Production use the same SERVICE_CATEGORY_MAP
// as BDC, or a different / expanded categorization?
const SERVICE_CATEGORY_MAP = {
  // Filled in after Joe confirms whether to reuse BDC's map or build a new one
};

// ── Period filter labels (same vocabulary as BDC for muscle memory) ──
const PERIOD_LABELS = {
  today:     'TODAY',
  yesterday: 'YESTERDAY',
  wk:        'WK',
  mtd:       'MTD',
  ytd:       'YTD',
  custom:    'CUSTOM',
};

// ── Color tokens — match BDC visual language ──
const COLOR = {
  orange: '#F47B20',
  green:  '#34D399',
  yellow: '#FBBF24',
  red:    '#F87171',
  blue:   '#60A5FA',
  gray:   '#9CA3AF',
  purple: '#A78BFA',
  pink:   '#EC4899',
  brown:  '#6B645A',
};

// ── List view column defs ──
// Confirmed against live API. Type 'badge-orderType' renders the colored OrderType pill.
// Type 'status-flags' renders InProgress/Locked/Posted as little colored dots.
// Location fields (Name, Address, City, State, Zip, County, Lat, Long, EnteredDate, AccountType)
// are joined from cache-locations.json at render time.
const SERVICE_ORDERS_COLUMNS = [
  { key: 'WorkDate',          label: 'When',         type: 'datetime',         sortable: true, default: true,  width: 90 },
  { key: 'Branch',            label: 'Branch',       type: 'branch',           sortable: true, default: true,  width: 75 },
  { key: '_LocCodeLink',      label: 'Loc #',        type: 'pp-loc-link',      sortable: true, default: true,  width: 70 },
  { key: '_LocName',          label: 'Name',         type: 'text-truncate',    sortable: true, default: true,  width: 130 },
  { key: '_LocCity',          label: 'City',         type: 'text',             sortable: true, default: true,  width: 100 },
  { key: '_LocState',         label: 'State',        type: 'text',             sortable: true, default: true,  width: 45 },
  { key: 'OrderType',         label: 'Type',         type: 'badge-orderType',  sortable: true, default: true,  width: 110 },
  { key: 'Locked',            label: 'Confirmed?',   type: 'confirmation',     sortable: true, default: true,  width: 100 },
  { key: 'Tech1',             label: 'Tech',         type: 'text',             sortable: true, default: true,  width: 55 },
  { key: 'Tech2',             label: 'Tech 2',       type: 'text',             sortable: true, default: true,  width: 60 },
  { key: 'ServiceCode',       label: 'Service',      type: 'text',             sortable: true, default: true,  width: 140 },
  { key: 'Duration',          label: 'Min',          type: 'number',           sortable: true, default: true,  width: 50 },
  { key: 'SubTotal',          label: 'Subtotal',     type: 'money',            sortable: true, default: true,  width: 80 },
  { key: '_status',           label: 'Status',       type: 'status-flags',     sortable: false, default: true, width: 65 },
  { key: 'Route',             label: 'Route',        type: 'text',             sortable: true, default: true,  width: 95 },
  { key: '_LocAddress',       label: 'Address',      type: 'text-truncate',    sortable: true, default: true,  width: 160 },
  { key: '_LocZip5',          label: 'Zip',          type: 'text',             sortable: true, default: true,  width: 60 },
  { key: '_Class',            label: 'Class',        type: 'text',             sortable: true, default: true,  width: 105 },
  { key: 'Description',       label: 'Description',  type: 'text-truncate',    sortable: false, default: true, width: 210 },
  // Non-default columns
  { key: 'Total',             label: 'Total (incl tax)', type: 'money',         sortable: true, default: false },
  { key: 'OrderNumber',       label: 'Order #',      type: 'text',             sortable: true, default: false },
  { key: 'OrderID',           label: 'Order ID',     type: 'number',           sortable: true, default: false },
  { key: 'LocationID',        label: 'Loc ID (raw)', type: 'number',           sortable: true, default: false },
  { key: 'Origin',            label: 'Origin',       type: 'text',             sortable: true, default: false },
  { key: 'EarliestTime',      label: 'Earliest',     type: 'time',             sortable: true, default: false },
  { key: 'LatestTime',        label: 'Latest',       type: 'time',             sortable: true, default: false },
  { key: 'ParentOrderID',     label: 'Parent #',     type: 'number',           sortable: true, default: false },
  { key: '_LocAccountType',   label: 'Account Type', type: 'text',             sortable: true, default: false },
  { key: '_LocLatitude',      label: 'Lat',          type: 'number',           sortable: true, default: false },
  { key: '_LocLongitude',     label: 'Long',         type: 'number',           sortable: true, default: false },
  { key: '_LocEnteredDate',   label: 'Loc Added',    type: 'date',             sortable: true, default: false },
];

// ── Invoices columns — confirmed against real PestPac report (30,008 records YTD) ──
// Column structure mirrors SERVICE_ORDERS_COLUMNS where data overlaps; invoice-specific
// columns (Balance, Aging) sit after Subtotal. Location fields (_LocName, _LocCity, etc.)
// come from cache-locations.json via joinLocationData — invoices have LocationID too.
const INVOICES_COLUMNS = [
  { key: 'InvoiceDate',        label: 'Invoice Date',  type: 'date',           sortable: true, default: true,  width: 90 },
  { key: 'Branch',             label: 'Branch',        type: 'branch',         sortable: true, default: true,  width: 75 },
  { key: '_LocCodeLink',       label: 'Loc #',         type: 'pp-loc-link',    sortable: true, default: true,  width: 70 },
  { key: 'CustomerName',       label: 'Name',          type: 'text-truncate',  sortable: true, default: true,  width: 130 },
  { key: '_LocCity',           label: 'City',          type: 'text',           sortable: true, default: true,  width: 100 },
  { key: '_LocState',          label: 'State',         type: 'text',           sortable: true, default: true,  width: 45 },
  { key: 'InvoiceType',        label: 'Type',          type: 'invoiceType',    sortable: true, default: true,  width: 110 },
  { key: 'Tech',               label: 'Tech',          type: 'text',           sortable: true, default: true,  width: 55 },
  { key: 'Tech2',              label: 'Tech 2',        type: 'text',           sortable: true, default: true,  width: 60 },
  { key: 'ServiceCode',        label: 'Service',       type: 'text',           sortable: true, default: true,  width: 140 },
  { key: 'SubTotal',           label: 'Subtotal',      type: 'money',          sortable: true, default: true,  width: 80 },
  { key: 'Balance',            label: 'Balance',       type: 'balance',        sortable: true, default: true,  width: 80 },
  { key: 'AgingDays',          label: 'Aging',         type: 'aging',          sortable: true, default: true,  width: 70 },
  { key: 'Route',              label: 'Route',         type: 'text',           sortable: true, default: true,  width: 95 },
  { key: '_LocAddress',        label: 'Address',       type: 'text-truncate',  sortable: true, default: true,  width: 160 },
  { key: '_LocZip5',           label: 'Zip',           type: 'text',           sortable: true, default: true,  width: 60 },
  { key: 'ServiceClass',       label: 'Class',         type: 'text',           sortable: true, default: true,  width: 105 },
  { key: 'ServiceDescription', label: 'Description',   type: 'text-truncate',  sortable: true, default: true,  width: 210 },
  // Non-default
  { key: 'Total',              label: 'Total (incl tax)', type: 'money',       sortable: true, default: false },
  { key: 'Tax',                label: 'Tax',           type: 'money',          sortable: true, default: false },
  { key: 'InvoiceNumber',      label: 'Invoice #',     type: 'text',           sortable: true, default: false },
  { key: 'OrderNumber',        label: 'Order #',       type: 'text',           sortable: true, default: false },
  { key: 'Sales',              label: 'Sales',         type: 'text',           sortable: true, default: false },
  { key: 'SaleValue',          label: 'Sale Value',    type: 'money',          sortable: true, default: false },
  { key: 'ProductionValue',    label: 'Production $',  type: 'money',          sortable: true, default: false },
  { key: 'Origin',             label: 'Origin',        type: 'text',           sortable: true, default: false },
  { key: 'PostedBy',           label: 'Posted By',     type: 'text',           sortable: true, default: false },
  { key: 'EnteredBy',          label: 'Entered By',    type: 'text',           sortable: true, default: false },
  { key: 'WorkDate',           label: 'Work Date',     type: 'date',           sortable: true, default: false },
  { key: 'LocationID',         label: 'Loc ID (raw)',  type: 'number',         sortable: true, default: false },
];

// ── Division classification (Pest vs CG vs NWL, Resi vs Commercial) ──
// Per Joe 2026-05-20.
//
// CG (Cat-Guard) and NWL (Nuisance Wildlife Services) are tracked separately.
// Rule: ServiceClass "NWL" = NWL. All other previously-cgnwl classes = CG.
//
// Service Classes (used on Invoices, exact match):
const CG_CLASSES   = new Set(['CAT-GUARD', 'CATGUARD', 'CG WARRANT']);
const NWL_CLASSES  = new Set(['NWL']);
//
// Commercial Pest Service Classes (used on Invoices, exact match):
const COMMERC_CLASSES = new Set(['COMM INIT', 'COMM SERVI', 'COMMERCIAL']);
//
// For ServiceOrders the API only returns ServiceCode (not ServiceClass).
// These explicit Sets were extracted from the cache-invoices.json code→class
// mapping on 2026-05-20 and are AUTHORITATIVE — they reflect actual PestPac
// data, not a regex guess.
const NWL_SERVICE_CODES = new Set([
  'BAT FOLLOW-UP', 'BAT INITIAL', 'BIRD REMOVAL',
  'NWFU', 'NWI', 'NWL EVICT FU', 'NWL EVICT INIT',
  'USX BAT FOLLOW', 'USX BAT INITIAL',
  'USX NWL EVIC FU', 'USX NWL EVICT', 'USX NWL FU', 'USX NWL INIT',
  'WOODPECKER INTL'
]);
const CG_SERVICE_CODES = new Set([
  'CG ATTIC ABATE', 'CG BASEMENT', 'CG BIRD EXCL', 'CG FULL INIT',
  'CG LOWER INIT', 'CG PRE-WALK', 'CG TRENCH INIT', 'CG UPPER INIT',
  'CG WARR 1YR', 'CGW AUTO-BILL', 'CGW AUTO-PAY', 'CGW AUTO-RENEW',
  'CGW NO RENEWAL', 'CGW RESEAL',
  'CONTINUE EXCLUS', 'CONTINUE REPAIR',
  'EXCLUSION INIT', 'EXTENDED REPAIR', 'FINAL WALK', 'GENERAL CG', 'LIFT',
  'USX ATTIC ABATE', 'USX BASEMENT', 'USX CONT EXCLU', 'USX CONT REPAIR',
  'USX EXCLUS INIT', 'USX FULL INIT', 'USX GENERAL CG',
  'USX LOWER INIT', 'USX TRENCH INIT', 'USX UPPER INIT',
  'USX WAR AUTOREN', 'USX WAR RESEAL', 'USX WARR 1YR'
]);
// Fallback patterns for ServiceOrder codes not yet seen in invoice data.
// NWL fallback matches wildlife-specific terms (BAT, WOODPECKER, NWL, NW[FI]).
// CG fallback matches Cat-Guard construction terms. NWL is checked first.
const NWL_CODE_PATTERN = /\b(NWL|NWFU|NWI|BAT|WOODPECKER)\b/;
const CG_CODE_PATTERN  = /\b(CG|CGW|CATGUARD|RIDGE|TRENCH|RESEAL|EXCLUS|EVICT|CONTINUE|EXTENDED|FINAL\s*WALK|GENERAL\s*CG)\b/;
const COMMERC_CODE_PATTERN = /^COMM/;

// Codes that contain "TOTAL PLAT" are Total Platinum pest service tiers
// (even when bundled with CGW). They are pest, NOT CG/NWL.
// Per Joe 2026-05-20.
const TOTAL_PLAT_PATTERN = /\bTOTAL\s*PLAT\b/;

// Classify a record into one of: 'pest-resi' | 'pest-commerc' | 'cg' | 'nwl'
// Prefer ServiceClass when present (Invoices); fall back to ServiceCode (Service Orders).
function classifyDivision(rec) {
  var sc = String(rec.ServiceClass || '').toUpperCase().trim();
  var code = String(rec.ServiceCode || '').toUpperCase().trim();
  // Early exclusion: TOTAL PLAT codes are always pest, never CG/NWL
  if (code && TOTAL_PLAT_PATTERN.test(code)) {
    if (sc && COMMERC_CLASSES.has(sc)) return 'pest-commerc';
    return 'pest-resi';
  }
  if (sc) {
    if (NWL_CLASSES.has(sc))     return 'nwl';
    if (CG_CLASSES.has(sc))      return 'cg';
    if (COMMERC_CLASSES.has(sc)) return 'pest-commerc';
    return 'pest-resi';
  }
  if (!code) return 'pest-resi';
  // Explicit Set lookup is authoritative
  if (NWL_SERVICE_CODES.has(code)) return 'nwl';
  if (CG_SERVICE_CODES.has(code))  return 'cg';
  // Fallback to patterns for codes not yet in invoice data
  if (NWL_CODE_PATTERN.test(code))     return 'nwl';
  if (CG_CODE_PATTERN.test(code))      return 'cg';
  if (COMMERC_CODE_PATTERN.test(code)) return 'pest-commerc';
  return 'pest-resi';
}

// Helper used by the filter buttons: does a record match a (possibly composite) division value?
// Supports the 7 button values: '' (all), 'all-pest', 'pest-resi', 'pest-commerc',
// 'cgnwl' (cg OR nwl), 'cg', 'nwl'.
function matchesDivision(rec, division) {
  if (!division) return true;
  var d = classifyDivision(rec);
  if (division === 'all-pest') return d === 'pest-resi' || d === 'pest-commerc';
  if (division === 'cgnwl')    return d === 'cg' || d === 'nwl';
  return d === division;
}

// Invoice Type code → friendly label and color (confirmed with Joe 2026-05-20)
const INVOICE_TYPE_LABEL = {
  'IN': 'Invoice',     // standard completed work
  'PR': 'Production',  // production lens type
  'CB': 'Callback',    // callback follow-up
  'CM': 'Credit Memo', // credit memo
  'PI': 'Pre-Bill',    // pre-billed
  'ES': 'Estimate',    // legacy
};
const INVOICE_TYPE_COLOR = {
  'IN': '#60A5FA',  // blue — invoice
  'PR': '#A78BFA',  // purple — production
  'CB': '#FBBF24',  // yellow — callback
  'CM': '#EC4899',  // pink — credit memo
  'PI': '#34D399',  // green — pre-bill
  'ES': '#9CA3AF',  // gray — estimate
};
