'use client'

import { useEffect, useState } from 'react'
import axios from 'axios'

// Service-visit board for the water_purifier theme: every scheduled / assigned /
// overdue / completed purifier visit in one filterable list. Technicians get
// assigned here, and a completed visit captures TDS, parts replaced and labour,
// optionally raising a repair invoice.

// Water "sky" palette.
const SKY = '#0EA5E9'
const ACCENT = '#0284C7'
const SOFT = '#E0F2FE'
const INK = '#0F172A'
const MUTE = '#64748B'
const LINE = '#E2E8F0'
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

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

function VisitStatusPill({ status }) {
  const meta = VISIT_STATUS_META[status] || { label: status || '—', cls: 'bg-slate-100 text-slate-600 ring-slate-200' }
  return <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ring-1 ring-inset ${meta.cls}`}>{meta.label}</span>
}

function FieldLabel({ children }) {
  return (
    <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide" style={{ color: ACCENT }}>
      {children}
    </span>
  )
}

function Banner({ error, notice }) {
  if (error) {
    return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</div>
  }
  if (notice) {
    return <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">{notice}</div>
  }
  return null
}

const inputCls = 'w-full rounded-md border p-2 text-sm text-slate-800 focus:outline-none'
const inputStyle = { borderColor: LINE }

// ── COMPLETE MODAL ────────────────────────────────────────────────────────────

function emptyPart() {
  return { part: '', qty: '1', amount: '' }
}

function CompleteVisitModal({ visit, onClose, onCompleted }) {
  const [tdsBefore, setTdsBefore] = useState(visit.tdsBefore != null ? String(visit.tdsBefore) : '')
  const [tdsAfter, setTdsAfter] = useState(visit.tdsAfter != null ? String(visit.tdsAfter) : '')
  const [parts, setParts] = useState(Array.isArray(visit.parts) && visit.parts.length
    ? visit.parts.map((p) => ({ part: p.part || '', qty: String(p.qty ?? 1), amount: String(p.amount ?? '') }))
    : [emptyPart()])
  const [labourCharge, setLabourCharge] = useState('')
  const [taxRate, setTaxRate] = useState('')
  const [notes, setNotes] = useState('')
  const [raiseInvoice, setRaiseInvoice] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function updatePart(idx, field, value) {
    setParts((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p)))
  }
  function addPart() {
    setParts((prev) => [...prev, emptyPart()])
  }
  function removePart(idx) {
    setParts((prev) => (prev.length <= 1 ? [emptyPart()] : prev.filter((_, i) => i !== idx)))
  }

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const partsReplaced = parts
        .filter((p) => p.part.trim() !== '' || p.amount !== '')
        .map((p) => ({
          part: p.part.trim(),
          qty: Number(p.qty) || 1,
          amount: Number(p.amount) || 0,
        }))
        .filter((p) => p.part !== '')
      const body = { partsReplaced, raiseInvoice }
      if (tdsBefore !== '') body.tdsBefore = Number(tdsBefore)
      if (tdsAfter !== '') body.tdsAfter = Number(tdsAfter)
      if (labourCharge !== '') body.labourCharge = Number(labourCharge)
      if (taxRate !== '') body.taxRate = Number(taxRate)
      if (notes.trim()) body.notes = notes.trim()
      const { data } = await axios.post(`/api/water-purifier/admin/visits/${visit.id}/complete`, body, { withCredentials: true })
      onCompleted(data?.invoice || null)
    } catch (err) {
      setError(errMsg(err, 'Could not complete the visit'))
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
            <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: ACCENT }}>Complete visit</p>
            <h2 className="text-base font-bold" style={{ color: INK }}>{visit.customerName || 'Service visit'}</h2>
            <p className="text-xs" style={{ color: MUTE }}>
              {visitKindLabel(visit.kind)}
              {visit.contract?.contractNumber ? ` · ${visit.contract.contractNumber}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-[#F0F9FF]">Close</button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {error && <Banner error={error} />}

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <FieldLabel>TDS before (ppm)</FieldLabel>
              <input type="number" min="0" step="1" value={tdsBefore} onChange={(e) => setTdsBefore(e.target.value)} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <FieldLabel>TDS after (ppm)</FieldLabel>
              <input type="number" min="0" step="1" value={tdsAfter} onChange={(e) => setTdsAfter(e.target.value)} className={inputCls} style={inputStyle} />
            </label>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <FieldLabel>Parts replaced</FieldLabel>
              <button onClick={addPart} className="text-[11px] font-bold hover:underline" style={{ color: ACCENT }}>+ Add part</button>
            </div>
            <div className="space-y-2">
              {parts.map((p, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2">
                  <input
                    value={p.part}
                    onChange={(e) => updatePart(idx, 'part', e.target.value)}
                    placeholder="Part name (e.g. RO membrane)"
                    className="col-span-6 rounded-md border p-1.5 text-sm text-slate-800 focus:outline-none"
                    style={inputStyle}
                    aria-label="Part name"
                  />
                  <input
                    type="number" min="1" step="1" value={p.qty}
                    onChange={(e) => updatePart(idx, 'qty', e.target.value)}
                    placeholder="Qty"
                    className="col-span-2 rounded-md border p-1.5 text-sm text-slate-800 focus:outline-none"
                    style={inputStyle}
                    aria-label="Quantity"
                  />
                  <input
                    type="number" min="0" step="0.01" value={p.amount}
                    onChange={(e) => updatePart(idx, 'amount', e.target.value)}
                    placeholder="Amount"
                    className="col-span-3 rounded-md border p-1.5 text-sm text-slate-800 focus:outline-none"
                    style={inputStyle}
                    aria-label="Amount"
                  />
                  <button
                    onClick={() => removePart(idx)}
                    className="col-span-1 rounded-md border text-sm font-bold text-red-600 hover:bg-red-50"
                    style={{ borderColor: LINE }}
                    aria-label="Remove part"
                    title="Remove part"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <FieldLabel>Labour charge</FieldLabel>
              <input type="number" min="0" step="0.01" value={labourCharge} onChange={(e) => setLabourCharge(e.target.value)} placeholder="0.00" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <FieldLabel>Tax %</FieldLabel>
              <input type="number" min="0" step="0.1" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="e.g. 18" className={inputCls} style={inputStyle} />
            </label>
          </div>

          <label className="block">
            <FieldLabel>Notes</FieldLabel>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Service notes for the customer record"
              className="w-full rounded-md border p-2.5 text-sm leading-6 text-slate-800 focus:outline-none" style={inputStyle} />
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={raiseInvoice} onChange={(e) => setRaiseInvoice(e.target.checked)} className="h-4 w-4" />
            Raise a repair invoice for the parts and labour
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t bg-[#F0F9FF] px-5 py-3" style={{ borderColor: LINE }}>
          <button onClick={onClose} className="rounded-md border bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-[#F0F9FF]" style={{ borderColor: LINE }}>Cancel</button>
          <button disabled={busy} onClick={submit} className="rounded-md px-4 py-2 text-sm font-bold text-white shadow-sm disabled:opacity-50" style={{ backgroundColor: SKY }}>
            {busy ? 'Completing…' : 'Complete visit'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── VISIT CARD ────────────────────────────────────────────────────────────────

function VisitCard({ visit, technicians, onAssign, onComplete, busyId }) {
  const [techId, setTechId] = useState(visit.technician?.id || '')
  useEffect(() => { setTechId(visit.technician?.id || '') }, [visit.technician?.id])
  const isDone = visit.status === 'DONE'
  const busy = busyId === visit.id

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm" style={{ borderColor: LINE }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <VisitStatusPill status={visit.status} />
            <span className="text-xs font-semibold text-slate-600">{visitKindLabel(visit.kind)}</span>
            {visit.contract?.contractNumber && (
              <span className="text-[11px] font-bold" style={{ color: ACCENT }}>{visit.contract.contractNumber}</span>
            )}
          </div>
          <p className="mt-1 truncate text-base font-bold" style={{ color: INK }}>{visit.customerName || 'Customer'}</p>
          <p className="mt-0.5 text-xs" style={{ color: MUTE }}>
            {visit.customerPhone ? visit.customerPhone : 'No phone'}
            {visit.pincode ? ` · ${visit.pincode}` : ''}
          </p>
          <p className="mt-0.5 text-xs" style={{ color: MUTE }}>
            Scheduled {fmtDate(visit.scheduledFor)}
            {visit.dueBy ? ` · due ${fmtDate(visit.dueBy)}` : ''}
            {visit.technician?.name ? ` · ${visit.technician.name}` : ' · unassigned'}
          </p>
          {isDone && (visit.tdsBefore != null || visit.tdsAfter != null) && (
            <p className="mt-0.5 text-xs" style={{ color: MUTE }}>
              TDS {visit.tdsBefore ?? '—'} → {visit.tdsAfter ?? '—'}
              {visit.billed != null ? ` · billed ${money(visit.billed)}` : ''}
            </p>
          )}
        </div>
      </div>

      {!isDone && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: SOFT }}>
          <select
            value={techId}
            onChange={(e) => setTechId(e.target.value)}
            disabled={busy}
            className="rounded-md border p-1.5 text-sm text-slate-800 focus:outline-none disabled:opacity-50"
            style={inputStyle}
            aria-label="Assign technician"
          >
            <option value="">Technician…</option>
            {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button
            disabled={busy || !techId}
            onClick={() => onAssign(visit, techId)}
            className="rounded-md border px-3 py-1.5 text-xs font-bold hover:bg-[#F0F9FF] disabled:opacity-50"
            style={{ borderColor: ACCENT, color: ACCENT }}
          >
            {busy ? 'Saving…' : 'Assign'}
          </button>
          <button
            disabled={busy}
            onClick={() => onComplete(visit)}
            className="rounded-md px-3 py-1.5 text-xs font-bold text-white shadow-sm disabled:opacity-50"
            style={{ backgroundColor: SKY }}
          >
            Complete
          </button>
        </div>
      )}
    </div>
  )
}

// ── ROOT ──────────────────────────────────────────────────────────────────────

const FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'SCHEDULED', label: 'Scheduled' },
  { key: 'ASSIGNED', label: 'Assigned' },
  { key: 'OVERDUE', label: 'Overdue' },
  { key: 'DONE', label: 'Done' },
]

export default function ServiceVisitsPanel() {
  const [visits, setVisits] = useState([])
  const [technicians, setTechnicians] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [filter, setFilter] = useState('ALL')
  const [busyId, setBusyId] = useState(null)
  const [completing, setCompleting] = useState(null)

  function visitsUrl(f) {
    if (f === 'OVERDUE') return '/api/water-purifier/admin/visits?due=overdue'
    if (f === 'ALL') return '/api/water-purifier/admin/visits'
    return `/api/water-purifier/admin/visits?status=${encodeURIComponent(f)}`
  }

  async function load(silent) {
    if (!silent) setLoading(true)
    setError('')
    try {
      const { data } = await axios.get(visitsUrl(filter), { withCredentials: true })
      setVisits(Array.isArray(data?.visits) ? data.visits : [])
    } catch (err) {
      setError(errMsg(err, 'Failed to load visits'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [filter])

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

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 5000)
    return () => clearTimeout(t)
  }, [notice])

  async function assign(visit, technicianId) {
    setBusyId(visit.id)
    setError('')
    try {
      await axios.put(`/api/water-purifier/admin/visits/${visit.id}/assign`, { technicianId, status: 'ASSIGNED' }, { withCredentials: true })
      setNotice('Technician assigned.')
      await load(true)
    } catch (err) {
      setError(errMsg(err, 'Could not assign the technician'))
    } finally {
      setBusyId(null)
    }
  }

  function onCompleted(invoice) {
    setCompleting(null)
    if (invoice?.invoiceNumber || invoice?.id) {
      const num = invoice.invoiceNumber || 'invoice'
      setNotice(
        <span>
          Visit completed · {num}{' '}
          {invoice.id && (
            <button
              onClick={() => window.open(`/api/water-purifier/admin/invoices/${invoice.id}/view`, '_blank', 'noopener')}
              className="font-bold underline"
              style={{ color: ACCENT }}
            >
              View invoice
            </button>
          )}
        </span>
      )
    } else {
      setNotice('Visit completed.')
    }
    load(true)
  }

  return (
    <div className="space-y-6" style={{ fontFamily: SANS }}>
      <div className="rounded-lg border bg-white p-6" style={{ borderColor: LINE, borderTop: `3px solid ${SKY}` }}>
        <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: ACCENT }}>Water purifier care</p>
        <h1 className="mt-2 text-2xl font-bold" style={{ color: INK }}>Service visits</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: '#475569' }}>
          Every preventive, filter-change and repair visit. Assign a technician, then complete the visit with TDS
          readings, parts replaced and labour — optionally raising a repair invoice.
        </p>
      </div>

      {error && <Banner error={error} />}
      {notice && <Banner notice={notice} />}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((c) => (
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
      ) : visits.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-white p-10 text-center text-sm" style={{ borderColor: LINE, color: MUTE }}>
          No visits in this view.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {visits.map((v) => (
            <VisitCard
              key={v.id}
              visit={v}
              technicians={technicians}
              onAssign={assign}
              onComplete={(visit) => setCompleting(visit)}
              busyId={busyId}
            />
          ))}
        </div>
      )}

      {completing && (
        <CompleteVisitModal
          visit={completing}
          onClose={() => setCompleting(null)}
          onCompleted={onCompleted}
        />
      )}
    </div>
  )
}
