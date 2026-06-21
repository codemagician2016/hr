'use client';

// ECOMMERCE Path B Phase 6b (2026-05-01) — real BulkOpsPanel.
// Backend: /api/ecom/bulk/* (Phase 6a).

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useEcommerceLocation } from '@/components/EcommerceLocationSwitcher';
import { useEcomAccess } from '@/components/EcomAccessContext';
import {
  KpiCard, KpiGrid,
  PageHeader, ErrorBanner, PrimaryButton, SecondaryButton,
  fmtNumber,
} from '@/components/ecom-ui';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `${res.status}`);
  return body;
}

// Validation per tab — runs client-side before the user hits Import so
// they see invalid rows in the preview rather than discovering them via
// a partial-failure response.
function validateRow(tab, row) {
  const errors = [];
  if (tab === 'products') {
    if (!row.name) errors.push('name required');
    if (!row.slug) errors.push('slug required');
    else if (!/^[a-z0-9-]+$/.test(row.slug)) errors.push('slug must be lowercase a-z0-9-');
    if (!row.priceMinor && row.priceMinor !== '0') errors.push('priceMinor required');
    else if (Number.isNaN(Number(row.priceMinor))) errors.push('priceMinor must be a number');
  } else if (tab === 'adjustments') {
    if (!row.productSlug) errors.push('productSlug required');
    if (!row.delta) errors.push('delta required');
    else if (Number.isNaN(Number(row.delta))) errors.push('delta must be a number');
    if (!row.reason) errors.push('reason required');
  }
  return errors;
}

// CSV parse — handles double-quoted fields with embedded commas + escaped quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

function rowsToObjects(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
    return obj;
  });
}

// imageUrls column accepts up to 20 URLs separated by `|` in one cell
// (commas are reserved for CSV itself). Leave it blank to keep whatever
// images the product already has — the importer only overwrites images
// when this column is explicitly set, so re-importing a CSV without an
// imageUrls column won't wipe images you added via the single-product
// editor.
const PRODUCT_TEMPLATE = `name,slug,priceMinor,categorySlug,sku,barcode,qrCode,isPublished,shortDescription,imageUrls
"Organic Apple",apples-1kg,250,produce,SKU-APP-1K,8901234567890,https://example.com/p/apples-1kg,true,"Crisp Indian apples 1kg","https://cdn.example.com/apple-1.jpg|https://cdn.example.com/apple-2.jpg"
"Whole-wheat Bread",wheat-bread,180,bakery,SKU-BR-WW,9421900000001,https://example.com/p/wheat-bread,true,"Fresh-baked daily","https://cdn.example.com/bread.jpg"`;

const ADJUSTMENT_TEMPLATE = `productSlug,locationId,delta,reason,note
apples-1kg,<paste-location-id>,50,GRN_RECEIPT,"Tuesday delivery"
wheat-bread,<paste-location-id>,-3,DAMAGE,"Squashed in transit"`;

