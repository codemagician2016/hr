'use client';

// Extracted from [slug]/admin/page.js 2026-04-29 as part of the admin
// page split.

import { useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, PrimaryButton, Modal, ModalActions, TextInput, TextArea, Empty, formatAdminDate, formatAdminDateTime, formatMoneyMinor } from '@/components/admin-ui';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { useConfirm } from '@/components/ConfirmDialog';
import { useApi } from '@/lib/useApi';

const WAITLIST_FILTERS = [
  { key: 'PENDING',   label: 'Waiting' },
  { key: 'NOTIFIED',  label: 'Notified' },
  { key: 'CONVERTED', label: 'Booked' },
  { key: 'DISMISSED', label: 'Dismissed' },
  { key: 'EXPIRED',   label: 'Expired' },
  { key: '',          label: 'All' },
];

function WaitlistTab() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawStatus = searchParams.get('status');
  const requestedStatus = rawStatus === 'all' ? '' : (rawStatus || 'PENDING');
  const status = WAITLIST_FILTERS.some((filter) => filter.key === requestedStatus) ? requestedStatus : 'PENDING';
  const setStatus = useCallback((nextStatus) => {
    const safeStatus = WAITLIST_FILTERS.some((filter) => filter.key === nextStatus) ? nextStatus : 'PENDING';
    const params = new URLSearchParams(searchParams.toString());
    if (safeStatus === 'PENDING') params.delete('status');
    else if (safeStatus === '') params.set('status', 'all');
    else params.set('status', safeStatus);
    router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
  }, [router, searchParams]);
  const confirm = useConfirm();
  const [pendingId, setPendingId] = useState(null);

  const { data: rows = [], loading, error, reload: load } = useApi(
    `/api/business/waitlist${status ? `?status=${status}` : ''}`,
    { select: (r) => r.waitlist || [] },
  );

  async function patchStatus(id, newStatus) {
    setPendingId(id);
    try {
      await api(`/api/business/waitlist/${id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
      await load();
    } catch (err) { alert(err.message || 'Could not update'); }
    finally { setPendingId(null); }
  }

  async function remove(id) {
    if (!await confirm('Permanently remove this waitlist entry?', { confirmLabel: 'Remove', tone: 'danger' })) return;
    setPendingId(id);
    try {
      await api(`/api/business/waitlist/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) { alert(err.message || 'Could not delete'); }
    finally { setPendingId(null); }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900" style={{ fontFamily: 'var(--font-heading)' }}>Waitlist</h2>
          <p className="text-sm text-gray-500 mt-0.5">Customers automatically get an email when a matching slot opens up.</p>
        </div>
        <div className="inline-flex flex-wrap gap-1 p-1 rounded-lg bg-gray-100">
          {WAITLIST_FILTERS.map((f) => (
            <button key={f.key || 'all'} onClick={() => setStatus(f.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${status === f.key ? 'bg-white shadow-sm text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorBanner message={error.message || String(error)} />}
      {loading ? (
        <div className="py-20 flex justify-center"><Spinner /></div>
      ) : rows.length === 0 ? (
        <Empty text={status === 'PENDING' ? 'Nobody on the waitlist right now.' : 'No entries with this status.'} />
      ) : (
        <ul className="bg-white rounded-2xl border border-gray-200 divide-y divide-gray-100 overflow-hidden">
          {rows.map((r) => {
            const dateLabel = new Date(r.preferredDate).toISOString().slice(0, 10);
            const window = r.preferredStartTime || r.preferredEndTime
              ? `${r.preferredStartTime || '—'} – ${r.preferredEndTime || '—'}`
              : 'any time';
            const busy = pendingId === r.id;
            return (
              <li key={r.id} className="p-4 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-start">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-semibold text-gray-900 truncate">{r.name}</p>
                    <WaitlistStatusPill status={r.status} />
                  </div>
                  <p className="text-xs text-gray-600 truncate">
                    <a href={`mailto:${r.email}`} className="hover:underline">{r.email}</a>
                    {r.phone && <span> · {r.phone}</span>}
                  </p>
                  <p className="text-xs text-gray-500 mt-1.5">
                    <span className="font-medium text-gray-700">{r.service?.name || 'Any service'}</span>
                    {r.staff?.name && <> · with <span className="font-medium text-gray-700">{r.staff.name}</span></>}
                    <> · {dateLabel} · <span>{window}</span></>
                  </p>
                  {r.notes && <p className="text-xs text-gray-500 mt-1.5 italic">&ldquo;{r.notes}&rdquo;</p>}
                  <p className="text-[10px] text-gray-400 mt-1.5">
                    Added {new Date(r.createdAt).toLocaleDateString()} · Expires {new Date(r.expiresAt).toLocaleDateString()}
                    {r.notifiedAt && <> · Notified {new Date(r.notifiedAt).toLocaleDateString()}</>}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  {r.status === 'PENDING' || r.status === 'NOTIFIED' ? (
                    <>
                      <button disabled={busy} onClick={() => patchStatus(r.id, 'CONVERTED')}
                        className="px-2.5 py-1 text-xs font-medium rounded-md bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
                        Mark booked
                      </button>
                      <button disabled={busy} onClick={() => patchStatus(r.id, 'DISMISSED')}
                        className="px-2.5 py-1 text-xs font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50">
                        Dismiss
                      </button>
                    </>
                  ) : null}
                  <button disabled={busy} onClick={() => remove(r.id)}
                    className="px-2.5 py-1 text-xs font-medium rounded-md text-rose-600 hover:bg-rose-50 disabled:opacity-50">
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function WaitlistStatusPill({ status }) {
  const styles = {
    PENDING:   { bg: 'bg-amber-100',   text: 'text-amber-800',   label: 'Waiting' },
    NOTIFIED:  { bg: 'bg-indigo-100',  text: 'text-indigo-800',  label: 'Notified' },
    CONVERTED: { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'Booked' },
    DISMISSED: { bg: 'bg-gray-100',    text: 'text-gray-700',    label: 'Dismissed' },
    EXPIRED:   { bg: 'bg-gray-100',    text: 'text-gray-500',    label: 'Expired' },
  };
  const s = styles[status] || styles.PENDING;
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

function StatCard({ label, value, hint, accent }) {
  const tone = accent === 'warn' ? 'text-rose-600' : 'text-gray-900';
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4">
      <p className="text-[11px] font-bold tracking-wider uppercase text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone}`} style={{ fontFamily: 'var(--font-heading)' }}>{value}</p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}


export default WaitlistTab;
