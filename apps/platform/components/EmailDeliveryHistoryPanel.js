'use client';

import { useEffect, useMemo, useState } from 'react';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'SENT', label: 'Sent' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'FAILED', label: 'Failed' },
];

const EVENT_OPTIONS = [
  { value: '', label: 'All events' },
  { value: 'user_signup_otp', label: 'User signup OTP' },
  { value: 'user_welcome', label: 'User welcome' },
  { value: 'user_password_reset_otp', label: 'User password reset OTP' },
  { value: 'customer_signup_otp', label: 'Customer signup OTP' },
  { value: 'customer_password_reset_otp', label: 'Customer password reset OTP' },
  { value: 'staff_invite', label: 'Staff invite' },
  { value: 'booking_created_customer', label: 'Booking confirmation (customer)' },
  { value: 'booking_created_staff', label: 'Booking notification (staff)' },
  { value: 'appointment_confirmed', label: 'Appointment confirmed' },
  { value: 'appointment_cancelled', label: 'Appointment cancelled' },
];

const STATUS_STYLES = {
  SENT: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  PENDING: 'bg-amber-100 text-amber-700 border-amber-200',
  FAILED: 'bg-red-100 text-red-700 border-red-200',
};

function buildQuery(filters) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.eventKey) params.set('eventKey', filters.eventKey);
  if (filters.recipient) params.set('recipient', filters.recipient);
  if (filters.businessId) params.set('businessId', filters.businessId);
  if (filters.limit) params.set('limit', String(filters.limit));
  const query = params.toString();
  return query ? `?${query}` : '';
}

