'use client';

// CelebrationsWidget — the derived celebration feed: upcoming birthdays + work
// anniversaries within a window. Reused on the ESS home dashboard (compact) and the
// news-feed page (full). Privacy-aware by construction — the backend hides opted-out
// employees and NEVER returns a DOB year (day/month only), so this component only
// ever renders what it is given.
//
// GET /api/hr/me/engagement/celebrations?windowDays=N → { birthdays, anniversaries }
// Customer session, self-only. A 404 (route not yet deployed) renders nothing.

import { useApi } from '@/lib/useApi';
import InfoTip from '@/components/InfoTip';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function whenLabel(inDays) {
  if (inDays === 0) return 'Today';
  if (inDays === 1) return 'Tomorrow';
  return `in ${inDays} days`;
}
function dayMonth(item) {
  // No year is ever present (privacy); show "12 Aug".
  const m = MONTHS[(item.month || 1) - 1] || '';
  return `${item.day} ${m}`;
}
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Avatar({ item }) {
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold"
      style={{ background: 'var(--theme-primary-soft, #f0fdfa)', color: 'var(--theme-primary)' }}
      aria-hidden={item.photoUrl ? undefined : 'true'}
    >
      {item.photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.photoUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span>{initials(item.name)}</span>
      )}
    </div>
  );
}

function Row({ item, kind }) {
  const emoji = kind === 'birthday' ? '🎂' : '🎉';
  const detail =
    kind === 'birthday'
      ? `Birthday · ${dayMonth(item)}`
      : `${item.years} year${item.years === 1 ? '' : 's'} · ${dayMonth(item)}`;
  return (
    <li className="flex items-center gap-3 py-2">
      <Avatar item={item} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
          {emoji} {item.isSelf ? 'You' : item.name}
        </div>
        <div className="truncate text-xs" style={{ color: 'var(--theme-muted)' }}>{detail}</div>
      </div>
      <span className="shrink-0 text-xs font-medium" style={{ color: 'var(--theme-primary)' }}>
        {whenLabel(item.inDays)}
      </span>
    </li>
  );
}

export default function CelebrationsWidget({ windowDays = 30, limit = 6, compact = false }) {
  const { data, error } = useApi(`/api/hr/me/engagement/celebrations?windowDays=${windowDays}`, {
    select: (b) => ({ birthdays: b?.birthdays || [], anniversaries: b?.anniversaries || [] }),
  });

  // Render nothing on error/not-deployed (keeps the dashboard clean + shippable).
  if (error) return null;
  const birthdays = data?.birthdays || [];
  const anniversaries = data?.anniversaries || [];
  if (!birthdays.length && !anniversaries.length) return null;

  // Merge + sort by soonest, tag the kind, cap to `limit` for the widget.
  const merged = [
    ...birthdays.map((b) => ({ kind: 'birthday', item: b })),
    ...anniversaries.map((a) => ({ kind: 'anniversary', item: a })),
  ].sort((x, y) => x.item.inDays - y.item.inDays).slice(0, limit);

  return (
    <section className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <div className="mb-1 flex items-center">
        <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
          Celebrations
        </h2>
        <InfoTip text="Upcoming birthdays and work anniversaries across your company. Birthdays show the day and month only — never the year. Anyone who has opted out is not shown." />
      </div>
      <ul className="divide-y" style={{ borderColor: 'var(--theme-border)' }}>
        {merged.map(({ kind, item }) => (
          <Row key={`${kind}-${item.employeeId}`} item={item} kind={kind} />
        ))}
      </ul>
    </section>
  );
}
