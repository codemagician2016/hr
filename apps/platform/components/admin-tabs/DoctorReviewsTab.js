'use client';

// Doctor v2 — patient review moderation (APPOINTMENT / doctor_clinic).
// Verified, appointment-linked reviews. Clinic publishes the ones to show
// on its own branded site. Backed by /api/reviews/admin.

import { useState } from 'react';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, Empty } from '@/components/admin-ui';
import { useApi } from '@/lib/useApi';

function Stars({ n }) {
  const r = Math.max(0, Math.min(5, Number(n) || 0));
  return <span className="text-amber-500" aria-label={`${r} of 5`}>{'★'.repeat(r)}{'☆'.repeat(5 - r)}</span>;
}

const BADGE = {
  PUBLISHED: 'bg-emerald-100 text-emerald-800',
  HIDDEN: 'bg-gray-100 text-gray-600',
  PENDING: 'bg-amber-100 text-amber-800',
};

export default function DoctorReviewsTab() {
  const { data: reviews = [], loading, error, reload } = useApi('/api/reviews/admin', { select: (r) => r.reviews || [] });
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  async function setStatus(id, status) {
    setBusy(id); setErr('');
    try { await api(`/api/reviews/admin/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await reload(); }
    catch (e) { setErr(e.message || 'Could not update review'); }
    finally { setBusy(''); }
  }

  if (loading) return <Spinner />;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Patient reviews</h2>
        <p className="text-sm text-gray-500">Verified reviews from completed visits. Publish the ones you want shown on your website.</p>
      </div>

      {error && <ErrorBanner message="Could not load reviews." />}
      {err && <ErrorBanner message={err} />}

      {reviews.length === 0 ? (
        <Empty text="No reviews yet. Patients can leave one after a completed visit." />
      ) : (
        <ul className="space-y-3">
          {reviews.map((r) => (
            <li key={r.id} className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Stars n={r.rating} />
                  <span className="ml-2 text-sm text-gray-600">
                    {r.customer?.name || 'Patient'}{r.staff?.name ? ` · ${r.staff.name}` : ''}
                  </span>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[r.status] || BADGE.PENDING}`}>{r.status}</span>
              </div>
              {r.body ? <p className="mt-2 text-sm text-gray-700">{r.body}</p> : null}
              <div className="mt-3 flex gap-2 text-sm">
                {r.status !== 'PUBLISHED' && (
                  <button type="button" disabled={busy === r.id} onClick={() => setStatus(r.id, 'PUBLISHED')}
                    className="rounded-lg bg-emerald-600 px-3 py-1 font-medium text-white hover:bg-emerald-700 disabled:opacity-50">Publish</button>
                )}
                {r.status !== 'HIDDEN' && (
                  <button type="button" disabled={busy === r.id} onClick={() => setStatus(r.id, 'HIDDEN')}
                    className="rounded-lg border border-gray-300 px-3 py-1 text-gray-700 hover:bg-gray-50 disabled:opacity-50">Hide</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
