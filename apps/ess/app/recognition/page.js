'use client';

// Recognition — Feature 35 ESS surface. Wired to the REAL /api/hr/me contract
// (customer/cookie session, the subject employee resolved server-side):
//   Wall      GET  /me/recognitions?direction=all|given|received (paginated)
//             POST /me/recognitions { recipientEmployeeIds[], valueId?, badgeId?,
//                  message, pointsEach?, visibility? } → 201 { recognition,
//                  needsApproval, message? } (400/409 messages shown verbatim)
//   Wallet    GET  /me/wallet → { pointsEnabled, balance, lifetimeEarned,
//                  inrPerPoint, inrValue } + GET /me/wallet/ledger (signed rows)
//   Rewards   GET  /me/catalog → { balance, items[affordable/inStock] }
//             POST /me/redemptions { catalogItemId } + GET /me/redemptions +
//             POST /me/redemptions/:id/cancel (own + PENDING only)
//   Awards    GET  /me/award-cycles (open windows) + POST /me/award-nominations
//             { cycleId, nomineeEmployeeId, citation } + GET /me/award-nominations
//             → { made, won }
//   Board     GET  /me/recognition/leaderboard?period=&board= → { rows, me }
// Colleague picking searches the company directory (GET /me/directory?q=).
// NOTE: there is no ESS endpoint listing values/badges yet, so the give modal
// offers the values/badges already seen on the wall (best-effort) — both are
// optional on the API. Mobile-first: cards + pill tabs, no wide tables.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import InfoTip from '@/components/InfoTip';
import { apiGet, apiPost } from '@/lib/api';
import { ServerPagination } from '@/lib/pagination';
import { formatDate } from '@/lib/format';

const VISIBILITIES = [
  { value: 'PUBLIC', label: 'Everyone', hint: 'Shows on the company news feed.' },
  { value: 'TEAM', label: 'Their team', hint: 'Only the recipients’ department sees it.' },
  { value: 'PRIVATE', label: 'Just them', hint: 'Only the people you name see it.' },
];
const PERIODS = [
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'allTime', label: 'All time' },
];
const LEDGER_REASONS = {
  RECOGNITION: 'Recognition',
  AWARD: 'Award win',
  REDEMPTION: 'Redemption',
  ADJUSTMENT: 'HR adjustment',
  EXPIRY: 'Points expired',
  REVERSAL: 'Reversal',
};

function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function personName(e) {
  if (!e) return 'A colleague';
  return [e.firstName, e.lastName].filter(Boolean).join(' ') || e.name || e.code || 'A colleague';
}

function Chip({ children, bg, fg, title }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ background: bg || '#f1f5f9', color: fg || '#475569' }}
      title={title}
    >
      {children}
    </span>
  );
}

function StatusChip({ status }) {
  const tones = {
    POSTED: { bg: '#ecfdf5', fg: '#047857', label: 'Posted' },
    PENDING_APPROVAL: { bg: '#fef3c7', fg: '#92400e', label: 'Awaiting approval' },
    REJECTED: { bg: '#fee2e2', fg: '#b91c1c', label: 'Rejected' },
    PENDING: { bg: '#fef3c7', fg: '#92400e', label: 'Pending' },
    APPROVED: { bg: '#dbeafe', fg: '#1d4ed8', label: 'Approved' },
    FULFILLED: { bg: '#ecfdf5', fg: '#047857', label: 'Fulfilled' },
    CANCELLED: { bg: '#f1f5f9', fg: '#64748b', label: 'Cancelled' },
    SUBMITTED: { bg: '#fef3c7', fg: '#92400e', label: 'Submitted' },
    SHORTLISTED: { bg: '#dbeafe', fg: '#1d4ed8', label: 'Shortlisted' },
    WON: { bg: '#ecfdf5', fg: '#047857', label: 'Won 🏆' },
    NOT_SELECTED: { bg: '#f1f5f9', fg: '#64748b', label: 'Not selected' },
  };
  const t = tones[status] || { bg: '#f1f5f9', fg: '#64748b', label: status };
  return <Chip bg={t.bg} fg={t.fg}>{t.label}</Chip>;
}

