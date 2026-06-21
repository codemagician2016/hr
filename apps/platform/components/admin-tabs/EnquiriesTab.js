'use client';

// Extracted from [slug]/admin/page.js 2026-04-29 as part of the admin
// page split.

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useConfirm } from '@/components/ConfirmDialog';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, PrimaryButton, Modal, ModalActions, TextInput, TextArea, Empty, formatAdminDate, formatAdminDateTime, formatMoneyMinor } from '@/components/admin-ui';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

const ENQUIRY_STATUS_LABELS = { NEW: 'New', READ: 'Read', REPLIED: 'Replied', ARCHIVED: 'Archived' };
const ENQUIRY_FILTERS = [
  { key: 'all',      label: 'All' },
  { key: 'NEW',      label: 'New' },
  { key: 'READ',     label: 'Read' },
  { key: 'REPLIED',  label: 'Replied' },
  { key: 'ARCHIVED', label: 'Archived' },
];

function EnquiriesTab() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [enquiries, setEnquiries] = useState([]);
  const [counts, setCounts] = useState({ NEW: 0, READ: 0, REPLIED: 0, ARCHIVED: 0 });
  const rawStatus = searchParams.get('status') || 'all';
  const filter = ENQUIRY_FILTERS.some((f) => f.key === rawStatus) ? rawStatus : 'all';
  const [loading, setLoading] = useState(true);
  const confirm = useConfirm();
  const selectedId = searchParams.get('id') || null;

  const replaceQuery = useCallback((mutator) => {
    const params = new URLSearchParams(searchParams.toString());
    mutator(params);
    router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
  }, [router, searchParams]);

  const setFilter = useCallback((nextFilter) => {
    const safeFilter = ENQUIRY_FILTERS.some((f) => f.key === nextFilter) ? nextFilter : 'all';
    replaceQuery((params) => {
      if (safeFilter === 'all') params.delete('status');
      else params.set('status', safeFilter);
      params.delete('id');
    });
  }, [replaceQuery]);

  const setSelectedId = useCallback((nextId) => {
    replaceQuery((params) => {
      if (nextId) params.set('id', nextId);
      else params.delete('id');
    });
  }, [replaceQuery]);

  async function load() {
    setLoading(true);
    try {
      const query = filter === 'all' ? '' : `?status=${filter}`;
      const data = await api(`/api/business/enquiries${query}`);
      setEnquiries(data.enquiries || []);
      setCounts(data.counts || {});
    } catch (err) {
      // ignore — UI will just show empty state
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [filter]);

  async function setStatus(id, status) {
    try {
      await api(`/api/business/enquiries/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      load();
    } catch (err) { alert(err.message); }
  }

  async function remove(id) {
    if (!await confirm('Delete this enquiry?', { confirmLabel: 'Delete', tone: 'danger' })) return;
    try {
      await api(`/api/business/enquiries/${id}`, { method: 'DELETE' });
      if (selectedId === id) setSelectedId(null);
      load();
    } catch (err) { alert(err.message); }
  }

  function openEnquiry(enquiry) {
    setSelectedId(enquiry.id);
    if (enquiry.status === 'NEW') setStatus(enquiry.id, 'READ');
  }

  const selected = enquiries.find((e) => e.id === selectedId);

  if (loading) return <div className="py-10 flex justify-center"><Spinner /></div>;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      {/* Filter strip */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-200 overflow-x-auto">
        {ENQUIRY_FILTERS.map((f) => {
          const count = f.key === 'all'
            ? (counts.NEW + counts.READ + counts.REPLIED + counts.ARCHIVED)
            : (counts[f.key] || 0);
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-[12px] font-medium rounded-lg transition-colors"
              style={{
                background: active ? '#111827' : 'transparent',
                color: active ? '#fff' : '#4B5563',
              }}
            >
              {f.label}
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full" style={{ background: active ? 'rgba(255,255,255,0.2)' : '#E5E7EB', color: active ? '#fff' : '#374151' }}>{count}</span>
            </button>
          );
        })}
      </div>

      {enquiries.length === 0 ? (
        <div className="p-10 text-center text-sm text-gray-500">
          No enquiries {filter !== 'all' ? `in ${ENQUIRY_STATUS_LABELS[filter].toLowerCase()}` : 'yet'}.
          <p className="mt-2 text-xs text-gray-400">Messages from your website&apos;s contact form appear here.</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-[360px,minmax(0,1fr)] min-h-[400px]">
          {/* Inbox list */}
          <div className="border-r border-gray-200 overflow-y-auto max-h-[calc(100vh-260px)]">
            {enquiries.map((e) => {
              const isSelected = e.id === selectedId;
              const isNew = e.status === 'NEW';
              return (
                <button
                  key={e.id}
                  onClick={() => openEnquiry(e)}
                  className="w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors"
                  style={{ background: isSelected ? '#F3F4F6' : 'transparent' }}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-sm font-semibold text-gray-900 truncate">{e.name}</span>
                    {isNew && <span className="px-1.5 py-0.5 text-[10px] font-bold text-white rounded" style={{ background: '#4F46E5' }}>NEW</span>}
                  </div>
                  <p className="text-xs text-gray-500 truncate">{e.message}</p>
                  <p className="text-[10px] text-gray-400 mt-1">{new Date(e.createdAt).toLocaleString()}</p>
                </button>
              );
            })}
          </div>

          {/* Detail pane */}
          <div className="p-6">
            {selected ? (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{selected.name}</h3>
                    <p className="text-xs text-gray-500">{new Date(selected.createdAt).toLocaleString()}</p>
                  </div>
                  <select
                    value={selected.status}
                    onChange={(e) => setStatus(selected.id, e.target.value)}
                    className="text-xs font-medium border border-gray-300 rounded-lg px-2 py-1 bg-white"
                  >
                    {Object.entries(ENQUIRY_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>

                <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
                  {selected.email && (<>
                    <dt className="text-gray-500">Email</dt>
                    <dd><a className="text-indigo-600 hover:underline" href={`mailto:${selected.email}`}>{selected.email}</a></dd>
                  </>)}
                  {selected.phone && (<>
                    <dt className="text-gray-500">Phone</dt>
                    <dd><a className="text-indigo-600 hover:underline" href={`tel:${selected.phone}`}>{selected.phone}</a></dd>
                  </>)}
                  {selected.subject && (<>
                    <dt className="text-gray-500">Subject</dt>
                    <dd className="text-gray-900">{selected.subject}</dd>
                  </>)}
                </dl>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Message</p>
                  <p className="text-sm text-gray-900 leading-relaxed whitespace-pre-wrap bg-gray-50 rounded-lg p-4 border border-gray-200">{selected.message}</p>
                </div>

                <div className="flex items-center gap-2 pt-2">
                  {selected.email && (
                    <a href={`mailto:${selected.email}?subject=Re: your enquiry`} className="px-3 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">Reply by email</a>
                  )}
                  {selected.phone && (
                    <a href={`tel:${selected.phone}`} className="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Call</a>
                  )}
                  <div className="flex-1" />
                  <button onClick={() => remove(selected.id)} className="px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg">Delete</button>
                </div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-gray-400">Select an enquiry to view details</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default EnquiriesTab;
