'use client';

import { useEffect, useState } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import LanguageSelector from '@/components/LanguageSelector';
import PricingPlanCards from '@/components/PricingPlanCards';
import { getUnifiedAdminUrl } from '@/lib/platformDomain';

// ============================================================================
// Landing page — multi-vertical AI-powered website platform
// ============================================================================

const INDUSTRIES = [
  { i: '✚', name: 'Dental Clinics' },
  { i: '▦', name: 'Restaurants' },
  { i: '▣', name: 'Grocery Stores' },
  { i: '◇', name: 'Retail Shops' },
  { i: '§', name: 'Law Firms' },
  { i: '₹', name: 'CA & Tax Consultants' },
  { i: '⌘', name: 'IT Agencies' },
  { i: '✂', name: 'Hair Salons' },
  { i: '⌿', name: 'Barbershops' },
  { i: '◈', name: 'Personal Trainers' },
  { i: '❋', name: 'Therapists' },
  { i: 'ॐ', name: 'Yoga Studios' },
  { i: '◉', name: 'Photographers' },
  { i: '▱', name: 'Portfolios' },
  { i: '▵', name: 'Real Estate' },
  { i: '❤', name: 'Veterinary' },
  { i: '↻', name: 'Physiotherapists' },
  { i: '✦', name: 'Chiropractors' },
  { i: '❀', name: 'Nail Studios' },
  { i: '✻', name: 'Spas & Wellness' },
  { i: '★', name: 'Tattoo Parlors' },
  { i: '♪', name: 'Music Teachers' },
  { i: '♛', name: 'Dance Studios' },
  { i: '◆', name: 'Tutors & Coaches' },
  { i: '◇', name: 'Consultants' },
  { i: '○', name: 'Cleaners' },
  { i: '⌬', name: 'Plumbers' },
  { i: '◯', name: 'Auto Detailing' },
  { i: '❍', name: 'Pet Grooming' },
  { i: '⊙', name: 'Opticians' },
];

const THEMES = [
  {
    name: 'Chambers', industries: 'Law · Advisory · Tax',
    bg: '#0b1628', fg: '#f5e7c6', accent: '#d9b770',
    dots: ['#0b1628', '#d9b770', '#ffffff'],
    badge: 'Mehta & Associates', badgeSub: 'PRACTICE · ABOUT · CONTACT',
    headline: 'A steadier hand in', headlineItalic: 'complex matters.',
    body: 'Corporate advisory, dispute resolution and tax litigation — for founders, families and enterprises.',
    headingFont: 'serif',
  },
  {
    name: 'Coastal Dental', industries: 'Dental · Medical · Vet',
    bg: '#eff6fb', fg: '#0b4a6f', accent: '#1a7ab8',
    dots: ['#1a7ab8', '#c8e1f1', '#ffffff'],
    badge: 'Bright Smile', badgeSub: 'Book · Services · Team',
    headline: 'A healthier smile, booked', headlineItalic: 'online.',
    body: 'Family dentistry in Koramangala. Same-day appointments.',
    chips: ['Cleaning', 'Whitening', 'Implants', 'Kids'],
    cta: 'Book appointment →',
  },
  {
    name: 'Osha', industries: 'Spa · Wellness · Salon',
    bg: '#f4ead8', fg: '#3d3322', accent: '#8a6f3f',
    dots: ['#f4ead8', '#8a6f3f', '#1a1510'],
    badge: 'O S H A   S P A', centered: true,
    headline: 'Quietude,', headlineItalic: 'by appointment.',
    body: 'A private, member-only spa. Deep tissue, aromatherapy, seasonal facials.',
    cta: 'R E S E R V E',
    headingFont: 'serif',
  },
  {
    name: 'Razor & Co.', industries: 'Barber · Salon · Tattoo',
    bg: '#0a0a0a', fg: '#ffffff', accent: '#e53935',
    dots: ['#0a0a0a', '#e53935', '#ffffff'],
    badge: '◇ RAZOR & CO.', uppercase: true,
    headline: 'SHARP CUTS.', headlineItalic: 'NO BS.', italicColor: '#e53935',
    body: 'Traditional barbering — fade, beard, hot towel. Walk-ins welcome, bookings preferred.',
    cta: 'BOOK A CHAIR',
    barcode: true,
  },
  {
    name: 'Iron Studio', industries: 'Fitness · Yoga · PT',
    bg: '#0b0b0b', fg: '#ffffff', accent: '#f97316',
    dots: ['#0a0a0a', '#f97316', '#ffffff'],
    badge: 'IRON / 01', splitBadge: true,
    headline: 'TRAIN LIKE YOU', headlineItalic: 'MEAN IT.', italicColor: '#f97316',
    body: '1-on-1 strength coaching. Programmed, progressive, personal.',
    cta: 'BOOK A SESSION →',
    uppercase: true,
  },
  {
    name: 'Meadow', industries: 'Therapy · Coaching',
    bg: '#e9efe4', fg: '#2a3627', accent: '#5a7a4e',
    dots: ['#e9efe4', '#5a7a4e', '#2a3627'],
    badge: '● Meadow Therapy',
    headline: 'Space to', headlineItalic: 'slow down,',
    headlineAfter: 'gently.',
    body: 'Confidential 1-on-1 therapy. Anxiety, grief, relationships, burnout.',
    twoCta: [{ label: 'In-person', sub: 'Indiranagar · 60m' }, { label: 'Online', sub: 'Zoom · Worldwide' }],
    headingFont: 'serif',
  },
];

const DESIGN_PRESETS = [
  { name: 'Medical trust', tone: 'Clinic', kind: 'clinic', bg: '#EAF6FB', surface: '#FFFFFF', ink: '#0B4A6F', muted: '#6A8798', accent: '#1A7AB8' },
  { name: 'Restaurant menu', tone: 'Restaurant', kind: 'restaurant', bg: '#14100C', surface: '#241A12', ink: '#F8E7CA', muted: '#C7A77F', accent: '#D6A24F' },
  { name: 'Agency bold', tone: 'Agency', kind: 'agency', bg: '#111827', surface: '#FFFFFF', ink: '#F9FAFB', muted: '#A7B0C0', accent: '#F97316' },
  { name: 'Wellness warm', tone: 'Wellness', kind: 'wellness', bg: '#F4EAD8', surface: '#FFFDF8', ink: '#3D3322', muted: '#7E6D55', accent: '#8A6F3F' },
  { name: 'Tech grid', tone: 'Consulting', kind: 'tech', bg: '#07111F', surface: '#0D1C31', ink: '#E8F1FF', muted: '#7EA0C4', accent: '#38BDF8' },
  { name: 'Luxury serif', tone: 'Premium', kind: 'luxury', bg: '#FBF7EF', surface: '#15110D', ink: '#221811', muted: '#8A7561', accent: '#B98B48' },
  { name: 'Grocery-ready', tone: 'Shop', kind: 'shop', bg: '#F0FDF4', surface: '#FFFFFF', ink: '#14532D', muted: '#6B8A74', accent: '#16A34A' },
  { name: 'Creative mosaic', tone: 'Portfolio', kind: 'portfolio', bg: '#FAFAFA', surface: '#111111', ink: '#111111', muted: '#71717A', accent: '#7C3AED' },
];

const DESIGN_STATS = [
  { label: 'Verticals', value: '3', detail: 'Booking · Shop · Web' },
  { label: 'Base themes', value: '40+', detail: 'Industry-specific families' },
  { label: 'Layout systems', value: '15', detail: 'Switch without rebuilding' },
  { label: 'Combinations', value: '1000s', detail: 'Theme + layout + colors' },
];

const DESIGN_ENGINE_FEATURES = [
  ['Theme', 'Industry-specific personality: clinic, restaurant, law, salon, grocery and more.'],
  ['Layout', 'Swap the structure without losing content, pages, SEO or domain settings.'],
  ['Visual style', 'Modern, luxury, editorial, compact, bold, soft, clinical or conversion-led.'],
  ['Colors', 'Preset palettes and brand color controls that keep the public site coherent.'],
  ['AI layer', 'AI-powered copy, SEO and setup assistance rolling into the builder.'],
];

