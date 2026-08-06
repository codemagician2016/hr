'use client';

// Recruitment job detail (Feature 12). Tabs:
//   - Pipeline: a Kanban-ish board of applications by stage, with the screening
//     score badge + a red KO chip; quick stage-move actions; links to the
//     candidate profile.
//   - Screening: the screening-question builder (typed questions; choice/
//     qualification options carry POINTS; tick Knockout to auto-reject).
//   - Scorecard: pick the default interview scorecard template for this job.
//   - Merit list: candidates ranked by combined application + interview score,
//     with a "Why this rank?" drawer printing the exact formula + every line.
// Every field has an ⓘ tooltip; lists are paginated. Server is the RBAC boundary.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ErrorBanner, PrimaryButton, TextInput, TextArea, Modal, ModalActions, Spinner } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { asList, PageHeader, Tabs, ActionButton } from '@/lib/ui';
import { Info, FieldLabel, ScoreBadge, Pager, NumberInput, StatusPill, CopyField, Check, StatCard, FunnelChart, ChannelChips, renderMergePreview } from '../../_components';

const TABS = [
  { key: 'summary', label: 'Summary' },
  { key: 'pipeline', label: 'Candidates' },
  { key: 'screening', label: 'Screening questions' },
  { key: 'scorecard', label: 'Interview scorecard' },
  { key: 'merit', label: 'Merit list' },
  { key: 'share', label: 'Share & careers' },
];

