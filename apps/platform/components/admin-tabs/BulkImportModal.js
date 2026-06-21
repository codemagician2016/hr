'use client';

// Generic bulk CSV import modal used by BrandsPanel + ProductsPanel.
// Props:
//   type      — 'brands' | 'products'  (drives label copy + endpoint)
//   onClose   — close callback
//   onSuccess — fires after a successful import; parent should refresh()
//
// Flow:
//   1. Seller clicks "Download sample" → browser hits /api/ecom/bulk-import/<type>/sample
//      (auth cookie carries; no Authorization header needed).
//   2. Seller picks a .csv file. We FileReader.readAsText it into state.
//   3. Submit → POST /api/ecom/bulk-import/<type> { csv: text }.
//   4. Backend replies with per-row results; we render the summary + a
//      collapsible error list so a seller can fix and re-upload.
//
// We deliberately stay JSON (no multipart). Lets us reuse the existing
// auth + error plumbing in api.js, and the sheets sellers actually upload
// are well under the 30MB Express body limit.

import { useRef, useState } from 'react';
import { api } from '@/lib/adminApi';

const COPY = {
  brands: {
    title: 'Bulk import brands',
    intro:
      'Upload a CSV of brand families + brands. Existing rows (matched by slug) are updated; new rows are created. Re-uploading a corrected sheet is safe.',
    columnsTitle: 'Required column: brand_name. Optional: family_name, family_slug, brand_slug, country_code, brand_logo_url, brand_description.',
    sampleEndpoint: '/api/ecom/bulk-import/brands/sample',
    submitEndpoint: '/api/ecom/bulk-import/brands',
    sampleFileName: 'brands-sample.csv',
    summaryFmt: (s) =>
      `${s.brands.created} brand${s.brands.created === 1 ? '' : 's'} created · ${s.brands.updated} updated · ${s.families.created} families created · ${s.families.updated} families updated`,
  },
  products: {
    title: 'Bulk import products',
    intro:
      'Upload a CSV of products. Rows are matched by slug; existing products are updated, new rows are created. Categories and brands are looked up by slug — make sure they exist before upload (or the row imports with a soft warning).',
    columnsTitle: 'Required columns: name, price. Optional: slug, description, short_description, category_slug, brand_slug, sku, barcode, qr_code, compare_price, currency, opening_stock_qty, is_published, is_featured, image_url, weight_grams, weight_display, meta_title, meta_description.',
    sampleEndpoint: '/api/ecom/bulk-import/products/sample',
    submitEndpoint: '/api/ecom/bulk-import/products',
    sampleFileName: 'products-sample.csv',
    summaryFmt: (s) =>
      `${s.created} product${s.created === 1 ? '' : 's'} created · ${s.updated} updated · ${s.inventory?.created || 0} inventory rows created · ${s.inventory?.updated || 0} inventory rows updated · ${s.skipped} skipped`,
  },
};

export default function BulkImportModal({ type, onClose, onSuccess }) {
  // Hooks must be called before any conditional return (rules-of-hooks),
  // even if the eventual render is a noop for an unknown `type`.
  const fileInputRef = useRef(null);
  const [fileName, setFileName] = useState('');
  const [csvText, setCsvText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [showAllErrors, setShowAllErrors] = useState(false);

  const copy = COPY[type];
  if (!copy) return null;
  const importComplete = !!result;

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError('');
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ''));
    reader.onerror = () => setError('Could not read the file');
    reader.readAsText(file);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!csvText.trim()) {
      setError('Pick a CSV file first');
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const body = await api(copy.submitEndpoint, {
        method: 'POST',
        body: JSON.stringify({ csv: csvText }),
      });
      setResult(body);
      if ((body.totalRows || 0) - (body.skipped || 0) > 0) {
        // Fire parent refresh whenever at least one row actually landed.
        onSuccess?.();
      }
    } catch (err) {
      setError(err.message || 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-base font-bold text-gray-900">{copy.title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-2xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-5">
          <p className="text-sm text-gray-600">{copy.intro}</p>

          <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">Step 1 — get the template</p>
            <a
              href={copy.sampleEndpoint}
              download={copy.sampleFileName}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-600 hover:underline"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" />
              </svg>
              Download sample CSV
            </a>
            <p className="text-xs text-gray-500 mt-2 leading-relaxed">{copy.columnsTitle}</p>
          </div>

          <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2">Step 2 — upload your file</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFile}
              className="block w-full text-sm text-gray-700
                         file:mr-3 file:py-1.5 file:px-3 file:rounded-md
                         file:border-0 file:text-sm file:font-semibold
                         file:bg-indigo-50 file:text-indigo-700
                         hover:file:bg-indigo-100"
            />
            {fileName && (
              <p className="text-xs text-gray-500 mt-2">
                Loaded: <span className="font-medium text-gray-700">{fileName}</span>
                {csvText && ` — ${csvText.split('\n').filter(Boolean).length - 1} data row(s) detected`}
              </p>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>
          )}

          {result && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
              <p className="text-sm font-semibold text-emerald-900">Done — {copy.summaryFmt(result)}</p>
              <p className="text-xs text-emerald-700 mt-0.5">
                {result.totalRows} row(s) processed · {result.errors?.length || 0} error(s)
              </p>
              {result.errors?.length > 0 && (
                <div className="mt-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setShowAllErrors((s) => !s)}
                    className="text-emerald-800 underline"
                  >
                    {showAllErrors ? 'Hide' : 'Show'} {result.errors.length} error(s)
                  </button>
                  {showAllErrors && (
                    <ul className="mt-2 max-h-40 overflow-y-auto bg-white rounded border border-emerald-100 p-2 space-y-1">
                      {result.errors.map((e, i) => (
                        <li key={i} className="text-gray-700">
                          <span className="font-mono text-gray-400">row {e.row}:</span> {e.error}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            <button
              type="submit"
              disabled={busy || !csvText || importComplete}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50"
            >
              {busy ? 'Importing…' : importComplete ? 'Imported' : 'Import'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              {result ? 'Close' : 'Cancel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