const PLANS = [
  {
    slug: 'solo', name: 'Solo', tagline: 'Get online and take your first booking today.',
    monthly: 900, yearly: 8640,
    features: [
      '1 staff member',
      'Up to 50 bookings / month',
      '.sitepresso.com subdomain included',
      'Email reminders',
      '"Powered by DriftHR" branding',
      'Platform-managed online payments',
    ],
    cta: 'Start trial',
  },
  {
    slug: 'starter', name: 'Starter', tagline: 'For the solo practitioner ready to look professional.',
    monthly: 499, yearly: 4790,
    features: [
      'Everything in Solo',
      'Up to 2 staff members',
      'Unlimited bookings',
      'Your own brand domain (yours.com)',
      'Branding watermark removed',
      '200 SMS reminders / month',
      'Basic CRM & client notes',
      'Google & Apple calendar sync',
    ],
    cta: 'Start trial',
  },
  {
    slug: 'professional', name: 'Professional', tagline: 'Built for teams.',
    monthly: 1499, yearly: 14390, popular: true,
    includedStaff: 10,
    features: [
      'Everything in Starter',
      'Up to 10 staff members included',
      // extra-staff line injected dynamically from regional pricing config
      'Service & staff routing',
      'Full CRM with tags & segments',
      'Marketing automation (birthdays, re-engagement)',
      'Advanced intake forms & file uploads',
      'Unlimited SMS reminders',
      'Analytics & reports',
      'Waiting list & multi-currency',
    ],
    cta: 'Start trial',
  },
  {
    slug: 'business', name: 'Business', tagline: 'Multi-location and group practices.',
    monthly: 3999, yearly: 38390,
    features: [
      'Everything in Professional',
      'Unlimited staff',
      'Multi-location support',
      'Role-based access control (RBAC)',
      'API access & webhooks',
      'HIPAA / compliance add-ons',
      'Priority support',
      'Dedicated success manager',
    ],
    cta: 'Talk to sales',
    ctaHref: 'mailto:sales@sitepresso.com',
  },
];

const TESTIMONIALS = [
  {
    name: 'Dr. Radhika Rao', role: 'Founder · Bright Smile Dental', initials: 'DR',
    initialsBg: '#1a7ab8',
    quote: 'I had a ',
    italic: 'real storefront',
    quoteRest: ' up before my evening clinic. My front-desk spends 40% less time on the phone now. This is what I\'ve been waiting for.',
    url: 'brightsmile.sitepresso.com',
  },
  {
    name: 'Mukund K.', role: 'Owner · Razor & Co. Barbershop', initials: 'MK',
    initialsBg: '#8b1c1c',
    quote: 'Customers text me and say ',
    italic: '\'your booking page is sick, bro.\'',
    quoteRest: ' My chair-booking doubled in a month. The barbershop theme looks like I paid ten grand.',
    url: 'razorandco.in',
  },
  {
    name: 'Aditi Mehta', role: 'Partner · Mehta & Associates', initials: 'AM',
    initialsBg: '#5e4a2a',
    quote: 'I was embarrassed to send my old site to clients. ',
    italic: 'Now I proudly share the link.',
    quoteRest: ' And it\'s on our own domain — nobody knows it\'s a SaaS.',
    url: 'consult.mehtalaw.in',
  },
];

const FAQS = [
  { q: 'Do I really not need a designer or developer?',
    a: 'Really. Pick a theme, drop in your logo and headline, set your services and hours. Publishing is one click. DriftHR hosts, updates and scales the software — you never touch code or servers.' },
  { q: 'Do I own the software, or is it hosted by you?',
    a: 'DriftHR is a SaaS — like Shopify. Your storefront runs on our infrastructure and stays up-to-date automatically. You don\'t own the software, but you own your brand, content, domain, customers and bookings. If you ever leave, you keep the domain and export every record.' },
  { q: 'Can my customers tell it\'s a SaaS?',
    a: 'On paid plans — no. Point your own domain (appointments.yourfirm.com) at us and we strip every "Powered by" mark. Customers see your brand; they never see DriftHR.' },
  { q: 'What if my industry isn\'t in the theme list?',
    a: 'We ship a neutral "Service Pro" theme that works for any service business. And we add 2–3 new industry themes every month. Tell us what you need.' },
  { q: 'How do bookings actually reach me?',
    a: 'Email and SMS the instant a customer books. Syncs to Google/Apple calendar. You never miss a slot, even during sessions.' },
  { q: 'Can I take deposits or full payment?',
    a: 'Yes. Use DriftHR-managed checkout for deposits, full payments, and subscriptions where your plan supports it. No-shows drop fast, checkout stays consistent, and billing records stay inside your admin.' },
  { q: 'What happens after the launch period?',
    a: 'You\'ll get a 30-day heads up. Pick any plan, or stay on Solo. Your site, domain, and bookings stay exactly as they are — nothing gets deleted.' },
  { q: 'Do I own my data and domain?',
    a: 'Yes. Bookings, customers and services export as CSV anytime. Your custom domain stays in your registrar account — you point it at us, you can point it away. The storefront software is ours to run; the business it powers is yours to keep.' },
  { q: 'Can I have multiple staff with their own calendars?',
    a: 'Yes, from the Team plan. Each staff member gets their own schedule, availability, services, and notifications. Customers pick who they want.' },
  { q: 'Can I use my own brand domain?',
    a: 'Yes. Bring any domain you own — yourbrand.com or book.yourbrand.com — and point it at us. We handle the SSL and hosting. Customers see your brand in the address bar; DriftHR stays invisible. Don\'t have a domain yet? You can start on a free sitepresso.com subdomain and switch to your own later.' },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-gray-900" style={{ fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>
      <Nav />
      <Hero />
      <IndustriesMarquee />
      <Verticals />
      <DesignEngine />
      <ShiftHeader />
      <BeforeAfter />
      <HowItWorksHeader />
      <Steps />
      <ThemesShowcase />
      <Pricing />
      <TestimonialsHeader />
      <Testimonials />
      <FAQHeader />
      <FAQ />
      <FinalCta />
      <Footer />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Shared bits
// ----------------------------------------------------------------------------

function SectionLabel({ children }) {
  return (
    <p className="text-xs font-semibold tracking-[0.18em] text-violet-600 font-mono uppercase flex items-center gap-2">
      <span className="inline-block w-5 h-px bg-violet-600" />
      {children}
    </p>
  );
}

function Italic({ children }) {
  return (
    <span className="italic text-violet-600" style={{ fontFamily: 'Georgia, "Times New Roman", ui-serif, serif' }}>
      {children}
    </span>
  );
}

function Check({ color = 'text-violet-600' }) {
  return (
    <svg className={`w-4 h-4 ${color}`} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M16.704 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.29-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
    </svg>
  );
}

function Logo({ size = 'nav' }) {
  // 'nav' = header logo, larger so the brand reads at a glance.
  // 'footer' = same scale; footer used to be smaller but now matches.
  const heightClass = size === 'footer' ? 'h-9' : 'h-10';
  return (
    <img
      src="/drifthr-logo.svg"
      alt="DriftHR · Effortless HR & payroll"
      className={`${heightClass} w-auto`}
    />
  );
}

// ----------------------------------------------------------------------------
// Navigation
// ----------------------------------------------------------------------------

function Nav() {
  const tCommon = useTranslations('common');
  const t = useTranslations('landing');
  const currentLocale = typeof document !== 'undefined'
    ? (document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/)?.[1] || 'en')
    : 'en';
  return (
    <nav className="sticky top-0 z-50 bg-white/95 backdrop-blur-md border-b border-gray-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-6 lg:px-8 h-[72px] flex items-center justify-between gap-8">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <Logo />
        </Link>
        <div className="hidden md:flex items-center gap-8 text-[15px] font-medium text-gray-600">
          <a href="#how-it-works" className="hover:text-violet-600 transition-colors">{t('navHowItWorks')}</a>
          <a href="#themes" className="hover:text-violet-600 transition-colors">{t('navThemes')}</a>
          <a href="#pricing" className="hover:text-violet-600 transition-colors">{t('navPricing')}</a>
          <a href="#faq" className="hover:text-violet-600 transition-colors">{t('navFaq')}</a>
          <Link href="/blog" className="hover:text-violet-600 transition-colors">{t('navBlog')}</Link>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <LanguageSelector currentLocale={currentLocale} />
          <span className="hidden sm:block w-px h-5 bg-gray-200" />
          {/* Login goes to the unified-admin host (app.<domain>/login)
              rather than apex /login. Apex /login still works for legacy
              path-based admin URLs but the new canonical login is on
              app.* — going there directly keeps the post-login redirect
              clean and avoids a cross-host hop. */}
          <a href={getUnifiedAdminUrl('/login')}
            className="hidden sm:inline-flex items-center px-4 py-2 border border-gray-300 hover:border-violet-400 hover:text-violet-600 text-gray-700 text-sm font-semibold rounded-xl transition-colors">
            {tCommon('signIn')}
          </a>
          <Link href="/signup?redirect=/onboarding"
            className="inline-flex items-center gap-1.5 px-5 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm">
            {tCommon('startFree')} →
          </Link>
        </div>
      </div>
    </nav>
  );
}

