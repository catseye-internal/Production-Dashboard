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
const SERVICE_ORDERS_COLUMNS = [
  { key: 'WorkDate',     label: 'When',         type: 'datetime',         sortable: true, default: true },
  { key: 'Branch',       label: 'Branch',       type: 'branch',           sortable: true, default: true },
  { key: 'OrderType',    label: 'Type',         type: 'badge-orderType',  sortable: true, default: true },
  { key: 'Tech1',        label: 'Tech',         type: 'text',             sortable: true, default: true },
  { key: 'ServiceCode',  label: 'Service',      type: 'text',             sortable: true, default: true },
  { key: 'Description',  label: 'Description',  type: 'text-truncate',    sortable: false, default: true },
  { key: 'Duration',     label: 'Min',          type: 'number',           sortable: true, default: true },
  { key: 'Route',        label: 'Route',        type: 'text',             sortable: true, default: true },
  { key: 'Locked',       label: 'Confirmed?',   type: 'confirmation',     sortable: true,  default: true },
  { key: '_status',      label: 'Status',       type: 'status-flags',     sortable: false, default: true },
  { key: 'Total',        label: 'Total',        type: 'money',            sortable: true, default: true },
  { key: 'OrderNumber',  label: 'Order #',      type: 'text',             sortable: true, default: false },
  { key: 'OrderID',      label: 'Order ID',     type: 'number',           sortable: true, default: false },
  { key: 'LocationID',   label: 'Loc ID',       type: 'number',           sortable: true, default: false },
  { key: 'Origin',       label: 'Origin',       type: 'text',             sortable: true, default: false },
  { key: 'EarliestTime', label: 'Earliest',     type: 'time',             sortable: true, default: false },
  { key: 'LatestTime',   label: 'Latest',       type: 'time',             sortable: true, default: false },
  { key: 'ParentOrderID', label: 'Parent #',    type: 'number',           sortable: true, default: false },
];

// ── Invoices columns — confirmed against real PestPac report (30,008 records YTD) ──
const INVOICES_COLUMNS = [
  { key: 'InvoiceDate',        label: 'Invoice Date',  type: 'date',           sortable: true, default: true },
  { key: 'InvoiceNumber',      label: 'Invoice #',     type: 'text',           sortable: true, default: true },
  { key: 'InvoiceType',        label: 'Type',          type: 'invoiceType',    sortable: true, default: true },
  { key: 'Branch',             label: 'Branch',        type: 'branch',         sortable: true, default: true },
  { key: 'CustomerName',       label: 'Customer',      type: 'text-truncate',  sortable: true, default: true },
  { key: 'Tech',               label: 'Tech',          type: 'text',           sortable: true, default: true },
  { key: 'ServiceDescription', label: 'Service',       type: 'text-truncate',  sortable: true, default: true },
  { key: 'Total',              label: 'Total',         type: 'money',          sortable: true, default: true },
  { key: 'Balance',            label: 'Balance',       type: 'balance',        sortable: true, default: true },
  { key: 'AgingDays',          label: 'Aging',         type: 'aging',          sortable: true, default: true },
  { key: 'OrderNumber',        label: 'Order #',       type: 'text',           sortable: true, default: false },
  { key: 'Sales',              label: 'Sales',         type: 'text',           sortable: true, default: false },
  { key: 'ServiceClass',       label: 'Class',         type: 'text',           sortable: true, default: false },
  { key: 'SubTotal',           label: 'Subtotal',      type: 'money',          sortable: true, default: false },
  { key: 'Tax',                label: 'Tax',           type: 'money',          sortable: true, default: false },
  { key: 'SaleValue',          label: 'Sale Value',    type: 'money',          sortable: true, default: false },
  { key: 'ProductionValue',    label: 'Production $',  type: 'money',          sortable: true, default: false },
  { key: 'Origin',             label: 'Origin',        type: 'text',           sortable: true, default: false },
  { key: 'PostedBy',           label: 'Posted By',     type: 'text',           sortable: true, default: false },
  { key: 'WorkDate',           label: 'Work Date',     type: 'date',           sortable: true, default: false },
];

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
