'use client';

// ECOMMERCE Path B Phase 4 (2026-05-01) — real InventoryPanel.
//
// First panel ported end-to-end from the prototype. Reads from
// /api/ecom/inventory + /api/ecom/inventory/summary, scoped by the
// topbar location switcher. Adjustment modal posts to /api/ecom/inventory/:id/adjust.
//
// Replaces the original "in build" stub. The shared `EcommerceStubPanel`
// helper stays for the other 16 panels still in stub mode.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useEcommerceLocation } from '@/components/EcommerceLocationSwitcher';
import { useTenant } from '@/components/TenantProvider';
import { formatCurrencyMinor, getDefaultCurrency } from '@/lib/currency';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.issues = body.issues || [];
    throw err;
  }
  return body;
}

// Reasons mirror the Prisma enum InventoryAdjustmentReason. Display labels
// shown in the modal dropdown — keys are sent to the API as-is.
const ADJUSTMENT_REASONS = [
  { key: 'COUNT_ADJUSTMENT',     label: 'Stock count correction' },
  { key: 'DAMAGE',               label: 'Damaged stock' },
  { key: 'THEFT',                label: 'Theft / shrinkage' },
  { key: 'EXPIRY',               label: 'Expired' },
  { key: 'GRN_RECEIPT',          label: 'Goods receipt (manual)' },
  { key: 'RETURN_RESTOCK',       label: 'Return — restocked' },
  { key: 'RETURN_SCRAP',         label: 'Return — scrapped' },
  { key: 'PROMOTIONAL_GIVEAWAY', label: 'Promotional giveaway' },
  { key: 'OTHER',                label: 'Other (see note)' },
];

function formatMoney(minor, currency) {
  return formatCurrencyMinor(minor, currency);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => Object.fromEntries(
    headers.map((header, index) => [header, (values[index] || '').trim()]),
  ));
}

