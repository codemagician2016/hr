'use strict';

/*
 * tabular.unit.test.js — Reports Platform shared export lib (export/tabular.js).
 * Plain-node, NO DB (mirrors recognition/__tests__ style):
 *   node backend/src/hr/reports/__tests__/tabular.unit.test.js
 *
 * Covers: CSV escaping + formula-injection neutralisation + BOM + totals row,
 * type-aware cell formatting, the XLSX optional-dep fallback (forced via the
 * xlsxModule:null hook), the real XLSX path when the dep is installed, the PDF
 * renderer (valid %PDF bytes), and format dispatch errors.
 */

const assert = require('assert');
const tab = require('../export/tabular');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

async function main() {
  /* ── neutralizeFormula: every dangerous lead char gets a quote prefix ── */
  {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      ok(`neutralises leading ${JSON.stringify(lead)}`, tab.neutralizeFormula(`${lead}SUM(A1)`) === `'${lead}SUM(A1)`);
    }
    ok('plain text untouched', tab.neutralizeFormula('hello') === 'hello');
    ok('empty stays empty', tab.neutralizeFormula('') === '');
    ok('null → empty', tab.neutralizeFormula(null) === '');
    ok('interior = untouched', tab.neutralizeFormula('a=b') === 'a=b');
  }

  /* ── csvCell: RFC-4180 escaping on top of the guard ── */
  {
    ok('plain cell unquoted', tab.csvCell('abc') === 'abc');
    ok('comma quoted', tab.csvCell('a,b') === '"a,b"');
    ok('quote doubled', tab.csvCell('say "hi"') === '"say ""hi"""');
    ok('newline quoted', tab.csvCell('a\nb') === '"a\nb"');
    ok('formula neutralised then quoted if needed', tab.csvCell('=1+1,x') === '"\'=1+1,x"');
  }

  /* ── formatCell: type-aware display ── */
  {
    ok('money → 2dp', tab.formatCell(1234.5, { type: 'money' }) === '1234.50');
    ok('money 0 → 0.00', tab.formatCell(0, { type: 'money' }) === '0.00');
    ok('number integer stays bare', tab.formatCell(42, { type: 'number' }) === '42');
    ok('number decimal kept', tab.formatCell(1.5, { type: 'number' }) === '1.5');
    ok('number float noise trimmed', tab.formatCell(0.1 + 0.2, { type: 'number' }) === '0.3');
    ok('date → ISO day', tab.formatCell(new Date('2026-07-23T10:30:00Z'), { type: 'date' }) === '2026-07-23');
    ok('date string parsed', tab.formatCell('2026-01-05', { type: 'date' }) === '2026-01-05');
    ok('null → empty', tab.formatCell(null, { type: 'money' }) === '');
    ok('string passthrough', tab.formatCell('ACTIVE', { type: 'enum' }) === 'ACTIVE');
  }

  /* ── buildCsv: BOM + title + header + body + TOTAL footer ── */
  {
    const out = tab.buildCsv({
      title: 'My Report',
      columns: [
        { key: 'name', label: 'Name', type: 'string' },
        { key: 'amount', label: 'Amount', type: 'money' },
      ],
      rows: [
        { name: 'Alice, A', amount: 10 },
        { name: '=cmd|/c calc', amount: 2.345 },
      ],
      totals: { amount: 12.35 },
    });
    ok('csv fileName', out.fileName === 'my_report.csv');
    ok('csv contentType', out.contentType === 'text/csv; charset=utf-8');
    ok('csv starts with BOM', out.content.charCodeAt(0) === 0xFEFF);
    const lines = out.content.slice(1).split('\r\n');
    ok('title line first', lines[0] === 'My Report');
    ok('blank separator', lines[1] === '');
    ok('header row', lines[2] === 'Name,Amount');
    ok('comma cell quoted', lines[3] === '"Alice, A",10.00');
    ok('formula neutralised in body', lines[4] === "'=cmd|/c calc,2.35");
    ok('TOTAL row present', lines[5] === 'TOTAL,12.35');
  }

  /* ── buildCsv without totals: no TOTAL row ── */
  {
    const out = tab.buildCsv({
      title: 'T',
      columns: [{ key: 'a', label: 'A' }],
      rows: [{ a: 'x' }],
    });
    ok('no TOTAL row when totals absent', !out.content.includes('TOTAL'));
  }

  /* ── buildXlsx forced fallback (xlsx unavailable) → valid CSV artefact ── */
  {
    const out = tab.buildXlsx({
      title: 'Fallback',
      columns: [{ key: 'a', label: 'A' }],
      rows: [{ a: '=EVIL()' }],
    }, { xlsxModule: null });
    ok('fallback fileName is .csv', out.fileName.endsWith('.csv'));
    ok('fallback contentType is csv', out.contentType.startsWith('text/csv'));
    ok('fallback still neutralises formulas', out.content.includes("'=EVIL()"));
  }

  /* ── buildXlsx real path (when the optional dep is installed) ── */
  {
    let xlsx = null;
    try { xlsx = require('xlsx'); } catch (_e) { /* not installed — fallback covered above */ }
    if (xlsx) {
      const out = tab.buildXlsx({
        title: 'Real XLSX',
        columns: [{ key: 'a', label: 'A' }, { key: 'n', label: 'N', type: 'money' }],
        rows: [{ a: 'x', n: 5 }],
        totals: { n: 5 },
      });
      ok('xlsx fileName', out.fileName.endsWith('.xlsx'));
      ok('xlsx contentType', out.contentType.includes('spreadsheetml'));
      ok('xlsx content is a Buffer', Buffer.isBuffer(out.content));
      ok('xlsx magic bytes (PK zip)', out.content[0] === 0x50 && out.content[1] === 0x4B);
    } else {
      ok('xlsx not installed — fallback path already covered', true);
    }
  }

  /* ── PDF: valid %PDF bytes, async contract ── */
  {
    const rows = [];
    for (let i = 0; i < 120; i++) rows.push({ emp: `EMP-${i}`, name: `Person ${i}`, net: i * 10.5 });
    const out = await tab.exportTabular('pdf', {
      title: 'PDF Report',
      columns: [
        { key: 'emp', label: 'Employee code' },
        { key: 'name', label: 'Employee name' },
        { key: 'net', label: 'Net pay', type: 'money' },
      ],
      rows,
      totals: { net: 999 },
    });
    ok('pdf fileName', out.fileName.endsWith('.pdf'));
    ok('pdf contentType', out.contentType === 'application/pdf');
    ok('pdf content is a Buffer', Buffer.isBuffer(out.content));
    ok('pdf magic bytes', out.content.slice(0, 5).toString('ascii') === '%PDF-');
  }

  /* ── dispatch: case-insensitive formats + 400 on junk ── */
  {
    const csv = await tab.exportTabular('csv', { title: 'x', columns: [{ key: 'a', label: 'A' }], rows: [] });
    ok('lowercase format accepted', csv.fileName.endsWith('.csv'));
    let threw = null;
    try { await tab.exportTabular('DOCX', { title: 'x', columns: [], rows: [] }); } catch (e) { threw = e; }
    ok('unknown format rejects', !!threw);
    ok('unknown format is a 400', threw.statusCode === 400);
    ok('error lists allowed formats', /CSV.*XLSX.*PDF/.test(threw.message));
  }

  console.log(`tabular.unit: ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
