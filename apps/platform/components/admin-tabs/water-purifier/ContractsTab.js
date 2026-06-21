'use client'

import { useEffect, useState } from 'react'
import axios from 'axios'

// AMC contract workspace for the water_purifier theme: the spine that ties a
// purifier service-request → an Annual Maintenance Contract → scheduled service
// visits → AMC + repair invoicing. Two views live in this one component
// (list ⇄ detail) so the admin shell only mounts a single tab.

// Water "sky" palette.
const SKY = '#0EA5E9'
const ACCENT = '#0284C7'
const SOFT = '#E0F2FE'
const SOFTER = '#F0F9FF'
const INK = '#0F172A'
const MUTE = '#64748B'
const LINE = '#E2E8F0'
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

const TIERS = ['BASIC', 'STANDARD', 'PREMIUM', 'COMPREHENSIVE']
const TIER_LABEL = {
  BASIC: 'Basic',
  STANDARD: 'Standard',
  PREMIUM: 'Premium',
  COMPREHENSIVE: 'Comprehensive',
}

const STATUS_META = {
  PROSPECT: { label: 'Prospect', cls: 'bg-[#F0F9FF] text-[#0284C7] ring-[#BAE6FD]' },
  ACTIVE: { label: 'Active', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  EXPIRED: { label: 'Expired', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-slate-100 text-slate-600 ring-slate-200' },
}
const STATUS_OPTIONS = ['PROSPECT', 'ACTIVE', 'EXPIRED', 'CANCELLED']

const VISIT_KINDS = ['PREVENTIVE', 'FILTER_CHANGE', 'REPAIR', 'INSTALLATION', 'INSPECTION']
const VISIT_KIND_LABEL = {
  PREVENTIVE: 'Preventive service',
  FILTER_CHANGE: 'Filter change',
  REPAIR: 'Repair',
  INSTALLATION: 'Installation',
  INSPECTION: 'Inspection',
}

const VISIT_STATUS_META = {
  SCHEDULED: { label: 'Scheduled', cls: 'bg-[#F0F9FF] text-[#0284C7] ring-[#BAE6FD]' },
  ASSIGNED: { label: 'Assigned', cls: 'bg-sky-50 text-sky-700 ring-sky-200' },
  EN_ROUTE: { label: 'En route', cls: 'bg-indigo-50 text-indigo-700 ring-indigo-200' },
  DONE: { label: 'Done', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  MISSED: { label: 'Missed', cls: 'bg-red-50 text-red-700 ring-red-200' },
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
    return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return '—'
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function tierLabel(t) {
  if (!t) return '—'
  return TIER_LABEL[t] || t
}

function visitKindLabel(k) {
  if (!k) return 'Service'
  return VISIT_KIND_LABEL[k] || k
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
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#0EA5E9] border-t-transparent" />
    </div>
  )
}

function StatusPill({ status }) {
  const meta = STATUS_META[status] || { label: status || '—', cls: 'bg-slate-100 text-slate-600 ring-slate-200' }
  return <span className={`rounded-md px-2 py-0.5 text-xs font-bold ring-1 ring-inset ${meta.cls}`}>{meta.label}</span>
}

function TierPill({ tier }) {
  return (
    <span className="rounded-md px-2 py-0.5 text-xs font-bold ring-1 ring-inset bg-[#F0F9FF] text-[#0284C7] ring-[#BAE6FD]">
      {tierLabel(tier)}
    </span>
  )
}

function VisitStatusPill({ status }) {
  const meta = VISIT_STATUS_META[status] || { label: status || '—', cls: 'bg-slate-100 text-slate-600 ring-slate-200' }
  return <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ring-1 ring-inset ${meta.cls}`}>{meta.label}</span>
}

function InvoiceStatusPill({ status }) {
  const map = {
    PAID: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    PARTIAL: 'bg-amber-50 text-amber-800 ring-amber-200',
    SENT: 'bg-sky-50 text-sky-700 ring-sky-200',
    ISSUED: 'bg-sky-50 text-sky-700 ring-sky-200',
    DRAFT: 'bg-[#F0F9FF] text-slate-500 ring-[#BAE6FD]',
    VOID: 'bg-slate-100 text-slate-500 ring-slate-200',
    OVERDUE: 'bg-red-50 text-red-700 ring-red-200',
  }
  const cls = map[status] || 'bg-slate-100 text-slate-600 ring-slate-200'
  const label = status ? status.charAt(0) + status.slice(1).toLowerCase() : '—'
  return <span className={`rounded-md px-2 py-0.5 text-xs font-bold ring-1 ring-inset ${cls}`}>{label}</span>
}

function FieldLabel({ children }) {
  return (
    <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide" style={{ color: ACCENT }}>
      {children}
    </span>
  )
}

function Card({ title, hint, right, children }) {
  return (
    <section className="rounded-lg border bg-white p-5 shadow-sm" style={{ borderColor: LINE, fontFamily: SANS }}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b pb-3" style={{ borderColor: SOFT }}>
        <div>
          <h3 className="text-base font-bold" style={{ color: INK }}>{title}</h3>
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

const inputCls = 'w-full rounded-md border p-2 text-sm text-slate-800 focus:outline-none'
const inputStyle = { borderColor: LINE }

// ── LIST VIEW ─────────────────────────────────────────────────────────────────

function Figure({ label, value, tone }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: ACCENT }}>{label}</p>
      <p className={`mt-0.5 text-sm font-bold ${tone === 'warn' ? 'text-amber-700' : ''}`} style={tone === 'warn' ? undefined : { color: INK }}>
        {value}
      </p>
    </div>
  )
}

function ContractRow({ contract, onOpen }) {
  const c = contract.customer || {}
  const included = Number(contract.visitsIncluded) || 0
  const used = Number(contract.visitsUsed) || 0
  return (
    <button
      onClick={() => onOpen(contract.id)}
      className="w-full rounded-lg border bg-white p-4 text-left shadow-sm transition-colors hover:bg-[#F0F9FF]"
      style={{ borderColor: LINE, fontFamily: SANS }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold" style={{ color: ACCENT }}>{contract.contractNumber || '—'}</span>
            <TierPill tier={contract.tier} />
            <StatusPill status={contract.status} />
          </div>
          <p className="mt-1 truncate text-base font-bold" style={{ color: INK }}>
            {c.name || 'No customer'}
          </p>
          <p className="mt-0.5 text-xs" style={{ color: MUTE }}>
            {contract.technician?.name ? `Tech: ${contract.technician.name}` : 'Unassigned technician'}
            {contract.unit?.brand ? ` · ${contract.unit.brand}${contract.unit.model ? ` ${contract.unit.model}` : ''}` : ''}
            {contract.unit?.pincode ? ` · ${contract.unit.pincode}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-4 text-right">
          <Figure label="Visits" value={`${used} / ${included}`} />
          <Figure label="AMC fee" value={money(contract.price, contract.currency)} />
          <Figure label="Expires" value={fmtDate(contract.endDate)} />
        </div>
      </div>
    </button>
  )
}

function ContractList({ onOpen, onNew }) {
  const [contracts, setContracts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('ALL')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const url = filter === 'ALL'
        ? '/api/water-purifier/admin/contracts'
        : `/api/water-purifier/admin/contracts?status=${encodeURIComponent(filter)}`
      const { data } = await axios.get(url, { withCredentials: true })
      setContracts(Array.isArray(data?.contracts) ? data.contracts : [])
    } catch (err) {
      setError(errMsg(err, 'Failed to load contracts'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [filter])

  const counts = contracts.reduce((acc, m) => {
    const s = m.status || 'PROSPECT'
    acc[s] = (acc[s] || 0) + 1
    return acc
  }, {})

  // When a specific status is selected the server already filtered, so the
  // total for that chip reflects the current page; "All" counts everything.
  const chips = [
    { key: 'ALL', label: `All${filter === 'ALL' ? ` (${contracts.length})` : ''}` },
    { key: 'ACTIVE', label: `Active${filter === 'ALL' ? ` (${counts.ACTIVE || 0})` : ''}` },
    { key: 'PROSPECT', label: `Prospect${filter === 'ALL' ? ` (${counts.PROSPECT || 0})` : ''}` },
    { key: 'EXPIRED', label: `Expired${filter === 'ALL' ? ` (${counts.EXPIRED || 0})` : ''}` },
    { key: 'CANCELLED', label: `Cancelled${filter === 'ALL' ? ` (${counts.CANCELLED || 0})` : ''}` },
  ]

  return (
    <div className="space-y-6" style={{ fontFamily: SANS }}>
      <div className="rounded-lg border bg-white p-6" style={{ borderColor: LINE, borderTop: `3px solid ${SKY}` }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: ACCENT }}>Water purifier care</p>
            <h1 className="mt-2 text-2xl font-bold" style={{ color: INK }}>AMC contracts</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: '#475569' }}>
              Open an Annual Maintenance Contract from a service request or from scratch, schedule preventive
              and filter-change visits, and bill the AMC fee plus any repair parts and labour.
            </p>
          </div>
          <button
            onClick={onNew}
            className="rounded-md px-4 py-2 text-sm font-bold text-white shadow-sm hover:opacity-95"
            style={{ backgroundColor: SKY }}
          >
            New contract
          </button>
        </div>
      </div>

      <Banner error={error} />

      <div className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => setFilter(c.key)}
            className="rounded-md border px-3 py-1.5 text-xs font-bold transition-colors"
            style={
              filter === c.key
                ? { backgroundColor: SKY, borderColor: SKY, color: '#fff' }
                : { backgroundColor: '#fff', borderColor: LINE, color: MUTE }
            }
          >
            {c.label}
          </button>
        ))}
      </div>

      {loading ? (
        <Spinner />
      ) : contracts.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-white p-10 text-center text-sm" style={{ borderColor: LINE, color: MUTE }}>
          No contracts in this view yet. Create one from a service request or start a blank AMC.
        </div>
      ) : (
        <div className="grid gap-3">
          {contracts.map((m) => (
            <ContractRow key={m.id} contract={m} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── NEW CONTRACT MODAL ────────────────────────────────────────────────────────

function NewContractModal({ technicians, onClose, onCreated }) {
  const [tab, setTab] = useState('blank')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // open-from-visit
  const [appointmentId, setAppointmentId] = useState('')

  // blank-contract fields
  const [customerId, setCustomerId] = useState('')
  const [tier, setTier] = useState('STANDARD')
  const [termMonths, setTermMonths] = useState('12')
  const [price, setPrice] = useState('')
  const [visitsIncluded, setVisitsIncluded] = useState('4')
  const [technicianId, setTechnicianId] = useState('')
  const [autoSchedule, setAutoSchedule] = useState(true)

  async function createFromVisit() {
    if (!appointmentId.trim()) { setError('Enter the service-request / appointment id.'); return }
    setBusy(true)
    setError('')
    try {
      const { data } = await axios.post('/api/water-purifier/admin/contracts', { appointmentId: appointmentId.trim() }, { withCredentials: true })
      const id = data?.contract?.id
      if (id) onCreated(id)
      else setError('Contract created but no id was returned.')
    } catch (err) {
      setError(errMsg(err, 'Could not create the contract'))
    } finally {
      setBusy(false)
    }
  }

  async function createBlank() {
    setBusy(true)
    setError('')
    try {
      const body = { tier, autoSchedule }
      if (customerId.trim()) body.customerId = customerId.trim()
      if (termMonths !== '') body.termMonths = Number(termMonths)
      if (price !== '') body.price = Number(price)
      if (visitsIncluded !== '') body.visitsIncluded = Number(visitsIncluded)
      if (technicianId) body.responsibleTechnicianId = technicianId
      const { data } = await axios.post('/api/water-purifier/admin/contracts', body, { withCredentials: true })
      const id = data?.contract?.id
      if (id) onCreated(id)
      else setError('Contract created but no id was returned.')
    } catch (err) {
      setError(errMsg(err, 'Could not create the contract'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/55 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      style={{ fontFamily: SANS }}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3" style={{ borderColor: LINE, boxShadow: `inset 0 3px 0 ${SKY}` }}>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: ACCENT }}>New contract</p>
            <h2 className="text-base font-bold" style={{ color: INK }}>Create an AMC</h2>
          </div>
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-[#F0F9FF]">Close</button>
        </div>

        <div className="flex gap-2 border-b px-5 pt-3" style={{ borderColor: SOFT }}>
          {[
            { key: 'blank', label: 'New contract' },
            { key: 'visit', label: 'From a service request' },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setError('') }}
              className="rounded-t-md border-b-2 px-3 py-2 text-sm font-bold transition-colors"
              style={tab === t.key ? { borderColor: SKY, color: ACCENT } : { borderColor: 'transparent', color: MUTE }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {error && <div className="mb-3"><Banner error={error} /></div>}

          {tab === 'visit' ? (
            <div className="space-y-3">
              <p className="text-sm" style={{ color: MUTE }}>
                Convert an existing service-request / appointment into an AMC. The customer, unit and history are
                carried across automatically.
              </p>
              <label className="block">
                <FieldLabel>Service-request / appointment id</FieldLabel>
                <input
                  value={appointmentId}
                  onChange={(e) => setAppointmentId(e.target.value)}
                  placeholder="e.g. appt_8h2k…"
                  className={inputCls}
                  style={inputStyle}
                />
              </label>
              <div className="flex justify-end pt-1">
                <button
                  disabled={busy}
                  onClick={createFromVisit}
                  className="rounded-md px-4 py-2 text-sm font-bold text-white shadow-sm disabled:opacity-50"
                  style={{ backgroundColor: SKY }}
                >
                  {busy ? 'Creating…' : 'Create from request'}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="block">
                <FieldLabel>Customer id (optional)</FieldLabel>
                <input
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  placeholder="Link an existing customer, or leave blank"
                  className={inputCls}
                  style={inputStyle}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <FieldLabel>Plan tier</FieldLabel>
                  <select value={tier} onChange={(e) => setTier(e.target.value)} className={inputCls} style={inputStyle}>
                    {TIERS.map((t) => <option key={t} value={t}>{tierLabel(t)}</option>)}
                  </select>
                </label>
                <label className="block">
                  <FieldLabel>Term (months)</FieldLabel>
                  <input type="number" min="1" step="1" value={termMonths} onChange={(e) => setTermMonths(e.target.value)} className={inputCls} style={inputStyle} />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <FieldLabel>AMC fee (optional)</FieldLabel>
                  <input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Defaults to plan price" className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <FieldLabel>Visits included</FieldLabel>
                  <input type="number" min="0" step="1" value={visitsIncluded} onChange={(e) => setVisitsIncluded(e.target.value)} className={inputCls} style={inputStyle} />
                </label>
              </div>
              <label className="block">
                <FieldLabel>Responsible technician (optional)</FieldLabel>
                <select value={technicianId} onChange={(e) => setTechnicianId(e.target.value)} className={inputCls} style={inputStyle}>
                  <option value="">Unassigned</option>
                  {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 pt-1 text-sm text-slate-700">
                <input type="checkbox" checked={autoSchedule} onChange={(e) => setAutoSchedule(e.target.checked)} className="h-4 w-4" />
                Auto-schedule the included visits across the term
              </label>
              <div className="flex justify-end pt-1">
                <button
                  disabled={busy}
                  onClick={createBlank}
                  className="rounded-md px-4 py-2 text-sm font-bold text-white shadow-sm disabled:opacity-50"
                  style={{ backgroundColor: SKY }}
                >
                  {busy ? 'Creating…' : 'Create contract'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── DETAIL: sub-cards ─────────────────────────────────────────────────────────

function HeaderCard({ contract, technicians, onPatch, patching }) {
  const c = contract.customer || {}
  const u = contract.unit || {}
  const [price, setPrice] = useState(contract.price ?? '')
  useEffect(() => { setPrice(contract.price ?? '') }, [contract.price])

  return (
    <section className="rounded-lg border bg-white p-6 shadow-sm" style={{ borderColor: LINE, borderTop: `3px solid ${SKY}`, fontFamily: SANS }}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold" style={{ color: ACCENT }}>{contract.contractNumber || '—'}</span>
            <TierPill tier={contract.tier} />
            <StatusPill status={contract.status} />
          </div>
          <h1 className="mt-1 text-2xl font-bold" style={{ color: INK }}>{c.name || 'No customer'}</h1>
          <p className="mt-1 text-sm" style={{ color: MUTE }}>
            {c.email ? c.email : ''}
            {c.email && c.phone ? ' · ' : ''}
            {c.phone ? c.phone : ''}
            {!c.email && !c.phone ? 'No contact on file' : ''}
          </p>
          <p className="mt-0.5 text-xs" style={{ color: MUTE }}>
            {u.brand ? `${u.brand}${u.model ? ` ${u.model}` : ''}` : 'No unit on file'}
            {u.purifierType ? ` · ${u.purifierType}` : ''}
            {u.pincode ? ` · ${u.pincode}` : ''}
            {u.lastTds != null ? ` · last TDS ${u.lastTds}` : ''}
          </p>
          <p className="mt-0.5 text-xs" style={{ color: MUTE }}>
            Term {fmtDate(contract.startDate)} → {fmtDate(contract.endDate)}
            {contract.nextVisitDueAt ? ` · next visit due ${fmtDate(contract.nextVisitDueAt)}` : ''}
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <FieldLabel>Responsible technician</FieldLabel>
          <select
            disabled={patching}
            value={contract.technician?.id || ''}
            onChange={(e) => onPatch({ responsibleTechnicianId: e.target.value || null })}
            className={`${inputCls} disabled:opacity-50`}
            style={inputStyle}
          >
            <option value="">Unassigned</option>
            {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="block">
          <FieldLabel>Status</FieldLabel>
          <select
            disabled={patching}
            value={contract.status || 'PROSPECT'}
            onChange={(e) => onPatch({ status: e.target.value })}
            className={`${inputCls} disabled:opacity-50`}
            style={inputStyle}
          >
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_META[s]?.label || s}</option>)}
          </select>
        </label>
        <label className="block">
          <FieldLabel>Plan tier</FieldLabel>
          <select
            disabled={patching}
            value={contract.tier || 'STANDARD'}
            onChange={(e) => onPatch({ tier: e.target.value })}
            className={`${inputCls} disabled:opacity-50`}
            style={inputStyle}
          >
            {TIERS.map((t) => <option key={t} value={t}>{tierLabel(t)}</option>)}
          </select>
        </label>
        <label className="block">
          <FieldLabel>AMC fee ({contract.currency || '—'})</FieldLabel>
          <input
            type="number" min="0" step="0.01" value={price} disabled={patching}
            onChange={(e) => setPrice(e.target.value)}
            onBlur={() => { if (String(price) !== String(contract.price ?? '')) onPatch({ price: price === '' ? null : Number(price) }) }}
            className={`${inputCls} disabled:opacity-50`}
            style={inputStyle}
          />
        </label>
      </div>
    </section>
  )
}

function KpiStrip({ contract }) {
  const currency = contract.currency
  const billing = contract.billing || {}
  const included = Number(contract.visitsIncluded) || 0
  const used = Number(contract.visitsUsed) || 0
  const remaining = contract.visitsRemaining != null
    ? (Number(contract.visitsRemaining) || 0)
    : Math.max(included - used, 0)
  const items = [
    { label: 'Visits used', value: `${used} / ${included}` },
    { label: 'Visits remaining', value: remaining },
    { label: 'Billed', value: money(billing.billedTotal, currency) },
    { label: 'Paid', value: money(billing.paidTotal, currency) },
    { label: 'Outstanding', value: money(billing.outstanding, currency), warn: (Number(billing.outstanding) || 0) > 0 },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5" style={{ fontFamily: SANS }}>
      {items.map((it) => (
        <div key={it.label} className="rounded-lg border bg-white p-4 shadow-sm" style={{ borderColor: LINE }}>
          <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: ACCENT }}>{it.label}</p>
          <p className={`mt-1 text-xl font-bold ${it.warn ? 'text-amber-700' : ''}`} style={it.warn ? undefined : { color: INK }}>{it.value}</p>
        </div>
      ))}
    </div>
  )
}

function VisitsCard({ contract, technicians, onChanged, setError, setNotice }) {
  const visits = Array.isArray(contract.visits) ? contract.visits : []
  const currency = contract.currency
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState('PREVENTIVE')
  const [scheduledFor, setScheduledFor] = useState(todayISO())
  const [dueBy, setDueBy] = useState('')
  const [technicianId, setTechnicianId] = useState('')
  const [notes, setNotes] = useState('')

  async function schedule() {
    if (!scheduledFor) { setError('Pick a date for the visit.'); return }
    setBusy(true)
    try {
      const body = { kind, scheduledFor }
      if (dueBy) body.dueBy = dueBy
      if (technicianId) body.technicianId = technicianId
      if (notes.trim()) body.notes = notes.trim()
      await axios.post(`/api/water-purifier/admin/contracts/${contract.id}/visits`, body, { withCredentials: true })
      setNotes('')
      setNotice('Service visit scheduled.')
      await onChanged()
    } catch (err) {
      setError(errMsg(err, 'Could not schedule the visit'))
    } finally {
      setBusy(false)
    }
  }

  const smallInput = 'w-full rounded-md border p-1.5 text-sm text-slate-800 focus:outline-none'

  return (
    <Card title="Service visits" hint="Preventive service, filter changes and repairs against this contract.">
      <div className="overflow-x-auto rounded-md border" style={{ borderColor: SOFT }}>
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] font-bold uppercase tracking-wide text-white" style={{ backgroundColor: ACCENT }}>
            <tr>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Scheduled</th>
              <th className="px-3 py-2">Technician</th>
              <th className="px-3 py-2">TDS in/out</th>
              <th className="px-3 py-2 text-right">Billed</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y" style={{ borderColor: SOFT }}>
            {visits.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-4 text-center text-xs" style={{ color: MUTE }}>No visits scheduled yet.</td></tr>
            ) : visits.map((v) => (
              <tr key={v.id} className="hover:bg-[#F0F9FF]">
                <td className="px-3 py-2 text-slate-700">{visitKindLabel(v.kind)}</td>
                <td className="px-3 py-2 text-slate-500">{fmtDate(v.scheduledFor)}{v.completedAt ? ` · done ${fmtDate(v.completedAt)}` : ''}</td>
                <td className="px-3 py-2 text-slate-600">{v.technician?.name || '—'}</td>
                <td className="px-3 py-2 text-slate-500">
                  {v.tdsBefore != null || v.tdsAfter != null ? `${v.tdsBefore ?? '—'} → ${v.tdsAfter ?? '—'}` : '—'}
                </td>
                <td className="px-3 py-2 text-right font-semibold" style={{ color: INK }}>{v.billed != null ? money(v.billed, currency) : '—'}</td>
                <td className="px-3 py-2"><VisitStatusPill status={v.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-6">
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={smallInput} style={inputStyle} aria-label="Visit kind">
          {VISIT_KINDS.map((k) => <option key={k} value={k}>{visitKindLabel(k)}</option>)}
        </select>
        <input type="date" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} className={smallInput} style={inputStyle} aria-label="Scheduled date" />
        <input type="date" value={dueBy} onChange={(e) => setDueBy(e.target.value)} className={smallInput} style={inputStyle} aria-label="Due by" />
        <select value={technicianId} onChange={(e) => setTechnicianId(e.target.value)} className={smallInput} style={inputStyle} aria-label="Technician">
          <option value="">Technician…</option>
          {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" className={smallInput} style={inputStyle} aria-label="Notes" />
        <button disabled={busy} onClick={schedule} className="rounded-md px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50" style={{ backgroundColor: SKY }}>
          {busy ? 'Scheduling…' : 'Schedule visit'}
        </button>
      </div>
    </Card>
  )
}

function InvoicesCard({ contract, onChanged, setError, setNotice }) {
  const currency = contract.currency
  const invoices = Array.isArray(contract.invoices) ? contract.invoices : []
  const [busy, setBusy] = useState(false)
  const [taxRate, setTaxRate] = useState('')

  async function generate() {
    setBusy(true)
    try {
      const body = {}
      if (taxRate !== '') body.taxRate = Number(taxRate)
      await axios.post(`/api/water-purifier/admin/contracts/${contract.id}/invoices`, body, { withCredentials: true })
      setNotice('AMC invoice generated.')
      await onChanged()
    } catch (err) {
      setError(errMsg(err, 'Could not generate the invoice'))
    } finally {
      setBusy(false)
    }
  }

  async function recordPayment(inv) {
    const cur = inv.currency || currency
    const raw = window.prompt(`Record a payment against ${inv.invoiceNumber || 'this invoice'} (balance ${money(inv.balance, cur)}):`, String(inv.balance ?? ''))
    if (raw == null) return
    const amount = Number(raw)
    if (!Number.isFinite(amount) || amount <= 0) { setError('Enter a valid payment amount.'); return }
    setBusy(true)
    try {
      await axios.post(`/api/water-purifier/admin/invoices/${inv.id}/payment`, { amount }, { withCredentials: true })
      setNotice('Payment recorded.')
      await onChanged()
    } catch (err) {
      setError(errMsg(err, 'Could not record the payment'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Invoices"
      hint="Bill the AMC fee, record payments, and view repair invoices raised from visits."
      right={
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number" min="0" step="0.1" value={taxRate} onChange={(e) => setTaxRate(e.target.value)}
            placeholder="Tax %" aria-label="Tax rate percent"
            className="w-20 rounded-md border p-1.5 text-sm text-slate-800 focus:outline-none"
            style={inputStyle}
          />
          <button
            disabled={busy}
            onClick={generate}
            className="rounded-md px-3 py-1.5 text-xs font-bold text-white shadow-sm disabled:opacity-50"
            style={{ backgroundColor: SKY }}
          >
            {busy ? 'Generating…' : 'Generate AMC invoice'}
          </button>
        </div>
      }
    >
      {invoices.length === 0 ? (
        <div className="rounded-md border border-dashed bg-[#F0F9FF] p-6 text-center text-sm" style={{ borderColor: LINE, color: MUTE }}>
          No invoices yet. Generate the AMC invoice above, or complete a visit with a repair charge.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border" style={{ borderColor: SOFT }}>
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] font-bold uppercase tracking-wide text-white" style={{ backgroundColor: ACCENT }}>
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
            <tbody className="divide-y" style={{ borderColor: SOFT }}>
              {invoices.map((inv) => {
                const cur = inv.currency || currency
                const balance = Number(inv.balance) || 0
                return (
                  <tr key={inv.id} className="hover:bg-[#F0F9FF]">
                    <td className="px-3 py-2 font-semibold" style={{ color: INK }}>{inv.invoiceNumber || '—'}</td>
                    <td className="px-3 py-2 text-slate-500">{fmtDate(inv.issuedAt)}</td>
                    <td className="px-3 py-2 text-right text-slate-700">{money(inv.total, cur)}</td>
                    <td className="px-3 py-2 text-right text-slate-700">{money(inv.amountPaid, cur)}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${balance > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{money(balance, cur)}</td>
                    <td className="px-3 py-2"><InvoiceStatusPill status={inv.status} /></td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <button
                          onClick={() => window.open(`/api/water-purifier/admin/invoices/${inv.id}/view`, '_blank', 'noopener')}
                          className="rounded-md border px-2 py-1 text-[11px] font-bold hover:bg-[#F0F9FF]"
                          style={{ borderColor: ACCENT, color: ACCENT }}
                        >
                          View
                        </button>
                        {balance > 0 && (
                          <button
                            disabled={busy}
                            onClick={() => recordPayment(inv)}
                            className="rounded-md border px-2 py-1 text-[11px] font-bold hover:bg-[#F0F9FF] disabled:opacity-50"
                            style={{ borderColor: ACCENT, color: ACCENT }}
                          >
                            Record payment
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

// ── DETAIL VIEW ───────────────────────────────────────────────────────────────

function BackBar({ onBack }) {
  return (
    <button
      onClick={onBack}
      className="inline-flex items-center gap-1.5 rounded-md border bg-white px-3 py-1.5 text-sm font-semibold hover:bg-[#F0F9FF]"
      style={{ borderColor: LINE, color: ACCENT, fontFamily: SANS }}
    >
      <span aria-hidden>←</span> All contracts
    </button>
  )
}

function ContractDetail({ contractId, technicians, onBack }) {
  const [contract, setContract] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [patching, setPatching] = useState(false)

  async function load(silent) {
    if (!silent) setLoading(true)
    setError('')
    try {
      const { data } = await axios.get(`/api/water-purifier/admin/contracts/${contractId}`, { withCredentials: true })
      setContract(data?.contract || null)
    } catch (err) {
      setError(errMsg(err, 'Failed to load the contract'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [contractId])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(t)
  }, [notice])

  async function patch(body) {
    setPatching(true)
    setError('')
    try {
      await axios.put(`/api/water-purifier/admin/contracts/${contractId}`, body, { withCredentials: true })
      await load(true)
    } catch (err) {
      setError(errMsg(err, 'Could not update the contract'))
    } finally {
      setPatching(false)
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

  if (!contract) {
    return (
      <div className="space-y-4">
        <BackBar onBack={onBack} />
        <Banner error={error || 'Contract not found.'} />
      </div>
    )
  }

  return (
    <div className="space-y-6" style={{ fontFamily: SANS }}>
      <BackBar onBack={onBack} />
      {error && <Banner error={error} />}
      {notice && <Banner notice={notice} />}

      <HeaderCard contract={contract} technicians={technicians} onPatch={patch} patching={patching} />
      <KpiStrip contract={contract} />
      <VisitsCard contract={contract} technicians={technicians} onChanged={() => load(true)} setError={setError} setNotice={setNotice} />
      <InvoicesCard contract={contract} onChanged={() => load(true)} setError={setError} setNotice={setNotice} />
    </div>
  )
}

// ── ROOT ──────────────────────────────────────────────────────────────────────

export default function ContractsTab() {
  const [selectedId, setSelectedId] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const [technicians, setTechnicians] = useState([])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { data } = await axios.get('/api/business/staff', { withCredentials: true })
        if (alive) setTechnicians(staffArray(data).filter((s) => s && s.id))
      } catch {
        if (alive) setTechnicians([])
      }
    })()
    return () => { alive = false }
  }, [])

  if (selectedId) {
    return <ContractDetail contractId={selectedId} technicians={technicians} onBack={() => setSelectedId(null)} />
  }

  return (
    <>
      <ContractList onOpen={setSelectedId} onNew={() => setShowNew(true)} />
      {showNew && (
        <NewContractModal
          technicians={technicians}
          onClose={() => setShowNew(false)}
          onCreated={(id) => { setShowNew(false); setSelectedId(id) }}
        />
      )}
    </>
  )
}
