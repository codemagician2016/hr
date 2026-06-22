'use client';

// DriftHR — marketing homepage. Self-contained (no Sitepresso website-builder
// sections): hero, the HR/payroll the product actually does, India + New Zealand
// compliance, white-label, pricing, FAQ. Brand: teal #16B6A6 / ink #16243B.
import Link from 'next/link';

const INK = '#16243B';
const TEAL = '#16B6A6';

function Logo() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/drifthr-logo.svg" alt="DriftHR" className="h-7 w-auto" />
  );
}

function Check() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="10" fill="#D6F3EF" />
      <path d="M6 10.5l2.5 2.5L14 7.5" stroke={TEAL} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-40 bg-white/90 backdrop-blur border-b border-slate-100">
      <div className="mx-auto max-w-6xl px-5 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2"><Logo /></Link>
        <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-600">
          <a href="#features" className="hover:text-slate-900">Features</a>
          <a href="#payroll" className="hover:text-slate-900">Payroll</a>
          <a href="#pricing" className="hover:text-slate-900">Pricing</a>
          <a href="#faq" className="hover:text-slate-900">FAQ</a>
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-sm font-semibold text-slate-700 hover:text-slate-900 px-3 py-2">Log in</Link>
          <Link href="/signup?redirect=/onboarding"
            className="text-sm font-semibold text-white rounded-lg px-4 py-2.5 shadow-sm hover:opacity-90"
            style={{ backgroundColor: INK }}>Start free</Link>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden" style={{ background: 'linear-gradient(180deg,#F4F9F9 0%,#FFFFFF 70%)' }}>
      <div className="mx-auto max-w-6xl px-5 pt-20 pb-16 grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <span className="inline-flex items-center gap-2 text-xs font-bold tracking-wide uppercase px-3 py-1.5 rounded-full"
            style={{ color: TEAL, backgroundColor: '#E3F6F3' }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: TEAL }} /> HR &amp; payroll · India &amp; New Zealand
          </span>
          <h1 className="mt-5 text-5xl sm:text-6xl font-extrabold leading-[1.05] tracking-tight" style={{ color: INK }}>
            Effortless HR<br />&amp; payroll.
          </h1>
          <p className="mt-5 text-lg text-slate-600 max-w-xl">
            Run your people, attendance, leave, claims and compliant payroll from one calm
            workspace — and give every employee a branded self-service portal on your own domain.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/signup?redirect=/onboarding"
              className="text-base font-semibold text-white rounded-xl px-6 py-3.5 shadow-sm hover:opacity-90"
              style={{ backgroundColor: TEAL }}>Start free →</Link>
            <a href="#features"
              className="text-base font-semibold rounded-xl px-6 py-3.5 border border-slate-200 hover:border-slate-300"
              style={{ color: INK }}>See how it works</a>
          </div>
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
            <span className="inline-flex items-center gap-2"><Check /> India + New Zealand payroll</span>
            <span className="inline-flex items-center gap-2"><Check /> White-label your brand</span>
            <span className="inline-flex items-center gap-2"><Check /> Compliance built in</span>
          </div>
        </div>
        <div className="relative">
          <div className="rounded-2xl border border-slate-200 bg-white shadow-xl p-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2"><Logo /></div>
              <span className="text-xs font-semibold px-2 py-1 rounded-md" style={{ color: TEAL, backgroundColor: '#E3F6F3' }}>June payroll · ready</span>
            </div>
            <div className="grid grid-cols-3 gap-3 mt-4">
              {[['Headcount', '128'], ['On leave today', '6'], ['Net pay', '₹38.4L']].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-slate-50 p-3">
                  <div className="text-xs text-slate-500">{k}</div>
                  <div className="text-xl font-bold mt-1" style={{ color: INK }}>{v}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 space-y-2">
              {[['Aarav Sharma', 'Engineering', '₹1,04,180'], ['Priya Nair', 'Design', '₹48,400'], ['Olivia Williams', 'Auckland', '$2,381.33']].map(([n, d, p]) => (
                <div key={n} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2.5">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full grid place-items-center text-xs font-bold text-white" style={{ backgroundColor: INK }}>{n.split(' ').map((x) => x[0]).join('')}</div>
                    <div><div className="text-sm font-semibold" style={{ color: INK }}>{n}</div><div className="text-xs text-slate-500">{d}</div></div>
                  </div>
                  <div className="text-sm font-semibold tabular-nums" style={{ color: INK }}>{p}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const FEATURES = [
  { t: 'Employee system of record', d: 'Profiles, org chart, documents, assets, shifts and pay inputs — one source of truth that stays in sync.' },
  { t: 'Attendance & leave', d: 'Policies, accruals, holidays and approvals. Employees request and track without chasing anyone.' },
  { t: 'Compliant payroll', d: 'Multi-entity, multi-currency runs to the exact paise/cent — with statutory filing outputs ready to submit.' },
  { t: 'Expenses, claims & loans', d: 'Reimbursements, advances and loan schedules that flow straight into the pay run.' },
  { t: 'Employee self-service', d: 'A branded portal where staff see payslips, balances and requests — on your own domain.' },
  { t: 'White-label, multi-tenant', d: 'Your logo, your colours, your domain. Built for agencies and groups running many companies.' },
];

function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-5 py-20">
      <div className="max-w-2xl">
        <p className="text-sm font-bold uppercase tracking-wide" style={{ color: TEAL }}>Everything people ops needs</p>
        <h2 className="mt-3 text-4xl font-extrabold tracking-tight" style={{ color: INK }}>One workspace, from hire to payslip.</h2>
        <p className="mt-4 text-lg text-slate-600">Give HR a clean command centre and employees a predictable self-service experience — from day one.</p>
      </div>
      <div className="mt-12 grid md:grid-cols-2 lg:grid-cols-3 gap-5">
        {FEATURES.map((f) => (
          <div key={f.t} className="rounded-2xl border border-slate-200 p-6 hover:shadow-md transition-shadow bg-white">
            <div className="h-10 w-10 rounded-xl grid place-items-center mb-4" style={{ backgroundColor: '#E3F6F3' }}>
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: TEAL }} />
            </div>
            <h3 className="text-lg font-bold" style={{ color: INK }}>{f.t}</h3>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">{f.d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Payroll() {
  const IN = ['EPF & ESI', 'TDS with §87A rebate', 'Professional Tax — 13 states', 'Gratuity & bonus', 'ECR / ESIC / Form 24Q outputs'];
  const NZ = ['PAYE & ACC levy', 'KiwiSaver & ESCT', 'Holidays Act 2003 leave', 'Student loan deductions', 'Payday filing & bank batch'];
  return (
    <section id="payroll" className="py-20" style={{ backgroundColor: INK }}>
      <div className="mx-auto max-w-6xl px-5">
        <div className="max-w-2xl">
          <p className="text-sm font-bold uppercase tracking-wide" style={{ color: TEAL }}>Payroll that knows the rules</p>
          <h2 className="mt-3 text-4xl font-extrabold tracking-tight text-white">Built for India 🇮🇳 and New Zealand 🇳🇿.</h2>
          <p className="mt-4 text-lg text-slate-300">A country-agnostic engine with statutory modules per region — computed in integer minor units, reconciled to the cent, and golden-tested.</p>
        </div>
        <div className="mt-12 grid md:grid-cols-2 gap-5">
          {[['India', IN], ['New Zealand', NZ]].map(([c, items]) => (
            <div key={c} className="rounded-2xl p-6 bg-white/5 border border-white/10">
              <h3 className="text-xl font-bold text-white">{c}</h3>
              <ul className="mt-4 space-y-2.5">
                {items.map((i) => (
                  <li key={i} className="flex items-center gap-3 text-slate-200 text-sm">
                    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none"><path d="M5 10.5l3 3L15 6.5" stroke={TEAL} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    {i}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    ['Set up your company', 'Add entities, pay components and policies — or start from a country template.'],
    ['Bring your people in', 'Import employees, compensation and attendance. Invite them to self-service.'],
    ['Run payroll with confidence', 'Compute, review variances, approve, and generate payslips + filing outputs.'],
  ];
  return (
    <section className="mx-auto max-w-6xl px-5 py-20">
      <h2 className="text-4xl font-extrabold tracking-tight text-center" style={{ color: INK }}>Live in days, not months.</h2>
      <div className="mt-12 grid md:grid-cols-3 gap-6">
        {steps.map(([t, d], i) => (
          <div key={t} className="relative rounded-2xl border border-slate-200 p-6">
            <div className="h-9 w-9 rounded-full grid place-items-center text-white font-bold" style={{ backgroundColor: TEAL }}>{i + 1}</div>
            <h3 className="mt-4 text-lg font-bold" style={{ color: INK }}>{t}</h3>
            <p className="mt-2 text-sm text-slate-600">{d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Pricing() {
  const tiers = [
    ['Starter', 'For small teams getting organised', ['Up to 25 employees', 'Core HR + self-service', 'Single country payroll'], false],
    ['Growth', 'For scaling companies', ['Up to 200 employees', 'Multi-entity payroll', 'White-label domain', 'Expenses & loans'], true],
    ['Scale', 'For groups & agencies', ['Unlimited employees', 'Multi-country payroll', 'Multiple tenants', 'Priority support'], false],
  ];
  return (
    <section id="pricing" className="mx-auto max-w-6xl px-5 py-20">
      <div className="text-center max-w-2xl mx-auto">
        <h2 className="text-4xl font-extrabold tracking-tight" style={{ color: INK }}>Simple, per-employee pricing.</h2>
        <p className="mt-4 text-lg text-slate-600">Start free. Pay only for active employees. No setup fees.</p>
      </div>
      <div className="mt-12 grid md:grid-cols-3 gap-5 items-start">
        {tiers.map(([name, sub, feats, featured]) => (
          <div key={name} className={`rounded-2xl border p-6 ${featured ? 'shadow-xl' : 'bg-white'}`}
            style={featured ? { borderColor: TEAL, boxShadow: '0 20px 50px rgba(22,182,166,.18)' } : { borderColor: '#E2E8F0' }}>
            {featured && <span className="text-xs font-bold uppercase tracking-wide px-2 py-1 rounded" style={{ color: TEAL, backgroundColor: '#E3F6F3' }}>Most popular</span>}
            <h3 className="mt-3 text-xl font-bold" style={{ color: INK }}>{name}</h3>
            <p className="mt-1 text-sm text-slate-500">{sub}</p>
            <ul className="mt-5 space-y-2.5">
              {feats.map((f) => (<li key={f} className="flex items-center gap-2.5 text-sm text-slate-700"><Check /> {f}</li>))}
            </ul>
            <Link href="/signup?redirect=/onboarding"
              className="mt-6 block text-center font-semibold rounded-xl px-4 py-3 text-white hover:opacity-90"
              style={{ backgroundColor: featured ? TEAL : INK }}>Start free</Link>
          </div>
        ))}
      </div>
    </section>
  );
}

const FAQS = [
  ['Which countries do you support?', 'India and New Zealand payroll today, with a country-agnostic engine designed to add more regions.'],
  ['Can I use my own domain and branding?', 'Yes — DriftHR is white-label. Bind your domain, set your logo and colours, and employees use a portal that looks like yours.'],
  ['Is payroll compliant?', 'Statutory rules are built in per country — EPF/ESI/TDS/PT and Form 24Q for India; PAYE/KiwiSaver/Holidays Act and payday filing for New Zealand.'],
  ['Do employees get self-service?', 'Every employee gets a portal for payslips, leave balances, requests and documents — no chasing HR for status updates.'],
];

function FAQ() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-5 py-20">
      <h2 className="text-4xl font-extrabold tracking-tight text-center" style={{ color: INK }}>Questions, answered.</h2>
      <div className="mt-10 divide-y divide-slate-200 border-y border-slate-200">
        {FAQS.map(([q, a]) => (
          <details key={q} className="group py-5">
            <summary className="flex items-center justify-between cursor-pointer list-none font-semibold" style={{ color: INK }}>
              {q}<span className="text-slate-400 group-open:rotate-45 transition-transform text-xl">+</span>
            </summary>
            <p className="mt-3 text-slate-600 text-sm leading-relaxed">{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="mx-auto max-w-6xl px-5 pb-20">
      <div className="rounded-3xl px-8 py-14 text-center" style={{ background: `linear-gradient(135deg, ${INK}, #0F1A2C)` }}>
        <h2 className="text-4xl font-extrabold tracking-tight text-white">Give your team a calmer payday.</h2>
        <p className="mt-4 text-lg text-slate-300 max-w-xl mx-auto">Set up your company, bring your people in, and run your first compliant pay run this week.</p>
        <Link href="/signup?redirect=/onboarding"
          className="mt-8 inline-block font-semibold rounded-xl px-7 py-3.5 text-white hover:opacity-90"
          style={{ backgroundColor: TEAL }}>Start free →</Link>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-slate-100">
      <div className="mx-auto max-w-6xl px-5 py-10 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3"><Logo /><span className="text-sm text-slate-500">Effortless HR &amp; payroll.</span></div>
        <div className="flex items-center gap-6 text-sm text-slate-500">
          <a href="#features" className="hover:text-slate-900">Features</a>
          <a href="#pricing" className="hover:text-slate-900">Pricing</a>
          <Link href="/login" className="hover:text-slate-900">Log in</Link>
        </div>
        <div className="text-xs text-slate-400">© 2026 DriftHR</div>
      </div>
    </footer>
  );
}

export default function HomePage() {
  return (
    <main className="bg-white text-slate-900 antialiased">
      <Nav />
      <Hero />
      <Features />
      <Payroll />
      <HowItWorks />
      <Pricing />
      <FAQ />
      <CTA />
      <Footer />
    </main>
  );
}
