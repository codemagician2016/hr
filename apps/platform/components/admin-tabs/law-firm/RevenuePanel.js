'use client'

import { useEffect, useState } from 'react'
import axios from 'axios'

// Revenue & billing dashboard for the law_firm theme: a single read-only KPI
// board over the firm's billed / collected / outstanding position, this month's
// billing, unbilled WIP, trust held, and open-matter count.

// Premium legal palette — matches the navy/gold storefront.
const NAVY = '#1E3A5F'
const GOLD = '#B8862E'
const SERIF = 'Georgia, "Times New Roman", serif'
const MUTE = '#5A6B82'

function money(amount, currency) {
  const n = Number(amount)
  const safe = Number.isFinite(n) ? n : 0
  const formatted = safe.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${currency ? `${currency} ` : ''}${formatted}`
}

function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#1E3A5F] border-t-transparent" />
    </div>
  )
}

function Kpi({ label, value, hint, tone }) {
  return (
    <div className="rounded-lg border border-[#E5E2D9] bg-white p-5 shadow-sm" style={tone === 'gold' ? { borderTop: `3px solid ${GOLD}` } : undefined}>
      <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: GOLD }}>{label}</p>
      <p
        className={`mt-2 text-2xl font-bold ${tone === 'warn' ? 'text-amber-700' : ''}`}
        style={tone === 'warn' ? { fontFamily: SERIF } : { fontFamily: SERIF, color: NAVY }}
      >
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
      const { data } = await axios.get('/api/law-firm/admin/revenue', { withCredentials: true })
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
    <div className="space-y-6">
      <div className="rounded-lg border border-[#E5E2D9] bg-white p-6" style={{ borderTop: `3px solid ${GOLD}` }}>
        <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: GOLD }}>Law practice</p>
        <h1 className="mt-2 text-2xl font-bold" style={{ fontFamily: SERIF, color: NAVY }}>Revenue &amp; billing</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: '#475569' }}>
          The firm&apos;s billing position across all matters — what has been billed and collected, what remains
          outstanding, unbilled work in progress, and client funds held on trust.
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
          <Kpi label="Billed (total)" value={money(r.billedTotal, currency)} tone="gold" hint="All invoices issued" />
          <Kpi label="Collected" value={money(r.collectedTotal, currency)} hint="Payments received" />
          <Kpi label="Outstanding" value={money(r.outstanding, currency)} tone="warn" hint="Awaiting payment" />
          <Kpi label="Billed this month" value={money(r.billedThisMonth, currency)} hint="Invoices issued this month" />
          <Kpi label="Unbilled WIP" value={money(r.unbilledWip, currency)} hint="Time &amp; disbursements not yet invoiced" />
          <Kpi label="Held in trust" value={money(r.trustHeld, currency)} hint="Client funds on trust" />
          <Kpi label="Open matters" value={Number.isFinite(Number(r.openMatters)) ? Number(r.openMatters) : 0} hint="Active engagements" />
        </div>
      )}
    </div>
  )
}
