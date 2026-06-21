'use client'

import { useEffect, useState } from 'react'
import axios from 'axios'

// Conflict-of-interest workspace for the law_firm theme. Every consultation
// request lands PENDING; the firm reviews the matter and the other parties
// here, then Clears / Flags / Waives the conflict check. CLEARED unlocks
// confirming the appointment (enforced server-side in
// appointment.controller.updateStatus).

// Premium legal palette — matches the navy/gold storefront.
const NAVY = '#1E3A5F'
const GOLD = '#B8862E'
const SERIF = 'Georgia, "Times New Roman", serif'

const STATUS_META = {
  PENDING:  { label: 'Conflict check pending', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  CLEARED:  { label: 'Cleared — ready to confirm', cls: 'bg-emerald-50 text-emerald-800 border-emerald-300' },
  CONFLICT: { label: 'Conflict found', cls: 'bg-red-50 text-red-800 border-red-200' },
  WAIVED:   { label: 'Waived — informed consent', cls: 'bg-[#FBFAF6] text-[#1E3A5F] border-[#E5E2D9]' },
}

function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#1E3A5F] border-t-transparent" />
    </div>
  )
}

function fmtDate(d) {
  if (!d) return '—'
  try { return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) } catch { return '—' }
}

function ConsultationCard({ row, onAction }) {
  const intake = row.intake || {}
  const status = intake.conflictStatus || 'PENDING'
  const meta = STATUS_META[status] || STATUS_META.PENDING
  const [notes, setNotes] = useState(intake.conflictNotes || '')
  const [busy, setBusy] = useState('')

  async function act(next) {
    setBusy(next)
    try { await onAction(row.appointmentId, next, notes) } finally { setBusy('') }
  }

  return (
    <div className="rounded-lg border border-[#E5E2D9] bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#EFEAE0] pb-3">
        <div>
          <p className="text-base font-bold" style={{ fontFamily: SERIF, color: NAVY }}>{row.clientName || 'Prospective client'}</p>
          <p className="text-xs text-slate-500">
            {[row.clientEmail, row.clientPhone].filter(Boolean).join(' · ') || 'No contact'}
          </p>
        </div>
        <span className={`rounded-md border px-2.5 py-1 text-xs font-bold ${meta.cls}`}>{meta.label}</span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Detail label="Matter type">{intake.matterType || row.serviceName || 'Consultation'}</Detail>
        <Detail label="Consultation">{fmtDate(row.date)} · {row.startTime}{row.lawyerName ? ` · ${row.lawyerName}` : ''}</Detail>
        <Detail label="Format">{intake.format === 'VIDEO' ? 'Video call' : intake.format === 'PHONE' ? 'Phone' : 'In person'}</Detail>
        <Detail label="Existing client">{intake.existingClient || '—'}</Detail>
        <Detail label="Photo ID (AML/CFT)">{intake.idDocumentType || '—'}</Detail>
        <Detail label="Deadline">{intake.deadline || '—'}</Detail>
      </div>

      {intake.matterSummary && (
        <div className="mt-3">
          <Detail label="Matter summary">{intake.matterSummary}</Detail>
        </div>
      )}

      <div className="mt-3 rounded-md border border-red-100 bg-red-50/60 p-3">
        <p className="text-[11px] font-bold uppercase tracking-wide text-red-700">Other parties — run conflict check</p>
        <p className="mt-1 text-sm font-semibold text-slate-800">{intake.opposingParty || 'None stated'}</p>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Consents: conflict-of-interest {intake.conflictConsentAt ? '✓' : '—'} · AML/CFT {intake.amlConsentAt ? '✓' : '—'}
        {intake.referralSource ? ` · via ${intake.referralSource}` : ''}
      </p>

      <label className="mt-3 block">
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide" style={{ color: GOLD }}>Conflict-check note</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Who was searched, the outcome, and any waiver basis…"
          className="w-full resize-none rounded-md border border-[#DAD4C7] px-3 py-2 text-sm text-slate-800 outline-none focus:border-[#1E3A5F]"
        />
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => act('CLEARED')} disabled={!!busy}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50">
          {busy === 'CLEARED' ? 'Clearing…' : 'Clear — no conflict'}
        </button>
        <button onClick={() => act('CONFLICT')} disabled={!!busy}
          className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-800 disabled:opacity-50">
          {busy === 'CONFLICT' ? 'Saving…' : 'Flag conflict'}
        </button>
        <button onClick={() => act('WAIVED')} disabled={!!busy}
          className="rounded-md border border-[#1E3A5F] px-3 py-1.5 text-xs font-bold text-[#1E3A5F] hover:bg-[#FBFAF6] disabled:opacity-50">
          Waive (informed consent)
        </button>
        {status !== 'CLEARED' && (
          <span className="text-xs font-semibold text-amber-700">Engagement is blocked until cleared.</span>
        )}
      </div>
    </div>
  )
}

function Detail({ label, children }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: GOLD }}>{label}</p>
      <p className="mt-0.5 text-sm text-slate-700">{children}</p>
    </div>
  )
}

export default function ConflictChecksTab({ config }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('PENDING')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const { data } = await axios.get('/api/law-firm/admin/consultations', { withCredentials: true })
      setRows(data.consultations || [])
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load consultations')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleAction(appointmentId, conflictStatus, conflictNotes) {
    try {
      await axios.put(`/api/law-firm/admin/consultations/${appointmentId}/conflict`,
        { conflictStatus, conflictNotes }, { withCredentials: true })
      await load()
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update the conflict check')
    }
  }

  const counts = rows.reduce((acc, r) => {
    const s = r.intake?.conflictStatus || 'PENDING'
    acc[s] = (acc[s] || 0) + 1
    return acc
  }, {})
  const shown = filter === 'ALL' ? rows : rows.filter((r) => (r.intake?.conflictStatus || 'PENDING') === filter)

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-[#E5E2D9] bg-white p-6" style={{ borderTop: `3px solid ${GOLD}` }}>
        <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: GOLD }}>Law practice</p>
        <h1 className="mt-2 text-2xl font-bold" style={{ fontFamily: SERIF, color: NAVY }}>Conflict-of-interest checks</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Every consultation request is held pending until the firm clears a conflict-of-interest check.
          Review the matter and the other parties, then clear, flag, or waive (with informed consent).
          An engagement cannot be confirmed until the conflict status is cleared.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {['PENDING', 'CLEARED', 'CONFLICT', 'WAIVED', 'ALL'].map((key) => (
          <button key={key} onClick={() => setFilter(key)}
            className={`rounded-md border px-3 py-1.5 text-xs font-bold transition-colors ${filter === key ? 'border-[#1E3A5F] bg-[#1E3A5F] text-white' : 'border-[#DAD4C7] bg-white text-slate-600 hover:bg-[#FBFAF6]'}`}>
            {key === 'ALL' ? `All (${rows.length})` : `${key.charAt(0) + key.slice(1).toLowerCase()} (${counts[key] || 0})`}
          </button>
        ))}
      </div>

      {loading ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#DAD4C7] bg-white p-10 text-center text-sm text-slate-500">
          No consultations in this view yet.
        </div>
      ) : (
        <div className="grid gap-4">
          {shown.map((row) => (
            <ConsultationCard key={row.appointmentId} row={row} onAction={handleAction} />
          ))}
        </div>
      )}
    </div>
  )
}
