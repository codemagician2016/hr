'use strict';

/*
 * ============================================================================
 *  Statutory Registers — PURE projector (Feature 32)
 * ============================================================================
 *
 *  PURE. No DB, no I/O, no prisma, no Date.now. Every function takes the
 *  already-fetched FROZEN source rows + a RegisterDefinition and returns a
 *  tabular result. It NEVER queries and NEVER recomputes — the controller
 *  fetches the frozen rows (via registers/sources.js) and hands them in. This
 *  mirrors filing/india.js and compliance/india.calendar.js (the pure-engine
 *  contract) one-for-one.
 *
 *  A RegisterDefinition.columns is an ordered list of column descriptors:
 *      { key, label, source, path, transform?, daily?, statutory?, align? }
 *  - `source`   : 'employee' | 'statutory' | 'summary' | 'line' | 'component'
 *                 | 'balance' | 'literal' | 'derived' | 'daily' — which object
 *                 on the per-worker bundle row the value comes from.
 *  - `path`     : dot-path into that object (e.g. "uan", "summary.lopDays"); for
 *                 source:'component' it is the componentCode to look up; for
 *                 source:'derived' it is a whitelisted derivation key.
 *  - `transform`: a whitelisted, PURE formatter name (rupee/days2/date/...).
 *  - `daily`    : true ⇒ the muster per-day grid — expanded to one column per
 *                 day-of-month by expandDailyColumns(); the cell is statusMark().
 *
 *  buildRegister(definition, sourceBundle, opts)
 *     → { columns:[{key,label,align?}], rows:[{cells:[...], _raw?}],
 *         totals:{...}, meta:{...} }
 *
 *  See docs/features/32-statutory-registers.md §4.
 */

// ── Decimal/number coercion (Prisma Decimal | string | number → Number) ──────

function toNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'object' && typeof v.toNumber === 'function') {
    const n = v.toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Money is held as rupee-Decimal on the frozen sources (PayRunLine etc are
// Decimal(15,2)); we sum via integer paise to avoid float drift, exactly like
// reports/aggregations.js + filing/india.js.
function toMinor(v) {
  return Math.round(toNumber(v) * 100);
}
function fromMinor(minor) {
  return Math.round(minor) / 100;
}

// ── Whitelisted transforms (PURE) ────────────────────────────────────────────
// Unknown transform ⇒ assertColumns() throws at definition-validate time, never
// at generate time. Each returns a STRING for display (the exporters render
// strings); the raw numeric is preserved separately for control totals.

function formatRupee(v) {
  const n = toNumber(v);
  const neg = n < 0;
  // en-IN lakh/crore grouping; ₹ symbol; 2 dp — matches payslipPdf money().
  const grouped = Math.abs(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${neg ? '-' : ''}₹${grouped}`;
}

function formatDays2(v) {
  return toNumber(v).toFixed(2);
}

function formatHours2(v) {
  return toNumber(v).toFixed(2);
}

function minutesToHours(v) {
  return (toNumber(v) / 60).toFixed(2);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDateParts(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return { y: value.getUTCFullYear(), m: value.getUTCMonth() + 1, d: value.getUTCDate() };
  }
  const s = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return null;
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function formatDate(v) {
  const p = toDateParts(v);
  if (!p) return '';
  return `${pad2(p.d)}-${pad2(p.m)}-${p.y}`; // DD-MM-YYYY (Indian statutory convention)
}

function formatText(v) {
  return v == null ? '' : String(v);
}

// PAN/UAN/identifiers — identity passthrough (masking is enforced upstream by the
// controller's field-redaction; the transform never invents/strips a value).
function formatIdentity(v) {
  return v == null ? '' : String(v);
}

function formatInt(v) {
  return String(Math.round(toNumber(v)));
}

// The muster-roll cell vocabulary, derived from the ALREADY-classified
// Attendance.status + lopFraction (so it matches exactly what payroll froze — no
// re-derivation). See docs §4 status-mark table.
function statusMark(status, lopFraction) {
  const lop = toNumber(lopFraction);
  switch (status) {
    case 'PRESENT':
    case 'WORK_FROM_HOME':
    case 'ON_DUTY':
      return 'P';
    case 'HALF_DAY':
      return '½'; // ½
    case 'ON_LEAVE':
      return lop > 0 ? 'LWP' : 'L';
    case 'ABSENT':
      return 'A';
    case 'WEEKLY_OFF':
      return 'WO';
    case 'HOLIDAY':
      return 'H';
    case 'HOLIDAY_WORKED':
      return 'H*';
    case 'MISSING_PUNCH':
      return 'MP';
    default:
      return status ? String(status).slice(0, 2) : '—'; // — for unknown/none
  }
}

const TRANSFORMS = Object.freeze({
  rupee: { fn: formatRupee, money: true, align: 'right' },
  days2: { fn: formatDays2, align: 'right' },
  hours2: { fn: formatHours2, align: 'right' },
  minutesToHours: { fn: minutesToHours, align: 'right' },
  date: { fn: formatDate, align: 'left' },
  text: { fn: formatText, align: 'left' },
  uan: { fn: formatIdentity, align: 'left' },
  pan: { fn: formatIdentity, align: 'left' },
  identity: { fn: formatIdentity, align: 'left' },
  int: { fn: formatInt, align: 'right' },
  statusMark: { fn: (v) => formatText(v), align: 'center' },
});

const VALID_SOURCES = Object.freeze([
  'employee', 'statutory', 'summary', 'line', 'component', 'balance',
  'literal', 'derived', 'daily',
]);

// ── PII masking (Feature 32 §6 — "an exporter never emits a field the actor can't
// read"). The controller derives the maskFields set per the actor's permissions
// and passes it into buildRegister; resolveCell masks the bound value when the
// column's key is in that set. PURE — no permission logic lives here.
//
// Statutory identifiers keep a short, non-identifying tail (so the register is
// still reconcilable by an authorised reviewer) while the bulk is redacted;
// free-text identity (DOB / address) is fully redacted.

const PII_MASK_CHAR = '•';

// Reveal only the last `keep` characters of an identifier; redact the rest.
function maskTail(value, keep = 4) {
  const s = value == null ? '' : String(value);
  if (!s) return '';
  if (s.length <= keep) return PII_MASK_CHAR.repeat(s.length);
  return PII_MASK_CHAR.repeat(s.length - keep) + s.slice(-keep);
}

// Fully redact a free-text PII field (DOB / address) — emit a fixed token so the
// column still renders but discloses nothing.
function maskFull(value) {
  const s = value == null ? '' : String(value);
  return s ? '••••••' : '';
}

// A column is "fully redacted" (date/address) vs "tail-masked" (identifier). We
// fully-redact non-identifier transforms (date/text) and tail-mask identifiers.
function maskValueForColumn(column, displayText) {
  const t = column && column.transform;
  if (t === 'date' || t === 'text') return maskFull(displayText);
  return maskTail(displayText, 4);
}

// Whitelisted derivations — small, named, pure roll-ups the column can request
// without a definition needing to bind to a non-existent stored field. Each is a
// READ over already-frozen figures (no recompute beyond +/- of frozen Decimals).
const DERIVATIONS = Object.freeze({
  // days actually worked = payable − paid-leave (both frozen on AttendancePayInput)
  daysPresent: (b) => {
    const s = b.summary || {};
    return toNumber(s.payableDays) - toNumber(s.paidLeaveDays);
  },
  fullName: (b) => {
    const e = b.employee || {};
    return [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ');
  },
  // employer-side total statutory cost (advisory) — frozen PayRunLine figures
  pfTotal: (b) => toNumber((b.line || {}).pfEmployee) + toNumber((b.line || {}).pfEmployer),
});

// ── assertColumns — definition validator (write-time guard) ──────────────────
// Throws (with .code) on an unknown source / transform / derivation, so a bad
// definition is rejected at seed/PATCH time, never at generate time.

function assertColumns(columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    const e = new Error('RegisterDefinition.columns must be a non-empty array');
    e.code = 'BAD_COLUMNS';
    throw e;
  }
  const seen = new Set();
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    if (!c || typeof c !== 'object') {
      const e = new Error(`column[${i}] must be an object`);
      e.code = 'BAD_COLUMN';
      throw e;
    }
    if (!c.key || typeof c.key !== 'string') {
      const e = new Error(`column[${i}] missing string "key"`);
      e.code = 'BAD_COLUMN_KEY';
      throw e;
    }
    if (seen.has(c.key)) {
      const e = new Error(`duplicate column key "${c.key}"`);
      e.code = 'DUP_COLUMN_KEY';
      throw e;
    }
    seen.add(c.key);
    if (typeof c.label !== 'string') {
      const e = new Error(`column "${c.key}" missing string "label"`);
      e.code = 'BAD_COLUMN_LABEL';
      throw e;
    }
    const source = c.daily ? 'daily' : c.source;
    if (!VALID_SOURCES.includes(source)) {
      const e = new Error(`column "${c.key}" has unknown source "${source}"`);
      e.code = 'BAD_COLUMN_SOURCE';
      throw e;
    }
    if (c.transform && !TRANSFORMS[c.transform]) {
      const e = new Error(`column "${c.key}" has unknown transform "${c.transform}"`);
      e.code = 'BAD_COLUMN_TRANSFORM';
      throw e;
    }
    if (source === 'derived' && !DERIVATIONS[c.path]) {
      const e = new Error(`column "${c.key}" has unknown derivation "${c.path}"`);
      e.code = 'BAD_COLUMN_DERIVATION';
      throw e;
    }
  }
  return true;
}

// ── small helpers ────────────────────────────────────────────────────────────

function getPath(obj, path) {
  if (!obj || !path) return undefined;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function lastDom(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

// ── expandDailyColumns — muster: one column per day of the period ─────────────
// Preferred: a `window` = { start, end } (the FROZEN pay run's actual period) ⇒
// one column PER CALENDAR DATE across [start..end] inclusive, keyed by the full
// ISO date so a non-calendar cycle (e.g. 26→25, spanning two months) prints the
// right days and stays byte-identical to the frozen summary's span.
//
// Fallback: a `period` = { year, month } ⇒ one column per day-of-month (legacy
// calendar-month muster). Correctly handles 28/29/30/31-day months (leap-Feb=29).
//
// Accepts (windowOrPeriod) — a { start, end } window OR a { year, month } period.

function isoDate(y, m1, d) {
  return `${y}-${pad2(m1)}-${pad2(d)}`;
}

function expandDailyColumns(windowOrPeriod) {
  const w = windowOrPeriod || {};
  // window form — one column per date across the frozen run period.
  if (w.start != null && w.end != null) {
    const s = toDateParts(w.start);
    const e = toDateParts(w.end);
    if (!s || !e) return [];
    const cols = [];
    let cur = new Date(Date.UTC(s.y, s.m - 1, s.d));
    const last = Date.UTC(e.y, e.m - 1, e.d);
    let guard = 0;
    while (cur.getTime() <= last && guard < 400) {
      const y = cur.getUTCFullYear();
      const m1 = cur.getUTCMonth() + 1;
      const d = cur.getUTCDate();
      cols.push({ key: `d${isoDate(y, m1, d)}`, label: String(d), align: 'center', _date: isoDate(y, m1, d) });
      cur = new Date(cur.getTime() + 86400000);
      guard += 1;
    }
    return cols;
  }
  // period (calendar-month) form — legacy day-of-month columns.
  const year = +w.year;
  const month = +w.month;
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return [];
  }
  const days = lastDom(year, month);
  const cols = [];
  for (let d = 1; d <= days; d++) {
    cols.push({ key: `d${d}`, label: String(d), align: 'center', _day: d });
  }
  return cols;
}

// ── resolveCell — pull the column's bound field off the worker bundle row ─────
// Returns { text, raw, money } — `text` for display, `raw` numeric for totals,
// `money` flags a rupee column. PURE.

function resolveCell(column, bundleRow, ctx) {
  const tx = column.transform ? TRANSFORMS[column.transform] : null;
  const isMoney = !!(tx && tx.money);

  let raw;
  switch (column.daily ? 'daily' : column.source) {
    case 'literal':
      raw = column.value != null ? column.value : column.path;
      break;
    case 'employee':
      raw = getPath(bundleRow.employee, column.path);
      break;
    case 'statutory':
      raw = getPath(bundleRow.statutory, column.path);
      break;
    case 'summary':
      raw = getPath(bundleRow.summary, column.path);
      break;
    case 'line':
      raw = getPath(bundleRow.line, column.path);
      break;
    case 'balance':
      raw = getPath(bundleRow.balance, column.path);
      break;
    case 'component': {
      // path = componentCode; look it up among this worker's components.
      const comps = bundleRow.components || [];
      const hit = comps.find((c) => c.componentCode === column.path);
      raw = hit ? hit.amount : 0;
      break;
    }
    case 'derived':
      raw = DERIVATIONS[column.path] ? DERIVATIONS[column.path](bundleRow, ctx) : undefined;
      break;
    case 'daily': {
      // muster per-day cell: find the frozen Attendance row for this column's day.
      // Prefer an exact full-date match (window form — correct on a non-calendar
      // cycle that spans two months); fall back to day-of-month (legacy form).
      const days = bundleRow.days || [];
      const wantDate = column._date;
      const day = column._day;
      const hit = days.find((a) => {
        const dp = toDateParts(a.date);
        if (!dp) return false;
        if (wantDate) return isoDate(dp.y, dp.m, dp.d) === wantDate;
        return dp.d === day;
      });
      if (hit) {
        return { text: statusMark(hit.status, hit.lopFraction), raw: hit.status, money: false };
      }
      // No row: distinguish pre-DOJ/post-exit (—) from a real gap. The summary's
      // frozen day counts remain authoritative; an absent grid cell is just "—".
      return { text: '—', raw: null, money: false };
    }
    default:
      raw = undefined;
  }

  // statusMark transform applied directly to a status-string source.
  if (column.transform === 'statusMark') {
    return { text: statusMark(raw, column.lopFraction), raw, money: false };
  }

  const fn = tx ? tx.fn : formatText;
  let text = fn(raw);

  // PII redaction (Feature 32 §6): mask the DISPLAY text only (raw is untouched
  // so control totals never depend on a masked field). Money columns are never
  // PII and are never in maskFields. The daily grid returns early above.
  const maskFields = ctx && ctx.maskFields;
  if (maskFields && maskFields.has && maskFields.has(column.key)) {
    text = maskValueForColumn(column, text);
  }
  return { text, raw, money: isMoney };
}

// ── controlTotals — column sums for the printed footer (Rupee + days) ─────────
// Sums every money column (in paise → exact) and every days/hours column; keyed
// by column.key so the footer can render under the right column. PURE.

function controlTotals(rows, columns) {
  const totals = {};
  const moneyMinor = {};
  for (const col of columns) {
    if (col.daily) continue;
    const tx = col.transform ? TRANSFORMS[col.transform] : null;
    if (!tx) continue;
    const isMoney = !!tx.money;
    const isNumeric = isMoney || ['days2', 'hours2', 'minutesToHours', 'int'].includes(col.transform);
    if (!isNumeric) continue;
    let sum = 0;
    let minor = 0;
    for (const r of rows) {
      const cell = r._byKey ? r._byKey[col.key] : null;
      if (!cell || cell.raw == null) continue;
      if (isMoney) minor += toMinor(cell.raw);
      else sum += toNumber(cell.raw);
    }
    if (isMoney) {
      moneyMinor[col.key] = minor;
      totals[col.key] = { value: fromMinor(minor), display: formatRupee(fromMinor(minor)), money: true };
    } else {
      totals[col.key] = { value: sum, display: sum.toFixed(2), money: false };
    }
  }
  return { byColumn: totals, moneyMinorByColumn: moneyMinor };
}

// ── buildRegister — the entry point ──────────────────────────────────────────
//
// definition  : a RegisterDefinition row (or seed object) — { kind, formCode,
//               formLabel, actLabel, stateCode, cadence, source, columns, meta }.
// sourceBundle: the already-fetched frozen rows for the (entity, period):
//               { frozen, workers:[{ employee, statutory, summary?, days?, line?,
//                 components?, balances?/balance?, txns? }], period?, payRun?,
//                 title? }.
// opts        : { period:{year,month}, maskFields? }.
//
// Returns { columns, rows, totals, meta } or, if the source isn't frozen,
// { frozen:false, reason, code }.

function buildRegister(definition, sourceBundle, opts = {}) {
  if (!definition) {
    const e = new Error('buildRegister: definition required');
    e.code = 'NO_DEFINITION';
    throw e;
  }
  const bundle = sourceBundle || {};
  // Frozen-source gate (the cardinal invariant). The projector NEVER recomputes
  // to fill a gap — it surfaces the typed NOT_FROZEN result the UI renders as
  // "freeze the run / close attendance first."
  if (bundle.frozen === false) {
    return {
      frozen: false,
      code: bundle.code || 'NOT_FROZEN',
      reason: bundle.reason || 'The source for this register is not frozen yet.',
      meta: { formLabel: definition.formLabel, formCode: definition.formCode },
    };
  }

  assertColumns(definition.columns);

  // Resolve the column layout: expand the single `daily:true` marker into one
  // column per period day, in place. The day window comes from the FROZEN bundle
  // (bundle.window = the run periodStart/periodEnd) when present, so a non-calendar
  // cycle prints the actual run days; else the calendar month (legacy fallback).
  const period = opts.period || bundle.period || null;
  const dailyWindow = opts.window || bundle.window || period;
  const outColumns = [];
  for (const col of definition.columns) {
    if (col.daily) {
      const dailyCols = expandDailyColumns(dailyWindow);
      for (const dc of dailyCols) {
        outColumns.push({ key: dc.key, label: dc.label, align: 'center', daily: true, _day: dc._day, _date: dc._date });
      }
    } else {
      const tx = col.transform ? TRANSFORMS[col.transform] : null;
      outColumns.push({
        key: col.key,
        label: col.label,
        align: col.align || (tx ? tx.align : 'left'),
        source: col.source,
        path: col.path,
        transform: col.transform,
        value: col.value,
        statutory: !!col.statutory,
      });
    }
  }

  const workers = Array.isArray(bundle.workers) ? bundle.workers : [];
  // maskFields: a Set of column keys whose DISPLAY value the actor may not read.
  // Derived by the controller from the actor's permissions/role (§6 PII contract).
  const maskFields = opts.maskFields instanceof Set
    ? opts.maskFields
    : (Array.isArray(opts.maskFields) ? new Set(opts.maskFields) : null);
  const ctx = { period, payRun: bundle.payRun, maskFields };
  const rows = [];
  let sl = 0;
  for (const w of workers) {
    sl += 1;
    const cells = [];
    const byKey = {};
    for (const col of outColumns) {
      // Auto Sl.No support: a literal column with path:'__sl' numbers rows.
      if (col.source === 'literal' && col.path === '__sl') {
        const cell = { text: String(sl), raw: sl, money: false };
        cells.push(cell);
        byKey[col.key] = cell;
        continue;
      }
      const cell = resolveCell(col, w, ctx);
      cells.push(cell);
      byKey[col.key] = cell;
    }
    rows.push({ cells, _byKey: byKey, _employeeId: w.employee ? w.employee.id : null });
  }

  const totals = controlTotals(rows, outColumns);

  // Strip the internal _byKey from the public rows shape but keep it for the
  // controlTotals already computed; exporters only read cells + totals.
  const publicRows = rows.map((r) => ({ cells: r.cells, employeeId: r._employeeId }));

  return {
    frozen: true,
    columns: outColumns.map((c) => ({ key: c.key, label: c.label, align: c.align, statutory: c.statutory, daily: !!c.daily })),
    rows: publicRows,
    totals,
    rowCount: publicRows.length,
    meta: Object.assign(
      {
        kind: definition.kind,
        formCode: definition.formCode,
        formLabel: definition.formLabel,
        actLabel: definition.actLabel,
        stateCode: definition.stateCode || null,
        cadence: definition.cadence,
        source: definition.source,
        title: bundle.title || null,
        period: period || null,
        orientation: (definition.meta && definition.meta.orientation) || 'landscape',
      },
      bundle.meta || {}
    ),
  };
}

module.exports = {
  buildRegister,
  resolveCell,
  statusMark,
  controlTotals,
  expandDailyColumns,
  assertColumns,
  maskTail,
  maskFull,
  maskValueForColumn,
  // exposed for the seed + exporters + tests
  TRANSFORMS,
  DERIVATIONS,
  VALID_SOURCES,
  toNumber,
  toMinor,
  fromMinor,
  formatRupee,
};
