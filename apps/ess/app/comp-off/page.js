'use client';

// My Comp-off (Feature 30) — the employee's compensatory-off balance + lot list.
//
// SELF-SERVICE SURFACE: every call goes to the customer-session
// /api/hr/me/comp-off/* endpoints, which resolve the employee SERVER-SIDE from the
// session. The page NEVER sends an employeeId.
//   Balance : GET /api/hr/me/comp-off/balance   { available, lotCount, soonestExpiry }
//   Lots    : GET /api/hr/me/comp-off/credits    { credits:[{ remaining, expiresOn, status, ... }] }
//
// AVAIL is NOT here — to use a comp-off, the employee applies on the normal Leave
// page and picks the "Comp-off" leave type (the existing Apply-Leave form). This
// page is read-only: balance + per-credit expiry chips so they know what they have
// and when it lapses.

import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return String(d).slice(0, 10); }
}
function daysUntil(d) {
  if (!d) return null;
  const ms = new Date(`${String(d).slice(0, 10)}T00:00:00.000Z`).getTime() - Date.now();
  return Math.ceil(ms / 86400000);
}

// Status chip — Active / Expiring soon / Expired / Used / Pending / Voided.
function StatusChip({ credit }) {
  const left = daysUntil(credit.expiresOn);
  let label = credit.status;
  let bg = 'var(--theme-border)';
  let fg = 'var(--theme-text)';
  if (credit.status === 'ACTIVE') {
    if (left != null && left <= 7) { label = `Expiring in ${Math.max(0, left)}d`; bg = '#FEF3C7'; fg = '#92400E'; }
    else { label = 'Active'; bg = '#DCFCE7'; fg = '#166534'; }
  } else if (credit.status === 'EXPIRED') { label = 'Expired'; bg = '#FEE2E2'; fg = '#991B1B'; }
  else if (credit.status === 'EXHAUSTED') { label = 'Used'; bg = '#E5E7EB'; fg = '#374151'; }
  else if (credit.status === 'PENDING') { label = 'Awaiting approval'; bg = '#DBEAFE'; fg = '#1E40AF'; }
  else if (credit.status === 'VOIDED') { label = 'Voided'; bg = '#E5E7EB'; fg = '#6B7280'; }
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: bg, color: fg }}>
      {label}
    </span>
  );
}

function sourceLabel(kind) {
  switch (kind) {
    case 'WEEKLY_OFF': return 'weekly off';
    case 'HOLIDAY': return 'a holiday';
    case 'EXTRA_HOURS': return 'extra hours';
    case 'HR_GRANT': return 'an HR grant';
    default: return String(kind || '').toLowerCase();
  }
}

function CompOffInner() {
  const bal = useApi('/api/hr/me/comp-off/balance');
  const lots = useApi('/api/hr/me/comp-off/credits');

  const loading = bal.loading || lots.loading;
  const error = bal.error || lots.error;
  const balance = bal.data || {};
  const credits = (lots.data && lots.data.credits) || [];

  const soonestLeft = daysUntil(balance.soonestExpiry);

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <h1 className="mb-1 text-xl font-bold" style={{ color: 'var(--theme-text)' }}>My Comp-off</h1>
      <p className="mb-4 text-sm" style={{ color: 'var(--theme-muted)' }}>
        Days earned for working on a weekly off or holiday. Each credit expires on its own date — apply for it
        (pick <b>Comp-off</b> on the Leave page) before it lapses.
      </p>

      {error ? <ErrorBanner message={error.message || 'Could not load your comp-off.'} /> : null}

      {/* Balance card */}
      <div className="mb-5 rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        {loading && !bal.data ? (
          <Centered><Spinner /></Centered>
        ) : (
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-3xl font-bold" style={{ color: 'var(--theme-text)' }}>
                {Number(balance.available || 0)} <span className="text-base font-medium" style={{ color: 'var(--theme-muted)' }}>day(s) available</span>
              </div>
              <div className="mt-1 text-sm" style={{ color: 'var(--theme-muted)' }}>
                {balance.soonestExpiry
                  ? <>Soonest expires {fmtDate(balance.soonestExpiry)}{soonestLeft != null ? ` (in ${Math.max(0, soonestLeft)} day(s))` : ''}.</>
                  : 'No active comp-off credits right now.'}
              </div>
            </div>
            <a href="/leave" className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition"
              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
              Apply comp-off
            </a>
          </div>
        )}
      </div>

      {/* Lot list */}
      <div className="rounded-2xl border bg-white shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <div className="border-b px-4 py-3 text-sm font-semibold" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}>
          Your comp-off credits
        </div>
        {loading && !lots.data ? (
          <Centered><Spinner /></Centered>
        ) : credits.length === 0 ? (
          <Empty title="No comp-off yet" subtitle="When you work on a weekly off or holiday, the credit shows up here." />
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--theme-border)' }}>
            {credits.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                    Earned {Number(c.quantity)} day(s) for working {sourceLabel(c.sourceKind)} on {fmtDate(c.sourceDate)}
                  </div>
                  <div className="mt-0.5 text-xs" style={{ color: 'var(--theme-muted)' }}>
                    Expires {fmtDate(c.expiresOn)}
                    {Number(c.consumed) > 0 ? ` · ${Number(c.consumed)} used` : ''}
                    {` · ${Number(c.remaining)} remaining`}
                  </div>
                </div>
                <StatusChip credit={c} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function CompOffPage() {
  return (
    <AppShell>
      <CompOffInner />
    </AppShell>
  );
}
