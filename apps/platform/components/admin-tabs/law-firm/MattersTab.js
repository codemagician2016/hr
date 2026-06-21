'use client'

import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'

// Matter management workspace for the law_firm theme: the spine that ties a
// cleared consultation → an open matter → engagement letter → time/disbursement
// WIP → invoicing → trust accounting. Two views live in this one component
// (list ⇄ detail) so the admin shell only mounts a single tab.

// Premium legal palette — matches the navy/gold storefront.
const NAVY = '#1E3A5F'
const GOLD = '#B8862E'
const SERIF = 'Georgia, "Times New Roman", serif'
const HAIRLINE = '#E5E2D9'
const PARCHMENT = '#FBFAF6'
const MUTE = '#5A6B82'

const FEE_BASES = ['HOURLY', 'FIXED', 'RETAINER', 'CONTINGENCY', 'ESTIMATE', 'PRO_BONO']
const FEE_BASIS_LABEL = {
  HOURLY: 'Hourly rate',
  FIXED: 'Fixed fee',
  RETAINER: 'Retainer',
  CONTINGENCY: 'Conditional (no win, no fee)',
  ESTIMATE: 'Estimate only',
  PRO_BONO: 'Pro bono',
}

const STATUS_META = {
  PROSPECT: { label: 'Prospect', cls: 'bg-[#FBFAF6] text-[#1E3A5F] ring-[#E5E2D9]' },
  OPEN: { label: 'Open', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  ON_HOLD: { label: 'On hold', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
  CLOSED: { label: 'Closed', cls: 'bg-slate-100 text-slate-600 ring-slate-200' },
}
const STATUS_OPTIONS = ['PROSPECT', 'OPEN', 'ON_HOLD', 'CLOSED']

const ENGAGEMENT_META = {
  NOT_SENT: { label: 'Not issued', cls: 'bg-[#FBFAF6] text-slate-500 ring-[#E5E2D9]' },
  DRAFT: { label: 'Draft', cls: 'bg-amber-50 text-amber-700 ring-amber-200' },
  SENT: { label: 'Issued — awaiting acceptance', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
  ACCEPTED: { label: 'Accepted', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
}

// ── helpers ──────────────────────────────────────────────────────────────────

function money(amount, currency) {
  const n = Number(amount)
  const safe = Number.isFinite(n) ? n : 0
  const formatted = safe.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${currency ? `${currency} ` : ''}${formatted}`
}

function fmtDate(d) {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return '—'
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function feeBasisLabel(b) {
  if (!b) return '—'
  return FEE_BASIS_LABEL[b] || b
}

function staffArray(data) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.staff)) return data.staff
  return []
}

function errMsg(err, fallback) {
  return err?.response?.data?.message || err?.message || fallback
}

function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#1E3A5F] border-t-transparent" />
    </div>
  )
}

function StatusPill({ status }) {
  const meta = STATUS_META[status] || { label: status || '—', cls: 'bg-slate-100 text-slate-600 ring-slate-200' }
  return <span className={`rounded-md px-2 py-0.5 text-xs font-bold ring-1 ring-inset ${meta.cls}`}>{meta.label}</span>
}

function EngagementPill({ status }) {
  const meta = ENGAGEMENT_META[status] || ENGAGEMENT_META.NOT_SENT
  return <span className={`rounded-md px-2 py-0.5 text-xs font-bold ring-1 ring-inset ${meta.cls}`}>{meta.label}</span>
}

function InvoiceStatusPill({ status }) {
  const map = {
    PAID: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    PARTIAL: 'bg-amber-50 text-amber-800 ring-amber-200',
    SENT: 'bg-amber-50 text-amber-700 ring-amber-200',
    ISSUED: 'bg-amber-50 text-amber-700 ring-amber-200',
    DRAFT: 'bg-[#FBFAF6] text-slate-500 ring-[#E5E2D9]',
    VOID: 'bg-slate-100 text-slate-500 ring-slate-200',
    OVERDUE: 'bg-red-50 text-red-700 ring-red-200',
  }
  const cls = map[status] || 'bg-slate-100 text-slate-600 ring-slate-200'
  const label = status ? status.charAt(0) + status.slice(1).toLowerCase() : '—'
  return <span className={`rounded-md px-2 py-0.5 text-xs font-bold ring-1 ring-inset ${cls}`}>{label}</span>
}

function FieldLabel({ children }) {
  return (
    <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide" style={{ color: GOLD }}>
      {children}
    </span>
  )
}

function Card({ title, hint, right, children }) {
  return (
    <section className="rounded-lg border border-[#E5E2D9] bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[#EFEAE0] pb-3">
        <div>
          <h3 className="text-base font-bold" style={{ fontFamily: SERIF, color: NAVY }}>{title}</h3>
          {hint && <p className="mt-0.5 text-xs" style={{ color: MUTE }}>{hint}</p>}
        </div>
        {right}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

function Banner({ error, notice }) {
  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
        {error}
      </div>
    )
  }
  if (notice) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
        {notice}
      </div>
    )
  }
  return null
}

// ── LIST VIEW ─────────────────────────────────────────────────────────────────

function MatterRow({ matter, onOpen }) {
  return (
    <button
      onClick={() => onOpen(matter.id)}
      className="w-full rounded-lg border border-[#E5E2D9] bg-white p-4 text-left shadow-sm transition-colors hover:bg-[#FBFAF6]"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold" style={{ color: GOLD }}>{matter.matterNumber || '—'}</span>
            <StatusPill status={matter.status} />
          </div>
          <p className="mt-1 truncate text-base font-bold" style={{ fontFamily: SERIF, color: NAVY }}>
            {matter.title || 'Untitled matter'}
          </p>
          <p className="mt-0.5 text-xs" style={{ color: MUTE }}>
            {matter.client?.name || 'No client'}
            {matter.responsibleLawyer?.name ? ` · ${matter.responsibleLawyer.name}` : ''}
            {matter.practiceArea ? ` · ${matter.practiceArea}` : ''}
            {matter.feeBasis ? ` · ${feeBasisLabel(matter.feeBasis)}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-4 text-right">
          <Figure label="Billed" value={money(matter.billedTotal, matter.currency)} />
          <Figure label="Outstanding" value={money(matter.outstanding, matter.currency)} tone={Number(matter.outstanding) > 0 ? 'warn' : ''} />
          <Figure label="Trust" value={money(matter.trustBalance, matter.currency)} />
        </div>
      </div>
    </button>
  )
}

function Figure({ label, value, tone }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: GOLD }}>{label}</p>
      <p className={`mt-0.5 text-sm font-bold ${tone === 'warn' ? 'text-amber-700' : ''}`} style={tone === 'warn' ? undefined : { color: NAVY }}>
        {value}
      </p>
    </div>
  )
}

