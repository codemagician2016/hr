'use client'

const RX_FIELDS = [
  'Patient details and allergies',
  'Complaint, diagnosis and vitals',
  'Medicines with dose, timing, frequency and duration',
  'Tests, advice and follow-up date',
  'Doctor registration number and clinic branch',
]

function Icon({ type, size = 18, stroke = 'currentColor' }) {
  const paths = {
    rx: <><path d="M5 21V4h4a3 3 0 0 1 0 6H5" /><path d="M5 10l8 11M13 16l5 5M18 16l-5 5" /></>,
    check: <><path d="m4 12 5 5L20 6" /></>,
    document: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></>,
    share: <><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></>,
    stethoscope: <><path d="M5 3v6a4 4 0 0 0 8 0V3" /><path d="M9 13v3a5 5 0 0 0 10 0v-1" /><circle cx="19" cy="13" r="2" /></>,
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[type] || paths.rx}
    </svg>
  )
}

export default function PrescriptionsTab({ tenant, config }) {
  const business = tenant?.business || {}
  const delivery = config?.prescription?.delivery || []
  const primary = '#0F766E'
  const accent = '#2563EB'

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="relative bg-gradient-to-br from-teal-700 via-teal-600 to-blue-700 px-6 py-7 text-white sm:px-8">
          <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10" aria-hidden />
          <div className="pointer-events-none absolute -bottom-16 right-24 h-32 w-32 rounded-full bg-white/5" aria-hidden />
          <div className="relative flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-4">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white/15 ring-1 ring-inset ring-white/25">
                <Icon type="rx" size={24} stroke="white" />
              </span>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-teal-100">Doctor clinic</p>
                <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Prescription workflow</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-teal-50/90">
                  Doctors can prepare a structured prescription after an appointment, keep it on clinic letterhead,
                  and share it with the patient as a PDF through portal, WhatsApp or email.
                </p>
              </div>
            </div>
            <span className="inline-flex w-fit items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-xs font-bold text-white ring-1 ring-inset ring-white/25 backdrop-blur">
              <Icon type="stethoscope" size={15} stroke="white" />
              {business.name || 'Clinic'} Rx Pad
            </span>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 ring-1 ring-inset ring-teal-100">
              <Icon type="check" size={18} stroke={primary} />
            </span>
            <h2 className="text-base font-bold text-slate-900">What the prescription captures</h2>
          </div>
          <div className="mt-5 space-y-2.5">
            {RX_FIELDS.map((field) => (
              <div
                key={field}
                className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3.5 transition hover:border-teal-200 hover:bg-teal-50/50"
              >
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-teal-600 to-blue-600 text-white shadow-sm">
                  <Icon type="check" size={12} stroke="white" />
                </span>
                <p className="text-sm font-medium leading-6 text-slate-700">{field}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 ring-1 ring-inset ring-blue-100">
              <Icon type="document" size={18} stroke={accent} />
            </span>
            <h2 className="text-base font-bold text-slate-900">Clinic prescription template</h2>
          </div>

          <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ring-1 ring-slate-900/5">
            <div className="h-1.5 w-full bg-gradient-to-r from-teal-600 via-teal-500 to-blue-600" aria-hidden />
            <div className="p-5">
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white shadow-sm" style={{ backgroundColor: primary }}>
                    <Icon type="rx" size={22} stroke="white" />
                  </span>
                  <div>
                    <p className="text-lg font-extrabold leading-tight text-slate-900">{business.name || 'Clinic Name'}</p>
                    <p className="mt-1 text-xs text-slate-500">Branch address · Doctor registration no. · Contact</p>
                  </div>
                </div>
                <span className="hidden rounded-md px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide sm:inline-block" style={{ color: accent, backgroundColor: '#EFF6FF' }}>
                  Letterhead
                </span>
              </div>
              <div className="mt-4 grid gap-3 text-sm text-slate-700">
                <p><span className="font-bold text-slate-900">Patient:</span> Name, age, gender</p>
                <p><span className="font-bold text-slate-900">Diagnosis:</span> Clinical diagnosis and notes</p>
                <div>
                  <p className="flex items-center gap-2 font-bold text-slate-900">
                    <span className="font-serif text-lg leading-none text-teal-700">℞</span> Rx
                  </p>
                  <div className="mt-2 rounded-lg border-l-2 bg-slate-50 p-3 text-xs leading-6 text-slate-600" style={{ borderColor: primary }}>
                    Medicine · Strength · Dose · Frequency · Duration · Instructions
                  </div>
                </div>
                <p><span className="font-bold text-slate-900">Advice:</span> Tests, precautions and follow-up date</p>
              </div>
            </div>
          </div>

          {delivery.length > 0 && (
            <div className="mt-5">
              <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Icon type="share" size={14} stroke={primary} />
                Share with patient
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {delivery.map((item) => (
                  <span
                    key={item}
                    className="inline-flex items-center rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-semibold capitalize text-teal-800"
                  >
                    {item.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