// ----------------------------------------------------------------------------
// Hero
// ----------------------------------------------------------------------------

function Hero() {
  const t = useTranslations('landing');
  return (
    <section className="relative min-h-[78svh] overflow-hidden bg-[#080A10] text-white">
      <HeroDesignBackdrop />
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(90deg, rgba(8,10,16,0.98) 0%, rgba(8,10,16,0.88) 42%, rgba(8,10,16,0.48) 100%), linear-gradient(180deg, rgba(31,18,70,0.34) 0%, rgba(8,10,16,0.18) 52%, rgba(8,10,16,0.88) 100%)',
        }}
      />

      <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-8 pt-16 md:pt-20 pb-14 md:pb-16">
        <div className="max-w-4xl">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/15 bg-white/10 text-xs font-medium text-white/90 mb-6 backdrop-blur-md">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>{t('launchBadge')}</span>
          </div>
          <h1 className="max-w-4xl text-5xl md:text-6xl lg:text-7xl font-bold leading-[1.04] text-white">
            {t('heroHeadlineStart')}
            <br />
            <span className="italic text-violet-200" style={{ fontFamily: 'Georgia, "Times New Roman", ui-serif, serif' }}>
              {t('heroHeadlineItalic')}
            </span>
          </h1>
          <p className="mt-6 text-lg md:text-xl text-white/75 leading-relaxed max-w-2xl">
            {t('heroSubhead')}
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3">
            <Link href="/signup?redirect=/onboarding"
              className="inline-flex items-center justify-center gap-2 px-7 py-4 bg-white hover:bg-violet-50 text-gray-950 font-semibold rounded-2xl transition-all hover:shadow-xl hover:-translate-y-0.5">
              {t('heroCta1')} →
            </Link>
            <a href="#themes"
              className="inline-flex items-center justify-center gap-2 px-7 py-4 bg-white/10 border border-white/20 hover:bg-white/15 text-white font-semibold rounded-2xl transition-colors backdrop-blur-md">
              {t('heroCta2')}
            </a>
          </div>
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-sm text-white/75">
            <span className="inline-flex items-center gap-1.5"><Check color="text-emerald-300" /> {t('trustHosted')}</span>
            <span className="inline-flex items-center gap-1.5"><Check color="text-emerald-300" /> {t('trustDomain')}</span>
            <span className="inline-flex items-center gap-1.5"><Check color="text-emerald-300" /> {t('trustNoCard')}</span>
            <span className="inline-flex items-center gap-1.5"><Check color="text-emerald-300" /> {t('trustThemes')}</span>
          </div>
        </div>

        <div className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {DESIGN_STATS.map((stat) => (
            <div key={stat.label} className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur-md">
              <p className="text-3xl font-bold text-white">{stat.value}</p>
              <p className="mt-1 text-xs font-semibold uppercase tracking-[0.14em] text-violet-200">{stat.label}</p>
              <p className="mt-2 text-xs text-white/50">{stat.detail}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HeroDesignBackdrop() {
  return (
    <div className="absolute inset-0 opacity-80">
      <div className="absolute -right-16 top-6 hidden w-[58vw] rotate-[-5deg] grid-cols-2 gap-5 lg:grid">
        {DESIGN_PRESETS.slice(0, 6).map((preset, index) => (
          <div
            key={preset.name}
            className={`overflow-hidden rounded-2xl border border-white/10 bg-white/10 shadow-2xl ${index % 2 ? 'translate-y-10' : ''}`}
          >
            <MiniWebsitePreview preset={preset} compact />
            <div className="flex items-center justify-between bg-black/45 px-4 py-3 text-white backdrop-blur-md">
              <span className="text-sm font-semibold">{preset.name}</span>
              <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-violet-200">{preset.tone}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="absolute inset-x-4 bottom-4 grid grid-cols-4 gap-3 opacity-50 lg:hidden">
        {DESIGN_PRESETS.slice(0, 4).map((preset) => (
          <div key={preset.name} className="h-28 overflow-hidden rounded-xl">
            <MiniWebsitePreview preset={preset} compact />
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniWebsitePreview({ preset, compact = false }) {
  const h = compact ? 'h-56' : 'h-56 md:h-60';
  return (
    <div
      className={`${h} overflow-hidden`}
      style={{ backgroundColor: preset.bg, color: preset.ink }}
      aria-hidden="true"
    >
      <div className="flex h-full flex-col">
        <MiniNav preset={preset} />
        <div className="flex-1 p-3">
          <MiniPreviewBody preset={preset} compact={compact} />
        </div>
      </div>
    </div>
  );
}

function MiniNav({ preset }) {
  return (
    <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: `${preset.accent}26`, backgroundColor: `${preset.surface}CC` }}>
      <div className="flex items-center gap-2">
        <span className="h-5 w-5 rounded-md" style={{ backgroundColor: preset.accent }} />
        <span className="h-2.5 w-20 rounded-full" style={{ backgroundColor: preset.ink, opacity: 0.82 }} />
      </div>
      <div className="hidden items-center gap-1.5 sm:flex">
        <span className="h-1.5 w-8 rounded-full" style={{ backgroundColor: preset.muted, opacity: 0.45 }} />
        <span className="h-1.5 w-8 rounded-full" style={{ backgroundColor: preset.muted, opacity: 0.45 }} />
        <span className="h-4 w-10 rounded-full" style={{ backgroundColor: preset.accent }} />
      </div>
    </div>
  );
}

function MiniPreviewBody({ preset, compact }) {
  if (preset.kind === 'clinic') return <MiniClinic preset={preset} compact={compact} />;
  if (preset.kind === 'restaurant') return <MiniRestaurant preset={preset} compact={compact} />;
  if (preset.kind === 'agency') return <MiniAgency preset={preset} compact={compact} />;
  if (preset.kind === 'wellness') return <MiniWellness preset={preset} compact={compact} />;
  if (preset.kind === 'tech') return <MiniTech preset={preset} compact={compact} />;
  if (preset.kind === 'luxury') return <MiniLuxury preset={preset} compact={compact} />;
  if (preset.kind === 'shop') return <MiniShop preset={preset} compact={compact} />;
  return <MiniPortfolio preset={preset} compact={compact} />;
}

function MiniLine({ color, width = 'w-full', height = 'h-2', opacity = 1 }) {
  return <span className={`block rounded-full ${width} ${height}`} style={{ backgroundColor: color, opacity }} />;
}

function MiniClinic({ preset }) {
  return (
    <div className="grid h-full grid-cols-[1.05fr_0.95fr] gap-3">
      <div className="space-y-2">
        <MiniLine color={preset.accent} width="w-16" height="h-1.5" />
        <MiniLine color={preset.ink} width="w-28" height="h-3" />
        <MiniLine color={preset.ink} width="w-20" height="h-3" />
        <MiniLine color={preset.muted} width="w-24" height="h-1.5" opacity={0.45} />
        <div className="mt-2 flex gap-1.5">
          <span className="h-5 w-16 rounded-md" style={{ backgroundColor: preset.accent }} />
          <span className="h-5 w-12 rounded-md border" style={{ borderColor: `${preset.accent}55` }} />
        </div>
      </div>
      <div className="rounded-xl p-2" style={{ backgroundColor: preset.surface }}>
        <div className="mb-2 h-14 rounded-lg" style={{ background: `linear-gradient(135deg, ${preset.accent}30, ${preset.bg})` }} />
        <div className="grid grid-cols-2 gap-1.5">
          {[0, 1, 2, 3].map((item) => (
            <span key={item} className="h-5 rounded-md" style={{ backgroundColor: `${preset.accent}${item % 2 ? '20' : '35'}` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MiniRestaurant({ preset }) {
  return (
    <div className="grid h-full grid-cols-[0.9fr_1.1fr] gap-3">
      <div className="rounded-xl border p-3" style={{ borderColor: `${preset.accent}66`, backgroundColor: preset.surface }}>
        <MiniLine color={preset.accent} width="w-12" height="h-1.5" />
        <div className="mt-3 space-y-2">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="flex items-center justify-between gap-2">
              <MiniLine color={preset.ink} width="w-16" height="h-1.5" opacity={0.75} />
              <span className="h-1.5 w-5 rounded-full" style={{ backgroundColor: preset.accent }} />
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <div className="h-16 rounded-xl" style={{ background: `linear-gradient(135deg, ${preset.accent}, #5B3418)` }} />
        <div className="grid grid-cols-3 gap-1.5">
          {['2', '4', '6'].map((seat) => (
            <span key={seat} className="rounded-md py-1 text-center text-[9px] font-bold" style={{ backgroundColor: `${preset.accent}30`, color: preset.ink }}>
              {seat}
            </span>
          ))}
        </div>
        <span className="block h-5 rounded-md" style={{ backgroundColor: preset.accent }} />
      </div>
    </div>
  );
}

function MiniAgency({ preset }) {
  return (
    <div className="grid h-full grid-cols-[1fr_0.9fr] gap-3">
      <div className="space-y-2">
        <span className="inline-flex rounded-md px-2 py-1 text-[9px] font-bold uppercase" style={{ backgroundColor: preset.accent, color: '#111827' }}>Strategy</span>
        <MiniLine color={preset.ink} width="w-28" height="h-4" />
        <MiniLine color={preset.ink} width="w-20" height="h-4" />
        <MiniLine color={preset.muted} width="w-24" height="h-1.5" opacity={0.65} />
        <span className="block h-6 w-20 rounded-full" style={{ backgroundColor: preset.accent }} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className={`${item === 0 ? 'row-span-2' : ''} rounded-xl`} style={{ backgroundColor: item === 0 ? preset.accent : preset.surface, opacity: item === 0 ? 1 : 0.92 }} />
        ))}
      </div>
    </div>
  );
}

function MiniWellness({ preset }) {
  return (
    <div className="h-full rounded-2xl p-3" style={{ backgroundColor: preset.surface }}>
      <div className="grid h-full grid-cols-[0.95fr_1.05fr] gap-3">
        <div className="rounded-[999px_999px_24px_24px]" style={{ background: `linear-gradient(180deg, ${preset.accent}55, ${preset.bg})` }} />
        <div className="space-y-2 self-center">
          <MiniLine color={preset.accent} width="w-12" height="h-1.5" />
          <MiniLine color={preset.ink} width="w-24" height="h-3" />
          <MiniLine color={preset.ink} width="w-16" height="h-3" />
          <MiniLine color={preset.muted} width="w-20" height="h-1.5" opacity={0.5} />
          <div className="flex gap-1.5">
            <span className="h-5 w-12 rounded-full" style={{ backgroundColor: `${preset.accent}35` }} />
            <span className="h-5 w-10 rounded-full" style={{ backgroundColor: `${preset.accent}25` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniTech({ preset }) {
  return (
    <div className="grid h-full grid-cols-[1.15fr_0.85fr] gap-3">
      <div className="rounded-xl border p-3" style={{ borderColor: `${preset.accent}35`, backgroundColor: preset.surface }}>
        <MiniLine color={preset.accent} width="w-12" height="h-1.5" />
        <div className="mt-3 grid grid-cols-2 gap-2">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="rounded-lg border p-2" style={{ borderColor: `${preset.accent}26`, backgroundColor: '#07111F' }}>
              <MiniLine color={item === 0 ? preset.accent : preset.ink} width="w-8" height="h-2" opacity={item === 0 ? 1 : 0.65} />
              <MiniLine color={preset.muted} width="w-10" height="h-1.5" opacity={0.45} />
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((item) => (
          <div key={item} className="h-4 rounded-md" style={{ backgroundColor: item === 1 ? preset.accent : `${preset.surface}` }} />
        ))}
      </div>
    </div>
  );
}

function MiniLuxury({ preset }) {
  return (
    <div className="grid h-full grid-cols-[0.9fr_1.1fr] gap-3">
      <div className="rounded-xl p-3 text-center" style={{ backgroundColor: preset.surface, color: '#F6E7CE' }}>
        <MiniLine color={preset.accent} width="mx-auto w-12" height="h-1.5" />
        <p className="mt-3 text-xl leading-none" style={{ fontFamily: 'Georgia, serif' }}>Luxe</p>
        <MiniLine color="#F6E7CE" width="mx-auto mt-2 w-16" height="h-1.5" opacity={0.45} />
        <span className="mx-auto mt-4 block h-5 w-16 rounded-full" style={{ backgroundColor: preset.accent }} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2 rounded-xl" style={{ background: `linear-gradient(135deg, ${preset.accent}55, ${preset.bg})` }} />
        <div className="rounded-xl border" style={{ borderColor: `${preset.accent}45`, backgroundColor: preset.surface }} />
        <div className="rounded-xl border" style={{ borderColor: `${preset.accent}45`, backgroundColor: '#FFFFFF' }} />
      </div>
    </div>
  );
}

function MiniShop({ preset }) {
  return (
    <div className="grid h-full grid-cols-[0.7fr_1.3fr] gap-3">
      <div className="space-y-1.5">
        {['Fresh', 'Dairy', 'Bakery', 'Fruit'].map((label, index) => (
          <span key={label} className="block rounded-lg px-2 py-1 text-[9px] font-semibold" style={{ backgroundColor: index === 0 ? preset.accent : preset.surface, color: index === 0 ? '#FFFFFF' : preset.ink }}>
            {label}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="rounded-xl border bg-white p-2" style={{ borderColor: `${preset.accent}30` }}>
            <div className="h-8 rounded-lg" style={{ backgroundColor: `${preset.accent}${item % 2 ? '25' : '40'}` }} />
            <MiniLine color={preset.ink} width="mt-2 w-12" height="h-1.5" opacity={0.75} />
            <MiniLine color={preset.accent} width="mt-1 w-8" height="h-1.5" />
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniPortfolio({ preset }) {
  return (
    <div className="grid h-full grid-cols-[1fr_0.85fr] gap-3">
      <div className="grid grid-cols-2 gap-2">
        {[0, 1, 2, 3, 4, 5].map((item) => (
          <div
            key={item}
            className={`${item === 0 || item === 5 ? 'row-span-2' : ''} rounded-xl`}
            style={{ backgroundColor: item % 3 === 0 ? preset.accent : item % 3 === 1 ? preset.surface : '#E4E4E7' }}
          />
        ))}
      </div>
      <div className="space-y-2 self-center">
        <MiniLine color={preset.ink} width="w-24" height="h-3" />
        <MiniLine color={preset.ink} width="w-16" height="h-3" />
        <MiniLine color={preset.muted} width="w-20" height="h-1.5" opacity={0.6} />
        <span className="block h-6 w-20 rounded-full" style={{ backgroundColor: preset.surface }} />
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Industries marquee
// ----------------------------------------------------------------------------

function IndustriesMarquee() {
  const t = useTranslations('landing');
  const doubled = [...INDUSTRIES, ...INDUSTRIES];
  return (
    <section className="border-y border-gray-100 bg-gray-50/50 py-10 md:py-14 overflow-hidden">
      <p className="text-center text-xs font-mono tracking-[0.25em] text-gray-500 mb-8 uppercase">
        {t('marqueeLabel')}
      </p>
      <div className="space-y-4">
        <MarqueeRow items={doubled} direction="ltr" />
        <MarqueeRow items={[...INDUSTRIES].reverse().concat([...INDUSTRIES].reverse())} direction="rtl" />
      </div>
    </section>
  );
}

function MarqueeRow({ items, direction }) {
  return (
    <div className="flex overflow-hidden">
      <div className={`flex gap-3 shrink-0 pr-3 ${direction === 'ltr' ? 'animate-marquee-ltr' : 'animate-marquee-rtl'}`}>
        {items.map((it, i) => (
          <span key={i} className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-gray-200 bg-white text-sm text-gray-700 whitespace-nowrap">
            <span className="text-violet-500">{it.i}</span>{it.name}
          </span>
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Verticals showcase — three websites on one platform.
// Lives between the marquee and "The shift" so the multi-vertical USP
// lands before the appointment-flavoured before/after copy.
// ----------------------------------------------------------------------------

const VERTICAL_CARDS = [
  {
    key: 'APPOINTMENT',
    accent: 'from-violet-500 to-fuchsia-500',
    badge: 'bg-violet-100 text-violet-700',
    icon: '📅',
    titleKey: 'verticalApptTitle',
    taglineKey: 'verticalApptTagline',
    bodyKey: 'verticalApptBody',
    href: '/signup?redirect=/onboarding&vertical=APPOINTMENT',
    examples: ['Salon', 'Clinic', 'Coach', 'Studio'],
  },
  {
    key: 'ECOMMERCE',
    accent: 'from-emerald-500 to-teal-500',
    badge: 'bg-emerald-100 text-emerald-700',
    icon: '🛒',
    titleKey: 'verticalEcomTitle',
    taglineKey: 'verticalEcomTagline',
    bodyKey: 'verticalEcomBody',
    href: '/signup?redirect=/onboarding&vertical=ECOMMERCE',
    examples: ['Grocer', 'Boutique', 'Bakery', 'Cloud kitchen'],
  },
  {
    key: 'STATIC',
    accent: 'from-amber-500 to-orange-500',
    badge: 'bg-amber-100 text-amber-700',
    icon: '✨',
    titleKey: 'verticalStaticTitle',
    taglineKey: 'verticalStaticTagline',
    bodyKey: 'verticalStaticBody',
    href: '/signup?redirect=/onboarding&vertical=STATIC',
    examples: ['Lawyer', 'Consultant', 'Architect', 'Agency'],
  },
];

function Verticals() {
  const t = useTranslations('landing');
  return (
    <section id="verticals" className="max-w-7xl mx-auto px-6 lg:px-8 pt-20 md:pt-28 pb-10">
      <div className="text-center max-w-3xl mx-auto">
        <SectionLabel><span className="flex justify-center w-full">{t('verticalsEyebrow')}</span></SectionLabel>
        <h2 className="mt-5 text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.05] tracking-tight">
          {t('verticalsHeadlineStart')}{' '}
          <Italic>{t('verticalsHeadlineItalic')}</Italic>
        </h2>
        <p className="mt-6 text-lg text-gray-600 leading-relaxed">
          {t('verticalsBody')}
        </p>
      </div>

      <div className="mt-12 grid md:grid-cols-3 gap-5">
        {VERTICAL_CARDS.map((card) => (
          <Link
            key={card.key}
            href={card.href}
            className="group relative rounded-3xl border border-gray-200 bg-white p-7 hover:border-gray-900 hover:shadow-xl transition-all duration-200 overflow-hidden"
          >
            {/* Top accent bar */}
            <div
              className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${card.accent}`}
              aria-hidden="true"
            />
            <div className="flex items-center gap-3 mb-5">
              <span className={`w-12 h-12 rounded-2xl ${card.badge} text-2xl flex items-center justify-center`}>
                {card.icon}
              </span>
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] font-mono font-semibold text-gray-500">
                  {t(card.taglineKey)}
                </p>
                <h3 className="text-xl font-bold text-gray-900">
                  {t(card.titleKey)}
                </h3>
              </div>
            </div>
            <p className="text-sm text-gray-600 leading-relaxed">
              {t(card.bodyKey)}
            </p>
            <div className="mt-5 flex flex-wrap gap-1.5">
              {card.examples.map((ex) => (
                <span
                  key={ex}
                  className="inline-flex items-center px-2.5 py-1 rounded-full bg-gray-100 text-gray-600 text-xs font-medium"
                >
                  {ex}
                </span>
              ))}
            </div>
            <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-gray-900 group-hover:gap-2.5 transition-all">
              {t('verticalCta')}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------------
// Design engine — current-state product story
// ----------------------------------------------------------------------------

function DesignEngine() {
  return (
    <section className="max-w-7xl mx-auto px-6 lg:px-8 py-20 md:py-28">
      <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-end">
        <div>
          <SectionLabel>Design engine</SectionLabel>
          <h2 className="mt-5 text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.08]">
            Thousands of combinations,
            <br />
            <Italic>one clean builder.</Italic>
          </h2>
          <p className="mt-6 text-lg text-gray-600 leading-relaxed">
            DriftHR is no longer just a booking page. It is a vertical-aware website system:
            themes, layouts, visual treatments and brand colors combine into polished sites for
            appointments, ecommerce and static web businesses.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {DESIGN_ENGINE_FEATURES.map(([title, body]) => (
            <div key={title} className="rounded-2xl border border-gray-200 bg-white p-5">
              <p className="text-xs font-mono font-semibold uppercase tracking-[0.16em] text-violet-600">{title}</p>
              <p className="mt-3 text-sm leading-relaxed text-gray-600">{body}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {DESIGN_PRESETS.map((preset) => (
          <div key={preset.name} className="group overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-xl">
            <MiniWebsitePreview preset={preset} />
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-gray-900">{preset.name}</p>
                <p className="text-xs text-gray-500">{preset.tone}</p>
              </div>
              <div className="flex gap-1">
                {[preset.bg, preset.surface, preset.accent].map((color) => (
                  <span key={color} className="h-4 w-4 rounded-full border border-gray-200" style={{ backgroundColor: color }} />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-3xl border border-gray-200 bg-gray-950 p-6 text-white md:p-8">
        <div className="grid gap-6 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <p className="text-xs font-mono font-semibold uppercase tracking-[0.18em] text-violet-300">AI-powered next</p>
            <h3 className="mt-3 text-2xl md:text-3xl font-bold">AI assistance belongs inside the builder, not as a separate tool.</h3>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-white/70">
              The landing page now positions DriftHR for the AI layer coming next: guided copy,
              SEO suggestions, page structure help and faster setup across all three verticals.
            </p>
          </div>
          <Link href="/signup?redirect=/onboarding" className="inline-flex items-center justify-center rounded-2xl bg-white px-6 py-3 text-sm font-bold text-gray-950 hover:bg-violet-50">
            Start building →
          </Link>
        </div>
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------------
// "The shift" header
// ----------------------------------------------------------------------------

function ShiftHeader() {
  const t = useTranslations('landing');
  return (
    <section className="max-w-5xl mx-auto px-6 lg:px-8 pt-20 md:pt-28 pb-10">
      <SectionLabel>{t('shiftEyebrow')}</SectionLabel>
      <h2 className="mt-5 text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.1] tracking-tight">
        {t('shiftHeadlineStart')}
        <br />
        <Italic>{t('shiftHeadlineItalic')}</Italic>
      </h2>
      <p className="mt-6 text-lg text-gray-600 max-w-2xl leading-relaxed">
        {t('shiftBody')}
      </p>
    </section>
  );
}

// ----------------------------------------------------------------------------
// Before / After cards
// ----------------------------------------------------------------------------

function BeforeAfter() {
  const t = useTranslations('landing');
  return (
    <section className="max-w-7xl mx-auto px-6 lg:px-8 pb-16 md:pb-24 grid md:grid-cols-2 gap-5">
      {/* Before */}
      <div className="rounded-3xl bg-[#f4efe4] p-8 md:p-10">
        <p className="text-xs font-mono tracking-[0.18em] text-gray-500 uppercase">{t('beforeLabel')}</p>
        <h3 className="mt-3 text-2xl md:text-3xl font-bold text-gray-900 tracking-tight">{t('beforeHeadline')}</h3>
        <ul className="mt-6 space-y-3.5">
          {[
            [t('beforeMissedCalls'),   t('beforeMissedCallsRest')],
            [t('beforeWhatsApp'),       t('beforeWhatsAppRest')],
            [t('beforeNoStorefront'),   t('beforeNoStorefrontRest')],
            [t('beforeNoAfterHours'),   t('beforeNoAfterHoursRest')],
          ].map(([bold, rest], i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-md bg-gray-300/60 text-gray-700 flex items-center justify-center flex-shrink-0 mt-0.5">✕</span>
              <span className="text-sm md:text-base text-gray-800"><strong className="font-semibold">{bold}</strong>{rest.startsWith(',') || rest.startsWith('—') ? rest : ` ${rest}`}</span>
            </li>
          ))}
        </ul>
        <div className="mt-6 rounded-xl border border-gray-300/50 bg-white/50 p-3 space-y-1.5">
          <div className="px-3 py-2 rounded-md bg-white border border-red-100 text-xs text-red-700 font-mono">↙ Missed call · Mom · Sat 8:04pm</div>
          <div className="px-3 py-2 rounded-md bg-white border border-gray-200 text-xs text-gray-700 font-mono">Tomorrow 11? — Rajesh</div>
          <div className="px-3 py-2 rounded-md bg-white border border-gray-200 text-xs text-gray-700 font-mono">can u do whitening next wk?</div>
          <div className="px-3 py-2 rounded-md bg-white border border-red-100 text-xs text-red-700 font-mono">↙ Missed call · Unknown · Sun 9:17am</div>
        </div>
      </div>

      {/* After */}
      <div className="rounded-3xl bg-gray-900 text-white p-8 md:p-10">
        <p className="text-xs font-mono tracking-[0.18em] text-violet-400 uppercase">{t('afterLabel')}</p>
        <h3 className="mt-3 text-2xl md:text-3xl font-bold tracking-tight">{t('afterHeadline')}</h3>
        <ul className="mt-6 space-y-3.5">
          {[
            [t('afterAlwaysOn'),  t('afterAlwaysOnRest')],
            [t('afterInstant'),   t('afterInstantRest')],
            [t('afterBranded'),   t('afterBrandedRest')],
            [t('afterDomain'),    t('afterDomainRest')],
          ].map(([bold, rest], i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-md bg-violet-500/20 text-violet-300 flex items-center justify-center flex-shrink-0 mt-0.5"><Check color="text-violet-300" /></span>
              <span className="text-sm md:text-base text-gray-100"><strong className="font-semibold">{bold}</strong> {rest}</span>
            </li>
          ))}
        </ul>
        <div className="mt-6 rounded-xl border border-white/10 bg-black/30 p-3 space-y-1.5">
          {[
            ['Priya M. · Teeth whitening', 'Thu 3:30pm'],
            ['Arjun S. · Consultation', 'Fri 11:00am'],
            ['Neha R. · Cleaning', 'Sat 10:00am'],
          ].map(([left, right], i) => (
            <div key={i} className="px-3 py-2 rounded-md bg-black/40 border border-white/10 flex items-center justify-between text-xs">
              <span className="text-gray-100 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />{left}</span>
              <span className="font-mono text-gray-400">{right}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------------
// How it works
// ----------------------------------------------------------------------------

function HowItWorksHeader() {
  const t = useTranslations('landing');
  return (
    <section id="how-it-works" className="max-w-7xl mx-auto px-6 lg:px-8 pt-20 md:pt-28 pb-10">
      <SectionLabel>{t('howEyebrow')}</SectionLabel>
      <div className="mt-5 grid md:grid-cols-2 gap-8 md:gap-12 items-end">
        <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.1] tracking-tight">
          {t('howHeadlineStart')} <Italic>{t('howHeadlineItalic')}</Italic>
        </h2>
        <p className="text-lg text-gray-600 leading-relaxed">
          {t('howBody')}
        </p>
      </div>
    </section>
  );
}

function Steps() {
  const t = useTranslations('landing');
  return (
    <section className="max-w-7xl mx-auto px-6 lg:px-8 pb-16 md:pb-24 grid md:grid-cols-3 gap-5 md:gap-6">
      {/* Step 01 */}
      <StepCard num="01">
        <div className="rounded-xl bg-[#efe9dc]/60 p-4 md:p-5">
          <div className="grid grid-cols-3 gap-2.5">
            <div className="aspect-square rounded-xl bg-white border-2 border-violet-500 relative shadow-md">
              <span className="absolute top-2 left-2 right-8 h-1.5 rounded-full bg-gray-100" />
              <span className="absolute top-2 right-2 w-5 h-5 rounded-full bg-violet-600 text-white text-[10px] flex items-center justify-center">✓</span>
            </div>
            <div className="aspect-square rounded-xl" style={{ backgroundColor: '#0b1628' }} />
            <div className="aspect-square rounded-xl" style={{ backgroundColor: '#f4ead8' }} />
            <div className="aspect-square rounded-xl relative overflow-hidden" style={{ backgroundColor: '#0a0a0a' }}>
              <span className="absolute inset-y-0 left-0 w-1.5 bg-red-500" />
            </div>
            <div className="aspect-square rounded-xl" style={{ backgroundColor: '#e9efe4' }} />
            <div className="aspect-square rounded-xl relative overflow-hidden" style={{ backgroundColor: '#0b0b0b' }}>
              <span className="absolute top-2 right-2 w-3 h-3 rounded-sm bg-orange-500" />
            </div>
          </div>
        </div>
        <StepText
          title={t('step1Title')}
          body={t('step1Body')}
        />
      </StepCard>

      {/* Step 02 */}
      <StepCard num="02">
        <div className="rounded-xl bg-[#efe9dc]/60 p-4 md:p-5">
          <div className="grid grid-cols-5 gap-2.5 items-center">
            <div className="col-span-2 space-y-1.5">
              {['Logo →', 'Bright Smile Dental', 'A healthier smile,', 'Phone', 'Hours'].map((label, i) => (
                <div key={i} className={`px-2 py-1.5 rounded-md border text-[10px] font-mono truncate ${i === 2 ? 'border-violet-500 bg-violet-50/50 text-gray-900' : 'border-gray-200 bg-white text-gray-500'}`}>
                  {label}
                </div>
              ))}
            </div>
            <div className="col-span-3 rounded-xl border border-gray-200 p-3 space-y-1.5 bg-white">
              <div className="w-3/4 h-2 rounded bg-gray-900" />
              <div className="w-full h-1.5 rounded bg-gray-200" />
              <div className="w-5/6 h-1.5 rounded bg-gray-200" />
              <div className="pt-2">
                <div className="w-20 h-5 rounded bg-violet-600" />
              </div>
            </div>
          </div>
        </div>
        <StepText
          title={t('step2Title')}
          body={t('step2Body')}
        />
      </StepCard>

      {/* Step 03 */}
      <StepCard num="03">
        <div className="rounded-xl bg-[#efe9dc]/60 p-4 md:p-5">
          <div className="flex items-center gap-2 text-[11px] mb-3">
            <span className="inline-flex items-center gap-1.5 font-mono text-emerald-700"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />LIVE · 1 SEC AGO</span>
          </div>
          <div className="space-y-1.5">
            <div className="px-3 py-2 rounded-md bg-white border border-gray-200 font-mono text-xs flex items-center justify-between gap-2">
              <span className="truncate">
                <span className="text-gray-400">https:// </span>
                <strong className="text-gray-900">brightsmile</strong>
                <span className="text-gray-600">.sitepresso.com</span>
              </span>
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] tracking-wider bg-gray-100 text-gray-500">FREE</span>
            </div>
            <div className="px-3 py-2 rounded-md bg-white border border-violet-300 font-mono text-xs flex items-center justify-between gap-2">
              <span className="truncate">
                <span className="text-gray-400">https:// </span>
                <strong className="text-gray-900">yourbrand.com</strong>
              </span>
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] tracking-wider bg-violet-100 text-violet-700">YOUR BRAND DOMAIN</span>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {['Copy link', 'WhatsApp', 'Instagram bio'].map((l) => (
              <span key={l} className="px-2.5 py-1 rounded-full border border-gray-200 text-[11px] text-gray-600 bg-white">{l}</span>
            ))}
          </div>
        </div>
        <StepText
          title={t('step3Title')}
          body={t('step3Body')}
        />
      </StepCard>
    </section>
  );
}

function StepCard({ num, children }) {
  const t = useTranslations('landing');
  return (
    <div className="rounded-3xl border border-gray-200 p-5 md:p-6 bg-white flex flex-col">
      <p className="text-xs font-mono tracking-[0.18em] text-violet-600 uppercase mb-4">{t('stepLabel')} {num}</p>
      {children}
    </div>
  );
}

function StepText({ title, body }) {
  return (
    <div className="mt-6">
      <h3 className="text-2xl md:text-3xl font-bold text-gray-900 tracking-tight">{title}</h3>
      <p className="mt-2 text-base text-gray-600 max-w-2xl leading-relaxed">{body}</p>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Themes showcase
// ----------------------------------------------------------------------------

function ThemesShowcase() {
  const t = useTranslations('landing');
  return (
    <section id="themes" className="bg-[#f4efe4] py-20 md:py-28">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <SectionLabel>{t('themesEyebrow')}</SectionLabel>
        <h2 className="mt-5 text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.1] tracking-tight">
          {t('themesHeadlineStart')}
          <br />
          <Italic>{t('themesHeadlineItalic')}</Italic>
        </h2>
        <p className="mt-6 text-lg text-gray-600 max-w-2xl leading-relaxed">
          {t('themesBody')}
        </p>

        <div className="mt-12 grid md:grid-cols-2 gap-5">
          {THEMES.map((th) => <ThemeCard key={th.name} theme={th} />)}
        </div>

        <div className="mt-10 flex justify-center">
          <Link href="/signup?redirect=/onboarding"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-gray-900 bg-white hover:bg-gray-900 hover:text-white text-gray-900 font-semibold text-sm transition-colors">
            {t('themesBrowse')} →
          </Link>
        </div>
      </div>
    </section>
  );
}

function ThemeCard({ theme }) {
  const serif = theme.headingFont === 'serif' ? 'Georgia, "Times New Roman", ui-serif, serif' : undefined;
  return (
    <div className="rounded-3xl overflow-hidden bg-white shadow-sm">
      <div className="p-8 md:p-10 min-h-[280px] relative overflow-hidden" style={{ backgroundColor: theme.bg, color: theme.fg }}>
        {theme.barcode && (
          <div className="absolute top-0 right-0 bottom-0 w-3 flex flex-col">
            {Array.from({ length: 40 }).map((_, i) => (
              <span key={i} className="flex-1" style={{ backgroundColor: i % 2 ? '#ffffff' : theme.accent }} />
            ))}
          </div>
        )}
        <div className="flex items-center justify-between mb-6">
          {theme.splitBadge ? (
            <p className="text-xs font-bold tracking-wider" style={{ color: theme.fg }}>
              <span>IRON </span><span style={{ color: theme.accent }}>/ 01</span>
            </p>
          ) : (
            <p className={`text-xs font-semibold ${theme.uppercase ? 'tracking-widest' : 'tracking-wider'}`} style={{ color: theme.accent, fontFamily: serif }}>
              {theme.badge}
            </p>
          )}
          {theme.badgeSub && (
            <p className="text-[10px] font-mono tracking-wider opacity-70">{theme.badgeSub}</p>
          )}
        </div>
        <h3 className={`text-2xl md:text-3xl font-bold leading-tight ${theme.centered ? 'text-center' : ''} ${theme.uppercase ? 'tracking-tight' : ''}`} style={{ fontFamily: serif, color: theme.fg }}>
          {theme.headline}
          {theme.headlineItalic && (
            <>
              {theme.centered ? <br /> : ' '}
              <span className={theme.headingFont === 'serif' ? 'italic' : ''} style={{ color: theme.italicColor || theme.fg, fontFamily: serif }}>{theme.headlineItalic}</span>
            </>
          )}
          {theme.headlineAfter && (
            <>
              <br />
              <span style={{ color: theme.fg, fontFamily: serif }}>{theme.headlineAfter}</span>
            </>
          )}
        </h3>
        <p className={`mt-4 text-sm opacity-80 leading-relaxed ${theme.centered ? 'text-center' : ''}`}>{theme.body}</p>
        {theme.chips && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {theme.chips.map((c) => (
              <span key={c} className="px-2.5 py-1 rounded-full border text-[11px]" style={{ borderColor: `${theme.accent}55`, color: theme.accent }}>{c}</span>
            ))}
          </div>
        )}
        {theme.cta && !theme.twoCta && (
          <div className={`mt-5 ${theme.centered ? 'flex justify-center' : ''}`}>
            <span className={`inline-block px-4 py-2 text-xs font-semibold ${theme.uppercase ? 'tracking-wider' : ''}`} style={{ backgroundColor: theme.accent, color: theme.bg === '#eff6fb' ? '#ffffff' : (theme.bg === '#f4ead8' ? '#1a1510' : '#ffffff') }}>
              {theme.cta}
            </span>
          </div>
        )}
        {theme.twoCta && (
          <div className="mt-5 grid grid-cols-2 gap-2">
            {theme.twoCta.map((c) => (
              <div key={c.label} className="rounded-md px-3 py-2 text-xs" style={{ backgroundColor: `${theme.accent}22`, border: `1px solid ${theme.accent}44` }}>
                <p className="font-semibold" style={{ color: theme.fg }}>{c.label}</p>
                <p className="opacity-70" style={{ color: theme.fg }}>{c.sub}</p>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100">
        <div>
          <p className="font-semibold text-sm text-gray-900">{theme.name}</p>
          <p className="text-xs font-mono text-gray-500">{theme.industries}</p>
        </div>
        <div className="flex gap-1.5">
          {theme.dots.map((c, i) => (
            <span key={i} className="w-4 h-4 rounded-full border border-gray-200" style={{ backgroundColor: c }} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Pricing
// ----------------------------------------------------------------------------

// Vertical tabs for the landing pricing section. Each tab refetches the
// public pricing endpoint with ?vertical=… so the cards reflect the right
// product. Backend falls back to APPOINTMENT tiers if the requested
// vertical has none seeded yet.
async function publicPricingFetcher(country, vertical) {
  const params = new URLSearchParams();
  if (country) params.set('country', country);
  if (vertical) params.set('vertical', vertical);
  const url = `/api/public/pricing?${params.toString()}`;
  const res = await axios.get(url).then((r) => r.data).catch(() => null);
  return res?.pricing || null;
}

function Pricing() {
  const t = useTranslations('landing');
  return (
    <section id="pricing" className="max-w-7xl mx-auto px-6 lg:px-8 py-20 md:py-28">
      <div className="text-center max-w-3xl mx-auto">
        <SectionLabel><span className="flex justify-center w-full">{t('pricingEyebrow')}</span></SectionLabel>
        <h2 className="mt-5 text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.1] tracking-tight">
          {t('pricingHeadlineStart')} <Italic>{t('pricingHeadlineItalic')}</Italic>
        </h2>
        <p className="mt-6 text-lg text-gray-600">
          {t('pricingBody')}
        </p>

        <div className="mt-8 inline-flex items-center gap-3 px-4 py-3 rounded-full bg-emerald-50 border border-emerald-200">
          <span className="px-2.5 py-1 rounded-full bg-emerald-600 text-white text-[10px] font-mono font-semibold tracking-wider">LAUNCH</span>
          <span className="text-sm text-emerald-800">{t('pricingLaunchBadge')}</span>
        </div>
      </div>

      <PricingPlanCards
        fetcher={publicPricingFetcher}
        toolbarLabels={{
          monthlyLabel: t('pricingMonthly'),
          yearlyLabel: t('pricingYearly'),
          discountLabel: t('pricingDiscount'),
        }}
        className="mt-8"
        renderCard={(plan, ctx) => (
          <PlanCard key={plan.slug} plan={plan} billing={ctx.billing} symbol={ctx.symbol} />
        )}
        renderSkeleton={(i) => <PlanCardSkeleton key={i} />}
      />
    </section>
  );
}

function PlanCardSkeleton() {
  return (
    <div className="rounded-3xl p-6 md:p-8 bg-white border border-gray-200 animate-pulse">
      <div className="h-5 w-24 bg-gray-200 rounded" />
      <div className="mt-2 h-4 w-48 bg-gray-100 rounded" />
      <div className="mt-6 h-10 w-28 bg-gray-200 rounded" />
      <div className="mt-3 h-5 w-32 bg-gray-100 rounded" />
      <div className="mt-6 space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-3.5 w-full bg-gray-100 rounded" />
        ))}
      </div>
      <div className="mt-7 h-11 w-full bg-gray-100 rounded-xl" />
    </div>
  );
}

function PlanCard({ plan, billing, symbol = '$' }) {
  const t = useTranslations('landing');
  const tCommon = useTranslations('common');
  const price = billing === 'monthly' ? plan.monthly : Math.round(plan.yearly / 12);
  const popular = plan.popular;
  const isCustom = plan.isCustomPriced;
  return (
    <div className={`relative rounded-3xl p-6 md:p-8 flex flex-col ${popular ? 'bg-gray-900 text-white ring-2 ring-violet-500' : 'bg-white border border-gray-200'}`}>
      {popular && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-violet-500 text-white text-[10px] font-semibold tracking-wider font-mono">
          {t('pricingMostPopular')}
        </span>
      )}
      <h3 className={`text-lg font-semibold ${popular ? 'text-white' : 'text-gray-900'}`}>{plan.name}</h3>
      <p className={`mt-1 text-sm ${popular ? 'text-gray-300' : 'text-gray-500'}`}>{plan.tagline}</p>
      <div className="mt-6 flex items-baseline gap-1">
        {isCustom ? (
          <span className={`text-3xl md:text-4xl font-bold tracking-tight ${popular ? 'text-white' : 'text-gray-900'}`}>{t('pricingLetsTalk')}</span>
        ) : price === 0 ? (
          <>
            <span className={`text-5xl font-bold tracking-tight ${popular ? 'text-white' : 'text-gray-900'}`}>{tCommon('free')}</span>
            <span className={`text-base ${popular ? 'text-gray-400' : 'text-gray-500'}`}>{t('pricingFreeForever')}</span>
          </>
        ) : (
          <>
            <span className={`text-5xl font-bold tracking-tight ${popular ? 'text-white' : 'text-gray-900'}`}>{symbol}{price.toLocaleString('en-IN')}</span>
            <span className={`text-base ${popular ? 'text-gray-400' : 'text-gray-500'}`}>{t('pricingPerMo')}</span>
          </>
        )}
      </div>
      {!isCustom && price > 0 && Number(plan.trialDays) > 0 && (
        <span className={`mt-3 inline-flex self-start px-2.5 py-1 rounded-md text-[10px] font-mono font-semibold ${popular ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-700'}`}>
          {Number(plan.trialDays)}-day trial
        </span>
      )}
      <ul className={`mt-6 space-y-3 flex-1 text-sm ${popular ? 'text-gray-100' : 'text-gray-700'}`}>
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5">
            <Check color={popular ? 'text-violet-300' : 'text-violet-600'} />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <Link href={plan.ctaHref || '/signup?redirect=/onboarding'}
        className={`mt-7 inline-flex items-center justify-center px-5 py-3 rounded-xl text-sm font-semibold transition-colors ${popular ? 'bg-violet-500 hover:bg-violet-400 text-white' : 'border border-gray-300 hover:border-gray-900 text-gray-900'}`}>
        {plan.cta}
      </Link>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Testimonials
// ----------------------------------------------------------------------------

function TestimonialsHeader() {
  const t = useTranslations('landing');
  return (
    <section className="max-w-5xl mx-auto px-6 lg:px-8 pt-16 md:pt-24 pb-10">
      <SectionLabel>{t('testimonialsEyebrow')}</SectionLabel>
      <h2 className="mt-5 text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.1] tracking-tight">
        {t('testimonialsHeadlineStart')}
        <br />
        <Italic>{t('testimonialsHeadlineItalic')}</Italic>
      </h2>
      <p className="mt-6 text-lg text-gray-600 max-w-2xl leading-relaxed">
        {t('testimonialsBody')}
      </p>
    </section>
  );
}

function Testimonials() {
  return (
    <section className="max-w-7xl mx-auto px-6 lg:px-8 pb-16 md:pb-24 grid md:grid-cols-3 gap-5">
      {TESTIMONIALS.map((t) => (
        <div key={t.name} className="rounded-3xl border border-gray-200 bg-white p-7 flex flex-col">
          <div className="flex gap-0.5 text-amber-400 text-lg">
            {'★★★★★'.split('').map((s, i) => <span key={i}>{s}</span>)}
          </div>
          <p className="mt-5 text-base leading-relaxed text-gray-800 flex-1">
            &ldquo;{t.quote}<Italic>{t.italic}</Italic>{t.quoteRest}&rdquo;
          </p>
          <div className="mt-5 px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 text-xs font-mono text-gray-600">
            🔒 {t.url}
          </div>
          <div className="mt-5 pt-5 flex items-center gap-3 border-t border-gray-100">
            <span className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm" style={{ backgroundColor: t.initialsBg }}>
              {t.initials}
            </span>
            <div>
              <p className="font-semibold text-sm text-gray-900">{t.name}</p>
              <p className="text-xs text-gray-500">{t.role}</p>
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

// ----------------------------------------------------------------------------
// FAQ
// ----------------------------------------------------------------------------

function FAQHeader() {
  const t = useTranslations('landing');
  return (
    <section id="faq" className="max-w-7xl mx-auto px-6 lg:px-8 pt-16 md:pt-24 pb-10">
      <SectionLabel>{t('faqEyebrow')}</SectionLabel>
      <div className="mt-5 grid md:grid-cols-2 gap-8 md:gap-12 items-end">
        <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.1] tracking-tight">
          {t('faqHeadlineStart')} <Italic>{t('faqHeadlineItalic')}</Italic>
        </h2>
        <p className="text-lg text-gray-600 leading-relaxed">
          {t('faqBody')}
        </p>
      </div>
    </section>
  );
}

function FAQ() {
  const [open, setOpen] = useState(null);
  return (
    <section className="max-w-7xl mx-auto px-6 lg:px-8 pb-20 md:pb-28 grid md:grid-cols-2 gap-4 items-start">
      {FAQS.map((f, i) => (
        <div key={i} className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
          <button onClick={() => setOpen(open === i ? null : i)}
            className="w-full px-6 py-5 flex items-center justify-between gap-4 text-left hover:bg-gray-50 transition-colors">
            <span className="font-semibold text-gray-900">{f.q}</span>
            <span className={`w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center transition-transform flex-shrink-0 ${open === i ? 'rotate-45' : ''}`}>+</span>
          </button>
          {open === i && (
            <div className="px-6 pb-6 text-sm text-gray-600 leading-relaxed">{f.a}</div>
          )}
        </div>
      ))}
    </section>
  );
}

// ----------------------------------------------------------------------------
// Final CTA
// ----------------------------------------------------------------------------

function FinalCta() {
  const t = useTranslations('landing');
  return (
    <section className="px-6 lg:px-8 py-12">
      <div className="max-w-5xl mx-auto rounded-3xl py-16 md:py-24 px-6 md:px-12 text-center text-white relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #4338ca 0%, #5b21b6 50%, #7e22ce 100%)' }}>
        <div className="absolute top-0 left-1/4 w-96 h-96 rounded-full bg-white/5 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 rounded-full bg-white/5 blur-3xl pointer-events-none" />
        <div className="relative">
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.1] tracking-tight">
            {t('finalCtaHeadlineStart')}
            <br />
            <span className="italic text-white/95" style={{ fontFamily: 'Georgia, serif' }}>{t('finalCtaHeadlineItalic')}</span>
          </h2>
          <p className="mt-6 text-lg text-white/80 max-w-2xl mx-auto">
            {t('finalCtaBody')}
          </p>
          <div className="mt-10">
            <Link href="/signup?redirect=/onboarding"
              className="inline-flex items-center gap-2 px-8 py-4 bg-white text-violet-700 font-bold rounded-2xl transition-all hover:shadow-2xl hover:-translate-y-0.5">
              {t('finalCtaButton')} →
            </Link>
          </div>
          <div className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-white/80">
            <span className="inline-flex items-center gap-1.5"><Check color="text-white" /> {t('finalNoCard')}</span>
            <span className="inline-flex items-center gap-1.5"><Check color="text-white" /> {t('finalFreeLaunch')}</span>
            <span className="inline-flex items-center gap-1.5"><Check color="text-white" /> {t('finalCancel')}</span>
            <span className="inline-flex items-center gap-1.5"><Check color="text-white" /> {t('finalDataDomain')}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------------
// Footer
// ----------------------------------------------------------------------------

function Footer() {
  const t = useTranslations('landing');
  const columns = [
    { title: t('footerColProduct'), items: [
      { label: t('navThemes'), href: '#themes' },
      { label: t('navPricing'), href: '#pricing' },
      { label: t('footerLinkCustomDomains'), href: '#pricing' },
      { label: t('footerLinkChangelog'), href: '#' },
    ]},
    { title: t('footerColFor'), items: [
      { label: t('footerLinkDental'), href: '#themes' },
      { label: t('footerLinkLaw'), href: '#themes' },
      { label: t('footerLinkSalons'), href: '#themes' },
      { label: t('footerLinkFitness'), href: '#themes' },
    ]},
    { title: t('footerColResources'), items: [
      { label: t('footerLinkBlog'), href: '/blog' },
      { label: t('footerLinkHelp'), href: '#faq' },
      { label: t('navFaq'), href: '#faq' },
      { label: t('footerLinkTemplate'), href: '#themes' },
      { label: t('footerLinkStatus'), href: '#' },
    ]},
    // Order rationale: company info first → most-read legal in reading
    // order (Terms is the master, Privacy is data, Cookies is a Privacy
    // subset, Refund is transactional) → B2B/technical legal last
    // (DPA is B2B-only, Sub-processors is transparency).
    { title: t('footerColCompany'), items: [
      { label: t('footerLinkAbout'), href: '#' },
      { label: t('footerLinkContact'), href: 'mailto:support@sitepresso.com' },
      { label: t('footerLinkTerms'), href: '/legal/terms' },
      { label: t('footerLinkPrivacy'), href: '/legal/privacy' },
      { label: 'Cookies', href: '/legal/cookies' },
      { label: 'Refund', href: '/legal/refund' },
      { label: 'DPA', href: '/legal/dpa' },
      { label: 'Sub-processors', href: '/legal/sub-processors' },
    ]},
  ];
  return (
    <footer className="border-t border-gray-100 bg-gray-50/50">
      <div className="max-w-7xl mx-auto px-6 lg:px-8 pt-10 md:pt-12 pb-6 grid grid-cols-2 md:grid-cols-6 gap-x-6 gap-y-8">
        <div className="col-span-2">
          <Link href="/" className="flex items-center">
            <Logo size="footer" />
          </Link>
          <p className="mt-3 text-sm text-gray-600 max-w-xs leading-relaxed">
            {t('footerTagline')}
          </p>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {['India', 'Stripe-ready', 'GDPR'].map((b) => (
              <span key={b} className="px-2 py-0.5 rounded-full border border-gray-200 bg-white text-[10px] font-mono tracking-wider text-gray-600 uppercase">{b}</span>
            ))}
          </div>
        </div>
        {columns.map((col) => (
          <div key={col.title}>
            <p className="text-[11px] font-mono tracking-[0.18em] text-gray-500 uppercase mb-3">{col.title}</p>
            <ul className="space-y-1.5">
              {col.items.map((it) => (
                <li key={it.label}>
                  <a href={it.href} className="text-sm text-gray-800 hover:text-violet-600 transition-colors">{it.label}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-gray-100">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-gray-500">
          <p>© {new Date().getFullYear()} {t('footerCopyright')}</p>
          <p className="font-mono">{t('footerVersion')}</p>
        </div>
      </div>
    </footer>
  );
}
