'use client';

// Statutory Registers (Feature 32) — India muster roll + Form registers, a
// READ-ONLY projection over the FROZEN attendance + payroll + leave sources.
//   GET /api/hr/registers/catalog?entityId=&stateCode=&asOf=     available forms
//   GET /api/hr/registers/preview?kind=&formCode=&entityId=&period=&stateCode=  table JSON (paginated)
//   GET /api/hr/registers/export?...&format=PDF|XLSX|CSV         download the file
//   GET /api/hr/registers/exports?entityId=&kind=               generated-artefact history
//   GET /api/hr/registers/definitions?entityId=  + POST seed     definitions (canManageStatutory)
// Read/export gated on canViewPayrollReports; definition mgmt on canManageStatutory
// (server is the real boundary). India-only — the catalog follows the entity's
// StatutoryRegistrations. A register reads only frozen data: an unlocked run /
// unfrozen attendance shows the "freeze first" empty state (never a recomputed row).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner, PrimaryButton } from '@hr/ui';
import { get, post, downloadFile } from '@/lib/api';
import { PageHeader, Tabs } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';

const GROUP_ORDER = ['Attendance', 'Wages', 'Leave', 'Annual', 'Employees', 'Other'];

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return String(d).slice(0, 16); }
}

// Period input shape depends on cadence: month / FY / half / as-of date.
function defaultPeriodFor(cadence) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  if (cadence === 'ANNUAL' || cadence === 'PAYRUN_ANNUAL') {
    const fyStart = now.getUTCMonth() + 1 >= 4 ? y : y - 1;
    return `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
  }
  if (cadence === 'HALF_YEARLY') return `${y}-H1`;
  if (cadence === 'SNAPSHOT') return now.toISOString().slice(0, 10);
  return `${y}-${m}`; // PERIOD
}

export default function RegistersPage() {
  const [tab, setTab] = useState('registers');
  return (
    <div>
      <PageHeader
        title="Statutory Registers"
        subtitle="India muster roll + wage / overtime / leave / fines / employee + PF-3A/ESI registers — generated from the frozen attendance, payroll & leave data"
      />
      <Tabs
        tabs={[{ key: 'registers', label: 'Registers' }, { key: 'history', label: 'History' }, { key: 'definitions', label: 'Definitions' }]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'registers' && <RegistersTab />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'definitions' && <DefinitionsTab />}
    </div>
  );
}

// ── Registers tab — picker bar + preview + export ─────────────────────────────

function RegistersTab() {
  const [entities, setEntities] = useState([]);
  const [entityId, setEntityId] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [catalog, setCatalog] = useState([]);
  const [selKey, setSelKey] = useState(''); // "kind|formCode|stateCode"
  const [period, setPeriod] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dlBusy, setDlBusy] = useState('');

  useEffect(() => {
    get('/api/hr/payroll/entities')
      .then((r) => {
        const list = Array.isArray(r) ? r : (r.items || []);
        const inOnly = list.filter((e) => !e.countryCode || e.countryCode === 'IN');
        setEntities(inOnly);
        if (inOnly[0]) { setEntityId(inOnly[0].id); setStateCode(inOnly[0].stateCode || ''); }
      })
      .catch(() => {});
  }, []);

  // Load the catalog when the entity/state changes.
  useEffect(() => {
    if (!entityId) return;
    setCatalog([]); setSelKey(''); setData(null);
    get('/api/hr/registers/catalog', { entityId, stateCode })
      .then((r) => {
        setCatalog(r.items || []);
        if (r.items && r.items[0]) {
          const f = r.items[0];
          setSelKey(`${f.kind}|${f.formCode}|${f.stateCode || ''}`);
          setPeriod(defaultPeriodFor(f.cadence));
        }
      })
      .catch((e) => setError(e.data?.message || 'Failed to load register catalog.'));
  }, [entityId, stateCode]);

  const selected = useMemo(() => catalog.find((f) => `${f.kind}|${f.formCode}|${f.stateCode || ''}` === selKey) || null, [catalog, selKey]);

  // Group the catalog into the picker's optgroups.
  const grouped = useMemo(() => {
    const g = {};
    for (const f of catalog) { (g[f.group] = g[f.group] || []).push(f); }
    return GROUP_ORDER.filter((k) => g[k]).map((k) => ({ group: k, forms: g[k] }));
  }, [catalog]);

  const loadPreview = useCallback(() => {
    if (!entityId || !selected) return;
    setLoading(true); setError(''); setData(null);
    get('/api/hr/registers/preview', {
      entityId, kind: selected.kind, formCode: selected.formCode, stateCode: selected.stateCode || stateCode, period,
    })
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load preview.'))
      .finally(() => setLoading(false));
  }, [entityId, selected, stateCode, period]);

  async function doExport(format) {
    if (!entityId || !selected) return;
    setDlBusy(format); setError('');
    try {
      const q = new URLSearchParams({ entityId, kind: selected.kind, formCode: selected.formCode, stateCode: selected.stateCode || stateCode || '', period, format }).toString();
      await downloadFile(`/api/hr/registers/export?${q}`);
    } catch (e) {
      setError(e.data?.message || `Export failed (${format}).`);
    } finally {
      setDlBusy('');
    }
  }

  const notFrozen = data && data.frozen === false;

  return (
    <div className="mt-4 space-y-4">
      {/* Picker bar */}
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-gray-200 bg-white p-4">
        <label className="flex flex-col text-xs font-medium text-gray-600">
          Entity
          <select value={entityId} onChange={(e) => { const en = entities.find((x) => x.id === e.target.value); setEntityId(e.target.value); setStateCode(en?.stateCode || ''); }}
            className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {entities.length === 0 && <option value="">No India entities</option>}
            {entities.map((en) => <option key={en.id} value={en.id}>{en.code} — {en.legalName}</option>)}
          </select>
        </label>

        <label className="flex flex-col text-xs font-medium text-gray-600">
          State
          <input value={stateCode} onChange={(e) => setStateCode(e.target.value.toUpperCase())} placeholder="MH"
            className="mt-1 w-20 rounded-lg border border-gray-300 px-3 py-2 text-sm uppercase" />
        </label>

        <label className="flex flex-col text-xs font-medium text-gray-600">
          Register
          <select value={selKey} onChange={(e) => { setSelKey(e.target.value); const f = catalog.find((x) => `${x.kind}|${x.formCode}|${x.stateCode || ''}` === e.target.value); if (f) setPeriod(defaultPeriodFor(f.cadence)); }}
            className="mt-1 min-w-[20rem] rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {grouped.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.forms.map((f) => (
                  <option key={`${f.kind}|${f.formCode}|${f.stateCode || ''}`} value={`${f.kind}|${f.formCode}|${f.stateCode || ''}`}>
                    {f.formLabel}{f.builtin ? ' (default)' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="flex flex-col text-xs font-medium text-gray-600">
          Period
          {selected && selected.cadence === 'SNAPSHOT'
            ? <input type="date" value={period} onChange={(e) => setPeriod(e.target.value)} className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            : <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder={selected?.cadence === 'ANNUAL' ? '2025-26' : '2026-05'} className="mt-1 w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm" />}
        </label>

        <PrimaryButton onClick={loadPreview} disabled={!selected || loading}>Preview</PrimaryButton>

        <div className="ml-auto flex items-end gap-2">
          {['PDF', 'XLSX', 'CSV'].map((f) => (
            <button key={f} onClick={() => doExport(f)} disabled={!selected || dlBusy === f}
              className="rounded-md border border-gray-300 px-3 py-2 text-xs font-medium hover:bg-gray-50 disabled:opacity-50">
              {dlBusy === f ? '…' : f}
            </button>
          ))}
          <InfoTip text="Registers read only FROZEN payroll/attendance/leave. Export logs an audit row + a SHA-256 file hash (tamper evidence). PDF is inspector-ready A4 landscape; XLSX/CSV open in Excel." />
        </div>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && <div className="flex justify-center py-10"><Spinner /></div>}

      {/* Not-frozen empty state */}
      {notFrozen && (
        <div className="rounded-2xl border border-dashed border-amber-300 bg-amber-50 p-8 text-center text-sm">
          <p className="font-medium text-amber-800">This register reads frozen data.</p>
          <p className="mt-1 text-amber-700">{data.reason}</p>
        </div>
      )}

      {/* Preview */}
      {data && data.frozen && <RegisterPreview data={data} />}
    </div>
  );
}

function RegisterPreview({ data }) {
  const title = data.title || {};
  const cols = data.columns || [];
  const rows = data.rows || [];
  const totals = data.totals || {};
  const hasTotals = cols.some((c) => totals[c.key]);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white">
      {/* Statutory title block */}
      <div className="border-b border-gray-200 px-5 py-3">
        <div className="text-sm font-semibold text-gray-900">{data.meta?.formLabel}</div>
        <div className="text-xs text-gray-500">{data.meta?.actLabel}</div>
        <div className="mt-1 text-xs text-gray-600">
          {(title.tradeName || title.legalName) && <span className="font-medium">{title.tradeName || title.legalName}</span>}
          {title.stateCode && <span> · {title.stateCode}</span>}
          {title.pan && <span> · PAN {title.pan}</span>}
          {title.tan && <span> · TAN {title.tan}</span>}
          {data.meta?.periodLabel && <span> · Period {data.meta.periodLabel}</span>}
          <span> · {data.total} worker(s)</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 border-b border-gray-200 bg-gray-50 text-left uppercase tracking-wide text-gray-500">
            <tr>
              {cols.map((c) => (
                <th key={c.key} className={`whitespace-nowrap px-2 py-2 ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'} ${c.statutory ? 'text-blue-700' : ''}`}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.employeeId || `r-${i}`} className="border-b border-gray-100 hover:bg-gray-50">
                {(r.cells || []).map((cell, ci) => (
                  <td key={ci} className={`whitespace-nowrap px-2 py-1.5 ${cols[ci]?.align === 'right' ? 'text-right' : cols[ci]?.align === 'center' ? 'text-center' : 'text-left'}`} title={cell?.text || ''}>{cell?.text}</td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={cols.length} className="px-2 py-6 text-center text-gray-400">No rows for this period.</td></tr>
            )}
          </tbody>
          {hasTotals && (
            <tfoot className="border-t-2 border-gray-300 bg-gray-50 font-semibold text-gray-800">
              <tr>
                {cols.map((c, i) => (
                  <td key={c.key} className={`px-2 py-2 ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{i === 0 ? 'TOTAL' : (totals[c.key]?.display || '')}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {data.totalPages > 1 && (
        <div className="border-t border-gray-200 px-5 py-2 text-xs text-gray-500">
          Page {data.page} of {data.totalPages} · {data.total} rows · export for the full register
        </div>
      )}
    </div>
  );
}

// ── History tab — generated-artefact log ──────────────────────────────────────

function HistoryTab() {
  const [entities, setEntities] = useState([]);
  const [entityId, setEntityId] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/api/hr/payroll/entities').then((r) => { const l = Array.isArray(r) ? r : (r.items || []); setEntities(l); if (l[0]) setEntityId(l[0].id); }).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true); setError('');
    get('/api/hr/registers/exports', { entityId })
      .then((r) => setRows(r.items || []))
      .catch((e) => setError(e.data?.message || 'Failed to load history.'))
      .finally(() => setLoading(false));
  }, [entityId]);
  useEffect(() => { if (entityId) load(); }, [load, entityId]);

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-end gap-3">
        <label className="flex flex-col text-xs font-medium text-gray-600">
          Entity
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {entities.map((en) => <option key={en.id} value={en.id}>{en.code}</option>)}
          </select>
        </label>
        <InfoTip text="Every generated register is logged here for an inspection audit trail — form, period, format, who generated it, control totals, and a SHA-256 file hash." />
      </div>
      {error && <ErrorBanner message={error} />}
      {loading ? <div className="flex justify-center py-8"><Spinner /></div> : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Form</th><th className="px-4 py-2">Period</th><th className="px-4 py-2">Format</th>
                <th className="px-4 py-2">Rows</th><th className="px-4 py-2">Generated</th><th className="px-4 py-2">File hash</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-gray-100">
                  <td className="px-4 py-2">{r.kind} · {r.formCode}{r.stateCode ? ` · ${r.stateCode}` : ''}</td>
                  <td className="px-4 py-2">{r.periodLabel}</td>
                  <td className="px-4 py-2">{r.format}</td>
                  <td className="px-4 py-2">{r.rowCount}</td>
                  <td className="px-4 py-2">{fmtDate(r.createdAt)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-500" title={r.fileHash || ''}>{r.fileHash ? `${r.fileHash.slice(0, 12)}…` : '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">No registers generated yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Definitions tab — the per-state form schedule (canManageStatutory) ────────

function DefinitionsTab() {
  const [entities, setEntities] = useState([]);
  const [entityId, setEntityId] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    get('/api/hr/payroll/entities').then((r) => { const l = Array.isArray(r) ? r : (r.items || []); setEntities(l); if (l[0]) setEntityId(l[0].id); }).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true); setError('');
    get('/api/hr/registers/definitions', { entityId })
      .then((r) => setRows(r.items || []))
      .catch((e) => { if (e.status === 403) setForbidden(true); else setError(e.data?.message || 'Failed to load definitions.'); })
      .finally(() => setLoading(false));
  }, [entityId]);
  useEffect(() => { if (entityId) load(); }, [load, entityId]);

  async function reseed() {
    setBusy(true); setError('');
    try { await post('/api/hr/registers/definitions/seed', { entityId }); load(); }
    catch (e) { setError(e.data?.message || 'Re-seed failed.'); }
    finally { setBusy(false); }
  }

  if (forbidden) {
    return <div className="mt-4 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Definition management requires the <span className="font-medium">canManageStatutory</span> permission.</div>;
  }

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-end gap-3">
        <label className="flex flex-col text-xs font-medium text-gray-600">
          Entity
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {entities.map((en) => <option key={en.id} value={en.id}>{en.code}</option>)}
          </select>
        </label>
        <PrimaryButton onClick={reseed} loading={busy} disabled={!entityId}>Re-seed defaults</PrimaryButton>
        <InfoTip text="Seed the default IN register set for this entity from its statutory registrations. Idempotent. Switch a state to the Ease-of-Compliance combined registers by editing effective dates here." />
      </div>
      {error && <ErrorBanner message={error} />}
      {loading ? <div className="flex justify-center py-8"><Spinner /></div> : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Form</th><th className="px-4 py-2">Act</th><th className="px-4 py-2">State</th>
                <th className="px-4 py-2">Cadence</th><th className="px-4 py-2">Effective from</th><th className="px-4 py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-gray-100">
                  <td className="px-4 py-2">{r.formLabel}</td>
                  <td className="px-4 py-2 text-gray-500">{r.actLabel}</td>
                  <td className="px-4 py-2">{r.stateCode || '—'}</td>
                  <td className="px-4 py-2">{r.cadence}</td>
                  <td className="px-4 py-2">{String(r.effectiveFrom).slice(0, 10)}</td>
                  <td className="px-4 py-2">{r.isActive ? 'Yes' : 'No'}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">No definitions yet — click “Re-seed defaults”.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
