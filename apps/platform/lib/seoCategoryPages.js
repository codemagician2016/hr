// Compiled, serve-ready CATEGORY "money pages" — buyer-intent landing pages that
// target "{vertical} website builder" searches. These are the bottom-of-funnel pages
// that pair with the /themes/[slug] template showcases: a searcher looking for a
// "salon website builder" lands here, sees DriftHR framed as the purpose-built
// answer, and starts a trial.
//
// Same serving pattern as lib/seoThemePages.js (read by app/website-builder/[slug]).
// Copy is human and specific — written to read like a person, not a generator.
// Pricing rule (RULES.md §G3): NO free plan. CTA = "Start your 30-day free trial".

export const categoryPages = [
  {
    slug: 'salon',
    status: 'published',
    categoryKey: 'hair_salon',
    categoryLabel: 'Salons & Beauty',
    vertical: 'APPOINTMENT',
    targetKeyword: 'salon website builder',
    metaTitle: 'Salon Website Builder | Booking Site for Salons — DriftHR',
    metaDescription:
      'A salon website builder with online booking, a services-and-prices menu and stylist profiles built in. Launch a booking-ready salon website in minutes — no code.',
    h1: 'Salon Website Builder',
    directAnswer:
      'DriftHR is a salon website builder that comes with the things a salon actually needs — online appointment booking, a real services-and-prices menu, stylist profiles and a gallery — instead of an empty canvas you have to wire up yourself. You edit it in the browser and go live in minutes.',
    intro:
      'Most website builders hand you a blank page and leave the hard part — taking bookings — to a plugin you have to find, pay for and connect. A salon website builder should already know what a salon needs. This one does.',
    features: [
      { title: 'Booking is built in, not bolted on', body: "Clients pick a service, a stylist and a time and get an automatic confirmation. You're not paying for a separate booking tool or stitching one in." },
      { title: 'A services menu that quotes like a salon', body: 'Cuts, colour, treatments and styling with real prices — laid out the way you actually quote a client at the chair, not as a generic product grid.' },
      { title: 'Your team, by name', body: 'Stylist profiles with photos and bios. The whole thing speaks salon — "stylists" and "appointments", never "staff" and "events".' },
      { title: 'A gallery that books the chair', body: 'In this trade the photos do the selling. Show your best colour and cuts front and centre.' },
      { title: 'Looks like a salon, runs itself', body: 'A warm, editorial design out of the box, plus opening hours, a map, contact details and an about section already in place.' },
      { title: 'Your own domain, your own brand', body: 'Connect yoursalon.com on any paid plan. No DriftHR branding on your site.' },
    ],
    whyTitle: 'Why a salon website builder beats a generic one',
    why:
      "On Wix or Squarespace you start from nothing and add a booking app, a payments app and a calendar — three subscriptions and an afternoon of setup before a client can book. On a marketplace like Fresha you get bookings, but you're one listing among hundreds and the customer relationship belongs to them, not you. DriftHR gives you the booking engine of a marketplace on a website that's unmistakably yours — your domain, your brand, your client list.",
    bestFor:
      'Hair salons, colour bars, blow-dry bars and styling studios that want clients booking online at midnight instead of leaving a voicemail — and want the website to look like the brand, not a form.',
    faq: [
      { q: 'Do I need a separate booking system?', a: 'No. Online booking with automatic confirmations is part of the website — there is no extra tool to buy or connect.' },
      { q: 'Can I list every service and price?', a: 'Yes. The services menu is built for salon pricing, from a quick fringe trim to full balayage.' },
      { q: 'Can I use my own domain?', a: 'Yes. Connect a custom domain on any paid plan, with no DriftHR branding on your site.' },
      { q: 'How long does it take to launch?', a: 'Most salons are live the same day. You start from the salon template, swap in your services, photos and colours, and publish.' },
      { q: 'Is it free to use?', a: "You get a 30-day free trial to build and preview your whole site before you pay. After the trial it's a paid subscription." },
    ],
    related: [
      { label: 'See the Hair Salon template', href: '/themes/hair-salon' },
      { label: 'What a salon website should include', href: '/answers/what-should-a-hair-salon-website-include' },
      { label: 'Dental website builder', href: '/website-builder/dental' },
    ],
    signupHref: '/signup?redirect=/onboarding&vertical=APPOINTMENT',
    updatedAt: '2026-06-20',
  },

  {
    slug: 'dental',
    status: 'published',
    categoryKey: 'dental',
    categoryLabel: 'Healthcare',
    vertical: 'APPOINTMENT',
    targetKeyword: 'dental website builder',
    metaTitle: 'Dental Website Builder | Booking Site for Clinics — DriftHR',
    metaDescription:
      'A dental website builder with online appointment booking, a treatments-and-pricing menu and dentist profiles built in. Launch a patient-ready clinic website in minutes.',
    h1: 'Dental Website Builder',
    directAnswer:
      'DriftHR is a dental website builder that ships with what a practice needs — online appointment booking, a treatments menu with pricing, dentist profiles and patient information — rather than a blank template. You set it up in the browser and publish in minutes, no code or developer.',
    intro:
      'A clinic website has one job most builders make hard: let a patient book without phoning reception. A dental website builder should handle that on day one. This one does — and it reads calm and clinical, the way patients expect.',
    features: [
      { title: 'Patients book without the phone', body: 'Online appointment requests with automatic confirmations, built into the site. Reception spends less time on the phone and more with patients in the chair.' },
      { title: 'A treatments menu with real pricing', body: 'Check-ups, hygiene, whitening, implants — listed the way a practice presents treatment and cost, so new patients know what to expect.' },
      { title: 'Dentist profiles that build trust', body: 'Introduce each dentist by name with credentials and a photo. Trust is most of the decision in healthcare.' },
      { title: 'Calm, clinical design', body: 'A clean, reassuring look out of the box — not a loud retail template forced onto a healthcare brand.' },
      { title: 'Everything a patient looks for', body: 'Opening hours, location and map, new-patient information and contact details, all already laid out.' },
      { title: 'Your domain and brand', body: 'Connect yourclinic.com on any paid plan, with no DriftHR branding on your site.' },
    ],
    whyTitle: 'Why a dental website builder beats a generic one',
    why:
      "Generic builders treat a dental practice like an online shop: you bolt a booking widget onto a retail template and hope it reads professional. Listing sites take bookings but bury you among competitors and keep the patient relationship. A dental website builder gives you the booking and the patient-trust pages a clinic needs, on a site that looks like your practice and sends patients to you — not to a directory.",
    bestFor:
      'Dental practices, orthodontists and specialist clinics that want patients booking online and a website that reads as calm and credible as the care they give.',
    faq: [
      { q: 'Can patients book appointments online?', a: 'Yes. Online appointment booking with automatic confirmations is built in — no separate scheduling tool to buy.' },
      { q: 'Can I show treatments and prices?', a: 'Yes. The treatments menu is designed for clinical pricing, from a routine check-up to implants.' },
      { q: 'Can I use my own domain?', a: 'Yes. Connect a custom domain on any paid plan, with no DriftHR branding.' },
      { q: 'How quickly can the clinic go live?', a: 'Usually the same day. Start from the dental template, add your treatments, team and details, and publish.' },
      { q: 'Is it free to use?', a: "You get a 30-day free trial to build and preview the full site first. After the trial it's a paid subscription." },
    ],
    related: [
      { label: 'See the Dental Clinic template', href: '/themes/dental-clinic' },
      { label: 'What a dental website should include', href: '/answers/what-should-a-dental-clinic-website-include' },
      { label: 'Salon website builder', href: '/website-builder/salon' },
    ],
    signupHref: '/signup?redirect=/onboarding&vertical=APPOINTMENT',
    updatedAt: '2026-06-20',
  },

  {
    slug: 'law-firm',
    status: 'published',
    categoryKey: 'legal',
    categoryLabel: 'Professional Services',
    vertical: 'APPOINTMENT',
    targetKeyword: 'law firm website builder',
    metaTitle: 'Law Firm Website Builder | Site with Consultations — DriftHR',
    metaDescription:
      'A law firm website builder with consultation booking, practice-area pages and attorney profiles built in. Launch a credible, client-ready legal website in minutes.',
    h1: 'Law Firm Website Builder',
    directAnswer:
      'DriftHR is a law firm website builder that includes what a practice needs to win clients — consultation booking, practice-area pages and attorney profiles — instead of a blank template. You build it in the browser and publish in minutes, no code and no agency retainer.',
    intro:
      "A law firm's website has to do two things at once: look established enough to trust, and make it easy to book a consultation. Most builders give you the first and leave you to wire up the second. A law firm website builder should do both.",
    features: [
      { title: 'Consultation booking, built in', body: 'Prospective clients request a consultation and get an automatic confirmation — no phone tag, no separate scheduler to license.' },
      { title: 'Practice-area pages', body: 'Family, corporate, property, litigation — each area gets its own page, the way clients search and the way firms present expertise.' },
      { title: 'Attorney profiles', body: 'Introduce each lawyer with credentials, bar admissions and focus areas. In legal, the people are the pitch.' },
      { title: 'An established, credible look', body: 'A restrained, professional design out of the box — authority over decoration, which is exactly what legal clients want to see.' },
      { title: 'The pages clients expect', body: 'About the firm, contact and location, and clear calls to get in touch — all in place and ready to fill in.' },
      { title: 'Your domain and brand', body: 'Connect yourfirm.com on any paid plan, with no DriftHR branding on the site.' },
    ],
    whyTitle: 'Why a law firm website builder beats a generic one',
    why:
      "A generic builder can be made to look professional, but you still have to add consultation booking, structure practice areas and lay out attorney bios yourself — and legal directories that do offer intake take a cut and own the lead. A law firm website builder gives you intake booking and the credibility pages a firm needs, on a site that sends prospects straight to you and looks like a firm that's been around.",
    bestFor:
      'Solo practitioners, boutique firms and growing practices that want consultations booked online and a website that signals authority without a five-figure agency build.',
    faq: [
      { q: 'Can clients book a consultation online?', a: 'Yes. Consultation booking with automatic confirmations is built into the website — there is no separate intake tool to buy.' },
      { q: 'Can I have a page for each practice area?', a: 'Yes. Practice-area pages are part of the template, so each area of law gets its own page.' },
      { q: 'Can I use my own domain?', a: 'Yes. Connect a custom domain on any paid plan, with no DriftHR branding.' },
      { q: 'How fast can the firm go live?', a: 'Often the same day. Start from the law-firm template, add your practice areas and attorneys, and publish.' },
      { q: 'Is it free to use?', a: "You get a 30-day free trial to build and preview the whole site first. After the trial it's a paid subscription." },
    ],
    related: [
      { label: 'See the Law Firm template', href: '/themes/law-firm' },
      { label: 'What a law firm website should include', href: '/answers/what-should-a-law-firm-website-include' },
      { label: 'Salon website builder', href: '/website-builder/salon' },
    ],
    signupHref: '/signup?redirect=/onboarding&vertical=APPOINTMENT',
    updatedAt: '2026-06-20',
  },
];

export function publishedCategoryPages() {
  return categoryPages.filter((p) => p.status === 'published');
}

export function getCategoryPage(slug) {
  return categoryPages.find((p) => p.slug === slug && p.status === 'published') || null;
}

export default categoryPages;