export default function JobDetailPage() {
  const { id } = useParams();
  const [job, setJob] = useState(null);
  const [tab, setTab] = useState('summary');
  const [error, setError] = useState('');

  const loadJob = useCallback(async () => {
    try { setJob(await get(`/api/hr/recruitment/jobs/${id}`)); }
    catch (e) { setError(e.message); }
  }, [id]);
  useEffect(() => { loadJob(); }, [loadJob]);

  if (!job) return <div className="p-6">{error ? <ErrorBanner message={error} /> : <Spinner />}</div>;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Link href="/recruitment" className="text-xs text-gray-500 hover:underline">← All jobs</Link>
      <PageHeader
        title={job.title}
        subtitle={`${job.code} · ${job.countryCode} · ${job.openings} opening${job.openings === 1 ? '' : 's'}`}
        actions={<div className="flex items-center gap-2">{job.isPublic && job.publicLink?.live && <span className="text-[11px] font-semibold text-emerald-600">● Live on careers</span>}<StatusPill status={job.status} /></div>}
      />
      {error && <ErrorBanner message={error} />}
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'summary' && <SummaryTab jobId={id} onJobChanged={loadJob} onGoShare={() => setTab('share')} />}
      {tab === 'pipeline' && <PipelineTab jobId={id} />}
      {tab === 'screening' && <ScreeningTab jobId={id} />}
      {tab === 'scorecard' && <ScorecardTab job={job} onSaved={loadJob} />}
      {tab === 'merit' && <MeritTab jobId={id} />}
      {tab === 'share' && <ShareTab job={job} onSaved={loadJob} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Summary tab — the at-a-glance hire funnel + time-to-fill + close action
// ══════════════════════════════════════════════════════════════════════════
function SummaryTab({ jobId, onJobChanged, onGoShare }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [showClose, setShowClose] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try { setData(await get(`/api/hr/recruitment/jobs/${jobId}/summary`)); }
    catch (e) { setError(e.message); }
  }, [jobId]);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <ErrorBanner message={error} /> : <Spinner />;
  const { job, totals, funnel, timeToFill } = data;
  const ttf = timeToFill.days;
  const isClosable = job.status === 'OPEN' || job.status === 'ON_HOLD';

  return (
    <div className="space-y-6">
      {error && <ErrorBanner message={error} />}

      {/* Headline stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total applicants" value={totals.total} tone="accent" hint="Everyone who has applied to this role." />
        <StatCard label="In progress" value={totals.waiting} sub="not yet hired / rejected" hint="Active candidates still moving through the pipeline." />
        <StatCard label="Offers accepted" value={totals.hired} tone="good" sub={`of ${job.openings} opening${job.openings === 1 ? '' : 's'}`} />
        <StatCard
          label="Time to fill" value={ttf != null ? `${ttf}d` : '—'}
          tone={timeToFill.filled ? 'good' : 'default'}
          sub={timeToFill.filled ? 'first hire accepted' : 'open so far'}
          hint="Days from when the role opened to the first accepted offer (or to today if still open)."
        />
      </div>

      {/* Funnel */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-900">Hiring funnel
            <Info text="How candidates flow from applied → screened → shortlisted → interview → offer → accepted. The % shows conversion from the previous stage." />
          </h2>
          <span className="text-xs text-gray-400">{totals.offerSent} offer{totals.offerSent === 1 ? '' : 's'} sent</span>
        </div>
        <FunnelChart steps={funnel} />
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="inline-flex items-center rounded-full border border-red-100 bg-red-50 text-red-700 px-2.5 py-1">Rejected {totals.rejected}</span>
          <span className="inline-flex items-center rounded-full border border-amber-100 bg-amber-50 text-amber-700 px-2.5 py-1">Knocked out {totals.knockedOut}</span>
          <span className="inline-flex items-center rounded-full border border-yellow-100 bg-yellow-50 text-yellow-700 px-2.5 py-1">On hold {totals.onHold}</span>
          <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 text-gray-500 px-2.5 py-1">Withdrawn {totals.withdrawn}</span>
        </div>
      </section>

      {/* Status + careers + close */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-gray-900 flex items-center gap-2">Requisition status <StatusPill status={job.status} /></div>
            <div className="text-xs text-gray-500 mt-1">
              Opened {job.openedAt ? new Date(job.openedAt).toLocaleDateString() : '—'}
              {job.closedAt && ` · Closed ${new Date(job.closedAt).toLocaleDateString()}`}
              {job.closeReason && ` · ${job.closeReason}`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {job.isPublic && job.publicLink?.live
              ? <button onClick={onGoShare} className="text-sm px-3 py-2 rounded-lg border border-emerald-300 text-emerald-700 hover:bg-emerald-50">● Live — Share link</button>
              : <button onClick={onGoShare} className="text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--theme-primary)', color: 'var(--theme-primary)' }}>Share / publish</button>}
            {isClosable && <ActionButton tone="danger" onClick={() => setShowClose(true)}>Close job</ActionButton>}
          </div>
        </div>
      </section>

      {showClose && <CloseJobModal jobId={jobId} onClose={() => setShowClose(false)} onClosed={() => { setShowClose(false); load(); onJobChanged && onJobChanged(); }} />}
    </div>
  );
}

const CLOSE_REASONS = [
  { v: 'FILLED', label: 'Filled — all openings met', outcome: 'FILLED' },
  { v: 'CANCELLED', label: 'Cancelled — no longer hiring', outcome: 'CANCELLED' },
  { v: 'BUDGET', label: 'Budget frozen / on hold indefinitely', outcome: 'CANCELLED' },
  { v: 'OTHER', label: 'Other', outcome: 'CANCELLED' },
];

function CloseJobModal({ jobId, onClose, onClosed }) {
  const [reason, setReason] = useState('FILLED');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const chosen = CLOSE_REASONS.find((r) => r.v === reason) || CLOSE_REASONS[0];

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    const label = chosen.label;
    const reasonText = note.trim() ? `${label} — ${note.trim()}` : label;
    try {
      await post(`/api/hr/recruitment/jobs/${jobId}/close`, { outcome: chosen.outcome, reason: reasonText });
      onClosed();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  return (
    <Modal title="Close this job" onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={save} className="space-y-4">
        <p className="text-xs text-gray-500">Closing stops new public applications. A <b>Filled</b> close marks the requisition FILLED; everything else marks it CLOSED. The reason is recorded for the audit trail.</p>
        <div>
          <FieldLabel hint="Why the requisition is being closed. Filled = you've hired enough; Cancelled = the role is dropped.">Reason</FieldLabel>
          <select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {CLOSE_REASONS.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel hint="Optional free-text note added to the recorded reason.">Note (optional)</FieldLabel>
          <TextInput value={note} onChange={(v) => setNote(v)} placeholder="e.g. headcount moved to Q3" />
        </div>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-600">Cancel</button>
          <PrimaryButton type="submit" disabled={saving}>{saving ? 'Closing…' : 'Close job'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ── Candidates / pipeline — filters + bulk-select + a clean ranked list ───────
const STATUS_OPTIONS = ['APPLIED', 'SCREENING', 'INTERVIEWING', 'ASSESSMENT', 'OFFERED', 'HIRED', 'REJECTED', 'WITHDRAWN', 'ON_HOLD'];
const SOURCE_OPTIONS = ['PUBLIC', 'REFERRAL', 'AGENCY', 'MANUAL', 'IMPORT'];
const EMPTY_FILTERS = { status: '', stageId: '', source: '', knockout: '', minScore: '', maxScore: '', skill: '', from: '', to: '' };

function PipelineTab({ jobId }) {
  const [stages, setStages] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('merit');
  const [selected, setSelected] = useState(() => new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false); // "all within the filter"
  const [bulkBusy, setBulkBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [showBulkMessage, setShowBulkMessage] = useState(false);
  const [showApply, setShowApply] = useState(false);
  const pageSize = 50;

  const queryParams = useMemo(() => {
    const q = { jobId, page, pageSize, sort };
    for (const [k, v] of Object.entries(filters)) if (v !== '' && v != null) q[k] = v;
    return q;
  }, [jobId, page, sort, filters]);

  const loadStages = useCallback(async () => {
    try { setStages(asList(await get(`/api/hr/recruitment/jobs/${jobId}/stages`))); } catch { /* non-fatal */ }
  }, [jobId]);
  useEffect(() => { loadStages(); }, [loadStages]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await get('/api/hr/recruitment/applications', queryParams)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [queryParams]);
  useEffect(() => { load(); }, [load]);

  // a filter / page change resets the selection (the visible set changed).
  useEffect(() => { setSelected(new Set()); setSelectAllMatching(false); }, [queryParams]);

  const apps = data ? data.items : [];
  const total = data ? data.pagination.total : 0;
  const totalPages = data ? data.pagination.totalPages : 1;
  const sortedStages = [...stages].sort((a, b) => a.sortOrder - b.sortOrder);

  const activeFilterCount = Object.values(filters).filter((v) => v !== '' && v != null).length;
  const setFilter = (k) => (v) => { setFilters((s) => ({ ...s, [k]: v })); setPage(1); };
  const resetFilters = () => { setFilters(EMPTY_FILTERS); setPage(1); };

  // selection helpers
  const allOnPageSelected = apps.length > 0 && apps.every((a) => selected.has(a.id));
  const someOnPageSelected = apps.some((a) => selected.has(a.id));
  function togglePageAll(on) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const a of apps) { if (on) next.add(a.id); else next.delete(a.id); }
      return next;
    });
    if (!on) setSelectAllMatching(false);
  }
  function toggleOne(id, on) {
    setSelected((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });
    if (!on) setSelectAllMatching(false);
  }
  const selectionCount = selectAllMatching ? total : selected.size;

  async function runBulk(action, extra = {}) {
    setBulkBusy(true); setError(''); setNotice('');
    try {
      // "all within the filter" → server resolves the whole filtered set (never the
      // page only). Otherwise send the explicit, in-scope id allow-list.
      const filterPayload = { jobId };
      for (const [k, v] of Object.entries(filters)) if (v !== '' && v != null) filterPayload[k] = v;
      const body = selectAllMatching
        ? { action, filter: filterPayload, ...extra }
        : { action, filter: { jobId }, ids: [...selected], ...extra };
      const res = await post('/api/hr/recruitment/applications/bulk-action', body);
      setNotice(`${res.changed} candidate${res.changed === 1 ? '' : 's'} updated${res.skipped ? ` · ${res.skipped} skipped` : ''}.`);
      setSelected(new Set()); setSelectAllMatching(false);
      load();
    } catch (e) { setError(e.message); }
    finally { setBulkBusy(false); }
  }

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      {notice && <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {/* Pipeline stages — the ordered stages this job's candidates flow through,
          with a one-click "Apply template" to materialise a reusable pipeline. */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm mb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center text-sm font-semibold text-gray-900">
              Pipeline stages
              <Info text="The ordered stages candidates move through on this job. Apply a saved pipeline template to set them all up in one click." />
            </div>
            {sortedStages.length === 0 ? (
              <p className="text-xs text-gray-500 mt-1">No stages yet — apply a template to build this job&apos;s pipeline.</p>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {sortedStages.map((s, i) => (
                  <span key={s.id} className="inline-flex items-center gap-1">
                    {i > 0 && <span className="text-gray-300">→</span>}
                    <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-600">{s.name}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
          <ActionButton onClick={() => setShowApply(true)}>Apply template</ActionButton>
        </div>
      </div>

      {/* Filter bar */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm mb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <FieldLabel hint="Search by candidate name or email.">Search</FieldLabel>
            <TextInput value={filters.skill} onChange={(v) => setFilter('skill')(v)} placeholder="name or email" />
          </div>
          <div>
            <FieldLabel hint="Filter to one application status.">Status</FieldLabel>
            <select value={filters.status} onChange={(e) => setFilter('status')(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="">Any status</option>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel hint="Filter to one pipeline stage.">Stage</FieldLabel>
            <select value={filters.stageId} onChange={(e) => setFilter('stageId')(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="">Any stage</option>
              {sortedStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel hint="Where the application came from.">Source</FieldLabel>
            <select value={filters.source} onChange={(e) => setFilter('source')(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="">Any source</option>
              {SOURCE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel hint="Hide or isolate candidates who failed a knockout question.">Knockout</FieldLabel>
            <select value={filters.knockout} onChange={(e) => setFilter('knockout')(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="">All</option>
              <option value="false">Passed knockouts</option>
              <option value="true">Knocked out</option>
            </select>
          </div>
          <div>
            <FieldLabel hint="Minimum merit score (0–100).">Min merit</FieldLabel>
            <NumberInput value={filters.minScore} onChange={setFilter('minScore')} min={0} max={100} />
          </div>
          <div>
            <FieldLabel hint="Maximum merit score (0–100).">Max merit</FieldLabel>
            <NumberInput value={filters.maxScore} onChange={setFilter('maxScore')} min={0} max={100} />
          </div>
          <div>
            <FieldLabel hint="How to order the list.">Sort</FieldLabel>
            <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="merit">Merit (high → low)</option>
              <option value="recent">Most recent</option>
            </select>
          </div>
        </div>
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-gray-500">{total} candidate{total === 1 ? '' : 's'}{activeFilterCount ? ` · ${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} applied` : ''}</span>
          {activeFilterCount > 0 && <button type="button" onClick={resetFilters} className="text-xs text-gray-500 hover:underline">Clear filters</button>}
        </div>
      </div>

      {/* Bulk action bar (sticky-feel) — appears once anything is selected */}
      {selectionCount > 0 && (
        <div className="rounded-xl border-2 border-dashed mb-3 px-4 py-3 flex flex-wrap items-center gap-3" style={{ borderColor: 'var(--theme-primary)', background: 'color-mix(in srgb, var(--theme-primary) 6%, white)' }}>
          <span className="text-sm font-medium text-gray-800">{selectionCount} selected</span>
          {/* offer "select all matching" once a whole page is ticked and more rows exist */}
          {!selectAllMatching && allOnPageSelected && total > apps.length && (
            <button type="button" onClick={() => setSelectAllMatching(true)} className="text-xs font-medium hover:underline" style={{ color: 'var(--theme-primary)' }}>
              Select all {total} matching the filter
            </button>
          )}
          {selectAllMatching && (
            <button type="button" onClick={() => { setSelectAllMatching(false); setSelected(new Set()); }} className="text-xs text-gray-500 hover:underline">Clear selection</button>
          )}
          <div className="flex-1" />
          <button disabled={bulkBusy} onClick={() => setShowBulkMessage(true)} className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">Message {selectionCount}</button>
          <button disabled={bulkBusy} onClick={() => runBulk('shortlist')} className="text-sm px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">Shortlist</button>
          <BulkStatusButton disabled={bulkBusy} onPick={(status) => runBulk('set-status', { status })} />
          <button disabled={bulkBusy} onClick={() => { if (confirm(`Reject ${selectionCount} candidate${selectionCount === 1 ? '' : 's'}?`)) runBulk('reject', { reason: 'Bulk reject' }); }} className="text-sm px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50">Reject</button>
        </div>
      )}

      {/* List */}
      {loading ? <Spinner /> : (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-100">
                <th className="px-4 py-3 w-10"><Check checked={allOnPageSelected} indeterminate={someOnPageSelected} onChange={togglePageAll} label="Select all on page" /></th>
                <th className="px-4 py-3">Candidate</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Application</th>
                <th className="px-4 py-3">Merit</th>
              </tr>
            </thead>
            <tbody>
              {apps.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">No candidates match these filters.</td></tr>}
              {apps.map((a) => {
                const checked = selectAllMatching || selected.has(a.id);
                return (
                  <tr key={a.id} className={`border-b border-gray-50 last:border-0 ${checked ? 'bg-indigo-50/40' : 'hover:bg-gray-50'}`}>
                    <td className="px-4 py-3"><Check checked={checked} onChange={(on) => toggleOne(a.id, on)} label="Select candidate" /></td>
                    <td className="px-4 py-3">
                      <Link href={`/recruitment/applications/${a.id}`} className="font-medium text-gray-900 hover:underline">
                        {a.candidate ? `${a.candidate.firstName} ${a.candidate.lastName}` : (a.candidateId || 'Candidate').slice(0, 8)}
                      </Link>
                      {a.candidate?.email && <div className="text-[11px] text-gray-400">{a.candidate.email}</div>}
                    </td>
                    <td className="px-4 py-3"><StatusPill status={a.status} /></td>
                    <td className="px-4 py-3 text-xs text-gray-500">{a.appliedSource || 'MANUAL'}</td>
                    <td className="px-4 py-3"><ScoreBadge score={a.screeningScore} max={a.screeningMaxScore} knockedOut={a.knockedOut} /></td>
                    <td className="px-4 py-3 font-semibold tabular-nums" style={{ color: 'var(--theme-primary)' }}>{a.meritScore != null ? Number(a.meritScore) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} totalPages={totalPages} total={total} onPage={setPage} />

      {showBulkMessage && (
        <BulkMessageModal
          jobId={jobId}
          count={selectionCount}
          // Resolve the SAME server-side target set as the bulk actions: "all
          // matching" sends the whole filtered set; otherwise the explicit ids.
          payload={selectAllMatching
            ? { filter: (() => { const f = { jobId }; for (const [k, v] of Object.entries(filters)) if (v !== '' && v != null) f[k] = v; return f; })() }
            : { filter: { jobId }, ids: [...selected] }}
          onClose={() => setShowBulkMessage(false)}
          onSent={(res) => {
            setShowBulkMessage(false);
            setNotice(`Message: ${res.sent} sent · ${res.skipped} skipped · ${res.total} targeted.`);
            setSelected(new Set()); setSelectAllMatching(false);
          }}
        />
      )}

      {showApply && (
        <ApplyTemplateModal
          jobId={jobId}
          hasStages={stages.length > 0}
          onClose={() => setShowApply(false)}
          onApplied={(res) => {
            setShowApply(false);
            setNotice(`Applied ${res.stages?.length ?? 0} stage${(res.stages?.length ?? 0) === 1 ? '' : 's'}${res.replaced ? ' (replaced the previous pipeline)' : ''}.`);
            loadStages();
            load();
          }}
        />
      )}
    </div>
  );
}

// Apply a saved pipeline template's stages onto this job. Append-if-empty; a job
// that already has stages needs ?replace=true, allowed ONLY while it has no
// candidates (else the server returns 409 STAGES_IN_USE — surfaced verbatim).
function ApplyTemplateModal({ jobId, hasStages, onClose, onApplied }) {
  const [templates, setTemplates] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [appCount, setAppCount] = useState(null); // candidate count → replace safety
  const [needsReplace, setNeedsReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/api/hr/recruitment/pipeline-templates')
      .then((r) => setTemplates(asList(r)))
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load templates.'));
    // Candidate count decides whether replacing an existing pipeline is possible.
    get('/api/hr/recruitment/applications', { jobId, page: 1, pageSize: 1 })
      .then((r) => setAppCount(r?.pagination?.total ?? 0))
      .catch(() => setAppCount(null));
  }, [jobId]);

  const replaceSafe = appCount === 0; // no candidates → replacing is allowed

  async function apply(replace) {
    if (!selectedId) { setError('Pick a template to apply.'); return; }
    setBusy(true); setError('');
    try {
      const res = await post(`/api/hr/recruitment/pipeline-templates/${selectedId}/apply${replace ? '?replace=true' : ''}`, { jobId });
      onApplied(res);
    } catch (e) {
      if (e.data?.code === 'STAGES_EXIST') {
        // Job already has a pipeline — offer a replace only when it is safe.
        setNeedsReplace(true);
        if (!replaceSafe) setError(e.data?.message || 'This job already has pipeline stages.');
      } else {
        // STAGES_IN_USE and any other 4xx — surface verbatim.
        setError(e.data?.message || e.message || 'Failed to apply the template.');
      }
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Apply pipeline template" size="lg" onClose={onClose}>
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}

        {hasStages && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            This job already has pipeline stages. Applying a template will {replaceSafe
              ? 'replace them — allowed because there are no candidates yet.'
              : 'be refused: replacing is only possible while the job has no candidates.'}
          </p>
        )}

        {templates === null ? (
          <div className="py-8 flex justify-center"><Spinner /></div>
        ) : templates.length === 0 ? (
          <p className="text-sm text-gray-500">No pipeline templates yet. Create some under Settings → Pipeline templates.</p>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {templates.map((t) => {
              const ordered = (t.stages || []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
              const on = selectedId === t.id;
              return (
                <label key={t.id} className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer ${on ? 'bg-gray-50' : 'border-gray-200'}`} style={on ? { borderColor: 'var(--theme-primary)' } : undefined}>
                  <input type="radio" name="applyTemplate" value={t.id} checked={on} onChange={() => { setSelectedId(t.id); setNeedsReplace(false); setError(''); }} className="mt-1" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{t.name}</span>
                      {t.isDefault && <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Default</span>}
                    </span>
                    {t.description && <span className="block text-xs text-gray-500">{t.description}</span>}
                    <span className="mt-1 flex flex-wrap items-center gap-1">
                      {ordered.map((s, i) => (
                        <span key={s.id || i} className="inline-flex items-center gap-1">
                          {i > 0 && <span className="text-gray-300">→</span>}
                          <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-600">{s.name}</span>
                        </span>
                      ))}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}

        <ModalActions>
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">Cancel</button>
          {needsReplace && replaceSafe ? (
            <PrimaryButton loading={busy} onClick={() => apply(true)}>Replace existing stages</PrimaryButton>
          ) : (
            <PrimaryButton
              loading={busy}
              disabled={!selectedId || (hasStages && !replaceSafe)}
              onClick={() => apply(hasStages && replaceSafe)}
            >
              {hasStages && replaceSafe ? 'Replace with template' : 'Apply template'}
            </PrimaryButton>
          )}
        </ModalActions>
      </div>
    </Modal>
  );
}

// Bulk candidate-message modal — pick a candidate-facing template, confirm the
// count, and send to the current filtered/scoped set (POST /applications/
// bulk-message; the server re-resolves the target set so we can never message
// out of scope). Reject copy is opt-in — HR sees the count before confirming.
const BULK_CAND_KEYS = new Set([
  'HR_CAND_APPLIED', 'HR_CAND_SHORTLISTED', 'HR_CAND_INTERVIEW_INVITE',
  'HR_CAND_SLOT_REQUEST', 'HR_CAND_REJECTED', 'HR_CAND_OFFER',
]);

function BulkMessageModal({ jobId, count, payload, onClose, onSent }) {
  const [templates, setTemplates] = useState([]);
  const [selKey, setSelKey] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/api/hr/recruitment/comms-templates')
      .then((r) => {
        const items = (r?.items || []).filter((t) => BULK_CAND_KEYS.has(t.key));
        setTemplates(items);
        if (items[0]) setSelKey(items[0].key);
      })
      .catch((e) => setError(e.data?.message || e.message || 'Could not load message templates.'));
  }, []);

  const tpl = templates.find((t) => t.key === selKey) || null;
  const body = tpl ? (tpl.overrideBody || tpl.defaultBody || '') : '';
  const preview = renderMergePreview(body, { NAME: 'Alex Candidate', ROLE: 'this role', BIZ: 'your company' });
  const isReject = selKey === 'HR_CAND_REJECTED';

  async function send() {
    if (!tpl) return;
    setSending(true); setError('');
    try {
      const res = await post('/api/hr/recruitment/applications/bulk-message', { ...payload, templateKey: tpl.key });
      onSent(res);
    } catch (e) { setError(e.data?.message || e.message || 'Could not send the messages.'); }
    finally { setSending(false); }
  }

  return (
    <Modal title={`Message ${count} candidate${count === 1 ? '' : 's'}`} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <div className="space-y-4">
        <div>
          <FieldLabel hint="The candidate-facing message. Edit the copy under Settings → Candidate messages.">Template</FieldLabel>
          <select value={selKey} onChange={(e) => setSelKey(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {templates.length === 0 && <option value="">Loading…</option>}
            {templates.map((t) => <option key={t.key} value={t.key}>{t.displayName}{t.overridden ? ' (customised)' : ''}</option>)}
          </select>
        </div>
        {tpl && (
          <>
            <div className="flex items-center gap-2 text-xs text-gray-500"><span>Sends via:</span><ChannelChips channels={tpl.channels} /></div>
            <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-indigo-50/60 to-white p-3 text-sm text-gray-700">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">Preview <span className="normal-case font-normal">— sample values shown</span></p>
              <p className="whitespace-pre-wrap">{preview}</p>
            </div>
          </>
        )}
        {isReject && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            This tells {count} candidate{count === 1 ? '' : 's'} they weren’t selected. Please confirm the count before sending.
          </div>
        )}
        <ModalActions>
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-600">Cancel</button>
          <PrimaryButton type="button" onClick={send} disabled={sending || !tpl}>{sending ? 'Sending…' : `Send to ${count}`}</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

// Bulk "change status" dropdown button.
function BulkStatusButton({ onPick, disabled }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button disabled={disabled} onClick={() => setOpen((v) => !v)} className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">Change status ▾</button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-gray-200 bg-white shadow-lg py-1">
          {STATUS_OPTIONS.map((s) => (
            <button key={s} type="button" onClick={() => { setOpen(false); onPick(s); }} className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">{s.replace(/_/g, ' ')}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Screening questions builder ─────────────────────────────────────────────
const SCREENING_KINDS = [
  { v: 'SINGLE_CHOICE', label: 'Single choice' },
  { v: 'MULTI_CHOICE', label: 'Multiple choice' },
  { v: 'BOOLEAN', label: 'Yes / No' },
  { v: 'QUALIFICATION', label: 'Qualification (degree points)' },
  { v: 'NUMBER', label: 'Number' },
  { v: 'TEXT', label: 'Free text' },
];

// Apply a saved screening-form template's questions onto this job in one click.
// Appends when the job has no screening questions; if it already has some the
// server returns 409 QUESTIONS_EXIST → we confirm and retry with replace:true.
// On success the parent reloads so the applied set shows (still individually
// editable below). Templates are authored under Recruitment → Form templates.
function ApplyFormTemplateBar({ jobId, onApplied }) {
  const [templates, setTemplates] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    get('/api/hr/recruitment/screening-form-templates')
      .then((r) => {
        const items = asList(r);
        setTemplates(items);
        const def = items.find((t) => t.isDefault);
        setSelectedId(def ? def.id : (items[0] ? items[0].id : ''));
      })
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load form templates.'));
  }, []);

  async function apply() {
    if (!selectedId) { setError('Pick a form template to apply.'); return; }
    setBusy(true); setError(''); setNotice('');
    const call = (replace) => post(`/api/hr/recruitment/jobs/${jobId}/apply-screening-template`, { templateId: selectedId, ...(replace ? { replace: true } : {}) });
    try {
      let res;
      try {
        res = await call(false);
      } catch (e) {
        if (e.data?.code === 'QUESTIONS_EXIST') {
          if (!window.confirm('This job already has screening questions — replace them with the template?')) { setBusy(false); return; }
          res = await call(true);
        } else { throw e; }
      }
      const n = res?.questions?.length ?? 0;
      setNotice(`Applied ${n} question${n === 1 ? '' : 's'}${res?.replaced ? ' (replaced the previous set)' : ''}.`);
      onApplied && onApplied();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to apply the template.');
    } finally {
      setBusy(false);
    }
  }

  const chosen = (templates || []).find((t) => t.id === selectedId);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm mb-4">
      {error && <ErrorBanner message={error} />}
      {notice && <div className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center text-sm font-semibold text-gray-900">
            Apply a form template
            <Info text="Populate this job's screening questions from a reusable template in one click. The questions remain individually editable below." />
          </div>
          {templates === null ? (
            <p className="text-xs text-gray-500 mt-1">Loading templates…</p>
          ) : templates.length === 0 ? (
            <p className="text-xs text-gray-500 mt-1">No form templates yet. Create some under Recruitment → Form templates.</p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white min-w-[16rem]">
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' (default)' : ''} · {(t.questions || []).length} Q</option>)}
              </select>
              {chosen?.description && <span className="text-xs text-gray-400 truncate max-w-xs">{chosen.description}</span>}
            </div>
          )}
        </div>
        {templates && templates.length > 0 && (
          <PrimaryButton onClick={apply} disabled={busy || !selectedId}>{busy ? 'Applying…' : 'Apply'}</PrimaryButton>
        )}
      </div>
    </div>
  );
}

function ScreeningTab({ jobId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRows(asList(await get(`/api/hr/recruitment/jobs/${jobId}/screening-questions`))); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [jobId]);
  useEffect(() => { load(); }, [load]);

  async function remove(id) {
    if (!confirm('Delete this question?')) return;
    try { await del(`/api/hr/recruitment/screening-questions/${id}`); load(); }
    catch (e) { setError(e.message); }
  }

  if (loading) return <Spinner />;
  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <p className="text-sm text-gray-500 mb-3">
        Questions a candidate answers when they apply. Choice/qualification answers carry <b>points</b> (e.g. Master's → 6, CS engineering → 20).
        Tick <b>Knockout</b> to auto-reject a wrong answer. These auto-score the application — no manual marking.
      </p>
      <ApplyFormTemplateBar jobId={jobId} onApplied={load} />
      <div className="flex justify-end mb-3">
        <PrimaryButton onClick={() => setEditing({ prompt: '', kind: 'SINGLE_CHOICE', required: true, isKnockout: false, options: [{ label: '', value: '', points: 0 }] })}>Add question</PrimaryButton>
      </div>
      <div className="space-y-3">
        {rows.length === 0 && <div className="text-sm text-gray-400 border border-dashed rounded-xl p-6 text-center">No screening questions yet.</div>}
        {rows.map((q) => (
          <div key={q.id} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm font-medium text-gray-900">{q.prompt}
                  {q.isKnockout && <span className="ml-2 inline-flex items-center rounded-full border border-red-200 bg-red-50 text-red-700 px-2 py-0.5 text-[10px] font-semibold">KNOCKOUT</span>}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">{SCREENING_KINDS.find((k) => k.v === q.kind)?.label || q.kind}</div>
                {(q.options || []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {q.options.map((o) => (
                      <span key={o.id} className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{o.label} <b>+{Number(o.points)}</b></span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <ActionButton onClick={() => setEditing(q)}>Edit</ActionButton>
                <ActionButton tone="danger" onClick={() => remove(q.id)}>Delete</ActionButton>
              </div>
            </div>
          </div>
        ))}
      </div>
      {editing && <QuestionModal jobId={jobId} question={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function QuestionModal({ jobId, question, onClose, onSaved }) {
  const [prompt, setPrompt] = useState(question.prompt || '');
  const [kind, setKind] = useState(question.kind || 'SINGLE_CHOICE');
  const [isKnockout, setIsKnockout] = useState(!!question.isKnockout);
  const [knockoutValue, setKnockoutValue] = useState(Array.isArray(question.knockoutValue) ? question.knockoutValue.join(',') : (question.knockoutValue ?? ''));
  const [options, setOptions] = useState(question.options && question.options.length ? question.options.map((o) => ({ ...o })) : [{ label: '', value: '', points: 0 }]);
  const [maxPoints, setMaxPoints] = useState(question.maxPoints ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isEdit = !!question.id;
  const hasOptions = ['SINGLE_CHOICE', 'MULTI_CHOICE', 'QUALIFICATION', 'BOOLEAN'].includes(kind);

  const setOpt = (i, k, v) => setOptions((arr) => arr.map((o, j) => (j === i ? { ...o, [k]: v } : o)));
  const addOpt = () => setOptions((arr) => [...arr, { label: '', value: '', points: 0 }]);
  const removeOpt = (i) => setOptions((arr) => arr.filter((_, j) => j !== i));

  async function save(e) {
    e.preventDefault();
    if (!prompt.trim()) { setError('Enter the question prompt.'); return; }
    setSaving(true); setError('');
    const payload = {
      prompt, kind, isKnockout, required: true,
      maxPoints: kind === 'NUMBER' && maxPoints !== '' ? Number(maxPoints) : undefined,
      knockoutValue: isKnockout ? parseKnockout(kind, knockoutValue) : undefined,
      options: hasOptions ? options.filter((o) => o.label.trim()).map((o, i) => ({ label: o.label, value: o.value || o.label, points: Number(o.points) || 0, sortOrder: i })) : [],
    };
    try {
      if (isEdit) await patch(`/api/hr/recruitment/screening-questions/${question.id}`, payload);
      else await post(`/api/hr/recruitment/jobs/${jobId}/screening-questions`, payload);
      onSaved();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={isEdit ? 'Edit screening question' : 'Add screening question'} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={save} className="space-y-4">
        <div>
          <FieldLabel hint="The question the candidate answers, e.g. 'Do you have a Computer Science engineering degree?'">Question</FieldLabel>
          <TextInput value={prompt} onChange={(v) => setPrompt(v)} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel hint="The answer type. Single/Multiple choice and Qualification carry points per option; Yes/No is a simple boolean (great for knockouts).">Answer type</FieldLabel>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {SCREENING_KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}
            </select>
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={isKnockout} onChange={(e) => setIsKnockout(e.target.checked)} />
              Knockout question
              <Info text="A knockout auto-rejects the candidate if they don't give a passing answer (e.g. 'Must be eligible to work in India → Yes'). Their merit drops to 0 but they stay visible." />
            </label>
          </div>
        </div>

        {isKnockout && (
          <div>
            <FieldLabel hint="The passing value(s). For Yes/No use 'true'. For choices, the option value(s) that pass — comma-separate multiple.">Passing answer(s)</FieldLabel>
            <TextInput value={knockoutValue} onChange={(v) => setKnockoutValue(v)} placeholder={kind === 'BOOLEAN' ? 'true' : 'e.g. yes'} />
          </div>
        )}

        {kind === 'NUMBER' && (
          <div>
            <FieldLabel hint="Cap the points a numeric answer can earn.">Max points</FieldLabel>
            <NumberInput value={maxPoints} onChange={setMaxPoints} min={0} />
          </div>
        )}

        {hasOptions && (
          <div>
            <div className="text-sm font-medium text-gray-900 mb-2">Options + points
              <Info text="Each answer option and the points it earns. e.g. 'Master's → 6', 'Bachelor's → 4', 'B.Tech CS → 20'. The application score sums these." />
            </div>
            <div className="space-y-2">
              {options.map((o, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-7"><TextInput value={o.label} placeholder={`Option ${i + 1}`} onChange={(v) => setOpt(i, 'label', v)} /></div>
                  <div className="col-span-3"><NumberInput value={o.points} onChange={(v) => setOpt(i, 'points', v)} min={0} /></div>
                  <div className="col-span-2 text-right"><button type="button" onClick={() => removeOpt(i)} disabled={options.length === 1} className="text-xs text-red-600 hover:underline">Remove</button></div>
                </div>
              ))}
            </div>
            <button type="button" onClick={addOpt} className="text-sm mt-2 hover:underline" style={{ color: 'var(--theme-primary)' }}>+ Add option</button>
            <p className="text-[11px] text-gray-400 mt-1">Left = label shown to the candidate · Right = points awarded.</p>
          </div>
        )}

        <ModalActions>
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-600">Cancel</button>
          <PrimaryButton type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save question'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

function parseKnockout(kind, raw) {
  const parts = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (kind === 'BOOLEAN') return parts.map((p) => p.toLowerCase() === 'true');
  return parts;
}

// ── Scorecard template picker ───────────────────────────────────────────────
function ScorecardTab({ job, onSaved }) {
  const [templates, setTemplates] = useState([]);
  const [sel, setSel] = useState(job.scorecardTemplateId || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    get('/api/hr/recruitment/scorecard-templates').then((r) => setTemplates(asList(r))).catch((e) => setError(e.message));
  }, []);

  async function save() {
    setSaving(true); setError('');
    try { await patch(`/api/hr/recruitment/jobs/${job.id}`, { scorecardTemplateId: sel || null }); onSaved(); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  const chosen = templates.find((t) => t.id === sel);
  return (
    <div className="max-w-xl">
      {error && <ErrorBanner message={error} />}
      <p className="text-sm text-gray-500 mb-3">Pick the interview scorecard this job's rounds use by default. Interviewers rate each skill 1–10; the weighted total feeds the merit list.</p>
      <FieldLabel hint="The reusable skill set (created on the Recruitment → Scorecard templates tab). Each interview round defaults to this template.">Default interview scorecard</FieldLabel>
      <select value={sel} onChange={(e) => setSel(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
        <option value="">— None —</option>
        {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({(t.skills || []).length} skills)</option>)}
      </select>
      {chosen && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(chosen.skills || []).map((s) => <span key={s.id} className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{s.name} ×{Number(s.weight)}</span>)}
        </div>
      )}
      <div className="mt-4"><PrimaryButton onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</PrimaryButton></div>
    </div>
  );
}

// ── Merit list ──────────────────────────────────────────────────────────────
function MeritTab({ jobId }) {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [why, setWhy] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try { setData(await get(`/api/hr/recruitment/jobs/${jobId}/merit-list`, { page, pageSize: 25 })); }
    catch (e) { setError(e.message); }
  }, [jobId, page]);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <ErrorBanner message={error} /> : <Spinner />;
  const name = (a) => a.candidate ? `${a.candidate.firstName} ${a.candidate.lastName}` : (a.id || '').slice(0, 8);

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 mb-4">
        <b>Formula:</b> {data.job.formula}
      </div>

      <h3 className="text-sm font-semibold text-gray-900 mb-2">Ranked candidates</h3>
      <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto shadow-sm">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-100">
            <th className="px-4 py-3">Rank</th><th className="px-4 py-3">Candidate</th><th className="px-4 py-3">Application</th><th className="px-4 py-3">Interview</th><th className="px-4 py-3">Merit</th><th className="px-4 py-3"></th>
          </tr></thead>
          <tbody>
            {data.ranked.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">No interviewed candidates yet.</td></tr>}
            {data.ranked.map((a) => (
              <tr key={a.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3 font-semibold">{a.rank}</td>
                <td className="px-4 py-3"><Link href={`/recruitment/applications/${a.id}`} className="text-gray-900 hover:underline">{name(a)}</Link></td>
                <td className="px-4 py-3"><ScoreBadge score={a.screeningScore} max={a.screeningMaxScore} /></td>
                <td className="px-4 py-3 text-gray-700">{a.interviewScore != null ? Number(a.interviewScore) : '—'}</td>
                <td className="px-4 py-3 font-semibold" style={{ color: 'var(--theme-primary)' }}>{a.meritScore != null ? Number(a.meritScore) : '—'}</td>
                <td className="px-4 py-3 text-right"><ActionButton onClick={() => setWhy(a)}>Why this rank?</ActionButton></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPage={setPage} />

      {data.pending.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-gray-500 mb-2">Awaiting interview ({data.pending.length})</h3>
          <div className="flex flex-wrap gap-2">
            {data.pending.map((a) => (
              <Link key={a.id} href={`/recruitment/applications/${a.id}`} className="text-xs px-2.5 py-1 rounded-full border bg-white hover:bg-gray-50">
                {name(a)} <ScoreBadge score={a.screeningScore} max={a.screeningMaxScore} />
              </Link>
            ))}
          </div>
        </div>
      )}
      {data.knockedOut.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-gray-500 mb-2">Knocked out / rejected ({data.knockedOut.length})</h3>
          <div className="flex flex-wrap gap-2">
            {data.knockedOut.map((a) => (
              <span key={a.id} className="text-xs px-2.5 py-1 rounded-full border border-red-100 bg-red-50 text-red-700">{name(a)}</span>
            ))}
          </div>
        </div>
      )}

      {why && <WhyDrawer app={why} onClose={() => setWhy(null)} />}
    </div>
  );
}

function WhyDrawer({ app, onClose }) {
  const snap = app.scoreSnapshot || {};
  return (
    <Modal title={`Why this rank — ${app.candidate ? `${app.candidate.firstName} ${app.candidate.lastName}` : ''}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="rounded-lg bg-gray-50 border p-3 text-gray-600 text-xs">{snap.formula}</div>
        {snap.screening && (
          <div>
            <div className="font-semibold text-gray-900 mb-1">Application — {snap.screening.score}/{snap.screening.max} ({snap.screening.pct}%)</div>
            <ul className="text-xs text-gray-600 space-y-0.5">
              {(snap.screening.lines || []).map((l, i) => (
                <li key={i} className="flex justify-between">
                  <span>{l.q}{l.label ? ` — ${l.label}` : ''}{l.isKnockout ? (l.knockoutFailed ? ' (knockout FAILED)' : ' (knockout passed)') : ''}</span>
                  <span className="tabular-nums">+{l.awarded}</span>
                </li>
              ))}
            </ul>
            {snap.screening.knockouts && <div className="text-[11px] text-gray-400 mt-1">Knockouts: {snap.screening.knockouts.passed} passed, {snap.screening.knockouts.failed} failed</div>}
          </div>
        )}
        {snap.interview && (
          <div>
            <div className="font-semibold text-gray-900 mb-1">Interview — {snap.interview.score ?? 'pending'} ({snap.interview.aggregation} of {snap.interview.interviewers} interviewer{snap.interview.interviewers === 1 ? '' : 's'})</div>
            <ul className="text-xs text-gray-600 space-y-0.5">
              {(snap.interview.perInterviewer || []).map((p, i) => (
                <li key={i} className="flex justify-between"><span>{p.who}</span><span className="tabular-nums">{p.total}</span></li>
              ))}
            </ul>
          </div>
        )}
        <div className="border-t pt-3 flex justify-between font-semibold">
          <span>Merit (weighted)</span>
          <span style={{ color: 'var(--theme-primary)' }}>{snap.merit ?? (app.meritScore != null ? Number(app.meritScore) : '—')}</span>
        </div>
      </div>
    </Modal>
  );
}

// ── Share & careers ─────────────────────────────────────────────────────────
// The prominent "Share / public link" surface: a copyable candidate-facing URL
// to give to job portals (LinkedIn, Naukri, Indeed…) so applicants apply DIRECTLY
// to our portal, plus a Publish/Unpublish toggle. Candidates see the JD + apply —
// no internal scores ever leak (the public page reads the no-score apply API).
function ShareTab({ job, onSaved }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState(job.publicLink || null);

  // Resolve the freshest link bundle (origin may need the tenant host).
  const refreshLink = useCallback(async () => {
    try { const r = await get(`/api/hr/recruitment/jobs/${job.id}/share`); setLink(r.publicLink || null); }
    catch { /* fall back to whatever getJob embedded */ }
  }, [job.id]);
  useEffect(() => { refreshLink(); }, [refreshLink]);

  async function setPublic(isPublic) {
    setBusy(true); setError('');
    try {
      const r = await post(`/api/hr/recruitment/jobs/${job.id}/set-public`, { isPublic });
      setLink(r.publicLink || null);
      onSaved();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function publishOpen() {
    setBusy(true); setError('');
    try { await post(`/api/hr/recruitment/jobs/${job.id}/publish`, {}); onSaved(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  // Build an absolute URL even when the API can't resolve the tenant host: fall
  // back to the current browser origin + the relative careers path.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const absJobUrl = link ? (link.url || `${origin}${link.jobPath}`) : '';
  const absBoardUrl = link ? (link.careersUrl || `${origin}${link.careersPath}`) : '';
  const isLive = job.isPublic && job.status === 'OPEN';

  return (
    <div className="max-w-2xl space-y-5">
      {error && <ErrorBanner message={error} />}

      {/* The hero share card */}
      <section className="rounded-2xl border-2 bg-white p-5 shadow-sm" style={{ borderColor: isLive ? '#10b981' : 'var(--theme-primary)' }}>
        <div className="flex items-start justify-between gap-3 mb-1">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Share this job</h2>
            <p className="text-xs text-gray-500 mt-0.5">Give this link to job portals (LinkedIn, Naukri, Indeed…). Candidates apply directly on your careers page — no account needed, and your internal scores stay private.</p>
          </div>
          <span className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${isLive ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
            {isLive ? '● Live' : 'Not live'}
          </span>
        </div>

        {job.isPublic && link ? (
          <div className="space-y-3 mt-4">
            <CopyField label="Public apply link" hint="The candidate-facing job page. Paste this into any job board." value={absJobUrl} openHref={absJobUrl} />
            <CopyField label="Careers board" hint="Your full public careers board (all open public roles)." value={absBoardUrl} openHref={absBoardUrl} />
            {!isLive && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                This link is prepared but won't resolve until the job is <b>OPEN</b>.
                {job.status === 'DRAFT' && <button onClick={publishOpen} disabled={busy} className="ml-2 font-semibold underline">Publish now →</button>}
              </div>
            )}
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-gray-400">slug: <code className="bg-gray-100 px-1 rounded">{link.publicSlug}</code></span>
              <button onClick={() => setPublic(false)} disabled={busy} className="text-xs text-red-600 hover:underline">Unpublish (remove from careers)</button>
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-gray-300 p-5 text-center">
            <p className="text-sm text-gray-500 mb-3">This job is internal. Publish it to the public careers board to get a shareable apply link.</p>
            <PrimaryButton onClick={() => setPublic(true)} disabled={busy}>{busy ? 'Publishing…' : 'Publish to careers & get link'}</PrimaryButton>
          </div>
        )}
      </section>

      {/* Status helper */}
      <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-gray-900 flex items-center gap-2">Requisition status <StatusPill status={job.status} /></div>
          {job.status === 'DRAFT' && <PrimaryButton onClick={publishOpen} disabled={busy}>Publish (→ OPEN)</PrimaryButton>}
        </div>
        <p className="text-xs text-gray-500 mt-2">A job must be <b>OPEN</b> for its public link to accept applications. Use the Summary tab to close the job when hiring is done.</p>
      </section>
    </div>
  );
}
