'use client'

import { useMemo, useState } from 'react'
import axios from 'axios'

// Engagement Letter + Legal Advice Note editor for the law_firm theme.
// Reuses the tenant letterhead settings (same shape the doctor Rx uses) and
// persists through the generic /api/appointments/:id/document endpoint.

const FEE_BASES = ['Fixed fee', 'Hourly rate', 'Conditional (no win, no fee)', 'Retainer', 'Estimate only']

const DEFAULTS = {
  professionalIndemnity:
    "This firm holds professional indemnity insurance that meets or exceeds the minimum standards specified by the New Zealand Law Society. We are members of the Lawyers' Fidelity Fund.",
  complaintsProcedure:
    'If you have a concern about our service, please raise it with the lawyer responsible for your matter. If it is not resolved, you may contact the New Zealand Law Society Lawyers Complaints Service on 0800 261 801.',
  privilegeNotice:
    'This advice is confidential and subject to legal professional privilege. It is given for this matter only, based on the facts and instructions provided, and may not be relied on by any other person or for any other purpose.',
}

const TYPE_META = {
  engagement_letter: { label: 'Letter of Engagement', short: 'Engagement letter' },
  advice_note: { label: 'Legal Advice Note', short: 'Advice note' },
}

// Premium legal palette — matches the navy/gold storefront.
const NAVY = '#1E3A5F'
const GOLD = '#B8862E'
const SERIF = 'Georgia, "Times New Roman", serif'