function csvInt(value) {
  if (value === null || value === undefined || String(value).trim() === '') return undefined;
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

function csvText(value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text || undefined;
}

async function downloadCsv(path, fallbackName) {
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/i);
  const filename = match?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function StatusBadge({ row }) {
  if (row.isOutOfStock) {
    return <span className="px-2 py-0.5 rounded-full text-[11px] font-mono tracking-wider bg-red-50 text-red-700 border border-red-200">OUT OF STOCK</span>;
  }
  if (row.isLowStock) {
    return <span className="px-2 py-0.5 rounded-full text-[11px] font-mono tracking-wider bg-amber-50 text-amber-700 border border-amber-200">LOW STOCK</span>;
  }
  return <span className="px-2 py-0.5 rounded-full text-[11px] font-mono tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200">IN STOCK</span>;
}

function fmtTransferDate(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function TransferStatusBadge({ status }) {
  const map = {
    DRAFT: 'bg-gray-50 text-gray-700 border-gray-200',
    IN_TRANSIT: 'bg-blue-50 text-blue-700 border-blue-200',
    RECEIVED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    CANCELLED: 'bg-red-50 text-red-700 border-red-200',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full border text-[11px] font-mono tracking-wider ${map[status] || map.DRAFT}`}>
      {String(status || 'DRAFT').replace(/_/g, ' ')}
    </span>
  );
}

function locName(locations, id) {
  return locations.find((loc) => loc.id === id)?.name || 'Unknown location';
}

function AdjustModal({ stock, onClose, onSaved }) {
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState('COUNT_ADJUSTMENT');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const newOnHand = (stock?.onHand || 0) + Number(delta || 0);
  const wouldGoNegative = newOnHand < 0;

  async function handleSave(e) {
    e.preventDefault();
    if (delta === 0 || delta === '0' || delta === '') {
      setError('Delta must be non-zero (+ to add, - to remove)');
      return;
    }
    if (wouldGoNegative) {
      setError(`Adjustment would drop on-hand to ${newOnHand}`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(`/api/ecom/inventory/${stock.id}/adjust`, {
        method: 'POST',
        body: JSON.stringify({
          delta: Number(delta),
          reason,
          note: note || undefined,
        }),
      });
      onSaved?.();
      onClose?.();
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setBusy(false);
    }
  }

  if (!stock) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl border border-gray-200 shadow-xl max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <p className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500">Adjust stock</p>
            <h3 className="text-lg font-bold text-gray-900 truncate">{stock.product?.name || 'Unknown product'}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {stock.location?.name} · current on-hand <strong className="text-gray-900">{stock.onHand}</strong>
              {stock.product?.sku ? ` · SKU ${stock.product.sku}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSave} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Delta (+ adds, − removes) *</label>
            <input
              type="number"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500"
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              New on-hand will be <strong className={wouldGoNegative ? 'text-red-600' : 'text-gray-900'}>{newOnHand}</strong>
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Reason *</label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500"
            >
              {ADJUSTMENT_REASONS.map((r) => (
                <option key={r.key} value={r.key}>{r.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Note (optional)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="e.g. expired stock removed from aisle 3"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500"
            />
          </div>

          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={busy}
              className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400">
              Cancel
            </button>
            <button type="submit" disabled={busy || wouldGoNegative}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? 'Saving…' : 'Save adjustment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function StockSetupModal({ stock, onClose, onSaved }) {
  const [form, setForm] = useState({
    supplierSku: stock?.supplierSku || '',
    localPickCode: stock?.localPickCode || '',
    aisleCode: stock?.aisleCode || '',
    rackCode: stock?.rackCode || '',
    shelfCode: stock?.shelfCode || '',
    binLocation: stock?.binLocation || '',
    reorderPoint: stock?.reorderPoint ?? 0,
    reorderQty: stock?.reorderQty ?? 0,
    unitCostMajor: stock?.unitCostMinor ? String(stock.unitCostMinor / 100) : '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!stock) return;
    setForm({
      supplierSku: stock.supplierSku || '',
      localPickCode: stock.localPickCode || '',
      aisleCode: stock.aisleCode || '',
      rackCode: stock.rackCode || '',
      shelfCode: stock.shelfCode || '',
      binLocation: stock.binLocation || '',
      reorderPoint: stock.reorderPoint ?? 0,
      reorderQty: stock.reorderQty ?? 0,
      unitCostMajor: stock.unitCostMinor ? String(stock.unitCostMinor / 100) : '',
    });
    setError('');
  }, [stock]);

  if (!stock) return null;

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSave(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/ecom/inventory/upsert', {
        method: 'POST',
        body: JSON.stringify({
          productId: stock.productId,
          locationId: stock.locationId,
          supplierSku: form.supplierSku.trim() || null,
          localPickCode: form.localPickCode.trim() || null,
          aisleCode: form.aisleCode.trim() || null,
          rackCode: form.rackCode.trim() || null,
          shelfCode: form.shelfCode.trim() || null,
          binLocation: form.binLocation.trim() || null,
          reorderPoint: Math.max(0, Math.trunc(Number(form.reorderPoint) || 0)),
          reorderQty: Math.max(0, Math.trunc(Number(form.reorderQty) || 0)),
          unitCostMinor: form.unitCostMajor === '' ? null : Math.max(0, Math.round(Number(form.unitCostMajor || 0) * 100)),
        }),
      });
      onSaved?.();
      onClose?.();
    } catch (err) {
      setError(err.message || 'Failed to save stock setup');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl border border-gray-200 shadow-xl max-w-2xl w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <p className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500">Location stock setup</p>
            <h3 className="text-lg font-bold text-gray-900 truncate">{stock.product?.name || 'Unknown product'}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Central SKU {stock.product?.sku || 'not set'} · store-specific setup for {stock.location?.name || 'this location'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Supplier SKU</span>
              <input value={form.supplierSku} onChange={(e) => update('supplierSku', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500" />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Local pick / scan code</span>
              <input value={form.localPickCode} onChange={(e) => update('localPickCode', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500" />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Aisle</span>
              <input value={form.aisleCode} onChange={(e) => update('aisleCode', e.target.value)}
                placeholder="A3"
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500" />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Rack</span>
              <input value={form.rackCode} onChange={(e) => update('rackCode', e.target.value)}
                placeholder="R12"
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500" />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Shelf / bin</span>
              <input value={form.shelfCode} onChange={(e) => update('shelfCode', e.target.value)}
                placeholder="S2"
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500" />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Free-form bin note</span>
              <input value={form.binLocation} onChange={(e) => update('binLocation', e.target.value)}
                placeholder="Aisle 3 / Rack 12 / Shelf 2"
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
            </label>
          </div>

          <div className="grid sm:grid-cols-3 gap-3 pt-2 border-t border-gray-100">
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Reorder point</span>
              <input type="number" min="0" value={form.reorderPoint} onChange={(e) => update('reorderPoint', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500" />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Reorder qty</span>
              <input type="number" min="0" value={form.reorderQty} onChange={(e) => update('reorderQty', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500" />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Unit cost</span>
              <input type="number" min="0" step="0.01" value={form.unitCostMajor} onChange={(e) => update('unitCostMajor', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500" />
            </label>
          </div>

          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={busy}
              className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400">
              Cancel
            </button>
            <button type="submit" disabled={busy}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? 'Saving...' : 'Save setup'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function BulkStockModal({ open, onClose, onSaved, activeLocation, locationLabel = 'selected scope' }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setBusy(false);
    setError('');
    setResult(null);
  }, [open]);

  if (!open) return null;

  const scope = activeLocation && activeLocation !== 'ALL' ? activeLocation : 'ALL';
  const isAllScope = scope === 'ALL';

  async function handleDownload(kind) {
    setDownloadBusy(kind);
    setError('');
    try {
      if (kind === 'sample') {
        await downloadCsv('/api/ecom/bulk/inventory-sample.csv', 'inventory-opening-stock-sample.csv');
      } else {
        const params = new URLSearchParams({ locationId: scope });
        await downloadCsv(`/api/ecom/bulk/inventory-template.csv?${params.toString()}`, 'inventory-products-current-stock.csv');
      }
    } catch (err) {
      setError(err.message || 'Download failed');
    } finally {
      setDownloadBusy('');
    }
  }

  function toImportRows(csvRows) {
    return csvRows.map((row) => ({
      productSlug: csvText(row.productSlug),
      productSku: csvText(row.productSku),
      locationId: csvText(row.locationId),
      newOnHand: csvInt(row.newOnHand),
      delta: csvInt(row.delta),
      reason: csvText(row.reason) || 'COUNT_ADJUSTMENT',
      note: csvText(row.note),
      reorderPoint: csvInt(row.reorderPoint),
      reorderQty: csvInt(row.reorderQty),
      unitCostMinor: csvInt(row.unitCostMinor),
      supplierSku: csvText(row.supplierSku),
      localPickCode: csvText(row.localPickCode),
      aisleCode: csvText(row.aisleCode),
      rackCode: csvText(row.rackCode),
      shelfCode: csvText(row.shelfCode),
      binLocation: csvText(row.binLocation),
    })).filter((row) => {
      const hasProduct = row.productSlug || row.productSku;
      const hasQuantityChange = row.newOnHand !== undefined || row.delta !== undefined;
      const hasSetup = [
        row.reorderPoint,
        row.reorderQty,
        row.unitCostMinor,
        row.supplierSku,
        row.localPickCode,
        row.aisleCode,
        row.rackCode,
        row.shelfCode,
        row.binLocation,
      ].some((value) => value !== undefined);
      return hasProduct && row.locationId && (hasQuantityChange || hasSetup);
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (!file) {
      setError('Choose the completed CSV file first');
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const csvRows = parseCsv(await file.text());
      const rows = toImportRows(csvRows);
      if (rows.length === 0) {
        setError('No importable rows found. Fill newOnHand or delta for at least one product row.');
        return;
      }
      const response = await api('/api/ecom/bulk/inventory-adjustments', {
        method: 'POST',
        body: JSON.stringify({ rows }),
      });
      setResult(response);
      onSaved?.();
    } catch (err) {
      const issueText = err.issues?.length ? `: ${err.issues.slice(0, 3).map((issue) => issue.message).join(', ')}` : '';
      setError(`${err.message || 'Import failed'}${issueText}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl border border-gray-200 shadow-xl max-w-3xl w-full p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <p className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500">Bulk stock import</p>
            <h3 className="text-lg font-bold text-gray-900">Opening stock and stock-take CSV</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Download products with current inventory for {locationLabel}, fill newOnHand in Excel or Google Sheets, then upload it back as CSV. Every quantity change writes an inventory ledger row.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        <div className="grid md:grid-cols-2 gap-4 mb-5">
          <div className="rounded-xl border border-gray-200 p-4">
            <p className="text-sm font-semibold text-gray-900">Download working file</p>
            <p className="text-xs text-gray-500 mt-1">
              Includes product, category, brand, price, location ID, current on-hand/reserved/available, and setup columns.
            </p>
            <button
              type="button"
              onClick={() => handleDownload('template')}
              disabled={!!downloadBusy}
              className="mt-3 inline-flex items-center px-3 py-2 rounded-lg bg-gray-900 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {downloadBusy === 'template' ? 'Preparing...' : isAllScope ? 'Download all locations sheet' : 'Download this location sheet'}
            </button>
          </div>
          <div className="rounded-xl border border-gray-200 p-4">
            <p className="text-sm font-semibold text-gray-900">Need the format?</p>
            <p className="text-xs text-gray-500 mt-1">Use newOnHand for a physical count. Use delta only when you want to add or subtract from the current count.</p>
            <button
              type="button"
              onClick={() => handleDownload('sample')}
              disabled={!!downloadBusy}
              className="mt-3 inline-flex items-center px-3 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700 hover:border-gray-500 disabled:opacity-50"
            >
              {downloadBusy === 'sample' ? 'Preparing...' : 'Download sample CSV'}
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 mb-5">
          <p className="text-sm font-semibold text-amber-950">Recommended route for existing stock</p>
          <div className="mt-2 grid sm:grid-cols-3 gap-3 text-xs text-amber-900">
            <p><strong>1.</strong> Download existing products and inventory for the selected store or all stores.</p>
            <p><strong>2.</strong> Fill only <span className="font-mono">newOnHand</span> for the counted quantity on shelf/back room.</p>
            <p><strong>3.</strong> Upload the CSV. Reserved stock is kept separate, so available stays on-hand minus reserved.</p>
          </div>
          <p className="mt-3 text-xs text-amber-900">
            Do not edit <span className="font-mono">currentReserved</span> or <span className="font-mono">currentAvailable</span>. They are analysis columns; the system recalculates available as on-hand minus reserved.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 mb-1">Completed CSV file</span>
            <input
              type="file"
              accept=".csv,text/csv,application/vnd.ms-excel"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-gray-700 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-indigo-50 file:text-indigo-700 file:font-semibold hover:file:bg-indigo-100"
            />
          </label>

          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
          )}

          {result && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm font-semibold text-emerald-950">Import complete</p>
              <p className="text-xs text-emerald-800 mt-1">
                Processed {result.processed || 0}, applied {result.applied || 0}, created stock rows {result.createdStockRows || 0}, setup rows updated {result.metadataUpdated || 0}, unchanged {result.unchangedRows || 0}, failed {result.failed || 0}.
              </p>
              {result.firstErrors?.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-amber-900">
                  {result.firstErrors.map((item, index) => (
                    <li key={index}>Row {item.index + 2}: {item.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={busy}
              className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400">
              Close
            </button>
            <button type="submit" disabled={busy}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? 'Importing...' : 'Upload and apply stock'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PurchaseReceiveModal({ open, onClose, onSaved, activeLocation, locations, currency }) {
  const [products, setProducts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [newSupplierName, setNewSupplierName] = useState('');
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState('');
  const [purchaseOrderRef, setPurchaseOrderRef] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState([{ productId: '', productSearch: '', quantityReceived: 1, unitCostMajor: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setLocationId(activeLocation && activeLocation !== 'ALL' ? activeLocation : '');
    Promise.all([
      api('/api/ecom/products?perPage=500'),
      api('/api/ecom/suppliers?isActive=true&pageSize=200'),
    ])
      .then(([productsData, suppliersData]) => {
        setProducts(productsData.products || []);
        setSuppliers(suppliersData.rows || []);
      })
      .catch((err) => setError(err.message || 'Failed to load purchase data'));
  }, [open, activeLocation]);

  if (!open) return null;

  const productMap = new Map(products.map((p) => [p.id, p]));
  const productOptions = products.map((product) => ({
    product,
    label: [
      product.name,
      product.sku ? `SKU ${product.sku}` : '',
      product.barcode ? `Barcode ${product.barcode}` : '',
      product.qrCode ? `QR ${product.qrCode}` : '',
    ].filter(Boolean).join(' · '),
  }));
  const productSearchMap = new Map(productOptions.map((option) => [option.label.toLowerCase(), option.product]));
  function productLabel(product) {
    if (!product) return '';
    return [
      product.name,
      product.sku ? `SKU ${product.sku}` : '',
      product.barcode ? `Barcode ${product.barcode}` : '',
    ].filter(Boolean).join(' · ');
  }
  function resolveProductSearch(value) {
    const q = String(value || '').trim().toLowerCase();
    if (!q) return null;
    if (productSearchMap.has(q)) return productSearchMap.get(q);
    return products.find((product) => [
      product.id,
      product.name,
      product.sku,
      product.barcode,
      product.qrCode,
      product.slug,
    ].filter(Boolean).some((part) => String(part).toLowerCase() === q)) || null;
  }
  const invoiceTotalMinor = items.reduce((sum, item) => {
    const qty = Math.max(0, Number(item.quantityReceived) || 0);
    const unit = Math.max(0, Math.round((Number(item.unitCostMajor) || 0) * 100));
    return sum + qty * unit;
  }, 0);

  function updateItem(index, patch) {
    setItems((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeItem(index) {
    setItems((rows) => rows.length <= 1 ? rows : rows.filter((_, i) => i !== index));
  }

  async function submit(e) {
    e.preventDefault();
    if (!locationId) {
      setError('Choose the store or warehouse receiving this stock');
      return;
    }
    const cleanItems = items.map((item) => {
      const product = productMap.get(item.productId) || resolveProductSearch(item.productSearch);
      const quantityReceived = Math.max(0, Math.trunc(Number(item.quantityReceived) || 0));
      const unitCostMinor = Math.max(0, Math.round((Number(item.unitCostMajor) || 0) * 100));
      return product && quantityReceived > 0 ? {
        productId: product.id,
        productName: product.name,
        productSku: product.sku || undefined,
        quantityReceived,
        unitCostMinor,
        lineTotalMinor: quantityReceived * unitCostMinor,
      } : null;
    }).filter(Boolean);
    if (cleanItems.length === 0) {
      setError('Add at least one product with a received quantity');
      return;
    }
    setBusy(true);
    setError('');
    try {
      let effectiveSupplierId = supplierId || undefined;
      if (!effectiveSupplierId && newSupplierName.trim()) {
        const supplier = await api('/api/ecom/suppliers', {
          method: 'POST',
          body: JSON.stringify({ name: newSupplierName.trim() }),
        });
        effectiveSupplierId = supplier.id;
      }
      const grn = await api('/api/ecom/grn', {
        method: 'POST',
        body: JSON.stringify({
          locationId,
          receivedAt: new Date().toISOString(),
          supplierId: effectiveSupplierId,
          supplierInvoiceNo: supplierInvoiceNo.trim() || undefined,
          purchaseOrderRef: purchaseOrderRef.trim() || undefined,
          invoiceTotalMinor,
          notes: notes.trim() || undefined,
          items: cleanItems,
        }),
      });
      await api(`/api/ecom/grn/${grn.id}/post`, {
        method: 'POST',
        body: JSON.stringify({ locationId }),
      });
      onSaved?.();
      onClose?.();
    } catch (err) {
      setError(err.message || 'Failed to receive purchase');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl border border-gray-200 shadow-xl max-w-3xl w-full p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <p className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500">Purchase receiving</p>
            <h3 className="text-lg font-bold text-gray-900">Receive supplier stock</h3>
            <p className="text-xs text-gray-500 mt-0.5">Creates and posts a GRN, then updates on-hand inventory with an audit ledger.</p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="grid sm:grid-cols-3 gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Receiving location *</span>
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500"
              >
                <option value="">Select location</option>
                {locations.filter((l) => l.id !== 'ALL').map((loc) => (
                  <option key={loc.id} value={loc.id}>{loc.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Supplier</span>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500"
              >
                <option value="">Ad-hoc / new below</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">New supplier</span>
              <input
                value={newSupplierName}
                onChange={(e) => setNewSupplierName(e.target.value)}
                disabled={!!supplierId}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500 disabled:bg-gray-50"
                placeholder="Supplier name"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Supplier invoice</span>
              <input
                value={supplierInvoiceNo}
                onChange={(e) => setSupplierInvoiceNo(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500"
                placeholder="INV-1001"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">PO reference</span>
              <input
                value={purchaseOrderRef}
                onChange={(e) => setPurchaseOrderRef(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500"
                placeholder="PO-1001"
              />
            </label>
          </div>

          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <div className="grid grid-cols-[1fr_90px_120px_36px] gap-2 bg-gray-50 px-3 py-2 text-[10px] font-mono tracking-[0.14em] uppercase text-gray-500">
              <span>Product</span><span>Qty</span><span>Unit cost</span><span />
            </div>
            <div className="divide-y divide-gray-100">
              {items.map((item, index) => (
                <div key={index} className="grid grid-cols-[1fr_90px_120px_36px] gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <input
                      type="text"
                      list={`receive-product-options-${index}`}
                      value={item.productSearch || productLabel(productMap.get(item.productId))}
                      onChange={(e) => {
                        const text = e.target.value;
                        const matched = resolveProductSearch(text);
                        updateItem(index, { productSearch: text, productId: matched?.id || '' });
                      }}
                      onBlur={(e) => {
                        const matched = resolveProductSearch(e.target.value);
                        if (matched) updateItem(index, { productId: matched.id, productSearch: productLabel(matched) });
                      }}
                      placeholder="Search name, SKU, barcode"
                      className="w-full min-w-0 px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500"
                    />
                    <datalist id={`receive-product-options-${index}`}>
                      {productOptions.map(({ product, label }) => (
                        <option key={product.id} value={label} />
                      ))}
                    </datalist>
                  </div>
                  <input
                    type="number"
                    min="1"
                    value={item.quantityReceived}
                    onChange={(e) => updateItem(index, { quantityReceived: e.target.value })}
                    className="px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500"
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={item.unitCostMajor}
                    onChange={(e) => updateItem(index, { unitCostMajor: e.target.value })}
                    className="px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500"
                    placeholder="0.00"
                  />
                  <button
                    type="button"
                    onClick={() => removeItem(index)}
                    disabled={items.length <= 1}
                    className="rounded-lg text-gray-400 hover:text-red-600 disabled:opacity-30"
                    aria-label="Remove line"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setItems((rows) => [...rows, { productId: '', productSearch: '', quantityReceived: 1, unitCostMajor: '' }])}
              className="px-3 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400"
            >
              + Add line
            </button>
            <p className="text-sm text-gray-600">Invoice total: <strong className="text-gray-900">{formatMoney(invoiceTotalMinor, currency)}</strong></p>
          </div>

          <label className="block">
            <span className="block text-xs font-medium text-gray-700 mb-1">Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500"
              placeholder="Delivery condition, batch notes, or receiving comments"
            />
          </label>

          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={busy}
              className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400">
              Cancel
            </button>
            <button type="submit" disabled={busy}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
              {busy ? 'Posting...' : 'Receive and post stock'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TransferCreateModal({ open, onClose, onSaved, locations, activeLocation }) {
  const selectableLocations = locations.filter((loc) => loc.id !== 'ALL');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [stockRows, setStockRows] = useState([]);
  const [loadingStock, setLoadingStock] = useState(false);
  const [items, setItems] = useState([{ productId: '', quantityShipped: 1 }]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setNotes('');
    setItems([{ productId: '', quantityShipped: 1 }]);
    setFromLocationId(activeLocation && activeLocation !== 'ALL' ? activeLocation : '');
    setToLocationId('');
  }, [open, activeLocation]);

  // Load the origin's stocked products (with available qty) whenever the From
  // location changes — you can only transfer what's actually there.
  useEffect(() => {
    if (!open || !fromLocationId) { setStockRows([]); return undefined; }
    let cancelled = false;
    setLoadingStock(true);
    api(`/api/ecom/inventory?locationId=${fromLocationId}&pageSize=500`)
      .then((data) => {
        if (cancelled) return;
        const rows = (data.rows || [])
          .map((r) => ({
            productId: r.productId || r.product?.id,
            name: r.product?.name || r.productName || 'Product',
            sku: r.product?.sku || null,
            available: typeof r.available === 'number' ? r.available : Math.max(0, (r.onHand || 0) - (r.reserved || 0)),
          }))
          .filter((r) => r.productId && r.available > 0);
        setStockRows(rows);
        // Drop any selected product no longer valid for the new origin.
        setItems((its) => its.map((it) => (rows.some((r) => r.productId === it.productId) ? it : { ...it, productId: '' })));
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load stock for this location'); })
      .finally(() => { if (!cancelled) setLoadingStock(false); });
    return () => { cancelled = true; };
  }, [open, fromLocationId]);

  function updateItem(index, patch) {
    setItems((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeItem(index) {
    setItems((rows) => rows.filter((_, i) => i !== index));
  }

  async function create(e) {
    e.preventDefault();
    if (!fromLocationId || !toLocationId || fromLocationId === toLocationId) {
      setError('Choose two different locations');
      return;
    }
    const cleanItems = items.map((item) => {
      const row = stockRows.find((r) => r.productId === item.productId);
      return {
        productId: item.productId || undefined,
        productName: row?.name || '',
        productSku: row?.sku || undefined,
        quantityShipped: Math.max(1, Math.trunc(Number(item.quantityShipped) || 0)),
        available: row?.available ?? 0,
      };
    }).filter((item) => item.productId && item.productName && item.quantityShipped > 0);
    if (cleanItems.length === 0) {
      setError('Add at least one product line');
      return;
    }
    const over = cleanItems.find((it) => it.quantityShipped > it.available);
    if (over) {
      setError(`Only ${over.available} of "${over.productName}" available at the origin`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/api/ecom/transfers', {
        method: 'POST',
        body: JSON.stringify({
          fromLocationId,
          toLocationId,
          notes: notes || undefined,
          items: cleanItems.map(({ available, ...rest }) => rest),
        }),
      });
      onSaved?.();
      onClose?.();
    } catch (err) {
      setError(err.message || 'Could not create transfer');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-xl max-w-3xl w-full p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <p className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500">Inter-location transfer</p>
            <h3 className="text-lg font-bold text-gray-900">Move stock between stores or warehouses</h3>
            <p className="mt-1 text-xs text-gray-500">Draft first, then ship from origin and receive at destination.</p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700">×</button>
        </div>
        <form onSubmit={create} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">From location *</span>
              <select value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500">
                <option value="">Select origin</option>
                {selectableLocations.map((loc) => <option key={loc.id} value={loc.id} disabled={loc.id === toLocationId}>{loc.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">To location *</span>
              <select value={toLocationId} onChange={(e) => setToLocationId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500">
                <option value="">Select destination</option>
                {selectableLocations.map((loc) => <option key={loc.id} value={loc.id} disabled={loc.id === fromLocationId}>{loc.name}</option>)}
              </select>
            </label>
          </div>

          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <div className="grid grid-cols-[1fr_100px_36px] gap-2 bg-gray-50 px-3 py-2 text-[10px] font-mono tracking-[0.14em] uppercase text-gray-500">
              <span>Product</span><span>Qty</span><span />
            </div>
            <div className="divide-y divide-gray-100">
              {items.map((item, index) => (
                <div key={index} className="grid grid-cols-[1fr_100px_36px] gap-2 px-3 py-2">
                  <select value={item.productId} onChange={(e) => updateItem(index, { productId: e.target.value })}
                    disabled={!fromLocationId}
                    className="min-w-0 px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500 disabled:bg-gray-50">
                    <option value="">
                      {!fromLocationId ? 'Pick origin first'
                        : loadingStock ? 'Loading stock…'
                        : stockRows.length === 0 ? 'No stock at this location'
                        : 'Select product'}
                    </option>
                    {stockRows.map((r) => (
                      <option key={r.productId} value={r.productId}>
                        {r.name}{r.sku ? ` (${r.sku})` : ''} — {r.available} in stock
                      </option>
                    ))}
                  </select>
                  <input type="number" min="1"
                    max={stockRows.find((r) => r.productId === item.productId)?.available || undefined}
                    value={item.quantityShipped}
                    onChange={(e) => updateItem(index, { quantityShipped: e.target.value })}
                    className="px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:border-indigo-500" />
                  <button type="button" onClick={() => removeItem(index)} disabled={items.length <= 1}
                    className="rounded-lg text-gray-400 hover:text-red-600 disabled:opacity-30" aria-label="Remove line">×</button>
                </div>
              ))}
            </div>
          </div>

          <button type="button" onClick={() => setItems((rows) => [...rows, { productId: '', quantityShipped: 1 }])}
            className="px-3 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400">
            + Add line
          </button>

          <label className="block">
            <span className="block text-xs font-medium text-gray-700 mb-1">Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500"
              placeholder="Reason, vehicle, seal number, or handover notes" />
          </label>

          {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={busy}
              className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400">Cancel</button>
            <button type="submit" disabled={busy || !fromLocationId || !toLocationId || fromLocationId === toLocationId}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? 'Creating...' : 'Create transfer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TransfersPanel({ activeLocation, locations, onInventoryChanged }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const qs = useMemo(() => {
    const params = new URLSearchParams({ pageSize: '10' });
    if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
    return params.toString();
  }, [activeLocation]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api(`/api/ecom/transfers?${qs}`);
      setRows(data.rows || []);
    } catch (err) {
      setError(err.message || 'Failed to load transfers');
    } finally {
      setLoading(false);
    }
  }, [qs]);

  useEffect(() => { reload(); }, [reload]);

  async function act(transfer, action) {
    setBusy(`${action}:${transfer.id}`);
    setError('');
    try {
      if (action === 'ship') {
        await api(`/api/ecom/transfers/${transfer.id}/ship`, { method: 'POST', body: JSON.stringify({ locationId: transfer.fromLocationId }) });
      } else if (action === 'receive') {
        await api(`/api/ecom/transfers/${transfer.id}/receive`, {
          method: 'POST',
          body: JSON.stringify({
            locationId: transfer.toLocationId,
            items: (transfer.items || []).map((item) => ({ itemId: item.id, quantityReceived: item.quantityShipped })),
          }),
        });
      } else if (action === 'cancel') {
        await api(`/api/ecom/transfers/${transfer.id}`, { method: 'DELETE', body: JSON.stringify({ locationId: transfer.fromLocationId }) });
      }
      await reload();
      onInventoryChanged?.();
    } catch (err) {
      setError(err.message || 'Transfer action failed');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <div className="p-5 border-b border-gray-100 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Stock transfers</h3>
          <p className="mt-1 text-xs text-gray-500">Move inventory between warehouses and branch stores with ship and receive checkpoints.</p>
        </div>
        <button type="button" onClick={() => setOpen(true)}
          className="px-3 py-2 text-sm font-semibold rounded-xl bg-indigo-600 text-white hover:bg-indigo-700">
          + New transfer
        </button>
      </div>
      {error && <div className="px-5 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>}
      {loading ? (
        <p className="p-6 text-center text-sm text-gray-500">Loading transfers...</p>
      ) : rows.length === 0 ? (
        <p className="p-6 text-center text-sm text-gray-500">No transfers yet.</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {rows.map((transfer) => (
            <div key={transfer.id} className="p-4 flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-[260px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-mono text-xs font-semibold text-gray-900">{transfer.code}</p>
                  <TransferStatusBadge status={transfer.status} />
                  <span className="text-xs text-gray-600">
                    {locName(locations, transfer.fromLocationId)} <span className="text-gray-400">→</span> {locName(locations, transfer.toLocationId)}
                  </span>
                </div>

                {/* Every product moved, with quantities — not just a line count. */}
                <ul className="mt-2 space-y-1">
                  {(transfer.items || []).map((it) => {
                    const received = transfer.status === 'RECEIVED';
                    const short = received && it.quantityReceived !== it.quantityShipped;
                    return (
                      <li key={it.id} className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="text-gray-800 truncate">
                          {it.productName}{it.productSku ? <span className="text-gray-400 text-xs"> ({it.productSku})</span> : null}
                        </span>
                        <span className={`font-mono text-xs whitespace-nowrap ${short ? 'text-amber-700' : 'text-gray-500'}`}>
                          {received
                            ? `${it.quantityReceived}${short ? ` / ${it.quantityShipped}` : ''} received`
                            : transfer.status === 'IN_TRANSIT'
                              ? `${it.quantityShipped} in transit`
                              : `${it.quantityShipped} to move`}
                        </span>
                      </li>
                    );
                  })}
                </ul>

                {/* Timeline so it's clear what happened and when. */}
                <p className="mt-1.5 text-[11px] text-gray-400">
                  {transfer.receivedAt ? `Received ${fmtTransferDate(transfer.receivedAt)}`
                    : transfer.shippedAt ? `Shipped ${fmtTransferDate(transfer.shippedAt)}`
                    : transfer.createdAt ? `Drafted ${fmtTransferDate(transfer.createdAt)}` : ''}
                  {transfer.notes ? ` · ${transfer.notes}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {transfer.status === 'DRAFT' && (
                  <>
                    <button type="button" disabled={busy === `ship:${transfer.id}`} onClick={() => act(transfer, 'ship')}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">Ship</button>
                    <button type="button" disabled={busy === `cancel:${transfer.id}`} onClick={() => act(transfer, 'cancel')}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50">Cancel</button>
                  </>
                )}
                {transfer.status === 'IN_TRANSIT' && (
                  <button type="button" disabled={busy === `receive:${transfer.id}`} onClick={() => act(transfer, 'receive')}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">Receive all</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <TransferCreateModal
        open={open}
        onClose={() => setOpen(false)}
        onSaved={() => { reload(); onInventoryChanged?.(); }}
        locations={locations}
        activeLocation={activeLocation}
      />
    </div>
  );
}

export default function InventoryPanel() {
  const { tenant } = useTenant();
  const businessCurrency = getDefaultCurrency({ business: tenant?.business });
  const { active: activeLocation, setActive: setActiveLocation, locations, allowAll } = useEcommerceLocation();
  const searchParams = useSearchParams();
  const urlSearch = searchParams.get('q') || searchParams.get('search') || '';
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [search, setSearch] = useState(urlSearch);
  const [filter, setFilter] = useState('all'); // all | lowStock | outOfStock
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adjustTarget, setAdjustTarget] = useState(null);
  const [setupTarget, setSetupTarget] = useState(null);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);

  const locationLabel = useMemo(() => {
    if (activeLocation === 'ALL') return 'All locations';
    return locations.find((l) => l.id === activeLocation)?.name || 'All locations';
  }, [activeLocation, locations]);
  const selectedLocation = useMemo(
    () => locations.find((l) => l.id === activeLocation) || null,
    [activeLocation, locations],
  );
  const isAllLocations = activeLocation === 'ALL';
  // Stock transfers move inventory between branches — only meaningful for a
  // branch store. Single stores (OFF/FULFILLMENT) don't see them.
  const inventoryMode = String(tenant?.business?.multiStoreMode || 'OFF').toUpperCase();
  const isBranchMode = ['CHAIN', 'REGIONAL', 'BOTH'].includes(inventoryMode);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
      if (search.trim()) params.set('search', search.trim());
      if (filter === 'lowStock') params.set('lowStock', 'true');
      if (filter === 'outOfStock') params.set('outOfStock', 'true');
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));

      const summaryParams = new URLSearchParams();
      if (activeLocation && activeLocation !== 'ALL') summaryParams.set('locationId', activeLocation);

      const [list, sum] = await Promise.all([
        api(`/api/ecom/inventory?${params.toString()}`),
        api(`/api/ecom/inventory/summary?${summaryParams.toString()}`),
      ]);
      setRows(list.rows || []);
      setTotal(list.total || 0);
      setSummary(sum);
    } catch (err) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [activeLocation, search, filter, page, pageSize]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setSearch(urlSearch); }, [urlSearch]);

  // Reset to page 1 when filters / location change
  useEffect(() => { setPage(1); }, [activeLocation, search, filter]);

  async function downloadInventorySheet() {
    setDownloadBusy(true);
    setError('');
    try {
      const scope = activeLocation && activeLocation !== 'ALL' ? activeLocation : 'ALL';
      const params = new URLSearchParams({ locationId: scope });
      await downloadCsv(`/api/ecom/bulk/inventory-template.csv?${params.toString()}`, 'inventory-products-current-stock.csv');
    } catch (err) {
      setError(err.message || 'Download failed');
    } finally {
      setDownloadBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Inventory</h2>
            <p className="text-sm text-gray-500 mt-1">
              {locationLabel}
              {summary ? ` · ${summary.totalSkus} SKU${summary.totalSkus === 1 ? '' : 's'}` : ''}
              {summary?.lowStockCount ? ` · ${summary.lowStockCount} low` : ''}
              {summary?.outOfStockCount ? ` · ${summary.outOfStockCount} out of stock` : ''}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Bulk stock-takes, deliveries and audit trail. For one-off edits to a single product, use the Stock field on the Products tab.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={downloadInventorySheet}
              disabled={downloadBusy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:border-gray-400"
            >
              {downloadBusy ? 'Preparing...' : 'Download stock sheet'}
            </button>
            <button
              type="button"
              onClick={() => setBulkOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-indigo-200 bg-indigo-50 text-sm font-medium text-indigo-800 hover:border-indigo-400"
            >
              Upload stock CSV
            </button>
            <button
              type="button"
              onClick={() => setPurchaseOpen(true)}
              disabled={isAllLocations}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              + Receive purchase
            </button>
            <button
              type="button"
              onClick={reload}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:border-gray-400 disabled:opacity-50"
            >
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-[11px] font-mono tracking-[0.18em] uppercase text-emerald-700">Stock scope</p>
          <h3 className="mt-1 text-sm font-semibold text-emerald-950">
            {isAllLocations ? 'All locations overview' : `${locationLabel} inventory`}
          </h3>
          <p className="mt-1 text-xs text-emerald-800">
            {isAllLocations
              ? 'Totals and rows are grouped by store. Select one store to receive purchases or adjust stock.'
              : `Adjustments, purchases, reservations and order deductions apply only to ${locationLabel}.`}
          </p>
          {!isAllLocations && selectedLocation?.city && (
            <p className="mt-1 text-xs text-emerald-700">{selectedLocation.city}{selectedLocation.state ? `, ${selectedLocation.state}` : ''}</p>
          )}
        </div>
        <label className="min-w-[260px]">
          <span className="block text-[10px] font-mono tracking-[0.18em] uppercase text-emerald-700 mb-1">Inventory location</span>
          <select
            value={activeLocation || 'ALL'}
            onChange={(e) => setActiveLocation(e.target.value)}
            className="w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm font-semibold text-gray-900 focus:outline-none focus:border-emerald-500"
          >
            {allowAll && <option value="ALL">All locations - overview only</option>}
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>{loc.name}</option>
            ))}
          </select>
        </label>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total SKUs" value={summary?.totalSkus} hint="In scope" />
        <KpiCard label="Low stock" value={summary?.lowStockCount} hint="Below reorder point" tone="warning" />
        <KpiCard label="Out of stock" value={summary?.outOfStockCount} hint="Needs restocking" tone="danger" />
        <KpiCard
          label="Stock value"
          value={summary ? formatMoney(summary.stockValueMinor, businessCurrency) : null}
          hint="At cost"
          isMoney
        />
      </div>

      {isBranchMode && (
        <TransfersPanel
          activeLocation={activeLocation}
          locations={locations}
          onInventoryChanged={reload}
        />
      )}

      {/* Filter row */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search product, global SKU, supplier SKU, pick code, aisle or rack..."
          className="flex-1 min-w-[240px] px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500"
        />
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
          {[
            { key: 'all',        label: 'All' },
            { key: 'lowStock',   label: 'Low stock' },
            { key: 'outOfStock', label: 'Out of stock' },
          ].map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
                filter === f.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        {error && (
          <div className="p-4 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>
        )}
        {loading && rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-500">Loading inventory…</div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-semibold text-gray-900">No inventory rows found</p>
            <p className="text-xs text-gray-500 mt-1">
              {activeLocation === 'ALL'
                ? 'Inventory is created when you set per-location stock for a product.'
                : `No stock rows at ${locationLabel}. Open a product and set its stock for this store to start tracking.`}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-[10px] font-mono tracking-[0.18em] uppercase text-gray-500">
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Store codes</th>
                  <th className="px-4 py-3 text-right">On hand</th>
                  <th className="px-4 py-3 text-right">Reserved</th>
                  <th className="px-4 py-3 text-right">Available</th>
                  <th className="px-4 py-3 text-right">Reorder pt</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-gray-900">{r.product?.name || '—'}</p>
                      {r.product?.sku && <p className="text-xs text-gray-500 font-mono">{r.product.sku}</p>}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {r.location?.name || '—'}
                      {r.location?.city && <p className="text-xs text-gray-500">{r.location.city}</p>}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {r.localPickCode || r.supplierSku || r.aisleCode || r.rackCode || r.shelfCode || r.binLocation ? (
                        <div className="space-y-0.5">
                          {r.localPickCode && <p><span className="font-semibold text-gray-500">Pick:</span> <span className="font-mono">{r.localPickCode}</span></p>}
                          {r.supplierSku && <p><span className="font-semibold text-gray-500">Supplier:</span> <span className="font-mono">{r.supplierSku}</span></p>}
                          {(r.aisleCode || r.rackCode || r.shelfCode) && (
                            <p className="font-mono text-gray-800">{[r.aisleCode, r.rackCode, r.shelfCode].filter(Boolean).join(' / ')}</p>
                          )}
                          {r.binLocation && <p className="text-gray-500">{r.binLocation}</p>}
                        </div>
                      ) : (
                        <span className="text-gray-300">Not set</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900 font-mono">{r.onHand}</td>
                    <td className="px-4 py-3 text-right text-gray-500 font-mono">{r.reserved}</td>
                    <td className="px-4 py-3 text-right text-gray-900 font-mono">{r.available}</td>
                    <td className="px-4 py-3 text-right text-gray-500 font-mono">{r.reorderPoint || '—'}</td>
                    <td className="px-4 py-3"><StatusBadge row={r} /></td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-col items-end gap-1">
                        <button
                          type="button"
                          onClick={() => setSetupTarget(r)}
                          disabled={isAllLocations}
                          className="text-xs font-semibold text-gray-700 hover:text-gray-900 hover:underline disabled:text-gray-300 disabled:no-underline disabled:cursor-not-allowed"
                        >
                          {isAllLocations ? 'Select store' : 'Setup'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setAdjustTarget(r)}
                          disabled={isAllLocations}
                          className="text-xs font-semibold text-indigo-700 hover:text-indigo-900 hover:underline disabled:text-gray-300 disabled:no-underline disabled:cursor-not-allowed"
                        >
                          {isAllLocations ? '' : 'Adjust →'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {total > pageSize && (
          <div className="p-4 border-t border-gray-100 flex items-center justify-between">
            <p className="text-xs text-gray-500">
              Page {page} of {Math.max(1, Math.ceil(total / pageSize))} · {total} total
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400 disabled:opacity-50"
              >
                ← Prev
              </button>
              <button
                type="button"
                disabled={page >= Math.ceil(total / pageSize) || loading}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400 disabled:opacity-50"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </div>

      <AdjustModal
        stock={adjustTarget}
        onClose={() => setAdjustTarget(null)}
        onSaved={reload}
      />
      <StockSetupModal
        stock={setupTarget}
        onClose={() => setSetupTarget(null)}
        onSaved={reload}
      />
      <PurchaseReceiveModal
        open={purchaseOpen}
        onClose={() => setPurchaseOpen(false)}
        onSaved={reload}
        activeLocation={activeLocation}
        locations={locations}
        currency={businessCurrency}
      />
      <BulkStockModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onSaved={reload}
        activeLocation={activeLocation}
        locationLabel={locationLabel}
      />
    </div>
  );
}

function KpiCard({ label, value, hint, tone, isMoney }) {
  const tones = {
    danger: 'text-red-700',
    warning: 'text-amber-700',
  };
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5">
      <p className="text-[11px] font-mono tracking-[0.18em] uppercase text-gray-500">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${tone ? tones[tone] : 'text-gray-900'}`}>
        {value === null || value === undefined ? '—' : value}
      </p>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}
