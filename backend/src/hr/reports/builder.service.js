'use strict';

/*
 * builder.service.js — the report-builder engine.
 *
 * Pipeline: validate (against the datasets.js whitelist registry) → fetch (the
 * dataset's prisma query, tenant + F1-scope filtered) → group (optional, by one
 * groupable key: count + numeric/money sums) → sort → paginate. renderExport()
 * feeds the same pipeline into the shared tabular exporter (export/tabular.js).
 *
 * The compile/validate + fold steps are PURE (no I/O) and unit-tested without a
 * database (__tests__/builder.unit.test.js); only runDefinition touches prisma
 * via the dataset's fetch.
 *
 * Validation is FAIL-CLOSED with helpful 400s: an unknown dataset / column /
 * filter / groupBy / sort key rejects with the allowed list in the message, so
 * a definition can never reference anything outside the registry.
 */

const { getDataset, DATASET_KEYS } = require('./datasets');
const { exportTabular, slugify } = require('./export/tabular');

const RUN_HARD_CAP = 10000; // max source rows folded per run/export

function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  e.code = 'BAD_DEFINITION';
  return e;
}

// ── validation (pure) ────────────────────────────────────────────────────────

/**
 * Validate a definition-shaped object against the registry.
 * @param {object} def { datasetKey, columns|columnsJson, filters|filtersJson, groupBy, sort|sortJson }
 * @returns {{ dataset, columns:[colDef], columnKeys:[..], filters:{}, groupBy:string|null, sort:{key,dir}|null }}
 * @throws 400 with the allowed list on any unknown reference.
 */
function validateDefinition(def = {}) {
  const datasetKey = def.datasetKey;
  const dataset = getDataset(datasetKey);
  if (!dataset) {
    throw badRequest(`Unknown dataset "${datasetKey}". Allowed datasets: ${DATASET_KEYS.join(', ')}`);
  }

  const allowedCols = dataset.columns.map((c) => c.key);
  const colByKey = new Map(dataset.columns.map((c) => [c.key, c]));

  // Columns — ordered chosen keys; empty/missing = all dataset columns.
  const rawCols = def.columns !== undefined ? def.columns : def.columnsJson;
  let columnKeys;
  if (rawCols == null || (Array.isArray(rawCols) && rawCols.length === 0)) {
    columnKeys = [...allowedCols];
  } else {
    if (!Array.isArray(rawCols)) throw badRequest('columns must be an array of column keys.');
    columnKeys = rawCols.map(String);
    const unknown = columnKeys.filter((k) => !colByKey.has(k));
    if (unknown.length) {
      throw badRequest(`Unknown column(s) [${unknown.join(', ')}] for dataset "${datasetKey}". Allowed columns: ${allowedCols.join(', ')}`);
    }
    const dupes = columnKeys.filter((k, i) => columnKeys.indexOf(k) !== i);
    if (dupes.length) throw badRequest(`Duplicate column(s): ${[...new Set(dupes)].join(', ')}`);
  }

  // Filters — keys must be registered filter keys.
  const rawFilters = def.filters !== undefined ? def.filters : def.filtersJson;
  const allowedFilters = dataset.filters.map((f) => f.key);
  let filters = {};
  if (rawFilters != null) {
    if (typeof rawFilters !== 'object' || Array.isArray(rawFilters)) {
      throw badRequest('filters must be an object of { filterKey: value }.');
    }
    for (const [k, v] of Object.entries(rawFilters)) {
      if (v == null || v === '') continue; // empty filter = not applied
      if (!allowedFilters.includes(k)) {
        throw badRequest(`Unknown filter "${k}" for dataset "${datasetKey}". Allowed filters: ${allowedFilters.join(', ')}`);
      }
      filters[k] = v;
    }
  }

  // groupBy — one of the dataset's groupable keys.
  let groupBy = def.groupBy || null;
  if (groupBy != null && groupBy !== '') {
    groupBy = String(groupBy);
    if (!dataset.groupable.includes(groupBy)) {
      throw badRequest(`Cannot group dataset "${datasetKey}" by "${groupBy}". Allowed groupBy: ${dataset.groupable.join(', ')}`);
    }
  } else {
    groupBy = null;
  }

  // sort — { key, dir } where key ∈ dataset columns (or the grouped output cols).
  const rawSort = def.sort !== undefined ? def.sort : def.sortJson;
  let sort = null;
  if (rawSort != null) {
    if (typeof rawSort !== 'object' || Array.isArray(rawSort) || !rawSort.key) {
      throw badRequest('sort must be an object { key, dir } (dir: "asc" | "desc").');
    }
    const key = String(rawSort.key);
    const groupedKeys = groupBy ? [groupBy, 'count', ...allowedCols] : allowedCols;
    if (!groupedKeys.includes(key)) {
      throw badRequest(`Unknown sort key "${key}" for dataset "${datasetKey}". Allowed sort keys: ${groupedKeys.join(', ')}`);
    }
    const dir = String(rawSort.dir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
    sort = { key, dir };
  }

  return { dataset, columns: columnKeys.map((k) => colByKey.get(k)), columnKeys, filters, groupBy, sort };
}

// ── folds (pure) ─────────────────────────────────────────────────────────────

const NUMERIC_TYPES = new Set(['number', 'money']);

/** Sum numeric/money values without float drift (4-dp fixed-point). */
function addFixed(a, b) {
  return Math.round((a + b) * 10000) / 10000;
}

/**
 * Group rows by `groupBy`: each group carries the group value, a `count`, and
 * the SUM of every numeric/money column among `columns`.
 * Returns { rows, columns } — the grouped output column set (group key, count,
 * then the summed numeric columns, preserving definition order).
 */
function applyGrouping(rows, columns, groupBy) {
  const groupCol = columns.find((c) => c.key === groupBy) || { key: groupBy, label: groupBy, type: 'string' };
  const sumCols = columns.filter((c) => NUMERIC_TYPES.has(c.type) && c.key !== groupBy);
  const groups = new Map();
  for (const r of rows) {
    const raw = r[groupBy];
    const k = raw == null ? '—' : (raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw));
    if (!groups.has(k)) {
      const g = { [groupBy]: k, count: 0 };
      for (const c of sumCols) g[c.key] = 0;
      groups.set(k, g);
    }
    const g = groups.get(k);
    g.count += 1;
    for (const c of sumCols) {
      const v = r[c.key];
      if (typeof v === 'number' && Number.isFinite(v)) g[c.key] = addFixed(g[c.key], v);
    }
  }
  return {
    rows: [...groups.values()],
    columns: [
      { key: groupBy, label: groupCol.label, type: 'string' },
      { key: 'count', label: 'Count', type: 'number' },
      ...sumCols.map((c) => ({ key: c.key, label: c.label, type: c.type })),
    ],
  };
}

