'use client';

// Company Directory (Cycle 1) — a searchable, paginated, tenant-wide colleague
// directory so an employee can find anyone in their company. Premium card grid +
// search (name/designation/department/work email) + department/entity filters +
// server-side pagination that scales to 1000+. Privacy-first: the backend exposes ONLY
// safe work/professional fields (name, photo, designation, department, work email, work
// phone if shared, entity/location, reporting manager) — never personal email/phone,
// address, DOB, salary, or any HR-gated field. A colleague detail drawer shows the work
// profile + reporting line + "in <department>" + a deep link to the F19 org chart rooted
// at that person. A self opt-out lets the employee hide their work phone from the grid.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import { Spinner, Centered, ErrorBanner, Empty } from '@hr/ui';
import InfoTip from '@/components/InfoTip';
import { ServerPagination } from '@/lib/pagination';
import {
  fetchDirectory, fetchDirectoryFilters, fetchColleague,
  fetchMyDirectoryPreferences, updateMyDirectoryPreferences,
} from '@/lib/api';

function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function Avatar({ name, url, size = 11 }) {
  const cls = `h-${size} w-${size}`;
  return (
    <div className={`${cls} flex shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-bold`}
         style={{ background: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : initialsOf(name)}
    </div>
  );
}

// ── self opt-out (hide my work phone) ────────────────────────────────────────
function OptOutBar() {
  const [pref, setPref] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    fetchMyDirectoryPreferences()
      .then((p) => { if (alive) setPref(p); })
      .catch(() => { if (alive) setPref({ linked: false }); });
    return () => { alive = false; };
  }, []);

  if (!pref || !pref.linked) return null;
  const hidden = !!pref.hideWorkPhone;

  async function toggle() {
    setBusy(true); setErr('');
    try {
      const r = await updateMyDirectoryPreferences({ hideWorkPhone: !hidden });
      setPref((p) => ({ ...p, hideWorkPhone: r.hideWorkPhone }));
    } catch (e) { setErr(e.message || 'Could not update your preference'); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white px-4 py-3 text-sm shadow-sm"
         style={{ borderColor: 'var(--theme-border)' }}>
      <div className="flex items-center" style={{ color: 'var(--theme-muted)' }}>
        <span>
          {pref.hasWorkPhone
            ? (hidden ? 'Your work phone is hidden from colleagues.' : 'Your work phone is visible to colleagues.')
            : 'You have no work phone on file to share.'}
        </span>
        <InfoTip text="The directory only ever shows work/professional details. Your work phone is the one optional field — turn this off to hide it. Your name, designation, department and work email always stay visible so colleagues can still find you. Personal details (personal email/phone, address, date of birth, pay) are never shown here." />
      </div>
      {pref.hasWorkPhone && (
        <button type="button" onClick={toggle} disabled={busy}
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                style={{ borderColor: 'var(--theme-primary)', color: 'var(--theme-primary)' }}>
          {hidden ? 'Show my work phone' : 'Hide my work phone'}
        </button>
      )}
      {err && <span className="text-xs" style={{ color: '#dc2626' }}>{err}</span>}
    </div>
  );
}

// ── colleague detail drawer ──────────────────────────────────────────────────
function DetailDrawer({ id, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    fetchColleague(id)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [id]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Colleague details">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <div className="relative z-50 flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: 'var(--theme-border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Colleague</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-xl leading-none" style={{ color: 'var(--theme-muted)' }} aria-label="Close">×</button>
        </div>
        <div className="p-5">
          {loading ? <Centered><Spinner /></Centered> : error ? <ErrorBanner message={error.message} /> : data ? (
            <div className="space-y-5">
              <div className="flex items-center gap-4">
                <Avatar name={data.name} url={data.photoUrl} size={16} />
                <div className="min-w-0">
                  <div className="truncate text-lg font-semibold" style={{ color: 'var(--theme-text)' }}>{data.name}</div>
                  <div className="truncate text-sm" style={{ color: 'var(--theme-muted)' }}>{data.designation || '—'}</div>
                  {data.department && <div className="truncate text-xs" style={{ color: 'var(--theme-muted)' }}>in {data.department}</div>}
                </div>
              </div>

              <dl className="grid grid-cols-1 gap-3 text-sm">
                <Field label="Work email" value={data.workEmail} href={data.workEmail ? `mailto:${data.workEmail}` : null} />
                <Field label="Work phone" value={data.workPhone} href={data.workPhone ? `tel:${data.workPhone}` : null}
                       tip="Shown only when your colleague chose to share their work phone." />
                <Field label="Department" value={data.department} />
                <Field label="Designation" value={data.designation} />
                <Field label="Entity" value={data.entity} />
                <Field label="Location" value={data.location} />
                <Field label="Reporting manager" value={data.manager ? data.manager.name : null} />
                {typeof data.reportsCount === 'number' && data.reportsCount > 0 && (
                  <Field label="Direct reports" value={String(data.reportsCount)} />
                )}
              </dl>

              {data.orgChart && data.orgChart.href && (
                <Link href={data.orgChart.href}
                      className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold"
                      style={{ borderColor: 'var(--theme-primary)', color: 'var(--theme-primary)' }}>
                  View in the org chart →
                </Link>
              )}
            </div>
          ) : <Empty text="Couldn't load this colleague." />}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, href, tip }) {
  return (
    <div>
      <dt className="flex items-center text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
        {label}{tip ? <InfoTip text={tip} /> : null}
      </dt>
      <dd className="mt-0.5 text-sm" style={{ color: 'var(--theme-text)' }}>
        {value ? (href ? <a href={href} className="underline" style={{ color: 'var(--theme-primary)' }}>{value}</a> : value) : <span style={{ color: 'var(--theme-muted)' }}>—</span>}
      </dd>
    </div>
  );
}