async function getJson(path) {
  const res = await fetch(path, { credentials: 'include' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function prettyEventLabel(value) {
  if (!value) return 'Unknown event';
  const known = EVENT_OPTIONS.find((item) => item.value === value);
  if (known) return known.label;
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatDateTime(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('en-NZ', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function StatusPill({ status }) {
  const style = STATUS_STYLES[status] || 'bg-gray-100 text-gray-700 border-gray-200';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-semibold ${style}`}>
      {status || 'UNKNOWN'}
    </span>
  );
}

function LoadingSpinner() {
  return (
    <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-transparent" aria-hidden />
  );
}

function SummaryCard({ label, value, tint }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`text-3xl font-bold mt-2 inline-block px-3 py-1 rounded-lg ${tint}`}>
        {value}
      </p>
    </div>
  );
}

export default function EmailDeliveryHistoryPanel({
  endpoint,
  title,
  description,
  businesses = [],
  showBusinessColumn = false,
  emptyMessage = 'No email activity yet.',
}) {
  const initialFilters = useMemo(() => ({
    status: '',
    eventKey: '',
    recipient: '',
    businessId: '',
    limit: '25',
  }), []);

  const [filters, setFilters] = useState(initialFilters);
  const [draft, setDraft] = useState(initialFilters);
  const [data, setData] = useState({ deliveries: [], summary: { pending: 0, sent: 0, failed: 0 } });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!loading) setRefreshing(true);
      setError('');
      try {
        const payload = await getJson(`${endpoint}${buildQuery(filters)}`);
        if (!cancelled) setData(payload);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load email activity.');
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [endpoint, filters, refreshNonce]);

  const eventOptions = useMemo(() => {
    const map = new Map(EVENT_OPTIONS.map((item) => [item.value, item]));
    (data.deliveries || []).forEach((delivery) => {
      if (delivery.eventKey && !map.has(delivery.eventKey)) {
        map.set(delivery.eventKey, {
          value: delivery.eventKey,
          label: prettyEventLabel(delivery.eventKey),
        });
      }
    });
    return Array.from(map.values());
  }, [data.deliveries]);

  const shownCount = (data.deliveries || []).length;

  function applyFilters(e) {
    e.preventDefault();
    setFilters({
      status: draft.status,
      eventKey: draft.eventKey,
      recipient: draft.recipient.trim(),
      businessId: draft.businessId,
      limit: draft.limit,
    });
  }

  function resetFilters() {
    setDraft(initialFilters);
    setFilters(initialFilters);
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
            <p className="text-sm text-gray-500 mt-1">{description}</p>
          </div>
          <button
            type="button"
            onClick={() => setRefreshNonce((prev) => prev + 1)}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700 hover:border-gray-900"
          >
            {refreshing && <LoadingSpinner />}
            Refresh
          </button>
        </div>

        <form onSubmit={applyFilters} className="mt-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          {showBusinessColumn && (
            <select
              value={draft.businessId}
              onChange={(e) => setDraft((prev) => ({ ...prev, businessId: e.target.value }))}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">All businesses</option>
              {businesses.map((business) => (
                <option key={business.id} value={business.id}>{business.name}</option>
              ))}
            </select>
          )}

          <select
            value={draft.status}
            onChange={(e) => setDraft((prev) => ({ ...prev, status: e.target.value }))}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          >
            {STATUS_OPTIONS.map((item) => (
              <option key={item.label} value={item.value}>{item.label}</option>
            ))}
          </select>

          <select
            value={draft.eventKey}
            onChange={(e) => setDraft((prev) => ({ ...prev, eventKey: e.target.value }))}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          >
            {eventOptions.map((item) => (
              <option key={item.label} value={item.value}>{item.label}</option>
            ))}
          </select>

          <input
            type="search"
            value={draft.recipient}
            onChange={(e) => setDraft((prev) => ({ ...prev, recipient: e.target.value }))}
            placeholder="Filter by recipient email"
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />

          <div className="flex gap-2">
            <select
              value={draft.limit}
              onChange={(e) => setDraft((prev) => ({ ...prev, limit: e.target.value }))}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm min-w-[96px]"
            >
              <option value="25">25 rows</option>
              <option value="50">50 rows</option>
              <option value="100">100 rows</option>
            </select>
            <button
              type="submit"
              className="flex-1 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={resetFilters}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700 hover:border-gray-900"
            >
              Reset
            </button>
          </div>
        </form>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <SummaryCard label="Sent" value={data.summary?.sent || 0} tint="bg-emerald-50 text-emerald-700" />
        <SummaryCard label="Pending" value={data.summary?.pending || 0} tint="bg-amber-50 text-amber-700" />
        <SummaryCard label="Failed" value={data.summary?.failed || 0} tint="bg-red-50 text-red-700" />
        <SummaryCard label="Shown rows" value={shownCount} tint="bg-indigo-50 text-indigo-700" />
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Recent delivery history</h3>
            <p className="text-sm text-gray-500">
              This is the tracked email log for the selected filters. Failed rows keep the provider error for support follow-up.
            </p>
          </div>
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full border bg-gray-100 text-gray-700 border-gray-200 whitespace-nowrap">
            {(data.deliveries || []).length} rows
          </span>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-4">
            {error}
          </div>
        )}

        {loading ? (
          <div className="py-10 flex justify-center"><LoadingSpinner /></div>
        ) : (data.deliveries || []).length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-500 border border-dashed border-gray-200 rounded-xl">
            {emptyMessage}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <tr>
                  <th className="py-3 pr-4">Event</th>
                  <th className="py-3 pr-4">Recipient</th>
                  {showBusinessColumn && <th className="py-3 pr-4">Business</th>}
                  <th className="py-3 pr-4">Status</th>
                  <th className="py-3 pr-4">Triggered</th>
                  <th className="py-3">Result</th>
                </tr>
              </thead>
              <tbody>
                {(data.deliveries || []).map((delivery) => (
                  <tr key={delivery.id} className="align-top border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                    <td className="py-4 pr-4 min-w-[220px]">
                      <p className="font-semibold text-gray-900">{prettyEventLabel(delivery.eventKey)}</p>
                      <p className="mt-1 text-xs text-gray-500 break-words">{delivery.subject}</p>
                    </td>
                    <td className="py-4 pr-4 min-w-[220px]">
                      <p className="font-medium text-gray-900">{delivery.recipientName || 'Unnamed recipient'}</p>
                      <p className="mt-1 text-xs text-gray-600 break-all">{delivery.recipientEmail}</p>
                      {delivery.actualRecipientEmail && delivery.actualRecipientEmail !== delivery.recipientEmail && (
                        <p className="mt-1 text-xs text-amber-700 break-all">
                          Delivered to {delivery.actualRecipientEmail}
                        </p>
                      )}
                    </td>
                    {showBusinessColumn && (
                      <td className="py-4 pr-4 min-w-[180px]">
                        <p className="font-medium text-gray-900">{delivery.business?.name || 'Unknown business'}</p>
                        <p className="mt-1 text-xs text-gray-500">{delivery.business?.slug ? `/${delivery.business.slug}` : delivery.businessId || '—'}</p>
                      </td>
                    )}
                    <td className="py-4 pr-4 whitespace-nowrap">
                      <StatusPill status={delivery.status} />
                    </td>
                    <td className="py-4 pr-4 min-w-[180px] text-xs text-gray-600">
                      <p>{formatDateTime(delivery.attemptedAt || delivery.createdAt)}</p>
                      {delivery.sentAt && <p className="mt-1 text-emerald-700">Sent {formatDateTime(delivery.sentAt)}</p>}
                    </td>
                    <td className="py-4 min-w-[260px]">
                      {delivery.status === 'FAILED' ? (
                        <p className="text-sm text-red-700 break-words">{delivery.errorMessage || 'Provider returned an unknown error.'}</p>
                      ) : delivery.providerMessageId ? (
                        <div className="space-y-1">
                          <p className="text-xs uppercase tracking-wide text-gray-500">Provider message</p>
                          <p className="font-mono text-xs text-gray-700 break-all">{delivery.providerMessageId}</p>
                        </div>
                      ) : (
                        <p className="text-sm text-gray-500">No provider metadata stored.</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