/** Stable sort by { key, dir } — numbers numerically, Dates by time, else string. */
function applySort(rows, sort) {
  if (!sort || !sort.key) return rows;
  const { key } = sort;
  const mul = sort.dir === 'desc' ? -1 : 1;
  const rank = (v) => (v == null ? 1 : 0); // nulls always last, either direction
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (rank(av) !== rank(bv)) return rank(av) - rank(bv);
    if (av == null && bv == null) return 0;
    let cmp;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else if (av instanceof Date && bv instanceof Date) cmp = av.getTime() - bv.getTime();
    else cmp = String(av).localeCompare(String(bv));
    return cmp * mul;
  });
}

/** Slice for the requested page. */
function paginate(rows, page, pageSize) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 50));
  return { pageRows: rows.slice((p - 1) * ps, (p - 1) * ps + ps), page: p, pageSize: ps };
}

/** Column totals over ALL rows (numeric/money columns only). */
function computeTotals(rows, columns) {
  const numeric = columns.filter((c) => NUMERIC_TYPES.has(c.type));
  if (!numeric.length) return null;
  const totals = {};
  for (const c of numeric) totals[c.key] = 0;
  for (const r of rows) {
    for (const c of numeric) {
      const v = r[c.key];
      if (typeof v === 'number' && Number.isFinite(v)) totals[c.key] = addFixed(totals[c.key], v);
    }
  }
  return totals;
}

// ── run + export (prisma via the dataset fetch) ──────────────────────────────

/**
 * Run a (validated-on-entry) definition: fetch up to RUN_HARD_CAP source rows,
 * fold (group → sort), total, paginate.
 * @returns {{ datasetKey, columns, rows, page, pageSize, total, totals, groupBy, capped }}
 */
async function runDefinition(def, { businessId, scope, page = 1, pageSize = 50 } = {}) {
  const v = validateDefinition(def);
  const fetched = await v.dataset.fetch({
    businessId,
    scope,
    filters: v.filters,
    page: 1,
    pageSize: RUN_HARD_CAP,
  });
  const sourceRows = fetched.rows || [];
  const capped = (fetched.total || 0) > sourceRows.length;

  // Project to the chosen columns only (a definition never exposes more).
  let rows = sourceRows.map((r) => {
    const o = {};
    for (const k of v.columnKeys) o[k] = r[k];
    return o;
  });
  let columns = v.columns.map((c) => ({ key: c.key, label: c.label, type: c.type || 'string' }));

  if (v.groupBy) {
    const grouped = applyGrouping(rows, columns, v.groupBy);
    rows = grouped.rows;
    columns = grouped.columns;
  }
  rows = applySort(rows, v.sort);

  const totals = computeTotals(rows, columns);
  const { pageRows, page: p, pageSize: ps } = paginate(rows, page, pageSize);

  return {
    datasetKey: v.dataset.key,
    groupBy: v.groupBy,
    columns,
    rows: pageRows,
    page: p,
    pageSize: ps,
    total: rows.length,
    totals,
    capped,
  };
}

/**
 * Render a definition as a downloadable file via the shared tabular exporter.
 * @returns Promise<{ fileName, contentType, content, rowCount }>
 */
async function renderExport(def, format, { businessId, scope, title } = {}) {
  const v = validateDefinition(def); // fail before any fetch on a bad definition
  const run = await runDefinition(def, { businessId, scope, page: 1, pageSize: RUN_HARD_CAP });
  const name = title || def.name || v.dataset.label;
  const out = await exportTabular(format, {
    title: name,
    subtitle: v.groupBy ? `Grouped by ${v.groupBy}` : undefined,
    columns: run.columns,
    rows: run.rows,
    totals: run.totals || undefined,
    fileBase: `${slugify(name)}_${new Date().toISOString().slice(0, 10)}`,
  });
  out.rowCount = run.rows.length;
  return out;
}

module.exports = {
  validateDefinition,
  applyGrouping,
  applySort,
  paginate,
  computeTotals,
  runDefinition,
  renderExport,
  RUN_HARD_CAP,
};