// ── card ─────────────────────────────────────────────────────────────────────
function ColleagueCard({ e, onOpen }) {
  return (
    <button type="button" onClick={() => onOpen(e.id)}
            className="flex w-full items-start gap-3 rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:shadow-md"
            style={{ borderColor: 'var(--theme-border)' }}>
      <Avatar name={e.name} url={e.photoUrl} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>{e.name}</div>
        <div className="truncate text-xs" style={{ color: 'var(--theme-muted)' }}>
          {e.designation || '—'}{e.department ? ` · ${e.department}` : ''}
        </div>
        {e.workEmail && <div className="mt-1 truncate text-xs" style={{ color: 'var(--theme-muted)' }}>{e.workEmail}</div>}
        <div className="mt-1 flex flex-wrap gap-x-2 text-[11px]" style={{ color: 'var(--theme-muted)' }}>
          {e.workPhone && <span>{e.workPhone}</span>}
          {e.location && <span>· {e.location}</span>}
        </div>
      </div>
    </button>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
function DirectoryInner() {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [entityId, setEntityId] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(24);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({ departments: [], entities: [] });
  const [openId, setOpenId] = useState(null);
  const tickRef = useRef(0);

  // Debounce the search box (snappy at 1000+ rows; one request per pause).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  // Reset to page 1 whenever the query or a filter changes.
  useEffect(() => { setPage(1); }, [debouncedQ, departmentId, entityId, pageSize]);

  // Filter facets (departments / entities) — load once.
  useEffect(() => {
    let alive = true;
    fetchDirectoryFilters()
      .then((f) => { if (alive) setFilters({ departments: f.departments || [], entities: f.entities || [] }); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    if (debouncedQ) p.set('q', debouncedQ);
    if (departmentId) p.set('departmentId', departmentId);
    if (entityId) p.set('entityId', entityId);
    return `?${p.toString()}`;
  }, [page, pageSize, debouncedQ, departmentId, entityId]);

  const load = useCallback(async () => {
    const myTick = ++tickRef.current;
    setLoading(true); setError(null);
    try {
      const body = await fetchDirectory(queryString);
      if (myTick !== tickRef.current) return;
      setData(body);
    } catch (e) {
      if (myTick !== tickRef.current) return;
      setError(e);
    } finally {
      if (myTick === tickRef.current) setLoading(false);
    }
  }, [queryString]);

  useEffect(() => { load(); }, [load]);

  const items = data?.items || [];

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="flex items-center text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>
          Company Directory
          <InfoTip text="Find anyone in your company. The directory shows work details only — name, photo, designation, department, work email, work phone (if shared), entity/location and reporting manager. Personal details are never shown here." />
        </h1>
        <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>Search colleagues across your organisation.</p>
      </div>

      <OptOutBar />

      {/* search + filters */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, designation, department or work email…"
          aria-label="Search colleagues"
          className="w-full rounded-lg border px-3 py-2 text-sm sm:max-w-md"
          style={{ borderColor: 'var(--theme-border)' }}
        />
        {filters.departments.length > 0 && (
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}
                  aria-label="Filter by department"
                  className="rounded-lg border bg-white px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)' }}>
            <option value="">All departments</option>
            {filters.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
        {filters.entities.length > 1 && (
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)}
                  aria-label="Filter by entity"
                  className="rounded-lg border bg-white px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)' }}>
            <option value="">All entities</option>
            {filters.entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
        )}
      </div>

      {loading && !data ? (
        <Centered><Spinner /></Centered>
      ) : error ? (
        <ErrorBanner message={error.message} />
      ) : items.length === 0 ? (
        <Empty text={debouncedQ || departmentId || entityId ? 'No colleagues match your search.' : 'No colleagues to show yet.'} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((e) => <ColleagueCard key={e.id} e={e} onOpen={setOpenId} />)}
          </div>
          <ServerPagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            sizes={[12, 24, 48]}
            noun="colleagues"
          />
        </>
      )}

      {openId && <DetailDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

export default function DirectoryPage() {
  return <AppShell><DirectoryInner /></AppShell>;
}
