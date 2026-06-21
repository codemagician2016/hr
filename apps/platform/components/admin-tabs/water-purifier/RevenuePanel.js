'use client'

import { useEffect, useState } from 'react'
import axios from 'axios'

// Revenue & service dashboard for the water_purifier theme: a single read-only
// KPI board over the AMC book — active contracts, annual contract value, MRR,
// billed / collected / outstanding, this month's billing, renewals due, and the
// service load (visits this month + due soon).

// Water "sky" palette.
const SKY = '#0EA5E9'
const ACCENT = '#0284C7'
const INK = '#0F172A'
const MUTE = '#64748B'
const LINE = '#E2E8F0'
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

function money(amount, currency) {
  const n = Number(amount)
  const safe = Number.isFinite(n) ? n : 0
  const formatted = safe.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${currency ? `${currency} ` : ''}${formatted}`
}

function count(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#0EA5E9] border-t-transparent" />
    </div>
  )
}

function Kpi({ label, value, hint, tone }) {
  return (
    <div className="rounded-lg border bg-white p-5 shadow-sm" style={tone === 'sky' ? { borderColor: LINE, borderTop: `3px solid ${SKY}` } : { borderColor: LINE }}>
      <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: ACCENT }}>{label}</p>
      <p className={`mt-2 text-2xl font-bold ${tone === 'warn' ? 'text-amber-700' : ''}`} style={tone === 'warn' ? undefined : { color: INK }}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs" style={{ color: MUTE }}>{hint}</p>}
    </div>
  )
}

export default function RevenuePanel() {
  const [revenue, setRevenue] = useState(null)
  const [currency, setCurrency] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const { data } = await axios.get('/api/water-purifier/admin/revenue', { withCredentials: true })
      setRevenue(data?.revenue || null)
      if (data?.revenue?.currency) setCurrency(data.revenue.currency)
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to load revenue')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const r = revenue || {}

  return (
    <div className="space-y-6" style={{ fontFamily: SANS }}>
      <div className="rounded-lg border bg-white p-6" style={{ borderColor: LINE, borderTop: `3px solid ${SKY}` }}>
        <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: ACCENT }}>Water purifier care</p>
        <h1 className="mt-2 text-2xl font-bold" style={{ color: INK }}>Revenue &amp; service</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: '#475569' }}>
          The AMC book at a glance — active contracts and their recurring value, what has been billed and collected,
          what is outstanding, renewals coming due, and the service load on the road.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Kpi label="Active contracts" value={count(r.activeContracts)} tone="sky" hint="Live AMCs" />
          <Kpi label="Annual contract value" value={money(r.annualContractValue, currency)} hint="Total AMC fees per year" />
          <Kpi label="MRR" value={money(r.mrr, currency)} hint="Monthly recurring value" />
          <Kpi label="Billed (total)" value={money(r.billedTotal, currency)} hint="All invoices issued" />
          <Kpi label="Collected" value={money(r.collectedTotal, currency)} hint="Payments received" />
          <Kpi label="Outstanding" value={money(r.outstanding, currency)} tone="warn" hint="Awaiting payment" />
          <Kpi label="Billed this month" value={money(r.billedThisMonth, currency)} hint="Invoices issued this month" />
          <Kpi label="Renewals due (30d)" value={count(r.renewalsDue)} hint="Contracts expiring soon" />
          <Kpi label="Visits this month" value={count(r.visitsThisMonth)} hint="Service visits completed" />
          <Kpi label="Visits due soon" value={count(r.visitsDueSoon)} tone={count(r.visitsDueSoon) > 0 ? 'warn' : undefined} hint="Scheduled or overdue" />
        </div>
      )}
    </div>
  )
}
