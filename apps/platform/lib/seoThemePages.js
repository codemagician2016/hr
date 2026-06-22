// Compiled, serve-ready theme/template SEO pages for the marketing site.
//
// SOURCE OF TRUTH = the reviewed draft artifacts in content-seo/generated/theme-pages/*.md
// (the git review/rollback record). This file is the COMPILED serving layer the /themes/[slug]
// route reads — same pattern as lib/blogArticles.js. When a draft is reviewed and promoted via
// /seo-publish, its fields land here with status: 'published'.
//
// Every field below is real data captured from the original theme catalog
// (palette, hero copy, vocab, trust items) — not invented. Keep copy human and specific.

export const themePages = [
  {
    slug: 'hair-salon',
    status: 'published',
    categoryKey: 'hair_salon',
    categoryLabel: 'Personal Care & Beauty',
    vertical: 'APPOINTMENT',
    targetKeyword: 'hair salon website template',
    metaTitle: 'Hair Salon Website Template | Sitepresso',
    metaDescription:
      "Launch a salon booking website with Sitepresso's Hair Salon template: online appointments, a services & pricing menu, stylist profiles and a gallery. No code.",
    h1: 'Hair Salon Website Template',
    // AEO direct-answer block — the 40–55 words AI engines lift to cite us.
    directAnswer:
      'The Hair Salon template gives a salon a booking-ready website with a warm, editorial feel — online appointments, a real services-and-prices menu, stylist bios and a photo gallery. You edit it in the browser and publish in a few minutes. No code, no developer.',
    preview: {
      primary: '#6B3FA0',
      accent: '#9333EA',
      bg: '#FAF6F1',
      surface: '#FFFFFF',
      text: '#2A1F33',
      muted: '#6B5B73',
      font: "Georgia, 'Times New Roman', serif",
      heroHeadline: 'Your Hair, Transformed.',
      tagline: 'Where style meets expertise',
      ctaLabel: 'Book an Appointment',
      trust: ['Award-winning stylists', 'Premium product lines', 'Colour specialists'],
    },
    features: [
      { title: 'Online booking, around the clock', body: 'Clients choose a service, a stylist and a time without picking up the phone. Confirmations go out on their own.' },
      { title: 'A real services & price menu', body: 'List cuts, colour, treatments and styling with prices — laid out the way a salon actually quotes a client.' },
      { title: 'Stylist profiles', body: 'Introduce the team by name. The template speaks salon, not software: your "stylists", never generic "staff".' },
      { title: 'Work gallery', body: 'Show off your best colour and cuts. In this trade the photos are what book the chair.' },
      { title: 'Warm, editorial design', body: 'Deep purple and bright violet over a soft cream background, with serif headings. It feels like a salon, not a form.' },
      { title: 'Everything else a salon page needs', body: 'Opening hours, a location map, contact details and an about section — all in place, ready to fill in.' },
    ],
    bestFor:
      'Hair salons, colour bars and styling studios that would rather clients booked online at midnight than left a voicemail. The look does a lot of the selling, so it suits brands where style is the pitch.',
    customise:
      'Swap the colours, fonts, photos and copy; edit your services and prices; connect your own domain — all of it visually, nothing in code. Start from the template and make it yours the same afternoon.',
    faq: [
      { q: 'Can clients book appointments online?', a: 'Yes. Online booking with automatic confirmations is built in — no add-on or separate tool.' },
      { q: 'Can I list my services and prices?', a: 'Yes. The services menu is designed for salon pricing, from a quick trim to full colour.' },
      { q: 'Can I use my own domain?', a: 'Yes. Connect a custom domain on any paid plan.' },
      { q: 'Can I change the colours and photos?', a: 'Yes. Everything is editable in the browser — colours, fonts, images and text — with no code.' },
      { q: 'Is it good for SEO?', a: 'Yes. Pages are fast and mobile-friendly, and you can edit every title and description yourself.' },
    ],
    related: [
      { label: 'Dental Clinic website template', href: '/themes/dental-clinic' },
      { label: 'Law Firm website template', href: '/themes/law-firm' },
      { label: 'Browse all templates', href: '/#themes' },
    ],
    signupHref: '/signup?redirect=/onboarding&vertical=APPOINTMENT',
    updatedAt: '2026-06-18',
  },

  {
    slug: 'dental-clinic',
    status: 'published',
    categoryKey: 'dental',
    categoryLabel: 'Healthcare',
    vertical: 'APPOINTMENT',
    targetKeyword: 'dental clinic website template',
    metaTitle: 'Dental Clinic Website Template | Sitepresso',
    metaDescription:
      "Build a dental clinic website with Sitepresso's Dental template: online appointment booking, treatments & pricing, dentist profiles and patient info. No code.",
    h1: 'Dental Clinic Website Template',
    directAnswer:
      'The Dental Clinic template is a website for a dental practice with a clean, calm design — online appointment booking, a treatments menu with pricing, dentist profiles and patient information. You set it up in the browser and publish in minutes. No code required.',
    preview: {
      primary: '#0D9EDF',
      accent: '#089EE1',
      bg: '#FFFFFF',
      surface: '#F0F9FF',
      text: '#0F2A3A',
      muted: '#5A7488',
      font: "'Helvetica Neue', Arial, sans-serif",
      heroHeadline: 'Healthy Smiles Start Here.',
      tagline: 'Gentle care, lasting smiles',
      ctaLabel: 'Book a Treatment',
      trust: ['Gentle & pain-free care', 'Latest dental technology', 'All ages welcome'],
    },
    features: [
      { title: 'Online appointment booking', body: 'Patients book and re-book check-ups online, so the front desk stops playing phone tag.' },
      { title: 'Treatments & pricing', body: 'From routine check-ups to cosmetic work, set out clearly so patients know what to expect before they call.' },
      { title: 'Dentist profiles', body: 'Put faces and credentials to the practice. New patients want to trust the clinic before they sit in the chair.' },
      { title: 'Patient information', body: 'A place for new-patient details, what to bring, and how the first visit actually works.' },
      { title: 'Clean, reassuring design', body: 'Bright dental-blue on white with a soft surface tint — calm and professional, never clinical-cold.' },
      { title: 'The practical bits', body: 'Opening hours, a map, contact details and an about section, ready to fill in.' },
    ],
    bestFor:
      'Dental clinics, orthodontists and family practices that want patients booking and re-booking online, seeing treatments and prices up front, and trusting the practice before they walk in.',
    customise:
      'Edit the colours, fonts, photos and copy; set your own treatments and prices; connect your own domain — visually, with no code.',
    faq: [
      { q: 'Can patients book appointments online?', a: 'Yes. Online booking with confirmations is built in.' },
      { q: 'Can I list treatments and pricing?', a: 'Yes. The treatments menu is built for exactly that, from check-ups to cosmetic work.' },
      { q: 'Can I add a patient-information section?', a: 'Yes. It is part of the template, ready for new-patient details.' },
      { q: 'Can I use my own domain?', a: 'Yes. Connect a custom domain on any paid plan.' },
      { q: 'Is it good for SEO?', a: 'Yes. Fast, mobile-friendly pages with titles and descriptions you control.' },
    ],
    related: [
      { label: 'Hair Salon website template', href: '/themes/hair-salon' },
      { label: 'Law Firm website template', href: '/themes/law-firm' },
      { label: 'Browse all templates', href: '/#themes' },
    ],
    signupHref: '/signup?redirect=/onboarding&vertical=APPOINTMENT',
    updatedAt: '2026-06-18',
  },

  {
    slug: 'law-firm',
    status: 'published',
    categoryKey: 'legal',
    categoryLabel: 'Professional Services',
    vertical: 'APPOINTMENT',
    targetKeyword: 'law firm website template',
    metaTitle: 'Law Firm Website Template | Sitepresso',
    metaDescription:
      "Launch a law firm website with Sitepresso's Law Firm template: practice areas, solicitor profiles and online consultation booking. Refined dark design, no code.",
    h1: 'Law Firm Website Template',
    directAnswer:
      'The Law Firm template is a website for a legal practice with a refined, authoritative dark design — practice-area pages, solicitor profiles and online consultation scheduling. You build it in the browser and publish in minutes. No code, no agency.',
    preview: {
      primary: '#B8972E',
      accent: '#D4AF5A',
      bg: '#0F1923',
      surface: '#1A2535',
      text: '#F3EEDF',
      muted: '#A9B4C0',
      font: "Georgia, 'Times New Roman', serif",
      heroHeadline: 'Experienced Legal Counsel for Every Challenge.',
      tagline: 'Trusted legal advice',
      ctaLabel: 'Schedule a Consultation',
      trust: ['20+ years experience', 'Confidential consultation', 'Free first meeting'],
    },
    features: [
      { title: 'Online consultation scheduling', body: 'Prospective clients book a consultation themselves, and confirmations are sent automatically.' },
      { title: 'Practice-area pages', body: 'Set out commercial, property, family and litigation work in legal terms — "practice areas", not generic "services".' },
      { title: 'Solicitor profiles', body: 'Show experience and credentials. In this field, that is what wins the first call.' },
      { title: 'Authoritative dark design', body: 'Muted gold on deep navy with serif headings. It reads as serious and discreet — the way clients expect a firm to look.' },
      { title: 'Trust signals up front', body: 'Years of experience, confidential consultation, free first meeting — stated plainly, not buried in a footer.' },
      { title: 'The essentials', body: 'Office hours, a map, contact details and a proper firm "about" section.' },
    ],
    bestFor:
      "Law firms, solicitors and barristers' chambers that want prospective clients to understand their practice areas and book a consultation online — with a site that signals authority and discretion.",
    customise:
      'Edit the colours, fonts, photos and copy; set your own practice areas; connect your own domain — all visually, with no code.',
    faq: [
      { q: 'Can clients schedule a consultation online?', a: 'Yes. Online scheduling with confirmations is built in.' },
      { q: 'Can I list my practice areas?', a: 'Yes. The whole template is structured around practice areas.' },
      { q: 'Can I add solicitor profiles?', a: 'Yes, with room for experience and credentials.' },
      { q: 'Can I use my own domain?', a: 'Yes. Connect a custom domain on any paid plan.' },
      { q: 'Is it good for SEO?', a: 'Yes. Fast, mobile-friendly pages with editable titles and descriptions.' },
    ],
    related: [
      { label: 'Hair Salon website template', href: '/themes/hair-salon' },
      { label: 'Dental Clinic website template', href: '/themes/dental-clinic' },
      { label: 'Browse all templates', href: '/#themes' },
    ],
    signupHref: '/signup?redirect=/onboarding&vertical=APPOINTMENT',
    updatedAt: '2026-06-18',
  },
];

export function publishedThemePages() {
  return themePages.filter((p) => p.status === 'published');
}

export function getThemePage(slug) {
  return themePages.find((p) => p.slug === slug && p.status === 'published') || null;
}

export default themePages;