function MatterList({ onOpen, onNew }) {
  const [matters, setMatters] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('ALL')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const { data } = await axios.get('/api/law-firm/admin/matters', { withCredentials: true })
      setMatters(Array.isArray(data?.matters) ? data.matters : [])
    } catch (err) {
      setError(errMsg(err, 'Failed to load matters'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const counts = matters.reduce((acc, m) => {
    const s = m.status || 'OPEN'
    acc[s] = (acc[s] || 0) + 1
    return acc
  }, {})

  const chips = [
    { key: 'ALL', label: `All (${matters.length})` },
    { key: 'OPEN', label: `Open (${counts.OPEN || 0})` },
    { key: 'ON_HOLD', label: `On hold (${counts.ON_HOLD || 0})` },
    { key: 'CLOSED', label: `Closed (${counts.CLOSED || 0})` },
    { key: 'PROSPECT', label: `Prospect (${counts.PROSPECT || 0})` },
  ]

  const shown = filter === 'ALL' ? matters : matters.filter((m) => (m.status || 'OPEN') === filter)

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-[#E5E2D9] bg-white p-6" style={{ borderTop: `3px solid ${GOLD}` }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: GOLD }}>Law practice</p>
            <h1 className="mt-2 text-2xl font-bold" style={{ fontFamily: SERIF, color: NAVY }}>Matters</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: '#475569' }}>
              Open a matter from a conflict-cleared consultation, issue the letter of engagement,
              record time and disbursements, then bill and reconcile against the client trust account.
            </p>
          </div>
          <button
            onClick={onNew}
            className="rounded-md px-4 py-2 text-sm font-bold text-white shadow-sm hover:opacity-95"
            style={{ backgroundColor: NAVY }}
          >
            Open matter
          </button>
        </div>
      </div>

      <Banner error={error} />

      <div className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => setFilter(c.key)}
            className={`rounded-md border px-3 py-1.5 text-xs font-bold transition-colors ${
              filter === c.key
                ? 'border-[#1E3A5F] bg-[#1E3A5F] text-white'
                : 'border-[#DAD4C7] bg-white text-slate-600 hover:bg-[#FBFAF6]'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {loading ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#DAD4C7] bg-white p-10 text-center text-sm" style={{ color: MUTE }}>
          No matters in this view yet. Open one from a cleared consultation to get started.
        </div>
      ) : (
        <div className="grid gap-3">
          {shown.map((m) => (
            <MatterRow key={m.id} matter={m} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── OPEN MATTER MODAL ─────────────────────────────────────────────────────────

function OpenMatterModal({ onClose, onOpened }) {
  const [tab, setTab] = useState('consultation')
  const [consultations, setConsultations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // blank-matter fields
  const [title, setTitle] = useState('')
  const [practiceArea, setPracticeArea] = useState('')
  const [feeBasis, setFeeBasis] = useState('HOURLY')
  const [defaultRate, setDefaultRate] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      try {
        const { data } = await axios.get('/api/law-firm/admin/consultations', { withCredentials: true })
        if (!alive) return
        const rows = (Array.isArray(data?.consultations) ? data.consultations : []).filter((r) => {
          const cs = r.intake?.conflictStatus
          return cs === 'CLEARED' || cs === 'WAIVED'
        })
        setConsultations(rows)
      } catch (err) {
        if (alive) setError(errMsg(err, 'Failed to load consultations'))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  async function openFromConsultation(appointmentId) {
    setBusy(true)
    setError('')
    try {
      const { data } = await axios.post('/api/law-firm/admin/matters', { appointmentId }, { withCredentials: true })
      const id = data?.matter?.id
      if (id) onOpened(id)
      else setError('Matter created but no id was returned.')
    } catch (err) {
      setError(errMsg(err, 'Could not open the matter'))
    } finally {
      setBusy(false)
    }
  }

  async function openBlank() {
    if (!title.trim()) {
      setError('A matter title is required.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const body = { title: title.trim(), feeBasis }
      if (practiceArea.trim()) body.practiceArea = practiceArea.trim()
      if (defaultRate !== '') body.defaultRate = Number(defaultRate)
      const { data } = await axios.post('/api/law-firm/admin/matters', body, { withCredentials: true })
      const id = data?.matter?.id
      if (id) onOpened(id)
      else setError('Matter created but no id was returned.')
    } catch (err) {
      setError(errMsg(err, 'Could not open the matter'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/55 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#E5E2D9] px-5 py-3" style={{ boxShadow: `inset 0 3px 0 ${GOLD}` }}>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: GOLD }}>New matter</p>
            <h2 className="text-base font-bold" style={{ fontFamily: SERIF, color: NAVY }}>Open a matter</h2>
          </div>
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-[#FBFAF6]">Close</button>
        </div>

        <div className="flex gap-2 border-b border-[#EFEAE0] px-5 pt-3">
          {[
            { key: 'consultation', label: 'From cleared consultation' },
            { key: 'blank', label: 'Blank matter' },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setError('') }}
              className={`rounded-t-md border-b-2 px-3 py-2 text-sm font-bold transition-colors ${
                tab === t.key ? 'border-[#B8862E] text-[#1E3A5F]' : 'border-transparent text-slate-500 hover:text-[#1E3A5F]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {error && <div className="mb-3"><Banner error={error} /></div>}

          {tab === 'consultation' ? (
            loading ? (
              <Spinner />
            ) : consultations.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#DAD4C7] bg-[#FBFAF6] p-8 text-center text-sm" style={{ color: MUTE }}>
                No conflict-cleared consultations are waiting. Clear a conflict check first, then open the matter here.
              </div>
            ) : (
              <div className="grid gap-2">
                {consultations.map((c) => (
                  <div key={c.appointmentId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#E5E2D9] bg-white p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold" style={{ color: NAVY }}>{c.clientName || 'Prospective client'}</p>
                      <p className="text-xs" style={{ color: MUTE }}>
                        {c.intake?.matterType || c.serviceName || 'Consultation'} · {fmtDate(c.date)}{c.startTime ? ` ${c.startTime}` : ''}
                        {c.lawyerName ? ` · ${c.lawyerName}` : ''}
                      </p>
                      {c.intake?.matterSummary && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{c.intake.matterSummary}</p>
                      )}
                    </div>
                    <button
                      disabled={busy}
                      onClick={() => openFromConsultation(c.appointmentId)}
                      className="shrink-0 rounded-md px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                      style={{ backgroundColor: NAVY }}
                    >
                      {busy ? 'Opening…' : 'Open matter'}
                    </button>
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="space-y-3">
              <label className="block">
                <FieldLabel>Matter title</FieldLabel>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Property purchase — 14 Marine Parade"
                  className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none"
                />
              </label>
              <label className="block">
                <FieldLabel>Practice area</FieldLabel>
                <input
                  value={practiceArea}
                  onChange={(e) => setPracticeArea(e.target.value)}
                  placeholder="e.g. Conveyancing"
                  className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <FieldLabel>Fee basis</FieldLabel>
                  <select
                    value={feeBasis}
                    onChange={(e) => setFeeBasis(e.target.value)}
                    className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none"
                  >
                    {FEE_BASES.map((b) => <option key={b} value={b}>{feeBasisLabel(b)}</option>)}
                  </select>
                </label>
                <label className="block">
                  <FieldLabel>Default rate (optional)</FieldLabel>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={defaultRate}
                    onChange={(e) => setDefaultRate(e.target.value)}
                    placeholder="e.g. 350"
                    className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none"
                  />
                </label>
              </div>
              <div className="flex justify-end pt-1">
                <button
                  disabled={busy}
                  onClick={openBlank}
                  className="rounded-md px-4 py-2 text-sm font-bold text-white shadow-sm disabled:opacity-50"
                  style={{ backgroundColor: NAVY }}
                >
                  {busy ? 'Opening…' : 'Open matter'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── ENGAGEMENT MODAL ──────────────────────────────────────────────────────────

function EngagementModal({ matter, onClose, onIssued }) {
  const saved = matter.engagementDocument?.payload || {}
  const [scope, setScope] = useState(saved.scope || matter.description || matter.title || '')
  const [exclusions, setExclusions] = useState(saved.exclusions || '')
  const [feeBasis, setFeeBasis] = useState(saved.feeBasis || feeBasisLabel(matter.feeBasis) || FEE_BASES[0])
  const [feeEstimate, setFeeEstimate] = useState(saved.feeEstimate || '')
  const [disbursements, setDisbursements] = useState(saved.disbursements || '')
  const [clientResponsibilities, setClientResponsibilities] = useState(saved.clientResponsibilities || '')
  const [retainerAmount, setRetainerAmount] = useState('')
  const [recipientName, setRecipientName] = useState(matter.client?.name || '')
  const [recipientContact, setRecipientContact] = useState(matter.client?.email || matter.client?.phone || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function issue() {
    setBusy(true)
    setError('')
    try {
      const payload = { scope, feeBasis, feeEstimate, disbursements, clientResponsibilities, exclusions }
      const body = { payload, letterhead: {} }
      if (recipientName.trim()) body.recipientName = recipientName.trim()
      if (recipientContact.trim()) body.recipientContact = recipientContact.trim()
      if (retainerAmount !== '') body.retainerAmount = Number(retainerAmount)
      await axios.post(`/api/law-firm/admin/matters/${matter.id}/engagement`, body, { withCredentials: true })
      await onIssued()
    } catch (err) {
      setError(errMsg(err, 'Could not issue the engagement letter'))
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/55 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#E5E2D9] px-5 py-3" style={{ boxShadow: `inset 0 3px 0 ${GOLD}` }}>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: GOLD }}>Letter of engagement</p>
            <h2 className="text-base font-bold" style={{ fontFamily: SERIF, color: NAVY }}>Issue engagement letter</h2>
            <p className="text-xs" style={{ color: MUTE }}>{matter.matterNumber} · {matter.title}</p>
          </div>
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-[#FBFAF6]">Close</button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {error && <Banner error={error} />}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <FieldLabel>Recipient name</FieldLabel>
              <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)}
                className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none" />
            </label>
            <label className="block">
              <FieldLabel>Recipient contact</FieldLabel>
              <input value={recipientContact} onChange={(e) => setRecipientContact(e.target.value)}
                className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none" />
            </label>
          </div>
          <label className="block">
            <FieldLabel>Scope of engagement</FieldLabel>
            <textarea value={scope} onChange={(e) => setScope(e.target.value)} rows={3} placeholder="What the firm will do for this matter"
              className="w-full rounded-md border border-[#DAD4C7] p-2.5 text-sm leading-6 text-slate-800 focus:border-[#1E3A5F] focus:outline-none" />
          </label>
          <label className="block">
            <FieldLabel>Exclusions</FieldLabel>
            <textarea value={exclusions} onChange={(e) => setExclusions(e.target.value)} rows={2} placeholder="What this engagement does not cover"
              className="w-full rounded-md border border-[#DAD4C7] p-2.5 text-sm leading-6 text-slate-800 focus:border-[#1E3A5F] focus:outline-none" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <FieldLabel>Fee basis</FieldLabel>
              <input value={feeBasis} onChange={(e) => setFeeBasis(e.target.value)}
                className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none" />
            </label>
            <label className="block">
              <FieldLabel>Fee estimate</FieldLabel>
              <input value={feeEstimate} onChange={(e) => setFeeEstimate(e.target.value)} placeholder="e.g. $1,500 + GST"
                className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none" />
            </label>
          </div>
          <label className="block">
            <FieldLabel>Disbursements</FieldLabel>
            <textarea value={disbursements} onChange={(e) => setDisbursements(e.target.value)} rows={2} placeholder="Search fees, registration, courier, etc."
              className="w-full rounded-md border border-[#DAD4C7] p-2.5 text-sm leading-6 text-slate-800 focus:border-[#1E3A5F] focus:outline-none" />
          </label>
          <label className="block">
            <FieldLabel>Client responsibilities</FieldLabel>
            <textarea value={clientResponsibilities} onChange={(e) => setClientResponsibilities(e.target.value)} rows={2}
              className="w-full rounded-md border border-[#DAD4C7] p-2.5 text-sm leading-6 text-slate-800 focus:border-[#1E3A5F] focus:outline-none" />
          </label>
          <label className="block">
            <FieldLabel>Retainer amount (optional)</FieldLabel>
            <input type="number" min="0" step="0.01" value={retainerAmount} onChange={(e) => setRetainerAmount(e.target.value)}
              placeholder="Raises a retainer invoice on issue"
              className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none" />
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-[#E5E2D9] bg-[#FBFAF6] px-5 py-3">
          <button onClick={onClose} className="rounded-md border border-[#DAD4C7] bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-[#FBFAF6]">Cancel</button>
          <button disabled={busy} onClick={issue} className="rounded-md px-4 py-2 text-sm font-bold text-white shadow-sm disabled:opacity-50" style={{ backgroundColor: NAVY }}>
            {busy ? 'Issuing…' : 'Issue engagement letter'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── DETAIL: sub-cards ─────────────────────────────────────────────────────────

function HeaderCard({ matter, lawyers, onPatch, patching }) {
  const c = matter.client || {}
  const [rate, setRate] = useState(matter.defaultRate ?? '')
  const [fixedFee, setFixedFee] = useState(matter.fixedFee ?? '')
  useEffect(() => { setRate(matter.defaultRate ?? '') }, [matter.defaultRate])
  useEffect(() => { setFixedFee(matter.fixedFee ?? '') }, [matter.fixedFee])

  return (
    <section className="rounded-lg border border-[#E5E2D9] bg-white p-6 shadow-sm" style={{ borderTop: `3px solid ${GOLD}` }}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold" style={{ color: GOLD }}>{matter.matterNumber || '—'}</span>
            <StatusPill status={matter.status} />
          </div>
          <h1 className="mt-1 text-2xl font-bold" style={{ fontFamily: SERIF, color: NAVY }}>{matter.title || 'Untitled matter'}</h1>
          <p className="mt-1 text-sm" style={{ color: MUTE }}>
            {c.name || 'No client'}
            {c.email ? ` · ${c.email}` : ''}
            {c.phone ? ` · ${c.phone}` : ''}
          </p>
          <p className="mt-0.5 text-xs" style={{ color: MUTE }}>
            {matter.practiceArea || 'No practice area'} · Opened {fmtDate(matter.openedAt)}
            {matter.closedAt ? ` · Closed ${fmtDate(matter.closedAt)}` : ''}
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <FieldLabel>Responsible lawyer</FieldLabel>
          <select
            disabled={patching}
            value={matter.responsibleLawyer?.id || ''}
            onChange={(e) => onPatch({ responsibleLawyerId: e.target.value || null })}
            className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none disabled:opacity-50"
          >
            <option value="">Unassigned</option>
            {lawyers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label className="block">
          <FieldLabel>Status</FieldLabel>
          <select
            disabled={patching}
            value={matter.status || 'OPEN'}
            onChange={(e) => onPatch({ status: e.target.value })}
            className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none disabled:opacity-50"
          >
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_META[s]?.label || s}</option>)}
          </select>
        </label>
        <label className="block">
          <FieldLabel>Fee basis</FieldLabel>
          <select
            disabled={patching}
            value={matter.feeBasis || 'HOURLY'}
            onChange={(e) => onPatch({ feeBasis: e.target.value })}
            className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none disabled:opacity-50"
          >
            {FEE_BASES.map((b) => <option key={b} value={b}>{feeBasisLabel(b)}</option>)}
          </select>
        </label>
        {matter.feeBasis === 'FIXED' ? (
          <label className="block">
            <FieldLabel>Fixed fee ({matter.currency || '—'})</FieldLabel>
            <input
              type="number" min="0" step="0.01" value={fixedFee} disabled={patching}
              onChange={(e) => setFixedFee(e.target.value)}
              onBlur={() => { if (String(fixedFee) !== String(matter.fixedFee ?? '')) onPatch({ fixedFee: fixedFee === '' ? null : Number(fixedFee) }) }}
              className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none disabled:opacity-50"
            />
          </label>
        ) : (
          <label className="block">
            <FieldLabel>Default rate ({matter.currency || '—'})</FieldLabel>
            <input
              type="number" min="0" step="0.01" value={rate} disabled={patching}
              onChange={(e) => setRate(e.target.value)}
              onBlur={() => { if (String(rate) !== String(matter.defaultRate ?? '')) onPatch({ defaultRate: rate === '' ? null : Number(rate) }) }}
              className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none disabled:opacity-50"
            />
          </label>
        )}
      </div>
    </section>
  )
}

function EngagementCard({ matter, onOpenModal, onAccept, accepting }) {
  const doc = matter.engagementDocument
  const noOrigin = !matter.originAppointmentId
  return (
    <Card
      title="Engagement"
      hint="Letter of engagement under the Conduct and Client Care Rules 2008."
      right={<EngagementPill status={matter.engagementStatus} />}
    >
      <div className="space-y-3 text-sm">
        <p style={{ color: MUTE }}>
          {matter.engagementSentAt && <>Issued {fmtDate(matter.engagementSentAt)}. </>}
          {matter.engagementAcceptedAt && <>Accepted {fmtDate(matter.engagementAcceptedAt)}. </>}
          {!matter.engagementSentAt && !matter.engagementAcceptedAt && <>No engagement letter has been issued for this matter yet.</>}
        </p>

        {noOrigin && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
            This matter was opened without an origin consultation, so an engagement letter cannot be issued through the
            consultation engine. Open the matter from a cleared consultation to enable engagement letters.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            disabled={noOrigin}
            onClick={onOpenModal}
            title={noOrigin ? 'Requires an origin consultation' : undefined}
            className="rounded-md px-3 py-1.5 text-xs font-bold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
            style={{ backgroundColor: NAVY }}
          >
            {matter.engagementStatus === 'SENT' || matter.engagementStatus === 'ACCEPTED' ? 'Re-issue engagement letter' : 'Issue engagement letter'}
          </button>
          {doc && (
            <button
              onClick={() => window.open(`/api/law-firm/admin/matters/${matter.id}/engagement/view`, '_blank', 'noopener')}
              className="rounded-md border border-[#1E3A5F] px-3 py-1.5 text-xs font-bold text-[#1E3A5F] hover:bg-[#FBFAF6]"
            >
              View letter
            </button>
          )}
          {matter.engagementStatus === 'SENT' && (
            <button
              disabled={accepting}
              onClick={onAccept}
              className="rounded-md border border-emerald-600 px-3 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            >
              {accepting ? 'Saving…' : 'Mark accepted'}
            </button>
          )}
        </div>
      </div>
    </Card>
  )
}

function WipCard({ matter, onChanged, setError }) {
  const currency = matter.currency
  const time = Array.isArray(matter.timeEntries) ? matter.timeEntries : []
  const disb = Array.isArray(matter.disbursements) ? matter.disbursements : []
  const wip = matter.wip || {}

  const [busy, setBusy] = useState(false)
  const [tWorkedOn, setTWorkedOn] = useState(todayISO())
  const [tMinutes, setTMinutes] = useState('')
  const [tRate, setTRate] = useState('')
  const [tNarrative, setTNarrative] = useState('')

  const [dIncurredOn, setDIncurredOn] = useState(todayISO())
  const [dDescription, setDDescription] = useState('')
  const [dAmount, setDAmount] = useState('')

  async function addTime() {
    if (!tMinutes || Number(tMinutes) <= 0) { setError('Enter minutes worked.'); return }
    setBusy(true)
    try {
      const body = { minutes: Number(tMinutes), workedOn: tWorkedOn }
      if (tRate !== '') body.rate = Number(tRate)
      if (tNarrative.trim()) body.narrative = tNarrative.trim()
      await axios.post(`/api/law-firm/admin/matters/${matter.id}/time`, body, { withCredentials: true })
      setTMinutes(''); setTRate(''); setTNarrative('')
      await onChanged()
    } catch (err) {
      setError(errMsg(err, 'Could not add the time entry'))
    } finally {
      setBusy(false)
    }
  }

  async function delTime(entryId) {
    setBusy(true)
    try {
      await axios.delete(`/api/law-firm/admin/matters/${matter.id}/time/${entryId}`, { withCredentials: true })
      await onChanged()
    } catch (err) {
      setError(errMsg(err, 'Could not delete the time entry'))
    } finally {
      setBusy(false)
    }
  }

  async function addDisb() {
    if (!dDescription.trim()) { setError('Enter a disbursement description.'); return }
    if (!dAmount || Number(dAmount) <= 0) { setError('Enter a disbursement amount.'); return }
    setBusy(true)
    try {
      await axios.post(`/api/law-firm/admin/matters/${matter.id}/disbursements`, {
        description: dDescription.trim(), amount: Number(dAmount), incurredOn: dIncurredOn,
      }, { withCredentials: true })
      setDDescription(''); setDAmount('')
      await onChanged()
    } catch (err) {
      setError(errMsg(err, 'Could not add the disbursement'))
    } finally {
      setBusy(false)
    }
  }

  async function delDisb(disbId) {
    setBusy(true)
    try {
      await axios.delete(`/api/law-firm/admin/matters/${matter.id}/disbursements/${disbId}`, { withCredentials: true })
      await onChanged()
    } catch (err) {
      setError(errMsg(err, 'Could not delete the disbursement'))
    } finally {
      setBusy(false)
    }
  }

  const inputCls = 'w-full rounded-md border border-[#DAD4C7] p-1.5 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none'

  return (
    <Card
      title="Time & disbursements (WIP)"
      hint="Unbilled work in progress. Entries lock once invoiced."
      right={<span className="text-sm font-bold" style={{ color: NAVY }}>Unbilled WIP {money(wip.total, currency)}</span>}
    >
      <div className="space-y-6">
        {/* Time */}
        <div>
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide" style={{ color: GOLD }}>
            Time entries · unbilled {money(wip.unbilledTime, currency)}
          </p>
          <div className="overflow-x-auto rounded-md border border-[#EFEAE0]">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] font-bold uppercase tracking-wide text-white" style={{ backgroundColor: NAVY }}>
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Hours</th>
                  <th className="px-3 py-2">Rate</th>
                  <th className="px-3 py-2">Narrative</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFEAE0]">
                {time.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-4 text-center text-xs" style={{ color: MUTE }}>No time recorded yet.</td></tr>
                ) : time.map((t) => (
                  <tr key={t.id} className="hover:bg-[#FBFAF6]">
                    <td className="px-3 py-2 text-slate-600">{fmtDate(t.workedOn)}</td>
                    <td className="px-3 py-2 text-slate-600">{t.hours != null ? Number(t.hours).toFixed(2) : (Number(t.minutes || 0) / 60).toFixed(2)}</td>
                    <td className="px-3 py-2 text-slate-600">{t.rate != null ? money(t.rate, currency) : '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{t.narrative || '—'}</td>
                    <td className="px-3 py-2 text-right font-semibold" style={{ color: NAVY }}>{money(t.amount, currency)}</td>
                    <td className="px-3 py-2 text-right">
                      {t.billed ? (
                        <span className="text-[11px] font-semibold text-slate-400">Billed</span>
                      ) : (
                        <button disabled={busy} onClick={() => delTime(t.id)} className="text-[11px] font-bold text-red-600 hover:underline disabled:opacity-50">Delete</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <input type="date" value={tWorkedOn} onChange={(e) => setTWorkedOn(e.target.value)} className={inputCls} aria-label="Worked on" />
            <input type="number" min="0" step="1" value={tMinutes} onChange={(e) => setTMinutes(e.target.value)} placeholder="Minutes" className={inputCls} aria-label="Minutes" />
            <input type="number" min="0" step="0.01" value={tRate} onChange={(e) => setTRate(e.target.value)} placeholder="Rate" className={inputCls} aria-label="Rate" />
            <input value={tNarrative} onChange={(e) => setTNarrative(e.target.value)} placeholder="Narrative" className={`${inputCls} sm:col-span-1`} aria-label="Narrative" />
            <button disabled={busy} onClick={addTime} className="rounded-md px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50" style={{ backgroundColor: NAVY }}>Add time</button>
          </div>
        </div>

        {/* Disbursements */}
        <div>
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide" style={{ color: GOLD }}>
            Disbursements · unbilled {money(wip.unbilledDisbursements, currency)}
          </p>
          <div className="overflow-x-auto rounded-md border border-[#EFEAE0]">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] font-bold uppercase tracking-wide text-white" style={{ backgroundColor: NAVY }}>
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFEAE0]">
                {disb.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-4 text-center text-xs" style={{ color: MUTE }}>No disbursements recorded yet.</td></tr>
                ) : disb.map((d) => (
                  <tr key={d.id} className="hover:bg-[#FBFAF6]">
                    <td className="px-3 py-2 text-slate-600">{fmtDate(d.incurredOn)}</td>
                    <td className="px-3 py-2 text-slate-600">{d.description || '—'}</td>
                    <td className="px-3 py-2 text-right font-semibold" style={{ color: NAVY }}>{money(d.amount, currency)}</td>
                    <td className="px-3 py-2 text-right">
                      {d.billed ? (
                        <span className="text-[11px] font-semibold text-slate-400">Billed</span>
                      ) : (
                        <button disabled={busy} onClick={() => delDisb(d.id)} className="text-[11px] font-bold text-red-600 hover:underline disabled:opacity-50">Delete</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <input type="date" value={dIncurredOn} onChange={(e) => setDIncurredOn(e.target.value)} className={inputCls} aria-label="Incurred on" />
            <input value={dDescription} onChange={(e) => setDDescription(e.target.value)} placeholder="Description" className={inputCls} aria-label="Description" />
            <input type="number" min="0" step="0.01" value={dAmount} onChange={(e) => setDAmount(e.target.value)} placeholder="Amount" className={inputCls} aria-label="Amount" />
            <button disabled={busy} onClick={addDisb} className="rounded-md px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50" style={{ backgroundColor: NAVY }}>Add disbursement</button>
          </div>
        </div>
      </div>
    </Card>
  )
}

function InvoicesCard({ matter, onChanged, setError, setNotice }) {
  const currency = matter.currency
  const invoices = Array.isArray(matter.invoices) ? matter.invoices : []
  const trustBalance = Number(matter.trust?.balance) || 0
  const wipTotal = Number(matter.wip?.total) || 0
  const [busy, setBusy] = useState(false)
  const [taxRate, setTaxRate] = useState('')

  async function generate() {
    setBusy(true)
    try {
      const body = { includeUnbilledWip: true }
      if (taxRate !== '') { body.taxRate = Number(taxRate); body.taxLabel = 'GST' }
      await axios.post(`/api/law-firm/admin/matters/${matter.id}/invoices`, body, { withCredentials: true })
      setNotice('Invoice generated from unbilled work.')
      await onChanged()
    } catch (err) {
      setError(errMsg(err, 'Could not generate the invoice'))
    } finally {
      setBusy(false)
    }
  }

  async function recordPayment(inv) {
    const raw = window.prompt(`Record a payment against ${inv.invoiceNumber || 'this invoice'} (balance ${money(inv.balance, inv.currency || currency)}):`, String(inv.balance ?? ''))
    if (raw == null) return
    const amount = Number(raw)
    if (!Number.isFinite(amount) || amount <= 0) { setError('Enter a valid payment amount.'); return }
    setBusy(true)
    try {
      await axios.post(`/api/law-firm/admin/matters/${matter.id}/invoices/${inv.id}/payment`, { amount }, { withCredentials: true })
      setNotice('Payment recorded.')
      await onChanged()
    } catch (err) {
      setError(errMsg(err, 'Could not record the payment'))
    } finally {
      setBusy(false)
    }
  }

  async function applyTrust(inv) {
    setBusy(true)
    try {
      await axios.post(`/api/law-firm/admin/matters/${matter.id}/invoices/${inv.id}/apply-trust`, {}, { withCredentials: true })
      setNotice('Trust funds applied to the invoice.')
      await onChanged()
    } catch (err) {
      setError(errMsg(err, 'Could not apply trust funds'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Invoices"
      hint="Bill unbilled time and disbursements, record payments, and draw down trust."
      right={
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number" min="0" step="0.1" value={taxRate} onChange={(e) => setTaxRate(e.target.value)}
            placeholder="Tax %" aria-label="Tax rate percent"
            className="w-20 rounded-md border border-[#DAD4C7] p-1.5 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none"
          />
          <button
            disabled={busy || wipTotal <= 0}
            onClick={generate}
            title={wipTotal <= 0 ? 'No unbilled work to invoice' : undefined}
            className="rounded-md px-3 py-1.5 text-xs font-bold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
            style={{ backgroundColor: NAVY }}
          >
            Generate from unbilled work
          </button>
        </div>
      }
    >
      {invoices.length === 0 ? (
        <div className="rounded-md border border-dashed border-[#DAD4C7] bg-[#FBFAF6] p-6 text-center text-sm" style={{ color: MUTE }}>
          No invoices yet. Generate one from unbilled work above.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[#EFEAE0]">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] font-bold uppercase tracking-wide text-white" style={{ backgroundColor: NAVY }}>
              <tr>
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Issued</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">Paid</th>
                <th className="px-3 py-2 text-right">Balance</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EFEAE0]">
              {invoices.map((inv) => {
                const cur = inv.currency || currency
                const balance = Number(inv.balance) || 0
                const canTrust = trustBalance > 0 && balance > 0
                return (
                  <tr key={inv.id} className="hover:bg-[#FBFAF6]">
                    <td className="px-3 py-2 font-semibold" style={{ color: NAVY }}>{inv.invoiceNumber || '—'}</td>
                    <td className="px-3 py-2 text-slate-500">{fmtDate(inv.issuedAt)}</td>
                    <td className="px-3 py-2 text-right text-slate-700">{money(inv.total, cur)}</td>
                    <td className="px-3 py-2 text-right text-slate-700">{money(inv.amountPaid, cur)}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${balance > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{money(balance, cur)}</td>
                    <td className="px-3 py-2"><InvoiceStatusPill status={inv.status} /></td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <button
                          onClick={() => window.open(`/api/law-firm/admin/matters/${matter.id}/invoices/${inv.id}/view`, '_blank', 'noopener')}
                          className="rounded-md border border-[#1E3A5F] px-2 py-1 text-[11px] font-bold text-[#1E3A5F] hover:bg-[#FBFAF6]"
                        >
                          View
                        </button>
                        {balance > 0 && (
                          <button disabled={busy} onClick={() => recordPayment(inv)} className="rounded-md border border-[#1E3A5F] px-2 py-1 text-[11px] font-bold text-[#1E3A5F] hover:bg-[#FBFAF6] disabled:opacity-50">
                            Record payment
                          </button>
                        )}
                        {canTrust && (
                          <button disabled={busy} onClick={() => applyTrust(inv)} className="rounded-md px-2 py-1 text-[11px] font-bold text-white disabled:opacity-50" style={{ backgroundColor: GOLD }}>
                            Apply trust
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

const TRUST_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_TO_OFFICE', 'REFUND', 'DISBURSEMENT']
const TRUST_TYPE_LABEL = {
  DEPOSIT: 'Deposit',
  WITHDRAWAL: 'Withdrawal',
  TRANSFER_TO_OFFICE: 'Transfer to office',
  REFUND: 'Refund',
  DISBURSEMENT: 'Disbursement',
}
const TRUST_INFLOW = new Set(['DEPOSIT'])

function TrustCard({ matter, onChanged, setError, setNotice }) {
  const currency = matter.currency
  const trust = matter.trust || {}
  const entries = Array.isArray(trust.entries) ? trust.entries : []
  const balance = Number(trust.balance) || 0
  const [busy, setBusy] = useState(false)
  const [type, setType] = useState('DEPOSIT')
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')

  async function add() {
    if (!amount || Number(amount) <= 0) { setError('Enter a trust transaction amount.'); return }
    setBusy(true)
    try {
      const body = { type, amount: Number(amount) }
      if (reference.trim()) body.reference = reference.trim()
      await axios.post(`/api/law-firm/admin/matters/${matter.id}/trust`, body, { withCredentials: true })
      setAmount(''); setReference('')
      setNotice('Trust transaction recorded.')
      await onChanged()
    } catch (err) {
      setError(errMsg(err, 'Could not record the trust transaction'))
    } finally {
      setBusy(false)
    }
  }

  const inputCls = 'w-full rounded-md border border-[#DAD4C7] p-1.5 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none'

  return (
    <Card
      title="Trust account"
      hint="Client funds held on trust for this matter."
      right={
        <button
          onClick={() => window.open(`/api/law-firm/admin/matters/${matter.id}/trust/statement/view`, '_blank', 'noopener')}
          className="rounded-md border border-[#1E3A5F] px-3 py-1.5 text-xs font-bold text-[#1E3A5F] hover:bg-[#FBFAF6]"
        >
          Trust statement
        </button>
      }
    >
      <div className="mb-4 rounded-md border border-[#E5E2D9] bg-[#FBFAF6] p-4">
        <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: GOLD }}>Current trust balance</p>
        <p className="mt-1 text-2xl font-bold" style={{ fontFamily: SERIF, color: NAVY }}>{money(balance, currency)}</p>
      </div>

      <div className="overflow-x-auto rounded-md border border-[#EFEAE0]">
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] font-bold uppercase tracking-wide text-white" style={{ backgroundColor: NAVY }}>
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Reference</th>
              <th className="px-3 py-2 text-right">In</th>
              <th className="px-3 py-2 text-right">Out</th>
              <th className="px-3 py-2 text-right">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EFEAE0]">
            {entries.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-4 text-center text-xs" style={{ color: MUTE }}>No trust movements yet.</td></tr>
            ) : entries.map((e) => {
              const inflow = TRUST_INFLOW.has(e.type)
              const amt = Number(e.amount) || 0
              return (
                <tr key={e.id} className="hover:bg-[#FBFAF6]">
                  <td className="px-3 py-2 text-slate-500">{fmtDate(e.createdAt)}</td>
                  <td className="px-3 py-2 text-slate-600">{TRUST_TYPE_LABEL[e.type] || e.type}{e.note ? ` · ${e.note}` : ''}</td>
                  <td className="px-3 py-2 text-slate-500">{e.reference || '—'}</td>
                  <td className="px-3 py-2 text-right text-emerald-700">{inflow ? money(amt, currency) : ''}</td>
                  <td className="px-3 py-2 text-right text-amber-700">{!inflow ? money(amt, currency) : ''}</td>
                  <td className="px-3 py-2 text-right font-semibold" style={{ color: NAVY }}>{money(e.balanceAfter, currency)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls} aria-label="Trust transaction type">
          {TRUST_TYPES.map((t) => <option key={t} value={t}>{TRUST_TYPE_LABEL[t]}</option>)}
        </select>
        <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" className={inputCls} aria-label="Amount" />
        <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Reference" className={inputCls} aria-label="Reference" />
        <button disabled={busy} onClick={add} className="rounded-md px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50" style={{ backgroundColor: NAVY }}>Add transaction</button>
      </div>

      <p className="mt-3 text-xs" style={{ color: MUTE }}>
        This is a simplified running ledger for matter bookkeeping, not a statutory trust-account reconciliation.
      </p>
    </Card>
  )
}

// ── DETAIL VIEW ───────────────────────────────────────────────────────────────

function MatterDetail({ matterId, lawyers, onBack }) {
  const [matter, setMatter] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [patching, setPatching] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [showEngagement, setShowEngagement] = useState(false)

  async function load(silent) {
    if (!silent) setLoading(true)
    setError('')
    try {
      const { data } = await axios.get(`/api/law-firm/admin/matters/${matterId}`, { withCredentials: true })
      setMatter(data?.matter || null)
    } catch (err) {
      setError(errMsg(err, 'Failed to load the matter'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [matterId])

  // auto-dismiss the success notice
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(t)
  }, [notice])

  async function patch(body) {
    setPatching(true)
    setError('')
    try {
      await axios.put(`/api/law-firm/admin/matters/${matterId}`, body, { withCredentials: true })
      await load(true)
    } catch (err) {
      setError(errMsg(err, 'Could not update the matter'))
    } finally {
      setPatching(false)
    }
  }

  async function acceptEngagement() {
    setAccepting(true)
    setError('')
    try {
      await axios.post(`/api/law-firm/admin/matters/${matterId}/engagement/accept`, {}, { withCredentials: true })
      setNotice('Engagement marked as accepted.')
      await load(true)
    } catch (err) {
      setError(errMsg(err, 'Could not mark the engagement accepted'))
    } finally {
      setAccepting(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <BackBar onBack={onBack} />
        <Spinner />
      </div>
    )
  }

  if (!matter) {
    return (
      <div className="space-y-4">
        <BackBar onBack={onBack} />
        <Banner error={error || 'Matter not found.'} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <BackBar onBack={onBack} />
      {error && <Banner error={error} />}
      {notice && <Banner notice={notice} />}

      <HeaderCard matter={matter} lawyers={lawyers} onPatch={patch} patching={patching} />
      <EngagementCard
        matter={matter}
        onOpenModal={() => setShowEngagement(true)}
        onAccept={acceptEngagement}
        accepting={accepting}
      />
      <WipCard matter={matter} onChanged={() => load(true)} setError={setError} />
      <InvoicesCard matter={matter} onChanged={() => load(true)} setError={setError} setNotice={setNotice} />
      <TrustCard matter={matter} onChanged={() => load(true)} setError={setError} setNotice={setNotice} />

      {showEngagement && (
        <EngagementModal
          matter={matter}
          onClose={() => setShowEngagement(false)}
          onIssued={async () => { setShowEngagement(false); setNotice('Engagement letter issued.'); await load(true) }}
        />
      )}
    </div>
  )
}

function BackBar({ onBack }) {
  return (
    <button
      onClick={onBack}
      className="inline-flex items-center gap-1.5 rounded-md border border-[#DAD4C7] bg-white px-3 py-1.5 text-sm font-semibold text-[#1E3A5F] hover:bg-[#FBFAF6]"
    >
      <span aria-hidden>←</span> All matters
    </button>
  )
}

// ── ROOT ──────────────────────────────────────────────────────────────────────

export default function MattersTab() {
  const [selectedId, setSelectedId] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const [lawyers, setLawyers] = useState([])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { data } = await axios.get('/api/business/staff', { withCredentials: true })
        if (alive) setLawyers(staffArray(data).filter((s) => s && s.id))
      } catch {
        if (alive) setLawyers([])
      }
    })()
    return () => { alive = false }
  }, [])

  if (selectedId) {
    return <MatterDetail matterId={selectedId} lawyers={lawyers} onBack={() => setSelectedId(null)} />
  }

  return (
    <>
      <MatterList onOpen={setSelectedId} onNew={() => setShowNew(true)} />
      {showNew && (
        <OpenMatterModal
          onClose={() => setShowNew(false)}
          onOpened={(id) => { setShowNew(false); setSelectedId(id) }}
        />
      )}
    </>
  )
}
