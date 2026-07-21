'use client';

// Employee news feed — company announcements targeted to this employee
// (published + in-audience + not expired, pinned-first), plus the celebration feed
// (upcoming birthdays + work anniversaries). Wired to the REAL ESS contract:
//   GET  /api/hr/me/engagement/feed?page=&pageSize=   → { items, total }
//   POST /api/hr/me/engagement/feed/:id/read          → mark one read
//   POST /api/hr/me/engagement/feed/read-all          → mark all visible read
//   GET  /api/hr/me/engagement/celebrations           → { birthdays, anniversaries }
// Customer/cookie session; self-only (the subject is resolved server-side).

import { useCallback, useState } from 'react';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import InfoTip from '@/components/InfoTip';
import NotificationPrefsCard from '@/components/NotificationPrefsCard';
import { apiPost } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { formatDate } from '@/lib/format';
import { ServerPagination } from '@/lib/pagination';
import CelebrationsWidget from '@/components/CelebrationsWidget';

const PAGE_SIZES = [10, 25, 50];

const CATEGORY_TONE = {
  POLICY: { bg: '#eef2ff', fg: '#4338ca' },
  EVENT: { bg: '#ecfeff', fg: '#0e7490' },
  HOLIDAY: { bg: '#fef3c7', fg: '#92400e' },
  CELEBRATION: { bg: '#fce7f3', fg: '#9d174f' },
  NEWS: { bg: '#f0fdfa', fg: '#0f766e' },
  GENERAL: { bg: '#f1f5f9', fg: '#475569' },
};

function CategoryPill({ category }) {
  const t = CATEGORY_TONE[category] || CATEGORY_TONE.GENERAL;
  return (
    <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: t.bg, color: t.fg }}>
      {category}
    </span>
  );
}

function AnnouncementCard({ a, onMarkRead, busy }) {
  return (
    <article
      className="rounded-2xl border bg-white p-4 shadow-sm"
      style={{ borderColor: a.read ? 'var(--theme-border)' : 'var(--theme-primary)' }}
    >
      <div className="mb-2 flex items-center gap-2">
        {a.pinned && <span title="Pinned" aria-label="Pinned">📌</span>}
        <CategoryPill category={a.category} />
        {!a.read && (
          <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-white" style={{ background: 'var(--theme-primary)' }}>
            NEW
          </span>
        )}
        <span className="ml-auto text-xs" style={{ color: 'var(--theme-muted)' }}>
          {a.publishedAt ? formatDate(a.publishedAt) : ''}
        </span>
      </div>
      <h3 className="text-base font-semibold" style={{ color: 'var(--theme-text)' }}>{a.title}</h3>
      <p className="mt-1 whitespace-pre-wrap text-sm" style={{ color: 'var(--theme-text)' }}>{a.bodyRichText}</p>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs" style={{ color: 'var(--theme-muted)' }}>
          {a.authorName ? `Posted by ${a.authorName}` : ''}
        </span>
        {!a.read && (
          <button
            type="button"
            onClick={() => onMarkRead(a.id)}
            disabled={busy}
            className="rounded-lg border px-3 py-1 text-xs font-medium disabled:opacity-50"
            style={{ borderColor: 'var(--theme-primary)', color: 'var(--theme-primary)' }}
          >
            Mark as read
          </button>
        )}
      </div>
    </article>
  );
}

function FeedInner() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const { data, loading, error, reload } = useApi(
    `/api/hr/me/engagement/feed?page=${page}&pageSize=${pageSize}`,
    {
      deps: [page, pageSize],
      select: (b) => ({ items: b?.items || [], total: b?.total ?? (b?.items || []).length }),
    },
  );

  const items = data?.items || [];
  const total = data?.total ?? items.length;
  const unreadOnPage = items.filter((a) => !a.read).length;

  const markRead = useCallback(async (id) => {
    setBusy(true); setActionError('');
    try {
      await apiPost(`/api/hr/me/engagement/feed/${id}/read`);
      await reload();
    } catch (e) {
      setActionError(e.message || 'Could not mark as read.');
    } finally { setBusy(false); }
  }, [reload]);

  const markAllRead = useCallback(async () => {
    setBusy(true); setActionError('');
    try {
      await apiPost('/api/hr/me/engagement/feed/read-all');
      await reload();
    } catch (e) {
      setActionError(e.message || 'Could not mark all as read.');
    } finally { setBusy(false); }
  }, [reload]);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>
            News &amp; updates
            <InfoTip text="Company announcements targeted to you — pinned items appear first. Marking an item read clears it from your unread badge." />
          </h1>
          <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>What’s happening at your company.</p>
        </div>
        {unreadOnPage > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            disabled={busy}
            className="rounded-lg border px-3 py-2 text-xs font-medium disabled:opacity-50"
            style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
          >
            Mark all read
          </button>
        )}
      </header>

      {/* Celebrations — derived feed (birthdays + anniversaries), privacy-aware. */}
      <CelebrationsWidget />

      {/* Notification preferences (P1.6) — the unified write surface replaces
          the old celebrations-only opt-out bar: announcement pushes + the
          celebrations privacy control, via /me/engagement/notification-prefs. */}
      <NotificationPrefsCard />

      {actionError && <ErrorBanner message={actionError} />}

      {loading ? (
        <Centered><Spinner /></Centered>
      ) : error ? (
        // A not-yet-deployed route (404) degrades to a friendly empty state.
        error.status === 404 ? (
          <Empty text="No announcements yet. Check back soon." />
        ) : (
          <ErrorBanner message={error.message || 'Could not load the feed.'} />
        )
      ) : items.length === 0 ? (
        <Empty text="No announcements yet. Check back soon." />
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <AnnouncementCard key={a.id} a={a} onMarkRead={markRead} busy={busy} />
          ))}
        </div>
      )}

      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        sizes={PAGE_SIZES}
        noun="announcements"
      />
    </div>
  );
}

export default function FeedPage() {
  return (
    <AppShell>
      <FeedInner />
    </AppShell>
  );
}
