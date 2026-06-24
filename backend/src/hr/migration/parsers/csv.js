'use strict';

/**
 * csv.js — a PURE, dependency-free RFC-4180 CSV codec for the import subsystem.
 *
 * Why hand-rolled: the safe, audited XLSX/CSV libraries (SheetJS `xlsx`,
 * `papaparse`) are NOT in package.json and could not be installed in the build
 * environment (see the dependency FLAG in the feature notes). CSV is the primary
 * migration path the spec's acceptance tests exercise ("a CSV of back-dated
 * attendance + a CTC import"), so this codec is the load-bearing parser. It is
 * pure (no DB, no I/O), streamed-string in / rows-out, and unit-tested.
 *
 * Safety:
 *   - BOM tolerated (UTF-8 + BOM stripped).
 *   - CRLF / LF / CR line endings all handled.
 *   - RFC-4180 quoting: "a,b" stays one field; "" escapes a literal quote.
 *   - FORMULA-INJECTION GUARD (§11 file safety): neutralisation is applied ONLY
 *     on WRITE (toCsv — the one place a value can reach a spreadsheet). On READ
 *     the cell is kept VERBATIM (trimmed): the DB is not a spreadsheet, so
 *     prefixing a quote on read would corrupt legitimate data — e.g. an E.164
 *     phone "+919876543210" or a negative figure "-500" would be mangled and
 *     persisted/rejected. Type validity is enforced by the per-kind validators,
 *     not by mutating the raw cell. The export side (toCsv) still escapes a
 *     formula-leading cell so a re-opened annotated/report file is safe.
 *   - Row/byte caps are enforced by the caller (imports.service), not here.
 */

const FORMULA_LEAD = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Strip a UTF-8 BOM if present. */
function stripBom(s) {
  if (typeof s !== 'string') return '';
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Neutralise a cell value against CSV formula injection. Returns the value
 * unchanged when safe; prefixes a single quote when the leading char could be
 * interpreted as a formula by Excel/Sheets.
 *
 * WRITE-SIDE ONLY: applied by toCsv (export/report — the only place a value can
 * reach a spreadsheet). NEVER applied on read; mutating raw input corrupts
 * legitimate data (E.164 phones, negative money) — see the module doc-comment.
 */
function neutralizeCell(value) {
  if (value == null) return value;
  const s = String(value);
  if (s.length === 0) return s;
  if (FORMULA_LEAD.has(s[0])) return `'${s}`;
  return s;
}

/**
 * parseCsv(text) → { headers: string[], rows: Array<Record<string,string|null>>, rawRows: string[][] }
 *
 * - headers come from the first non-empty record.
 * - each data row maps header→cell; blank cells normalise to null; values are
 *   trimmed and kept VERBATIM (NOT formula-neutralised — that would corrupt
 *   legitimate input like "+91…" phones / "-500"; neutralisation is write-only).
 * - rawRows is the unmapped cell matrix (used for the per-row rawJson audit).
 */
function parseCsv(text) {
  const matrix = parseToMatrix(stripBom(text));
  if (matrix.length === 0) return { headers: [], rows: [], rawRows: [] };

  const headers = matrix[0].map((h) => String(h == null ? '' : h).trim());
  const rows = [];
  const rawRows = [];
  for (let r = 1; r < matrix.length; r += 1) {
    const cells = matrix[r];
    // Skip a fully-empty trailing line.
    if (cells.length === 1 && (cells[0] == null || String(cells[0]).trim() === '')) continue;
    const obj = {};
    const raw = [];
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c];
      let v = cells[c];
      // VERBATIM (trimmed) — do NOT neutralise on read. The DB is not a
      // spreadsheet; prefixing a quote here would mangle "+91…" phones and break
      // negative money. Formula-injection is neutralised on WRITE (toCsv) only.
      v = v == null ? '' : String(v).trim();
      raw.push(v);
      obj[key] = v === '' ? null : v;
    }
    rows.push(obj);
    rawRows.push(raw);
  }
  return { headers, rows, rawRows };
}

/**
 * parseToMatrix(text) — RFC-4180 state machine → string[][]. PURE.
 */
function parseToMatrix(text) {
  const out = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let started = false; // whether the current row has any content
  const pushField = () => { row.push(field); field = ''; started = true; };
  const pushRow = () => { out.push(row); row = []; started = false; };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } // escaped quote
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; started = true; continue; }
    if (ch === ',') { pushField(); continue; }
    if (ch === '\r') {
      // CRLF or lone CR — end the row; swallow a following \n.
      pushField(); pushRow();
      if (text[i + 1] === '\n') i += 1;
      continue;
    }
    if (ch === '\n') { pushField(); pushRow(); continue; }
    field += ch;
    started = true;
  }
  // Flush the trailing field/row if the file didn't end with a newline.
  if (started || field.length > 0 || row.length > 0) { pushField(); pushRow(); }
  return out;
}

/**
 * toCsv(headers, rows) — serialise an array of header keys + row objects to a
 * CSV string. Quotes any field containing a comma, quote, or newline; doubles
 * inner quotes; neutralises formula-leading cells (report-write safety).
 */
function toCsv(headers, rows) {
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    s = neutralizeCell(s);
    if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => esc(r[h])).join(','));
  }
  return lines.join('\r\n');
}

module.exports = { parseCsv, toCsv, neutralizeCell, stripBom, _internals: { parseToMatrix } };
