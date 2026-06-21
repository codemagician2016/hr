// Compiled, serve-ready AI-answer (AEO/GEO) pages for the marketing site.
//
// SOURCE OF TRUTH = reviewed draft artifacts in content-seo/generated/ai-answer-pages/*.md.
// This is the compiled serving layer the /answers/[slug] route reads (same pattern as
// lib/blogArticles.js and lib/seoThemePages.js).
//
// Answer pages exist to be QUOTED by AI engines and to win featured snippets. Each leads with a
// tight, citeable direct answer, then a genuinely useful, vertical-specific checklist. Keep copy
// human and concrete — these must pass the strip test (a salon checklist != a law firm checklist).

export const answerPages = [
  {
    slug: 'what-should-a-hair-salon-website-include',
    status: 'published',
    categoryLabel: 'Hair salons',
    question: 'What should a hair salon website include?',
    metaTitle: 'What Should a Hair Salon Website Include? | Sitepresso',
    metaDescription:
      'A hair salon website needs online booking, a services-and-prices menu, stylist profiles, a work gallery, and your hours and location. Here is the full checklist.',
    targetKeyword: 'what should a hair salon website include',
    directAnswer:
      'A hair salon website needs five essentials: online booking that works around the clock, a services-and-prices menu, stylist profiles, a gallery of real work, and your hours, location and contact details. The booking is what turns a visitor into a filled chair — everything else builds the trust to click it.',
    checklist: [
      { item: 'Online booking', why: 'Most people decide to book outside opening hours. If they cannot do it on your site, they call the salon that lets them.' },
      { item: 'A services and prices menu', why: 'Clients want to know what a cut, colour or treatment costs before they commit. Hiding prices loses the cautious ones.' },
      { item: 'Stylist profiles', why: 'People book a person, not a building. Names, photos and specialities help them choose who to sit with.' },
      { item: 'A work gallery', why: 'Your colour and cuts are the product. Real photos sell the appointment better than any description.' },
      { item: 'Hours, location and contact', why: 'Unglamorous, but the most-visited part of any local site. Keep it current and easy to find.' },
      { item: 'Reviews and a short about section (optional)', why: 'Social proof and a little of the salon’s story close the gap for first-timers.' },
    ],
    closing:
      'Sitepresso’s Hair Salon template ships with all of this already built, so you fill in your details instead of starting from a blank page. It can be live the same day, with no code.',
    faq: [
      { q: 'Do I really need online booking, or is a phone number enough?', a: 'A phone number alone loses the bookings that happen at night and on weekends. Online booking captures those and sends reminders, which cuts no-shows.' },
      { q: 'Should I show my prices?', a: 'Yes. Clear pricing filters in the right clients and saves you fielding “how much is…” messages all day.' },
      { q: 'How long does it take to build?', a: 'With a ready-made salon template you are editing text and photos, not designing — most owners are live within an afternoon.' },
    ],
    related: [
      { label: 'See the Hair Salon website template', href: '/themes/hair-salon' },
      { label: 'What should a dental clinic website include?', href: '/answers/what-should-a-dental-clinic-website-include' },
      { label: 'Start a 30-day free trial', href: '/signup?redirect=/onboarding&vertical=APPOINTMENT' },
    ],
    primaryCta: { label: 'See the Hair Salon template →', href: '/themes/hair-salon' },
    signupHref: '/signup?redirect=/onboarding&vertical=APPOINTMENT',
    updatedAt: '2026-06-18',
  },

  {
    slug: 'what-should-a-dental-clinic-website-include',
    status: 'published',
    categoryLabel: 'Dental clinics',
    question: 'What should a dental clinic website include?',
    metaTitle: 'What Should a Dental Clinic Website Include? | Sitepresso',
    metaDescription:
      'A dental clinic website should include online appointment booking, a treatments menu, dentist profiles, new-patient information, and your hours and location. Full checklist.',
    targetKeyword: 'what should a dental clinic website include',
    directAnswer:
      'A dental clinic website should cover five things: online appointment booking, a treatments menu with pricing, dentist profiles with credentials, clear new-patient information, and your hours, location and contact. Patients are choosing who to trust with their health, so the site has to reassure as much as it informs.',
    checklist: [
      { item: 'Online appointment booking', why: 'Patients increasingly expect to book without calling, and automatic reminders cut the no-shows that cost a clinic real money.' },
      { item: 'A treatments menu with pricing', why: 'From check-ups to cosmetic work, set expectations before the chair. Vague pricing makes people hesitate.' },
      { item: 'Dentist profiles and credentials', why: 'Health decisions hinge on trust. Names, qualifications and a photo do a lot of the convincing for you.' },
      { item: 'New-patient information', why: 'What to bring, what the first visit involves, which insurance you take — answer it before they have to ask.' },
      { item: 'Hours, location and contact', why: 'The page patients check most. Add parking or accessibility notes if they matter.' },
      { item: 'A few genuine patient reviews (optional)', why: 'Real reviews reassure a nervous first-timer more than any claim you make about yourself.' },
    ],
    closing:
      'Sitepresso’s Dental Clinic template includes booking, a treatments menu and patient information out of the box, with a calm, clinical design — so you can be live in minutes without code.',
    faq: [
      { q: 'Does a clinic website need online booking?', a: 'It is the single highest-value feature: it captures after-hours requests and reduces no-shows through automatic confirmations and reminders.' },
      { q: 'Should treatment prices be on the site?', a: 'At least price ranges. Patients are more likely to book when they are not worried about an unknown bill.' },
      { q: 'Can I add new-patient forms?', a: 'Yes — a new-patient information section is part of the template, ready for your details and instructions.' },
    ],
    related: [
      { label: 'See the Dental Clinic website template', href: '/themes/dental-clinic' },
      { label: 'What should a hair salon website include?', href: '/answers/what-should-a-hair-salon-website-include' },
      { label: 'Start a 30-day free trial', href: '/signup?redirect=/onboarding&vertical=APPOINTMENT' },
    ],
    primaryCta: { label: 'See the Dental Clinic template →', href: '/themes/dental-clinic' },
    signupHref: '/signup?redirect=/onboarding&vertical=APPOINTMENT',
    updatedAt: '2026-06-18',
  },

  {
    slug: 'what-should-a-law-firm-website-include',
    status: 'published',
    categoryLabel: 'Law firms',
    question: 'What should a law firm website include?',
    metaTitle: 'What Should a Law Firm Website Include? | Sitepresso',
    metaDescription:
      'A law firm website should include practice-area pages, solicitor profiles, online consultation booking, clear contact details and trust signals. The full checklist.',
    targetKeyword: 'what should a law firm website include',
    directAnswer:
      'A law firm website should include practice-area pages, solicitor profiles with experience and credentials, a way to book a consultation online, clear contact and office details, and visible trust signals such as years of experience or a free first meeting. Prospective clients are weighing something serious, so clarity and credibility matter more than flash.',
    checklist: [
      { item: 'Practice-area pages', why: 'People search by their problem — “property dispute”, “family law” — not by “legal services”. A page per area is how they find the right firm.' },
      { item: 'Solicitor profiles', why: 'Experience and credentials are the product. Show who will actually handle the matter, and what they have handled before.' },
      { item: 'Online consultation booking', why: 'Let a prospective client lock in a time the moment they decide, instead of leaving a message and waiting for a callback.' },
      { item: 'Trust signals', why: 'Years in practice, confidential consultation, a free first meeting — state them plainly and near the top, not buried in a footer.' },
      { item: 'Contact and office details', why: 'Phone, address, hours and a map. For serious matters, many clients still want to know where you physically are.' },
      { item: 'Outcomes or testimonials, handled carefully (optional)', why: 'Within what your jurisdiction’s rules allow, evidence of results reassures a hesitant client.' },
    ],
    closing:
      'Sitepresso’s Law Firm template is built around practice areas, solicitor profiles and consultation booking, with a refined, authoritative design — live in minutes, no code or agency.',
    faq: [
      { q: 'Why a page per practice area?', a: 'Because clients search for their specific issue. Separate pages let each rank for its own terms and speak directly to that client.' },
      { q: 'Can clients book a consultation online?', a: 'Yes — online consultation scheduling with confirmations is built into the template.' },
      { q: 'Can I show experience and credentials?', a: 'Yes. Solicitor profiles are designed for exactly that, since in legal work credibility is what wins the first call.' },
    ],
    related: [
      { label: 'See the Law Firm website template', href: '/themes/law-firm' },
      { label: 'What should a hair salon website include?', href: '/answers/what-should-a-hair-salon-website-include' },
      { label: 'Start a 30-day free trial', href: '/signup?redirect=/onboarding&vertical=APPOINTMENT' },
    ],
    primaryCta: { label: 'See the Law Firm template →', href: '/themes/law-firm' },
    signupHref: '/signup?redirect=/onboarding&vertical=APPOINTMENT',
    updatedAt: '2026-06-18',
  },
];

export function publishedAnswerPages() {
  return answerPages.filter((p) => p.status === 'published');
}

export function getAnswerPage(slug) {
  return answerPages.find((p) => p.slug === slug && p.status === 'published') || null;
}

export default answerPages;
