'use client'

import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import LegalDocumentModal from './LegalDocumentModal'

// Real working document workspace for the law_firm theme: every consultation
// with the engagement-letter / advice-note status, drafted and issued on firm
// letterhead through the shared appointment-document engine.

// Premium legal palette — matches the navy/gold storefront.
const NAVY = '#1E3A5F'
const GOLD = '#B8862E'
const SERIF = 'Georgia, "Times New Roman", serif'

function parseLetterhead(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { const p = JSON.parse(raw); return p && typeof p === 'object' ? p : {} } catch { return {} }
}

function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#1E3A5F] border-t-transparent" />
    </div>
  )
}

function StatusPill({ doc }) {
  if (!doc) return <span className="rounded-md bg-[#FBFAF6] px-2 py-0.5 text-xs font-semibold text-slate-500 ring-1 ring-inset ring-[#E5E2D9]">Not started</span>
  if (doc.status === 'issued') return <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200">Issued</span>
  return <span className="rounded-md bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-700 ring-1 ring-inset ring-amber-200">Draft</span>
}

export default function DocumentsTab({ tenant, config }) {
  const business = tenant?.business || {}
  const feeBases = config?.documents?.feeBases || []
  const letterheadSettings = useMemo(
    () => parseLetterhead(tenant?.content?.letterheadSettings),
    [tenant?.content?.letterheadSettings]
  )

  const [appointments, setAppointments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [active, setActive] = useState(null) // { appointment, type }

  async function load() {
    setLoading(true)
    setError('')
    try {
      const { data } = await axios.get('/api/appointments', { withCredentials: true })
      setAppointments(data.appointments || [])
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load consultations')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const rows = appointments.filter((a) => a.status !== 'CANCELLED' && a.status !== 'NO_SHOW')
  const docOf = (a, type) => (a.documents || []).find((d) => d.type === type) || null

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-[#E5E2D9] bg-white p-6" style={{ borderTop: `3px solid ${GOLD}` }}>
        <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: GOLD }}>Law practice</p>
        <h1 className="mt-2 text-2xl font-bold" style={{ fontFamily: SERIF, color: NAVY }}>Engagement letters &amp; advice notes</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          After the conflict check and consultation, issue a written letter of engagement (scope, fee basis,
          NZLS complaints procedure) and legal advice notes on {business.name || 'firm'} letterhead — delivered
          to the client portal or as a PDF, as required by the Conduct and Client Care Rules 2008.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#DAD4C7] bg-white p-10 text-center text-sm text-slate-500">
          No consultations yet. Engagement documents become available once a client books a consultation.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[#E5E2D9] bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="text-left text-xs font-bold uppercase tracking-wide text-white" style={{ backgroundColor: NAVY }}>
              <tr>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Matter type</th>
                <th className="px-4 py-3">Consultation date</th>
                <th className="px-4 py-3">Engagement letter</th>
                <th className="px-4 py-3">Advice note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EFEAE0]">
              {rows.map((a) => {
                const client = a.customer || a.user || {}
                const eng = docOf(a, 'engagement_letter')
                const adv = docOf(a, 'advice_note')
                return (
                  <tr key={a.id} className="hover:bg-[#FBFAF6]">
                    <td className="px-4 py-3 font-semibold" style={{ color: NAVY }}>{client.name || 'Client'}</td>
                    <td className="px-4 py-3 text-slate-600">{a.service?.name || 'Consultation'}</td>
                    <td className="px-4 py-3 text-slate-500">
                      {a.date ? new Date(a.date).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <StatusPill doc={eng} />
                        <button
                          onClick={() => setActive({ appointment: a, type: 'engagement_letter' })}
                          className="rounded-md border border-[#1E3A5F] px-2.5 py-1 text-xs font-bold text-[#1E3A5F] hover:bg-[#1E3A5F] hover:text-white"
                        >
                          {eng ? 'Edit' : 'Draft'}
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <StatusPill doc={adv} />
                        <button
                          onClick={() => setActive({ appointment: a, type: 'advice_note' })}
                          className="rounded-md border border-[#1E3A5F] px-2.5 py-1 text-xs font-bold text-[#1E3A5F] hover:bg-[#1E3A5F] hover:text-white"
                        >
                          {adv ? 'Edit' : 'Draft'}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {active && (
        <LegalDocumentModal
          appointment={active.appointment}
          documentType={active.type}
          letterheadSettings={letterheadSettings}
          feeBases={feeBases}
          onClose={() => setActive(null)}
          onSaved={async () => { await load() }}
        />
      )}
    </div>
  )
}