export default function BulkOpsPanel() {
  const { active: activeLocation, locations } = useEcommerceLocation();
  const { has } = useEcomAccess();
  const canImportProducts = has('catalogue.edit');
  const canImportAdjustments = has('inventory.adjust');
  const availableTabs = useMemo(() => [
    ...(canImportProducts ? [{ key: 'products', label: 'Import products' }] : []),
    ...(canImportAdjustments ? [{ key: 'adjustments', label: 'Import inventory adjustments' }] : []),
    { key: 'history', label: 'Run history' },
  ], [canImportAdjustments, canImportProducts]);
  const [tab, setTab] = useState(() => (canImportProducts ? 'products' : canImportAdjustments ? 'adjustments' : 'history'));
  const [csvText, setCsvText] = useState('');
  const [parsed, setParsed] = useState([]);
  const [parseError, setParseError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [summary, setSummary] = useState(null);

  const reload = useCallback(async () => {
    try {
      const [j, s] = await Promise.all([
        api('/api/ecom/bulk/jobs'),
        api('/api/ecom/bulk/summary'),
      ]);
      setJobs(j.rows || []);
      setSummary(s);
    } catch { /* tolerate */ }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (!availableTabs.some((item) => item.key === tab)) {
      setTab(availableTabs[0]?.key || 'history');
      setCsvText('');
      setParsed([]);
      setResult(null);
    }
  }, [availableTabs, tab]);

  function tryParse(text) {
    setCsvText(text);
    setParseError('');
    setResult(null);
    if (!text.trim()) { setParsed([]); return; }
    try {
      const rows = rowsToObjects(parseCsv(text));
      setParsed(rows);
    } catch (err) {
      setParseError(err.message || 'Failed to parse CSV');
      setParsed([]);
    }
  }

  async function importProducts() {
    setBusy(true); setResult(null);
    try {
      const rows = parsed.map((r) => {
        // imageUrls column is pipe-separated so a CSV cell can hold many
        // URLs (commas are taken by CSV). Empty string → omitted entirely
        // so the importer leaves existing images alone instead of wiping.
        const rawImages = (r.imageUrls || '').trim();
        const imageUrls = rawImages
          ? rawImages.split('|').map((u) => u.trim()).filter(Boolean)
          : undefined;
        return {
          name: r.name,
          slug: r.slug,
          priceMinor: Number(r.priceMinor),
          categorySlug: r.categorySlug || undefined,
          sku: r.sku || undefined,
          barcode: r.barcode || undefined,
          qrCode: r.qrCode || r.qr_code || undefined,
          isPublished: r.isPublished === 'true' || r.isPublished === '1',
          shortDescription: r.shortDescription || undefined,
          description: r.description || undefined,
          imageUrls,
        };
      });
      const out = await api('/api/ecom/bulk/products', {
        method: 'POST',
        body: JSON.stringify({ rows }),
      });
      setResult(out);
      reload();
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function importAdjustments() {
    setBusy(true); setResult(null);
    try {
      const defaultLocation = activeLocation !== 'ALL' ? activeLocation : null;
      const rows = parsed.map((r) => ({
        productSlug: r.productSlug,
        locationId: r.locationId || defaultLocation,
        delta: Number(r.delta),
        reason: r.reason,
        note: r.note || undefined,
      }));
      const out = await api('/api/ecom/bulk/inventory-adjustments', {
        method: 'POST',
        body: JSON.stringify({ rows }),
      });
      setResult(out);
      reload();
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setBusy(false);
    }
  }

  // Per-row validation results — re-runs cheaply when parsed list or tab
  // changes. Surfaces "5 of 12 rows have errors" at the top of the preview.
  const validation = useMemo(() => {
    if (parsed.length === 0) return { invalidCount: 0, perRow: [] };
    const perRow = parsed.map((row) => validateRow(tab, row));
    const invalidCount = perRow.filter((errs) => errs.length > 0).length;
    return { invalidCount, perRow };
  }, [parsed, tab]);
  const validRows = parsed.length - validation.invalidCount;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bulk operations"
        subtitle={summary
          ? `${fmtNumber(summary.runs30d)} runs · ${fmtNumber(summary.rowsProcessed30d)} rows processed · ${fmtNumber(summary.rowsFailed30d)} failed (last 30d)`
          : 'Loading…'}
      />

      <KpiGrid cols={4}>
        <KpiCard label="Runs · 30d" value={fmtNumber(summary?.runs30d)} />
        <KpiCard label="Rows processed" value={fmtNumber(summary?.rowsProcessed30d)} />
        <KpiCard label="Failed rows" value={fmtNumber(summary?.rowsFailed30d)} tone={summary?.rowsFailed30d > 0 ? 'warning' : null} />
        <KpiCard label="Row cap" value="1,000" hint="Per single import" />
      </KpiGrid>

      <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5 w-fit">
        {availableTabs.map((t) => (
          <button key={t.key} type="button" onClick={() => { setTab(t.key); setCsvText(''); setParsed([]); setResult(null); }}
            className={`px-4 py-1.5 text-sm font-semibold rounded-md ${tab === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab !== 'history' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-wider text-gray-500 mb-2">Paste CSV</p>
            <textarea value={csvText} onChange={(e) => tryParse(e.target.value)} rows={10}
              placeholder={tab === 'products' ? PRODUCT_TEMPLATE : ADJUSTMENT_TEMPLATE}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-xs font-mono focus:outline-none focus:border-indigo-500" />
            <button type="button" onClick={() => tryParse(tab === 'products' ? PRODUCT_TEMPLATE : ADJUSTMENT_TEMPLATE)}
              className="mt-2 text-xs font-semibold text-indigo-700 hover:underline">Insert template</button>
          </div>

          {parseError && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{parseError}</div>}

          {parsed.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <p className="text-xs font-mono uppercase tracking-wider text-gray-500">
                  Preview · {parsed.length} row{parsed.length === 1 ? '' : 's'}
                </p>
                <div className="flex items-center gap-2 text-xs">
                  <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                    <span className="w-2 h-2 rounded-full bg-emerald-500" /> {validRows} valid
                  </span>
                  {validation.invalidCount > 0 && (
                    <span className="inline-flex items-center gap-1 text-red-700 font-semibold">
                      <span className="w-2 h-2 rounded-full bg-red-500" /> {validation.invalidCount} need fixes
                    </span>
                  )}
                </div>
              </div>
              {validation.invalidCount > 0 && (
                <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2 flex items-start gap-2">
                  <span>⚠</span>
                  <span>
                    <strong>{validation.invalidCount} row{validation.invalidCount === 1 ? '' : 's'}</strong> will be skipped on import — fix the highlighted rows first OR proceed and the importer will skip them.
                  </span>
                </div>
              )}
              <div className="overflow-x-auto border border-gray-200 rounded-lg max-h-60">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-2 py-1 w-6"></th>
                      <th className="px-2 py-1 w-8 text-left font-mono">#</th>
                      {Object.keys(parsed[0]).map((k) => <th key={k} className="px-2 py-1 text-left font-mono">{k}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.slice(0, 100).map((r, i) => {
                      const errs = validation.perRow[i] || [];
                      const invalid = errs.length > 0;
                      return (
                        <tr key={i} className={`border-t border-gray-100 ${invalid ? 'bg-red-50/50' : ''}`}>
                          <td className="px-2 py-1">
                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${invalid ? 'bg-red-500' : 'bg-emerald-500'}`}
                              title={invalid ? errs.join('; ') : 'Valid'} />
                          </td>
                          <td className="px-2 py-1 font-mono text-gray-400">{i + 1}</td>
                          {Object.keys(parsed[0]).map((k) => <td key={k} className="px-2 py-1 font-mono">{r[k]}</td>)}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {parsed.length > 100 && <p className="text-[10px] text-gray-500 p-2">…showing first 100 of {parsed.length}</p>}
              </div>
            </div>
          )}

          {tab === 'adjustments' && activeLocation === 'ALL' && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
              Tip: select a specific location in the topbar so rows that omit <code>locationId</code> use it as default. Otherwise every row must include <code>locationId</code>.
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button"
              disabled={busy || parsed.length === 0}
              onClick={tab === 'products' ? importProducts : importAdjustments}
              className="px-4 py-2 text-sm font-semibold rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? 'Importing…' : `Import ${parsed.length} row${parsed.length === 1 ? '' : 's'}`}
            </button>
          </div>

          {result && (
            <div className={`rounded-2xl border p-4 ${result.failed > 0 ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
              {result.error ? (
                <p className="text-sm text-red-700">{result.error}</p>
              ) : (
                <>
                  <p className="text-sm font-semibold text-gray-900">
                    {tab === 'products'
                      ? `${result.created} created · ${result.updated} updated · ${result.failed} failed`
                      : `${result.applied} applied · ${result.failed} failed`}
                  </p>
                  {result.firstErrors?.length > 0 && (
                    <ul className="mt-2 text-xs text-red-700 space-y-1">
                      {result.firstErrors.map((e, i) => (
                        <li key={i} className="font-mono">row {e.index}: {e.message}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          {jobs.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-sm font-semibold text-gray-900">No jobs yet</p>
              <p className="text-xs text-gray-500 mt-1">Run an import above to populate this list.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {jobs.map((j) => {
                const p = j.payload || {};
                const isErr = (p.summary?.failed || 0) > 0;
                return (
                  <div key={j.id} className="p-4 flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{p.kind || 'JOB'}</p>
                      <p className="text-xs text-gray-500 font-mono mt-0.5">{new Date(j.createdAt).toLocaleString('en-GB')}</p>
                      {p.summary && (
                        <p className="text-xs text-gray-700 mt-1">
                          {Object.entries(p.summary).filter(([k]) => k !== 'firstErrors').map(([k, v]) => `${k}: ${v}`).join(' · ')}
                        </p>
                      )}
                    </div>
                    {isErr && <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">PARTIAL</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
