'use client'

import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'

// Dispatch board for the water_purifier theme: a focused, "right now" view of
// today's + overdue purifier visits, grouped by the technician they're assigned
// to (unassigned in their own column). Quick re-assign without leaving the board.

// Water "sky" palette.
const SKY = '#0EA5E9'
const ACCENT = '#0284C7'
const SOFT = '#E0F2FE'
const INK = '#0F172A'
const MUTE = '#64748B'
const LINE = '#E2E8F0'
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

const VISIT_KIND_LABEL = {
  PREVENTIVE: 'Preventive',
  FILTER_CHANGE: 'Filter change',
  REPAIR: 'Repair',
  INSTALLATION: 'Installation',
  INSPECTION: 'Inspection',
}

const ACTIVE_STATUSES = new Set(['SCHEDULED', 'ASSIGNED', 'EN_ROUTE'])

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtTime(d) {
  if (!d) return ''
  try {
    return new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function fmtDate(d) {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
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

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}
function endOfToday() {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d
}

function visitDate(v) {
  const raw = v.scheduledFor || v.dueBy
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#0EA5E9] border-t-transparent" />
    </div>
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

const inputStyle = { borderColor: LINE }

// ── DISPATCH CARD ─────────────────────────────────────────────────────────────

function DispatchCard({ visit, technicians, onAssign, busy, overdue }) {
  const [techId, setTechId] = useState(visit.technician?.id || '')
  useEffect(() => { setTechId(visit.technician?.id || '') }, [visit.technician?.id])
  const d = visitDate(visit)

  return (
    <div
      className="rounded-lg border bg-white p-3 shadow-sm"
      style={{ borderColor: overdue ? '#FCA5A5' : LINE }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold" style={{ color: INK }}>{visit.customerName || 'Customer'}</p>
          <p className="mt-0.5 text-xs" style={{ color: MUTE }}>
            {visitKindLabel(visit.kind)}
            {visit.pincode ? ` · ${visit.pincode}` : ''}
          </p>
          <p className="mt-0.5 text-xs" style={{ color: MUTE }}>
            {visit.customerPhone ? visit.customerPhone : 'No phone'}
            {visit.contract?.contractNumber ? ` · ${visit.contract.contractNumber}` : ''}
          </p>
        </div>
        <div className="shrink-0 text-right">
          {overdue ? (
            <span className="rounded-md bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-700 ring-1 ring-inset ring-red-200">
              Overdue {fmtDate(d)}
            </span>
          ) : (
            <span className="text-[11px] font-bold" style={{ color: ACCENT }}>{fmtTime(d) || 'Today'}</span>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 border-t pt-2" style={{ borderColor: SOFT }}>
        <select
          value={techId}
          onChange={(e) => setTechId(e.target.value)}
          disabled={busy}
          className="min-w-0 flex-1 rounded-md border p-1.5 text-xs text-slate-800 focus:outline-none disabled:opacity-50"
          style={inputStyle}
          aria-label="Assign technician"
        >
          <option value="">Unassigned…</option>
          {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button
          disabled={busy || !techId || techId === (visit.technician?.id || '')}
          onClick={() => onAssign(visit, techId)}
          className="shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
          style={{ backgroundColor: SKY }}
        >
          {busy ? '…' : 'Assign'}
        </button>
      </div>
    </div>
  )
}

function Kpi({ label, value, tone }) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm" style={{ borderColor: LINE }}>
      <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: ACCENT }}>{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone === 'warn' ? 'text-amber-700' : ''}`} style={tone === 'warn' ? undefined : { color: INK }}>{value}</p>
    </div>
  )
}

// ── ROOT ──────────────────────────────────────────────────────────────────────

export default function DispatchPanel() {
  const [visits, setVisits] = useState([])
  const [technicians, setTechnicians] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState(null)

  async function load(silent) {
    if (!silent) setLoading(true)
    setError('')
    try {
      const { data } = await axios.get('/api/water-purifier/admin/visits', { withCredentials: true })
      setVisits(Array.isArray(data?.visits) ? data.visits : [])
    } catch (err) {
      setError(errMsg(err, 'Failed to load the dispatch board'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

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
    const t = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(t)
  }, [notice])

  async function assign(visit, technicianId) {
    setBusyId(visit.id)
    setError('')
    try {
      await axios.put(`/api/water-purifier/admin/visits/${visit.id}/assign`, { technicianId, status: 'ASSIGNED' }, { withCredentials: true })
      setNotice('Visit re-assigned.')
      await load(true)
    } catch (err) {
      setError(errMsg(err, 'Could not assign the technician'))
    } finally {
      setBusyId(null)
    }
  }

  // Today's + overdue, still actionable (not done/missed).
  const { groups, unassigned, overdueCount, todayCount } = useMemo(() => {
    const todayStart = startOfToday().getTime()
    const todayEnd = endOfToday().getTime()
    const relevant = visits.filter((v) => {
      if (!ACTIVE_STATUSES.has(v.status)) return false
      const d = visitDate(v)
      if (!d) return false
      const t = d.getTime()
      return t <= todayEnd // today or earlier (overdue)
    })

    const byTech = new Map()
    const unassignedList = []
    let oCount = 0
    let tCount = 0

    for (const v of relevant) {
      const d = visitDate(v)
      const t = d.getTime()
      const isOverdue = t < todayStart
      const isToday = t >= todayStart && t <= todayEnd
      if (isOverdue) oCount += 1
      if (isToday) tCount += 1

      const decorated = { ...v, _overdue: isOverdue }
      const techId = v.technician?.id
      if (!techId) {
        unassignedList.push(decorated)
      } else {
        if (!byTech.has(techId)) {
          byTech.set(techId, { id: techId, name: v.technician?.name || 'Technician', visits: [] })
        }
        byTech.get(techId).visits.push(decorated)
      }
    }

    const sortFn = (a, b) => {
      const da = visitDate(a)?.getTime() ?? 0
      const db = visitDate(b)?.getTime() ?? 0
      return da - db
    }
    unassignedList.sort(sortFn)
    const groupList = Array.from(byTech.values())
    groupList.forEach((g) => g.visits.sort(sortFn))
    groupList.sort((a, b) => a.name.localeCompare(b.name))

    return { groups: groupList, unassigned: unassignedList, overdueCount: oCount, todayCount: tCount }
  }, [visits])

  const totalActionable = unassigned.length + groups.reduce((acc, g) => acc + g.visits.length, 0)

  return (
    <div className="space-y-6" style={{ fontFamily: SANS }}>
      <div className="rounded-lg border bg-white p-6" style={{ borderColor: LINE, borderTop: `3px solid ${SKY}` }}>
        <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: ACCENT }}>Water purifier care</p>
        <h1 className="mt-2 text-2xl font-bold" style={{ color: INK }}>Dispatch board</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: '#475569' }}>
          Today&apos;s and overdue visits, grouped by technician. Re-assign on the fly to balance the day&apos;s routes.
        </p>
      </div>

      {error && <Banner error={error} />}
      {notice && <Banner notice={notice} />}

      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Today's visits" value={todayCount} />
        <Kpi label="Unassigned" value={unassigned.length} tone={unassigned.length > 0 ? 'warn' : undefined} />
        <Kpi label="Overdue" value={overdueCount} tone={overdueCount > 0 ? 'warn' : undefined} />
      </div>

      {loading ? (
        <Spinner />
      ) : totalActionable === 0 ? (
        <div className="rounded-lg border border-dashed bg-white p-10 text-center text-sm" style={{ borderColor: LINE, color: MUTE }}>
          Nothing on the board — no visits due today or overdue. Nice and clear.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3 xl:grid-cols-4">
          {unassigned.length > 0 && (
            <div className="rounded-lg border bg-[#F0F9FF] p-3" style={{ borderColor: '#FCA5A5' }}>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-bold" style={{ color: INK }}>Unassigned</h3>
                <span className="rounded-md bg-red-50 px-2 py-0.5 text-[11px] font-bold text-red-700 ring-1 ring-inset ring-red-200">{unassigned.length}</span>
              </div>
              <div className="space-y-2">
                {unassigned.map((v) => (
                  <DispatchCard key={v.id} visit={v} technicians={technicians} onAssign={assign} busy={busyId === v.id} overdue={v._overdue} />
                ))}
              </div>
            </div>
          )}

          {groups.map((g) => (
            <div key={g.id} className="rounded-lg border bg-white p-3" style={{ borderColor: LINE }}>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="truncate text-sm font-bold" style={{ color: INK }}>{g.name}</h3>
                <span className="rounded-md px-2 py-0.5 text-[11px] font-bold ring-1 ring-inset" style={{ backgroundColor: SOFT, color: ACCENT, borderColor: SOFT }}>{g.visits.length}</span>
              </div>
              <div className="space-y-2">
                {g.visits.map((v) => (
                  <DispatchCard key={v.id} visit={v} technicians={technicians} onAssign={assign} busy={busyId === v.id} overdue={v._overdue} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