function Field({ label, value, onChange, rows = 3, placeholder }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide" style={{ color: GOLD }}>{label}</span>
      <textarea
        className="w-full rounded-md border border-[#DAD4C7] p-2.5 text-sm leading-6 text-slate-800 focus:border-[#1E3A5F] focus:outline-none"
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function Line({ label, value, onChange, placeholder }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide" style={{ color: GOLD }}>{label}</span>
      <input
        className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

export default function LegalDocumentModal({ appointment, documentType, letterheadSettings, feeBases, onClose, onSaved }) {
  const type = TYPE_META[documentType] ? documentType : 'engagement_letter'
  const meta = TYPE_META[type]
  const client = appointment.customer || appointment.user || {}
  const existing = (appointment.documents || []).find((d) => d.type === type) || null
  const saved = existing?.payload || {}

  const [matterReference, setMatterReference] = useState(
    saved.matterReference || (appointment.id ? String(appointment.id).slice(0, 8).toUpperCase() : '')
  )
  // Engagement letter fields
  const [scope, setScope] = useState(saved.scope || appointment.service?.name || '')
  const [exclusions, setExclusions] = useState(saved.exclusions || '')
  const [feeBasis, setFeeBasis] = useState(saved.feeBasis || (feeBases && feeBases[0]) || FEE_BASES[0])
  const [feeEstimate, setFeeEstimate] = useState(saved.feeEstimate || '')
  const [disbursements, setDisbursements] = useState(saved.disbursements || '')
  const [clientResponsibilities, setClientResponsibilities] = useState(saved.clientResponsibilities || '')
  const [professionalIndemnity, setProfessionalIndemnity] = useState(saved.professionalIndemnity || DEFAULTS.professionalIndemnity)
  const [complaintsProcedure, setComplaintsProcedure] = useState(saved.complaintsProcedure || DEFAULTS.complaintsProcedure)
  // Advice note fields
  const [background, setBackground] = useState(saved.background || appointment.notes || '')
  const [issues, setIssues] = useState(saved.issues || '')
  const [advice, setAdvice] = useState(saved.advice || '')
  const [recommendedSteps, setRecommendedSteps] = useState(saved.recommendedSteps || '')
  const [assumptions, setAssumptions] = useState(saved.assumptions || '')
  const [privilegeNotice, setPrivilegeNotice] = useState(saved.privilegeNotice || DEFAULTS.privilegeNotice)

  const [lawyerName, setLawyerName] = useState(
    existing?.letterhead?.providerName || appointment.staff?.name || 'Lawyer'
  )
  const [registrationValue, setRegistrationValue] = useState(
    saved.registrationNumber || letterheadSettings?.registrationValue || ''
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedAt, setSavedAt] = useState(existing?.updatedAt || null)

  const letterhead = useMemo(() => ({
    businessName: appointment.business?.name || 'Law Firm',
    address: 'Office address',
    contact: 'Phone · Email',
    registrationLabel: 'NZLS practising certificate',
    accentColor: '#1E3A5F',
    footerNote: '',
    logoUrl: '',
    signatureUrl: appointment.staff?.signatureUrl || '',
    ...(letterheadSettings || {}),
    providerName: lawyerName,
    providerTitle: appointment.staff?.subtitle || 'Lawyer',
    registrationValue,
  }), [appointment, letterheadSettings, lawyerName, registrationValue])

  const payload = type === 'engagement_letter'
    ? { matterReference, scope, exclusions, feeBasis, feeEstimate, disbursements, clientResponsibilities, professionalIndemnity, complaintsProcedure }
    : { matterReference, background, issues, advice, recommendedSteps, assumptions, privilegeNotice, registrationNumber: registrationValue }

  async function save(status) {
    setSaving(true)
    setError('')
    try {
      const { data } = await axios.put(`/api/appointments/${appointment.id}/document`, {
        type,
        title: meta.label,
        recipientName: client.name || 'Client',
        recipientContact: client.email || client.phone || '',
        payload,
        letterhead,
        status,
      }, { withCredentials: true })
      setSavedAt(data.document?.updatedAt || new Date().toISOString())
      await onSaved?.(data.document)
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save document')
    } finally {
      setSaving(false)
    }
  }

  const dateLabel = appointment.date
    ? new Date(appointment.date).toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' })
    : ''
  const accent = letterhead.accentColor || '#1E3A5F'

  return (
    <div
      id="sp-legaldoc-modal"
      className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/55 p-0 sm:items-center sm:p-4 print:static print:bg-white print:p-0"
      onClick={onClose}
    >
      <style jsx global>{`
        @media print {
          @page { size: A4 portrait; margin: 18mm 16mm; }
          body * { visibility: hidden; }
          #sp-legaldoc-print, #sp-legaldoc-print * { visibility: visible; }
          #sp-legaldoc-print { position: absolute; inset: 0; width: 100%; }
          .sp-no-print { display: none !important; }
        }
      `}</style>

      <div
        className="flex max-h-[96vh] w-full max-w-5xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl print:max-h-none print:max-w-none print:rounded-none print:shadow-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sp-no-print flex items-center justify-between border-b border-[#E5E2D9] px-5 py-3" style={{ borderBottomWidth: 1, boxShadow: `inset 0 3px 0 ${GOLD}` }}>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: GOLD }}>{TYPE_META[type].short}</p>
            <h2 className="text-base font-bold" style={{ fontFamily: SERIF, color: NAVY }}>{meta.label}</h2>
            <p className="text-xs text-slate-500">
              {client.name || 'Client'} · {appointment.service?.name || 'Consultation'}
              {savedAt && <span className="ml-2 font-semibold text-emerald-700">Saved</span>}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-[#FBFAF6]">Close</button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-2">
          {/* Editor */}
          <div className="sp-no-print space-y-3 overflow-y-auto border-r border-[#E5E2D9] p-5">
            <div className="grid grid-cols-2 gap-3">
              <Line label="Matter reference" value={matterReference} onChange={setMatterReference} placeholder="e.g. CONV-2026-014" />
              <Line label="Lawyer" value={lawyerName} onChange={setLawyerName} />
            </div>
            {type === 'engagement_letter' ? (
              <>
                <Field label="Scope of engagement" value={scope} onChange={setScope} placeholder="What the firm will do for this matter" />
                <Field label="Exclusions" value={exclusions} onChange={setExclusions} placeholder="What this engagement does not cover" />
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-bold uppercase tracking-wide" style={{ color: GOLD }}>Fee basis</span>
                    <select
                      className="w-full rounded-md border border-[#DAD4C7] p-2 text-sm text-slate-800 focus:border-[#1E3A5F] focus:outline-none"
                      value={feeBasis}
                      onChange={(e) => setFeeBasis(e.target.value)}
                    >
                      {(feeBases && feeBases.length ? feeBases : FEE_BASES).map((b) => <option key={b}>{b}</option>)}
                    </select>
                  </label>
                  <Line label="Fee estimate (NZD, incl. GST)" value={feeEstimate} onChange={setFeeEstimate} placeholder="e.g. $1,500 + GST" />
                </div>
                <Field label="Disbursements" value={disbursements} onChange={setDisbursements} rows={2} placeholder="Search fees, registration, courier, etc." />
                <Field label="Client responsibilities" value={clientResponsibilities} onChange={setClientResponsibilities} rows={2} />
                <Field label="Professional indemnity & Fidelity Fund" value={professionalIndemnity} onChange={setProfessionalIndemnity} rows={2} />
                <Field label="Complaints procedure" value={complaintsProcedure} onChange={setComplaintsProcedure} rows={2} />
              </>
            ) : (
              <>
                <Line label="NZLS practising certificate no." value={registrationValue} onChange={setRegistrationValue} />
                <Field label="Background / facts" value={background} onChange={setBackground} />
                <Field label="Issues" value={issues} onChange={setIssues} />
                <Field label="Advice" value={advice} onChange={setAdvice} rows={5} />
                <Field label="Recommended next steps" value={recommendedSteps} onChange={setRecommendedSteps} />
                <Field label="Assumptions" value={assumptions} onChange={setAssumptions} rows={2} />
                <Field label="Privilege & disclaimer" value={privilegeNotice} onChange={setPrivilegeNotice} rows={3} />
              </>
            )}
            {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p>}
          </div>

          {/* A4 preview */}
          <div className="overflow-y-auto bg-[#FBFAF6] p-5 print:bg-white print:p-0">
            <div id="sp-legaldoc-print" className="mx-auto max-w-[210mm] bg-white p-10 text-[12px] leading-6 text-slate-800 shadow print:max-w-none print:p-0 print:shadow-none">
              <div className="flex items-start justify-between border-b-2 pb-4" style={{ borderColor: accent }}>
                <div>
                  {letterhead.logoUrl ? (
                    <img src={letterhead.logoUrl} alt="" className="mb-2 h-12 object-contain" />
                  ) : null}
                  <p className="text-lg font-extrabold" style={{ color: accent }}>{letterhead.businessName}</p>
                  <p className="text-[11px] text-slate-500">{letterhead.address}</p>
                  <p className="text-[11px] text-slate-500">{letterhead.contact}</p>
                </div>
                <div className="text-right text-[11px] text-slate-500">
                  <p className="font-bold uppercase tracking-wide" style={{ color: accent }}>{meta.short}</p>
                  <p className="mt-1">{dateLabel}</p>
                  <p>Matter: {matterReference || '—'}</p>
                </div>
              </div>

              <div className="mt-5">
                <p><span className="font-bold">To:</span> {client.name || 'Client'}</p>
                <p className="text-slate-500">{client.email || client.phone || ''}</p>
              </div>

              {type === 'engagement_letter' ? (
                <div className="mt-5 space-y-4">
                  <p>Thank you for instructing {letterhead.businessName}. This letter sets out the terms on which we will act for you, as required by the Lawyers and Conveyancers Act (Lawyers: Conduct and Client Care) Rules 2008.</p>
                  <Block title="Scope of engagement" body={scope} />
                  <Block title="What this engagement does not cover" body={exclusions} />
                  <Block title="Our fees" body={`Basis: ${feeBasis}${feeEstimate ? `. Estimate: ${feeEstimate}` : ''}.`} />
                  <Block title="Disbursements" body={disbursements} />
                  <Block title="Your responsibilities" body={clientResponsibilities} />
                  <Block title="Professional indemnity & Fidelity Fund" body={professionalIndemnity} />
                  <Block title="Complaints" body={complaintsProcedure} />
                </div>
              ) : (
                <div className="mt-5 space-y-4">
                  <Block title="Background" body={background} />
                  <Block title="Issues" body={issues} />
                  <Block title="Advice" body={advice} />
                  <Block title="Recommended next steps" body={recommendedSteps} />
                  <Block title="Assumptions" body={assumptions} />
                  <Block title="Privilege & disclaimer" body={privilegeNotice} />
                </div>
              )}

              <div className="mt-10 border-t border-slate-200 pt-6">
                {letterhead.signatureUrl ? <img src={letterhead.signatureUrl} alt="" className="mb-1 h-12 object-contain" /> : null}
                <p className="font-bold">{lawyerName}</p>
                <p className="text-[11px] text-slate-500">{letterhead.providerTitle} · {letterhead.registrationLabel} {registrationValue || ''}</p>
                {type === 'engagement_letter' && (
                  <div className="mt-8 grid grid-cols-2 gap-8 text-[11px] text-slate-500">
                    <div className="border-t border-slate-300 pt-1">Client signature</div>
                    <div className="border-t border-slate-300 pt-1">Date</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="sp-no-print flex flex-wrap items-center justify-end gap-2 border-t border-[#E5E2D9] bg-[#FBFAF6] px-5 py-3">
          <button onClick={() => window.print()} className="rounded-md border border-[#DAD4C7] bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-[#FBFAF6]">Print / PDF</button>
          <button disabled={saving} onClick={() => save('draft')} className="rounded-md border border-[#1E3A5F] bg-white px-4 py-2 text-sm font-bold text-[#1E3A5F] hover:bg-[#1E3A5F] hover:text-white disabled:opacity-50">Save draft</button>
          <button disabled={saving} onClick={() => save('issued')} className="rounded-md px-4 py-2 text-sm font-bold text-white shadow-sm disabled:opacity-50" style={{ backgroundColor: NAVY }}>
            {saving ? 'Saving…' : `Issue ${meta.short.toLowerCase()} & save`}
          </button>
        </div>
      </div>
    </div>
  )
}

function Block({ title, body }) {
  if (!body || !String(body).trim()) return null
  return (
    <div>
      <p className="font-bold text-slate-900">{title}</p>
      <p className="whitespace-pre-wrap">{body}</p>
    </div>
  )
}