function PrimaryButton({ onClick, disabled, children, className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${className}`}
      style={{ background: 'var(--theme-primary)' }}
    >
      {children}
    </button>
  );
}

function Card({ children, className = '' }) {
  return (
    <div className={`rounded-2xl border bg-white p-4 shadow-sm ${className}`} style={{ borderColor: 'var(--theme-border)' }}>
      {children}
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="mt-10 mb-10 w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--theme-text)' }}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-xl leading-none" style={{ color: 'var(--theme-muted)' }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls = 'w-full rounded-lg border px-3 py-2 text-sm';
const inputStyle = { borderColor: 'var(--theme-border)', color: 'var(--theme-text)' };

// ── colleague picker (directory search, debounced) ───────────────────────────
function ColleaguePicker({ picked, onAdd, onRemove, single = false, excludeIds = [], label = 'Who are you recognising?' }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const query = q.trim();
    if (!query) { setResults([]); setSearching(false); return undefined; }
    setSearching(true);
    timer.current = setTimeout(() => {
      apiGet(`/api/hr/me/directory?q=${encodeURIComponent(query)}&pageSize=8`)
        .then((r) => setResults(r?.items || []))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q]);

  const pickedIds = new Set([...picked.map((p) => p.id), ...excludeIds]);
  const options = results.filter((r) => !pickedIds.has(r.id));

  return (
    <div>
      <span className="mb-1 block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{label}</span>
      {picked.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {picked.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
                  style={{ background: 'var(--theme-primary-soft, #eef2ff)', color: 'var(--theme-primary)' }}>
              {p.name}
              <button type="button" onClick={() => onRemove(p.id)} aria-label={`Remove ${p.name}`} className="opacity-70 hover:opacity-100">✕</button>
            </span>
          ))}
        </div>
      )}
      {(!single || picked.length === 0) && (
        <>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={inputCls}
            style={inputStyle}
            placeholder="Search colleagues by name…"
            aria-label={label}
          />
          {q.trim() !== '' && (
            <div className="mt-1 max-h-44 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--theme-border)' }}>
              {searching ? (
                <p className="px-3 py-2 text-xs" style={{ color: 'var(--theme-muted)' }}>Searching…</p>
              ) : options.length === 0 ? (
                <p className="px-3 py-2 text-xs" style={{ color: 'var(--theme-muted)' }}>No matching colleagues.</p>
              ) : options.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => { onAdd({ id: r.id, name: r.name }); setQ(''); setResults([]); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                  style={{ color: 'var(--theme-text)' }}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                        style={{ background: 'var(--theme-primary-soft, #eef2ff)', color: 'var(--theme-primary)' }}>
                    {initialsOf(r.name)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate">{r.name}</span>
                    {(r.designation || r.department) && (
                      <span className="block truncate text-xs" style={{ color: 'var(--theme-muted)' }}>
                        {[r.designation, r.department].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── give recognition modal ───────────────────────────────────────────────────
function GiveModal({ pointsEnabled, valueOptions, badgeOptions, onClose, onGiven }) {
  const [picked, setPicked] = useState([]);
  const [valueId, setValueId] = useState('');
  const [badgeId, setBadgeId] = useState('');
  const [message, setMessage] = useState('');
  const [points, setPoints] = useState('');
  const [visibility, setVisibility] = useState('PUBLIC');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  async function send() {
    setSending(true);
    setError('');
    try {
      const payload = {
        recipientEmployeeIds: picked.map((p) => p.id),
        message: message.trim(),
        visibility,
      };
      if (valueId) payload.valueId = valueId;
      if (badgeId) payload.badgeId = badgeId;
      if (pointsEnabled && points !== '') payload.pointsEach = Math.max(0, Math.round(Number(points)) || 0);
      const res = await apiPost('/api/hr/me/recognitions', payload);
      onGiven(res);
    } catch (e) {
      setError(e.message || 'Could not send the recognition.');
    } finally {
      setSending(false);
    }
  }

  const vis = VISIBILITIES.find((v) => v.value === visibility);

  return (
    <Modal title="Give recognition 🎉" onClose={onClose}>
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      <div className="space-y-4">
        <ColleaguePicker picked={picked} onAdd={(p) => setPicked((l) => [...l, p])} onRemove={(id) => setPicked((l) => l.filter((x) => x.id !== id))} />

        {valueOptions.length > 0 && (
          <div>
            <span className="mb-1 block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>Company value (optional)</span>
            <select value={valueId} onChange={(e) => setValueId(e.target.value)} className={inputCls} style={inputStyle}>
              <option value="">— pick a value —</option>
              {valueOptions.map((v) => <option key={v.id} value={v.id}>{v.icon ? `${v.icon} ` : ''}{v.name}</option>)}
            </select>
          </div>
        )}
        {badgeOptions.length > 0 && (
          <div>
            <span className="mb-1 block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>Badge (optional)</span>
            <select value={badgeId} onChange={(e) => setBadgeId(e.target.value)} className={inputCls} style={inputStyle}>
              <option value="">— no badge —</option>
              {badgeOptions.map((b) => <option key={b.id} value={b.id}>{b.icon ? `${b.icon} ` : ''}{b.name}</option>)}
            </select>
          </div>
        )}

        <div>
          <span className="mb-1 block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>Your shout-out</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            className={inputCls}
            style={inputStyle}
            placeholder="Say why they deserve it — be specific, it means more."
            aria-label="Recognition message"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          {pointsEnabled && (
            <div>
              <span className="mb-1 flex items-center gap-1 text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                Points each (optional)
                <InfoTip text="Points credited to EACH person you name. Big gives may need your manager's approval first — you'll see a banner if so." />
              </span>
              <input type="number" min={0} value={points} onChange={(e) => setPoints(e.target.value)} className={inputCls} style={inputStyle} placeholder="0" aria-label="Points each" />
            </div>
          )}
          <div className={pointsEnabled ? '' : 'col-span-2'}>
            <span className="mb-1 block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>Who sees it</span>
            <select value={visibility} onChange={(e) => setVisibility(e.target.value)} className={inputCls} style={inputStyle}>
              {VISIBILITIES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
          </div>
        </div>
        {vis && <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>{vis.hint}</p>}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm font-medium" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}>
          Cancel
        </button>
        <PrimaryButton onClick={send} disabled={sending || picked.length === 0 || !message.trim()}>
          {sending ? 'Sending…' : 'Send recognition'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

// ── Wall tab ─────────────────────────────────────────────────────────────────
function WallTab({ pointsEnabled }) {
  const [direction, setDirection] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [giveOpen, setGiveOpen] = useState(false);
  const [banner, setBanner] = useState(null); // { tone, text }

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    apiGet(`/api/hr/me/recognitions?direction=${direction}&page=${page}&pageSize=${pageSize}`)
      .then(setData)
      .catch((e) => setError(e.message || 'Could not load recognitions.'))
      .finally(() => setLoading(false));
  }, [direction, page, pageSize]);
  useEffect(load, [load]);

  const items = data?.items || [];

  // Best-effort value/badge options for the give modal, harvested from the wall
  // (there is no ESS values/badges listing endpoint yet — both are optional).
  const { valueOptions, badgeOptions } = useMemo(() => {
    const vals = new Map();
    const bads = new Map();
    for (const it of items) {
      if (it.value && !vals.has(it.value.id)) vals.set(it.value.id, it.value);
      if (it.badge && !bads.has(it.badge.id)) bads.set(it.badge.id, it.badge);
    }
    return { valueOptions: [...vals.values()], badgeOptions: [...bads.values()] };
  }, [items]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {[['all', 'All'], ['received', 'Received'], ['given', 'Given']].map(([v, l]) => {
          const on = direction === v;
          return (
            <button
              key={v}
              type="button"
              onClick={() => { setDirection(v); setPage(1); }}
              className="rounded-full border px-3 py-1 text-xs font-medium"
              style={on
                ? { background: 'var(--theme-primary)', borderColor: 'var(--theme-primary)', color: '#fff' }
                : { borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
            >
              {l}
            </button>
          );
        })}
        <PrimaryButton onClick={() => { setBanner(null); setGiveOpen(true); }} className="ml-auto">
          + Give recognition
        </PrimaryButton>
      </div>

      {banner && (
        <div
          className="rounded-xl border px-4 py-3 text-sm"
          style={banner.tone === 'warn'
            ? { borderColor: '#fcd34d', background: '#fffbeb', color: '#92400e' }
            : { borderColor: '#a7f3d0', background: '#ecfdf5', color: '#047857' }}
        >
          {banner.text}
        </div>
      )}
      {error && <ErrorBanner message={error} />}

      {loading ? (
        <Centered><Spinner /></Centered>
      ) : items.length === 0 ? (
        <Empty text="No recognitions yet — be the first to celebrate a colleague." />
      ) : (
        <div className="space-y-3">
          {items.map((r) => (
            <Card key={r.id}>
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>
                  {personName(r.giver)}
                  <span className="mx-1 font-normal" style={{ color: 'var(--theme-muted)' }}>recognised</span>
                  {(r.recipients || []).map((x) => personName(x.employee)).join(', ')}
                </span>
                {r.value && (
                  <Chip bg={`${r.value.colorHex || '#64748b'}1a`} fg={r.value.colorHex || '#475569'}>
                    {r.value.icon ? `${r.value.icon} ` : ''}{r.value.name}
                  </Chip>
                )}
                {r.badge && <Chip>{r.badge.icon ? `${r.badge.icon} ` : ''}{r.badge.name}</Chip>}
                {r.visibility && r.visibility !== 'PUBLIC' && (
                  <Chip title="Not on the public wall">{r.visibility === 'TEAM' ? 'Team only' : 'Private'}</Chip>
                )}
                {r.status !== 'POSTED' && <StatusChip status={r.status} />}
              </div>
              <p className="whitespace-pre-wrap text-sm" style={{ color: 'var(--theme-text)' }}>{r.message}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs" style={{ color: 'var(--theme-muted)' }}>
                {pointsEnabled && r.pointsEach > 0 && (
                  <span className="font-semibold" style={{ color: '#047857' }}>
                    +{r.pointsEach} point{r.pointsEach === 1 ? '' : 's'}{(r.recipients || []).length > 1 ? ' each' : ''}
                  </span>
                )}
                <span className="ml-auto">{formatDate(r.postedAt || r.createdAt)}</span>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={data?.total ?? items.length}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        sizes={[10, 25, 50]}
        noun="recognitions"
      />

      {giveOpen && (
        <GiveModal
          pointsEnabled={pointsEnabled}
          valueOptions={valueOptions}
          badgeOptions={badgeOptions}
          onClose={() => setGiveOpen(false)}
          onGiven={(res) => {
            setGiveOpen(false);
            setBanner(res.needsApproval
              ? { tone: 'warn', text: res.message || 'Your manager will approve the points first.' }
              : { tone: 'ok', text: 'Recognition sent. 🎉' });
            load();
          }}
        />
      )}
    </div>
  );
}

// ── Wallet tab ───────────────────────────────────────────────────────────────
function WalletTab({ wallet, onGoRewards }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    apiGet(`/api/hr/me/wallet/ledger?page=${page}&pageSize=${pageSize}`)
      .then(setData)
      .catch((e) => setError(e.message || 'Could not load your ledger.'))
      .finally(() => setLoading(false));
  }, [page, pageSize]);

  const items = data?.items || [];

  return (
    <div className="space-y-4">
      <Card className="text-center">
        <p className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>My balance</p>
        <p className="mt-1 text-4xl font-bold" style={{ color: 'var(--theme-text)' }}>
          {(wallet?.balance ?? 0).toLocaleString('en-IN')}
          <span className="ml-1 text-base font-medium" style={{ color: 'var(--theme-muted)' }}>points</span>
        </p>
        {wallet?.inrValue != null && (
          <p className="mt-0.5 text-sm" style={{ color: 'var(--theme-muted)' }}>≈ ₹{wallet.inrValue.toLocaleString('en-IN')}</p>
        )}
        <p className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>
          Lifetime earned: {(wallet?.lifetimeEarned ?? 0).toLocaleString('en-IN')}
        </p>
        <div className="mt-4">
          <PrimaryButton onClick={onGoRewards}>Redeem points</PrimaryButton>
        </div>
      </Card>

      {error && <ErrorBanner message={error} />}
      {loading ? (
        <Centered><Spinner /></Centered>
      ) : items.length === 0 ? (
        <Empty text="No points activity yet — recognitions you receive will show up here." />
      ) : (
        <Card className="divide-y" >
          {items.map((e) => (
            <div key={e.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0" style={{ borderColor: 'var(--theme-border)' }}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                  {LEDGER_REASONS[e.reason] || e.reason}
                </p>
                <p className="truncate text-xs" style={{ color: 'var(--theme-muted)' }}>
                  {formatDate(e.createdAt)}
                  {e.note ? ` · ${e.note}` : ''}
                  {e.expiresAt ? ` · expires ${formatDate(e.expiresAt)}` : ''}
                </p>
              </div>
              <span className="text-sm font-bold" style={{ color: e.points >= 0 ? '#047857' : '#b91c1c' }}>
                {e.points >= 0 ? '+' : ''}{e.points.toLocaleString('en-IN')}
              </span>
            </div>
          ))}
        </Card>
      )}
      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={data?.total ?? items.length}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        sizes={[10, 25, 50]}
        noun="entries"
      />
    </div>
  );
}

// ── Rewards tab (catalog + my redemptions) ───────────────────────────────────
const CATEGORY_EMOJI = {
  VOUCHER: '🎁', PERK: '✨', SWAG: '👕', COMP_OFF: '🌴', WFH: '🏠', CHARITY: '🤲', DONATION: '💝',
};

function RewardsTab() {
  const [catalog, setCatalog] = useState(null);
  const [redemptions, setRedemptions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmItem, setConfirmItem] = useState(null);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([
      apiGet('/api/hr/me/catalog'),
      apiGet('/api/hr/me/redemptions?page=1&pageSize=25'),
    ])
      .then(([c, r]) => { setCatalog(c); setRedemptions(r); })
      .catch((e) => setError(e.message || 'Could not load the rewards store.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  async function cancel(row) {
    setBusyId(row.id);
    setError('');
    try {
      await apiPost(`/api/hr/me/redemptions/${row.id}/cancel`);
      setNotice('Redemption cancelled — no points moved.');
      load();
    } catch (e) {
      setError(e.message || 'Could not cancel the redemption.');
    } finally {
      setBusyId('');
    }
  }

  if (loading) return <Centered><Spinner /></Centered>;

  const items = catalog?.items || [];
  const mine = redemptions?.items || [];
  const balance = catalog?.balance ?? 0;

  return (
    <div className="space-y-5">
      {error && <ErrorBanner message={error} />}
      {notice && (
        <div className="rounded-xl border px-4 py-3 text-sm" style={{ borderColor: '#a7f3d0', background: '#ecfdf5', color: '#047857' }}>{notice}</div>
      )}

      {catalog && catalog.pointsEnabled === false ? (
        <Empty text="The points program is not enabled right now." />
      ) : (
        <>
          <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
            You have <span className="font-bold" style={{ color: 'var(--theme-text)' }}>{balance.toLocaleString('en-IN')} points</span> to spend.
          </p>

          {items.length === 0 ? (
            <Empty text="The rewards store is empty right now — check back soon." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((i) => (
                <Card key={i.id} className="flex flex-col">
                  {i.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={i.imageUrl} alt="" className="mb-3 h-28 w-full rounded-xl object-cover" />
                  ) : (
                    <div className="mb-3 flex h-20 items-center justify-center rounded-xl text-3xl" style={{ background: 'var(--theme-primary-soft, #eef2ff)' }}>
                      {CATEGORY_EMOJI[i.category] || '🎁'}
                    </div>
                  )}
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>{i.name}</h3>
                  {i.description && <p className="mt-0.5 line-clamp-2 text-xs" style={{ color: 'var(--theme-muted)' }}>{i.description}</p>}
                  <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--theme-muted)' }}>
                    <span className="font-bold" style={{ color: 'var(--theme-text)' }}>{i.pointsCost.toLocaleString('en-IN')} pts</span>
                    {i.inrValue != null && <span>≈ ₹{Number(i.inrValue).toLocaleString('en-IN')}</span>}
                    {!i.inStock && <Chip bg="#fee2e2" fg="#b91c1c">Out of stock</Chip>}
                  </div>
                  <div className="mt-3">
                    <PrimaryButton
                      onClick={() => setConfirmItem(i)}
                      disabled={!i.affordable || !i.inStock}
                      className="w-full"
                    >
                      {i.affordable ? 'Redeem' : `Need ${(i.pointsCost - balance).toLocaleString('en-IN')} more`}
                    </PrimaryButton>
                  </div>
                </Card>
              ))}
            </div>
          )}

          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>My redemptions</h2>
            {mine.length === 0 ? (
              <Empty text="Nothing redeemed yet." />
            ) : (
              <div className="space-y-2">
                {mine.map((r) => (
                  <Card key={r.id} className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{r.catalogItem?.name || 'Reward'}</p>
                      <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                        {(r.pointsSpent || 0).toLocaleString('en-IN')} pts · {formatDate(r.createdAt)}
                      </p>
                      {r.status === 'FULFILLED' && r.fulfilmentRef && (
                        <p className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>
                          Your code / ref: <code className="rounded border px-1.5 py-0.5 font-mono text-[11px]" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}>{r.fulfilmentRef}</code>
                        </p>
                      )}
                    </div>
                    <StatusChip status={r.status} />
                    {r.status === 'PENDING' && (
                      <button
                        type="button"
                        onClick={() => cancel(r)}
                        disabled={busyId === r.id}
                        className="rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                        style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
                      >
                        Cancel
                      </button>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {confirmItem && (
        <Modal title={`Redeem “${confirmItem.name}”?`} onClose={() => setConfirmItem(null)}>
          <p className="text-sm" style={{ color: 'var(--theme-text)' }}>
            This costs <span className="font-bold">{confirmItem.pointsCost.toLocaleString('en-IN')} points</span> — you have {balance.toLocaleString('en-IN')}.
            After redeeming you&apos;ll have {(balance - confirmItem.pointsCost).toLocaleString('en-IN')}.
          </p>
          <p className="mt-2 text-xs" style={{ color: 'var(--theme-muted)' }}>
            Points move once the redemption is approved; you can cancel while it is still pending.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmItem(null)} className="rounded-lg border px-4 py-2 text-sm font-medium" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}>
              Not now
            </button>
            <PrimaryButton
              onClick={async () => {
                setError('');
                setNotice('');
                try {
                  await apiPost('/api/hr/me/redemptions', { catalogItemId: confirmItem.id });
                  setConfirmItem(null);
                  setNotice('Redemption requested — track it under “My redemptions”.');
                  load();
                } catch (e) {
                  setConfirmItem(null);
                  setError(e.message || 'Could not redeem this reward.');
                }
              }}
            >
              Confirm redeem
            </PrimaryButton>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Awards tab ───────────────────────────────────────────────────────────────
function NominateModal({ cycle, onClose, onDone }) {
  const [picked, setPicked] = useState([]);
  const [citation, setCitation] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setSending(true);
    setError('');
    try {
      await apiPost('/api/hr/me/award-nominations', {
        cycleId: cycle.id,
        nomineeEmployeeId: picked[0]?.id,
        citation: citation.trim(),
      });
      onDone();
    } catch (e) {
      setError(e.message || 'Could not submit the nomination.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal title={`Nominate for “${cycle.name}”`} onClose={onClose}>
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      <div className="space-y-4">
        <ColleaguePicker
          picked={picked}
          single
          onAdd={(p) => setPicked([p])}
          onRemove={() => setPicked([])}
          label="Who are you nominating?"
        />
        <div>
          <span className="mb-1 flex items-center gap-1 text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
            Why do they deserve it?
            <InfoTip text="Your citation goes to the shortlist and the award committee — concrete examples beat adjectives." />
          </span>
          <textarea
            value={citation}
            onChange={(e) => setCitation(e.target.value)}
            rows={4}
            className={inputCls}
            style={inputStyle}
            placeholder="Tell the committee what they did and the impact it had…"
            aria-label="Citation"
          />
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm font-medium" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}>
          Cancel
        </button>
        <PrimaryButton onClick={submit} disabled={sending || picked.length === 0 || !citation.trim()}>
          {sending ? 'Submitting…' : 'Submit nomination'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

function AwardsTab() {
  const [cycles, setCycles] = useState(null);
  const [mine, setMine] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [nominateFor, setNominateFor] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([
      apiGet('/api/hr/me/award-cycles'),
      apiGet('/api/hr/me/award-nominations'),
    ])
      .then(([c, m]) => { setCycles(c.items || []); setMine(m); })
      .catch((e) => setError(e.message || 'Could not load awards.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  if (loading) return <Centered><Spinner /></Centered>;

  const open = cycles || [];
  const made = mine?.made || [];
  const won = mine?.won || [];

  return (
    <div className="space-y-5">
      {error && <ErrorBanner message={error} />}
      {notice && (
        <div className="rounded-xl border px-4 py-3 text-sm" style={{ borderColor: '#a7f3d0', background: '#ecfdf5', color: '#047857' }}>{notice}</div>
      )}

      {won.length > 0 && (
        <div className="space-y-2">
          {won.map((w) => (
            <div key={w.id} className="rounded-2xl border px-4 py-3" style={{ borderColor: '#fcd34d', background: '#fffbeb' }}>
              <p className="text-sm font-semibold" style={{ color: '#92400e' }}>
                🏆 You won {w.cycle?.name || 'an award'}!
              </p>
              <p className="mt-0.5 text-xs" style={{ color: '#b45309' }}>
                {w.decidedAt ? `Decided ${formatDate(w.decidedAt)}. ` : ''}
                {w.certificateLetterId
                  ? 'Your award certificate is available under Documents → My Letters.'
                  : w.cycle ? 'Your certificate is on its way — check My Letters soon.' : ''}
              </p>
            </div>
          ))}
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
          Open for nominations
        </h2>
        {open.length === 0 ? (
          <Empty text="No award cycles are open right now." />
        ) : (
          <div className="space-y-3">
            {open.map((c) => (
              <Card key={c.id} className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>{c.name}</h3>
                  <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                    {c.periodLabel ? `${c.periodLabel} · ` : ''}closes {formatDate(c.nominateCloseAt)}
                    {c.pointsToWinner ? ` · winner gets ${c.pointsToWinner.toLocaleString('en-IN')} points` : ''}
                    {c.issueCertificate ? ' + certificate' : ''}
                  </p>
                </div>
                <PrimaryButton onClick={() => { setNotice(''); setNominateFor(c); }}>Nominate</PrimaryButton>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
          My nominations
        </h2>
        {made.length === 0 ? (
          <Empty text="You haven't nominated anyone yet." />
        ) : (
          <div className="space-y-2">
            {made.map((n) => (
              <Card key={n.id} className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                    {personName(n.nominee)}
                    <span className="font-normal" style={{ color: 'var(--theme-muted)' }}> · {n.cycle?.name || 'award'}</span>
                  </p>
                  <p className="line-clamp-1 text-xs" style={{ color: 'var(--theme-muted)' }} title={n.citation}>{n.citation}</p>
                </div>
                <StatusChip status={n.status} />
              </Card>
            ))}
          </div>
        )}
      </section>

      {nominateFor && (
        <NominateModal
          cycle={nominateFor}
          onClose={() => setNominateFor(null)}
          onDone={() => {
            setNominateFor(null);
            setNotice('Nomination submitted — you can track it below. 🤞');
            load();
          }}
        />
      )}
    </div>
  );
}

// ── Leaderboard tab ──────────────────────────────────────────────────────────
function LeaderboardTab() {
  const [period, setPeriod] = useState('month');
  const [board, setBoard] = useState('earners');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    apiGet(`/api/hr/me/recognition/leaderboard?period=${period}&board=${board}`)
      .then(setData)
      .catch((e) => setError(e.message || 'Could not load the leaderboard.'))
      .finally(() => setLoading(false));
  }, [period, board]);

  const rows = data?.rows || [];
  const me = data?.me || null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {[['earners', 'Top earners'], ['givers', 'Top givers']].map(([v, l]) => {
          const on = board === v;
          return (
            <button
              key={v}
              type="button"
              onClick={() => setBoard(v)}
              className="rounded-full border px-3 py-1 text-xs font-medium"
              style={on
                ? { background: 'var(--theme-primary)', borderColor: 'var(--theme-primary)', color: '#fff' }
                : { borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
            >
              {l}
            </button>
          );
        })}
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="ml-auto rounded-lg border px-2 py-1 text-xs"
          style={inputStyle}
          aria-label="Window"
        >
          {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>

      {me && (
        <div className="rounded-2xl border px-4 py-3 text-sm font-medium" style={{ borderColor: 'var(--theme-border)', background: 'var(--theme-primary-soft, #eef2ff)', color: 'var(--theme-primary)' }}>
          You&apos;re #{me.rank} {PERIODS.find((p) => p.value === period)?.label.toLowerCase()} 🎉
        </div>
      )}

      {error && <ErrorBanner message={error} />}
      {loading ? (
        <Centered><Spinner /></Centered>
      ) : rows.length === 0 ? (
        <Empty text="Nothing on this board yet — recognitions will light it up." />
      ) : (
        <Card>
          {rows.map((r) => {
            const isMe = me && r.employeeId === me.employeeId;
            return (
              <div
                key={r.employeeId}
                className="flex items-center gap-3 border-b py-2.5 first:pt-0 last:border-0 last:pb-0"
                style={{ borderColor: 'var(--theme-border)' }}
              >
                <span className="w-8 shrink-0 text-sm font-bold" style={{ color: isMe ? 'var(--theme-primary)' : 'var(--theme-muted)' }}>
                  #{r.rank}
                </span>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                      style={{ background: 'var(--theme-primary-soft, #eef2ff)', color: 'var(--theme-primary)' }}>
                  {initialsOf(r.name)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium" style={{ color: isMe ? 'var(--theme-primary)' : 'var(--theme-text)' }}>
                  {r.name || r.code || '—'}{isMe ? ' (you)' : ''}
                </span>
                <span className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>
                  {board === 'earners' ? `${(r.points || 0).toLocaleString('en-IN')} pts` : `${(r.count || 0).toLocaleString('en-IN')} given`}
                </span>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

// ── page shell ───────────────────────────────────────────────────────────────
function RecognitionInner() {
  const [tab, setTab] = useState('wall');
  const [wallet, setWallet] = useState(null);
  const [walletError, setWalletError] = useState(null);

  const loadWallet = useCallback(() => {
    apiGet('/api/hr/me/wallet')
      .then(setWallet)
      .catch((e) => setWalletError(e));
  }, []);
  useEffect(loadWallet, [loadWallet]);
  // Refresh the balance when hopping between tabs (points may have moved).
  useEffect(() => { loadWallet(); }, [tab, loadWallet]);

  const pointsEnabled = wallet ? wallet.pointsEnabled !== false : true;

  const tabs = [
    { key: 'wall', label: 'Wall' },
    ...(pointsEnabled ? [
      { key: 'wallet', label: 'My wallet' },
      { key: 'rewards', label: 'Rewards' },
    ] : []),
    { key: 'awards', label: 'Awards' },
    { key: 'leaderboard', label: 'Leaderboard' },
  ];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>
          Recognition
          <InfoTip text="Celebrate colleagues with shout-outs tied to company values — optionally with points you can spend in the rewards store. Nominate people for company awards, too." />
        </h1>
        <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
          {pointsEnabled && wallet
            ? <>You have <span className="font-semibold" style={{ color: 'var(--theme-text)' }}>{(wallet.balance ?? 0).toLocaleString('en-IN')} points</span>{wallet.inrValue != null ? ` (≈ ₹${wallet.inrValue.toLocaleString('en-IN')})` : ''}.</>
            : 'A little appreciation goes a long way.'}
        </p>
      </header>

      {walletError && walletError.status !== 404 && (
        <ErrorBanner message={walletError.message || 'Could not load your wallet.'} />
      )}

      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Recognition sections">
        {tabs.map((t) => {
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setTab(t.key)}
              className="shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium"
              style={on
                ? { background: 'var(--theme-primary)', borderColor: 'var(--theme-primary)', color: '#fff' }
                : { borderColor: 'var(--theme-border)', color: 'var(--theme-text)', background: '#fff' }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'wall' && <WallTab pointsEnabled={pointsEnabled} />}
      {tab === 'wallet' && pointsEnabled && <WalletTab wallet={wallet} onGoRewards={() => setTab('rewards')} />}
      {tab === 'rewards' && pointsEnabled && <RewardsTab />}
      {tab === 'awards' && <AwardsTab />}
      {tab === 'leaderboard' && <LeaderboardTab />}
    </div>
  );
}

export default function RecognitionPage() {
  return (
    <AppShell>
      <RecognitionInner />
    </AppShell>
  );
}
