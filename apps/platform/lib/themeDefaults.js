// ============================================================================
// Sitepresso — Default Section Content Registry (Phase 1.5 · April 2026)
//
// Every profession ships with a complete, nice-looking storefront before the
// tenant adds any of their own data:
//   • services       — 4 profession-appropriate service cards
//   • team           — 3 team members with varied names
//   • testimonials   — 4 reviews from a global, diversity-mixed pool
//   • pricing        — 3 tier cards
//   • faq            — 6 Q&As
//   • gallery        — 6 captioned placeholder tiles
//   • businessHours  — default opening-hours text
//
// All content is TEXT ONLY. Avatar / gallery / service images use the
// storefront's built-in placeholder treatments (deterministic coloured
// initials, diagonal-stripe gallery cells). When the owner adds real data
// it replaces the default automatically.
//
// The storefront reads these via getDefaultSections(professionKey) and uses
// them as fallback when content / services / staff / testimonials arrays
// from the DB are empty.
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Global testimonial pool — 20 diverse names + profession-agnostic quotes.
// Each profession gets a rotating 4-entry slice so the same business doesn't
// always show the same names, but two neighbouring profession pages still
// read as "real people".
// ─────────────────────────────────────────────────────────────────────────────
const TESTIMONIAL_POOL = [
  { name: 'Aisha Patel',         role: 'Customer',  rating: 5, text: 'The whole team was professional and the service exceeded my expectations. Would recommend to anyone.' },
  { name: 'Marcus Williams',     role: 'Client',    rating: 5, text: 'Booked online in under a minute. Clean space, on time, and worth every penny. Coming back.' },
  { name: 'Hiroshi Tanaka',      role: 'Regular',   rating: 5, text: 'Best experience I have had in years. Thoughtful, patient, and the quality was outstanding.' },
  { name: 'Sophia Ramirez',      role: 'Customer',  rating: 5, text: 'Finally a place that actually listens. Walked in nervous and left with a smile.' },
  { name: 'Fatima Al-Rashid',    role: 'Client',    rating: 5, text: 'Every detail mattered. From the booking confirmation to the follow-up, everything felt considered.' },
  { name: 'Oluwaseun Adeyemi',   role: 'Client',    rating: 5, text: 'I was recommended by a friend and now I recommend them to everyone. Genuinely good people.' },
  { name: 'Emma Johansson',      role: 'Customer',  rating: 5, text: 'Calm, welcoming, and incredibly skilled. I will not go anywhere else.' },
  { name: 'Chen Wei',            role: 'Client',    rating: 5, text: 'Punctual, transparent on pricing, and very warm. Exactly what I needed.' },
  { name: 'David Cohen',         role: 'Regular',   rating: 4, text: 'Great work and honest advice. Appreciated the time they took to answer all my questions.' },
  { name: 'Priya Kapoor',        role: 'Customer',  rating: 5, text: 'Absolutely lovely from start to finish. My family now books here too.' },
  { name: 'James O\u2019Brien', role: 'Client',    rating: 5, text: 'Straightforward, skilled, and friendly — the three things I look for. A rare combination.' },
  { name: 'Amara Okonkwo',       role: 'Customer',  rating: 5, text: 'Couldn\u2019t be happier. The result speaks for itself and the experience was better than I hoped.' },
  { name: 'Lucia Ferrari',       role: 'Client',    rating: 5, text: 'Modern, spotless, and the team genuinely care. This is how every business should feel.' },
  { name: 'Arjun Mehta',         role: 'Regular',   rating: 5, text: 'Consistently excellent. I\u2019ve been coming here for over a year and it never disappoints.' },
  { name: 'Nina Petrov',         role: 'Customer',  rating: 5, text: 'Took their time, explained every option, and the result was exactly what I wanted.' },
  { name: 'Kai Nakamura',        role: 'Client',    rating: 4, text: 'Clean, modern space and a well-trained team. Easy online booking was a huge plus.' },
  { name: 'Zara Ahmed',          role: 'Customer',  rating: 5, text: 'Highly professional and genuinely kind. Will be back — and already told my whole family.' },
  { name: 'Liam O\u2019Connor', role: 'Client',    rating: 5, text: 'I had high expectations and they beat them. Top marks all round.' },
  { name: 'Nadia Al-Sayed',      role: 'Customer',  rating: 5, text: 'From the first call I felt I was in good hands. Can\u2019t recommend strongly enough.' },
  { name: 'Samuel Gyamfi',       role: 'Regular',   rating: 5, text: 'Best in the neighbourhood. Seriously — go once and you\u2019ll understand why.' },
];

// Rotate a 4-entry slice for a given profession so different professions see
// different faces. Deterministic hash → consistent across reloads.
function pickTestimonials(professionKey) {
  let h = 0;
  for (const c of professionKey) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  const start = h % TESTIMONIAL_POOL.length;
  return Array.from({ length: 4 }, (_, i) => TESTIMONIAL_POOL[(start + i) % TESTIMONIAL_POOL.length]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Default team — three staff with diverse names. Roles are profession-specific
// (we use the profession's vocab.staff or a hand-picked title).
// ─────────────────────────────────────────────────────────────────────────────
const TEAM_NAMES = [
  { name: 'Dr. Ayesha Khan',     initials: 'AK' },
  { name: 'Marcus Johnson',       initials: 'MJ' },
  { name: 'Sofia Hernandez',      initials: 'SH' },
  { name: 'Takeshi Yamamoto',     initials: 'TY' },
  { name: 'Oluwafemi Okafor',     initials: 'OO' },
  { name: 'Lena Voss',            initials: 'LV' },
];
function pickTeamNames(professionKey) {
  let h = 0;
  for (const c of professionKey) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  const start = h % TEAM_NAMES.length;
  return Array.from({ length: 3 }, (_, i) => TEAM_NAMES[(start + i) % TEAM_NAMES.length]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Profession-specific service / team-role / FAQ / pricing / gallery content.
// Every profession key in business/lib/themes.js has an entry here.
// ─────────────────────────────────────────────────────────────────────────────
const PROFESSION_CONTENT = {

  // ──── Healthcare ─────────────────────────────────────────────────────────
  general_practice: {
    teamRoles: ['General Practitioner', 'Nurse Practitioner', 'Practice Nurse'],
    services: [
      { name: 'New patient consultation', description: 'A thorough 45-minute first visit covering your health history, goals and care plan.', duration: 45, price: 120 },
      { name: 'Follow-up appointment',    description: 'A focused 20-minute visit for existing patients to review progress or address new concerns.', duration: 20, price: 70 },
      { name: 'Annual health check',      description: 'Full physical, lifestyle review and preventative screening aligned to your age and risk profile.', duration: 60, price: 180, highlighted: true },
      { name: 'Minor procedure',          description: 'In-clinic minor procedures including mole removal, joint injections and wound care.', duration: 30, price: 150 },
    ],
    faq: [
      { q: 'Do you accept insurance?', a: 'Yes — we bill most major insurers directly. Bring your member card and a valid ID to your first visit.' },
      { q: 'Do I need a referral?', a: 'Not for a general consultation. Specialist visits or imaging may require one — we will advise at the first appointment.' },
      { q: 'How do I prepare for my appointment?', a: 'Arrive 10 minutes early, bring a list of current medications and any previous test results if available.' },
      { q: 'What if I need to cancel?', a: 'Please give us 24 hours notice so we can offer the slot to another patient. Same-day cancellations may incur a small fee.' },
      { q: 'Do you see children?', a: 'Yes, we welcome patients of all ages. Parents are welcome to sit in during the consultation.' },
      { q: 'Is online booking secure?', a: 'Absolutely. Bookings are encrypted and your health details are never shared without your consent.' },
    ],
    pricing: [
      { name: 'Standard visit',   price: 70,  period: 'per visit', features: ['20-minute consultation', 'Prescription issued if needed', 'Email summary after visit'] },
      { name: 'Extended visit',   price: 120, period: 'per visit', features: ['45-minute in-depth consultation', 'Care plan document', 'Priority phone follow-up'], highlighted: true },
      { name: 'Annual check-up',  price: 180, period: 'per year',  features: ['Full physical exam', 'Preventative screening', 'Lifestyle coaching', 'Blood test (when clinically indicated)'] },
    ],
    gallery: ['Reception', 'Consultation room', 'Treatment area', 'Waiting lounge', 'Procedure room', 'Our team'],
  },

  dental: {
    teamRoles: ['Principal Dentist', 'Associate Dentist', 'Dental Hygienist'],
    services: [
      { name: 'New patient exam',        description: 'Comprehensive oral health assessment, X-rays where needed, and a personalised treatment plan.', duration: 45, price: 95 },
      { name: 'Scale & polish',          description: 'Professional cleaning to remove plaque, tartar and surface staining — leaves your smile feeling fresh.', duration: 30, price: 80, highlighted: true },
      { name: 'Composite filling',       description: 'Tooth-coloured fillings that blend seamlessly. Strong, durable and mercury-free.', duration: 45, price: 160 },
      { name: 'Teeth whitening',         description: 'In-chair professional whitening — visible results in one appointment.', duration: 60, price: 350 },
    ],
    faq: [
      { q: 'How often should I visit?', a: 'Twice a year for a check-up and clean is standard for most healthy adults. We may recommend more often based on your needs.' },
      { q: 'Are your dentists registered?', a: 'Yes — every dentist on our team is fully registered and continues their education annually.' },
      { q: 'Is teeth whitening safe?', a: 'Yes, when performed by a qualified dentist. We use professional-grade gels and protect your gums throughout.' },
      { q: 'Do you see anxious patients?', a: 'Absolutely. Let us know at booking and we will take extra time to make you comfortable. Sedation options available.' },
      { q: 'Do you offer payment plans?', a: 'Yes, interest-free payment plans are available for treatments over $500. Ask at your consultation.' },
      { q: 'What should I do for a dental emergency?', a: 'Call us as soon as possible — we hold slots open each day for urgent appointments, and offer advice over the phone.' },
    ],
    pricing: [
      { name: 'Check-up',    price: 95,  period: 'per visit', features: ['Full oral exam', 'Intra-oral photographs', 'Treatment plan'] },
      { name: 'Hygiene visit', price: 80,  period: 'per visit', features: ['Professional clean', 'Polish & fluoride', 'Home-care advice'], highlighted: true },
      { name: 'Whitening',   price: 350, period: 'per session', features: ['In-chair whitening', 'Gum protection', 'Take-home top-up gel'] },
    ],
    gallery: ['Reception', 'Treatment room', 'Waiting area', 'Digital imaging suite', 'Hygiene room', 'Our team'],
  },

  physio: {
    teamRoles: ['Senior Physiotherapist', 'Sports Physiotherapist', 'Clinical Physiotherapist'],
    services: [
      { name: 'Initial assessment',     description: 'Full 60-minute examination, diagnosis and a personalised recovery plan — including treatment during the session.', duration: 60, price: 110 },
      { name: 'Follow-up session',      description: 'Hands-on treatment, progress review and exercise progression.', duration: 45, price: 85, highlighted: true },
      { name: 'Sports injury clinic',   description: 'Rapid assessment and treatment for acute sports injuries — with return-to-play guidance.', duration: 45, price: 95 },
      { name: 'Post-surgery rehab',     description: 'Structured rehabilitation following orthopaedic surgery, liaising with your consultant throughout.', duration: 60, price: 110 },
    ],
    faq: [
      { q: 'Do I need a referral?', a: 'No — you can self-refer. If you are using insurance, check your policy first as some insurers require a GP referral.' },
      { q: 'What should I wear?', a: 'Loose, comfortable clothing you can move in. Shorts and a T-shirt are ideal for lower-limb and back assessments.' },
      { q: 'How many sessions will I need?', a: 'Most conditions improve within 3–6 sessions. We will give you a realistic estimate at the first visit.' },
      { q: 'Do you claim insurance directly?', a: 'Yes — we bill most major insurers directly. Please bring your policy number to the first appointment.' },
      { q: 'Is there parking?', a: 'Free on-site parking is available for patients. The clinic is also close to public transport.' },
      { q: 'Can I book online out of hours?', a: 'Yes — our online booking is open 24/7 and you\u2019ll get a confirmation email within minutes.' },
    ],
    pricing: [
      { name: 'Assessment',  price: 110, period: 'per visit', features: ['60-minute initial exam', 'Diagnosis', 'Take-home exercise plan'] },
      { name: 'Follow-up',   price: 85,  period: 'per visit', features: ['45-minute hands-on session', 'Progress review', 'Exercise progression'], highlighted: true },
      { name: '6-visit pack', price: 480, period: 'package', features: ['Six follow-up sessions', 'Save $30 on the single rate', 'Flexible scheduling'] },
    ],
    gallery: ['Clinic', 'Treatment room', 'Rehab gym', 'Reception', 'Our team', 'Equipment'],
  },

  // ──── Personal Care & Beauty ─────────────────────────────────────────────
  barbershop: {
    teamRoles: ['Master Barber', 'Senior Barber', 'Barber'],
    services: [
      { name: 'Signature cut',     description: 'A precision cut tailored to your face shape, hair type and style. Finished with a hot towel and styling.', duration: 45, price: 45, highlighted: true },
      { name: 'Skin fade',         description: 'Sharp, gradient fade with detailed blending — the modern classic, executed properly.', duration: 45, price: 55 },
      { name: 'Beard trim & shape', description: 'Beard sculpting with a straight razor finish, hot towel and beard oil.', duration: 30, price: 30 },
      { name: 'The full works',    description: 'Cut + beard + hot towel shave. Ninety minutes, strong coffee included.', duration: 90, price: 95 },
    ],
    faq: [
      { q: 'Do you take walk-ins?', a: 'Yes — walk-ins are welcome when chairs are free. Booking guarantees your slot and preferred barber.' },
      { q: 'Can I request a specific barber?', a: 'Of course. Our online booking lets you pick by name. First-time? Any of our barbers will look after you.' },
      { q: 'What products do you use?', a: 'Professional-grade pomades, clays and beard oils from reputable brands. We stock our favourites if you want to take any home.' },
      { q: 'Do you cut children\u2019s hair?', a: 'Yes — we welcome kids from age 5. First-cut experiences include a photo for the grandparents.' },
      { q: 'Is there a cancellation policy?', a: 'Cancel or reschedule with 4+ hours notice — no fee. Late cancellations may be charged 50%.' },
      { q: 'Do you take cash?', a: 'Cash, card, and mobile payments all accepted. Tip your barber however suits you.' },
    ],
    pricing: [
      { name: 'Signature cut', price: 45, period: 'per visit', features: ['45-min precision cut', 'Hot towel finish', 'Style advice'] },
      { name: 'Cut + beard',   price: 70, period: 'per visit', features: ['Cut + beard trim', 'Hot towel + oil', 'Style finish'], highlighted: true },
      { name: 'The full works', price: 95, period: 'per visit', features: ['Cut + beard + shave', '90 minutes', 'Strong coffee'] },
    ],
    gallery: ['Chairs', 'Fade work', 'Beard work', 'Shop floor', 'Product wall', 'Our barbers'],
  },

  hair_salon: {
    teamRoles: ['Creative Director', 'Senior Stylist', 'Colour Specialist'],
    services: [
      { name: 'Cut & style',         description: 'Consultation, cut, and a fresh blow-dry tailored to your hair type.', duration: 60, price: 75, highlighted: true },
      { name: 'Full head colour',    description: 'All-over colour with premium ammonia-free products — rich tone, gentle on your hair.', duration: 120, price: 160 },
      { name: 'Balayage',            description: 'Hand-painted highlights for a natural, lived-in finish. Includes toner and gloss.', duration: 180, price: 230 },
      { name: 'Bridal styling',      description: 'Hair up or down, trial included. Book early — peak dates fill up months ahead.', duration: 90, price: 180 },
    ],
    faq: [
      { q: 'Do you offer consultations?', a: 'Yes — complimentary 15-minute consultations before colour services or big changes. Book online.' },
      { q: 'What products do you use?', a: 'Professional, cruelty-free colour lines and styling products. Ask at reception for retail recommendations.' },
      { q: 'Can I bring a picture?', a: 'Please do! Visual references help us nail the look you want. We\u2019ll also be honest about what will suit you.' },
      { q: 'How long does colour last?', a: 'Typically 4–6 weeks before roots show. We\u2019ll schedule your refresh at checkout.' },
      { q: 'Do you offer gift vouchers?', a: 'Yes — any denomination, any service. Physical or digital. Ask at reception or call us.' },
      { q: 'What if I\u2019m running late?', a: 'Let us know — we\u2019ll do our best to fit you in. Over 15 minutes may need rescheduling.' },
    ],
    pricing: [
      { name: 'Cut & style', price: 75,  period: 'per visit', features: ['Consultation', 'Cut + blow-dry', 'Style finish'] },
      { name: 'Colour refresh', price: 160, period: 'per visit', features: ['Full head colour', 'Toner', 'Cut + blow-dry'], highlighted: true },
      { name: 'Bridal',      price: 180, period: 'per booking', features: ['Trial session', 'Wedding-day styling', 'Priority booking'] },
    ],
    gallery: ['Salon floor', 'Colour bar', 'Styling station', 'Washing area', 'Reception', 'Our stylists'],
  },

  makeup: {
    teamRoles: ['Lead Makeup Artist', 'Bridal Specialist', 'Editorial Makeup Artist'],
    services: [
      { name: 'Everyday glam',       description: 'A polished everyday look — enhanced skin, subtle contour, and a soft eye. 60 minutes.', duration: 60, price: 85 },
      { name: 'Bridal makeup',       description: 'Full bridal look with trial included. Long-wearing, photo-ready and tailored to your dress.', duration: 90, price: 250, highlighted: true },
      { name: 'Event makeup',        description: 'Red-carpet-ready look for galas, weddings and parties. False lashes included.', duration: 75, price: 140 },
      { name: 'Makeup lesson',       description: 'One-to-one 90-minute lesson using your own products. Leave with a written kit list.', duration: 90, price: 150 },
    ],
    faq: [
      { q: 'Do I need a trial for my bridal look?', a: 'Highly recommended. The trial is included and gives us time to perfect the look before the big day.' },
      { q: 'Do you travel?', a: 'Yes — on-location makeup is available for weddings, shoots and events. Travel charges apply beyond 30km.' },
      { q: 'What brands do you use?', a: 'Professional long-wear brands across all skin tones. We test-patch for sensitive skin on request.' },
      { q: 'How far ahead should I book?', a: 'Peak wedding dates fill 6–9 months out. Everyday makeup can often be booked with a few days notice.' },
      { q: 'Do you do groups?', a: 'Yes — bridal parties, hen dos, corporate shoots. Group discounts for 4+ looks.' },
      { q: 'What about allergies?', a: 'Let us know at booking. We stock hypoallergenic alternatives and can patch-test in advance.' },
    ],
    pricing: [
      { name: 'Event look',   price: 140, period: 'per session', features: ['75-minute application', 'False lashes', 'Touch-up kit'] },
      { name: 'Bridal',       price: 250, period: 'per booking', features: ['Trial session', 'Wedding-day makeup', 'Priority booking'], highlighted: true },
      { name: 'Lesson',       price: 150, period: 'per session', features: ['90-minute 1-on-1', 'Use your own products', 'Take-home kit list'] },
    ],
    gallery: ['Studio', 'Bridal looks', 'Editorial work', 'Skin prep', 'Product kit', 'On-location'],
  },

  nail_tech: {
    teamRoles: ['Lead Nail Technician', 'Senior Technician', 'Nail Technician'],
    services: [
      { name: 'Classic manicure',    description: 'Shape, cuticle care, buff and polish. Thirty minutes of calm.', duration: 30, price: 35 },
      { name: 'Gel manicure',        description: 'Long-wearing gel polish — up to three weeks without chipping.', duration: 45, price: 50, highlighted: true },
      { name: 'Builder gel nails',   description: 'Strength overlay for natural nails. Prevents breakage and extends length.', duration: 60, price: 65 },
      { name: 'Spa pedicure',        description: 'Soak, scrub, callus removal, massage, polish. Forty-five minutes of relaxation.', duration: 45, price: 55 },
    ],
    faq: [
      { q: 'How long does gel polish last?', a: 'Typically 2–3 weeks without chipping. It depends on your nail care and day-to-day activities.' },
      { q: 'Is gel safe for my nails?', a: 'Yes, when applied and removed properly. We never scrape or damage the nail plate.' },
      { q: 'Do you do nail art?', a: 'Absolutely — from subtle detailing to full editorial looks. Bring a picture or chat to your technician.' },
      { q: 'Can I book back-to-back with a friend?', a: 'Yes — we can book side-by-side appointments for friends. Just mention it at booking.' },
      { q: 'What if I have weak nails?', a: 'We recommend a builder-gel overlay to protect and strengthen. Results visible within a few applications.' },
      { q: 'Do you take children?', a: 'Yes, from age 8 with a parent present. Gentle products and kid-friendly colours.' },
    ],
    pricing: [
      { name: 'Classic', price: 35, period: 'per visit', features: ['Shape + buff', 'Cuticle care', 'Polish'] },
      { name: 'Gel',     price: 50, period: 'per visit', features: ['Shape + prep', 'Gel polish', '2–3 week wear'], highlighted: true },
      { name: 'Builder', price: 65, period: 'per visit', features: ['Overlay application', 'Natural-nail strength', 'Choice of finish'] },
    ],
    gallery: ['Nail bar', 'Nail art', 'Manicure station', 'Pedicure chair', 'Colour wall', 'Our technicians'],
  },

  spa: {
    teamRoles: ['Spa Director', 'Senior Therapist', 'Massage Therapist'],
    services: [
      { name: 'Signature massage',   description: 'Sixty minutes of tailored relaxation — Swedish, deep tissue or a blend, your choice.', duration: 60, price: 110, highlighted: true },
      { name: 'Facial treatment',    description: 'Deep-cleanse, exfoliation, mask and massage. Visible glow, zero pressure.', duration: 60, price: 120 },
      { name: 'Hot stone therapy',   description: 'Heated basalt stones melt away tension. Ninety minutes of complete reset.', duration: 90, price: 160 },
      { name: 'Half-day retreat',    description: 'Massage + facial + steam room access + herbal tea. Three hours, totally unplugged.', duration: 180, price: 280 },
    ],
    faq: [
      { q: 'What should I wear?', a: 'Arrive in comfortable clothes — we provide a robe and slippers. Underwear stays on during massage.' },
      { q: 'How early should I arrive?', a: 'Fifteen minutes early so you can change, enjoy the steam room and fill out a health form.' },
      { q: 'Is there parking?', a: 'Free on-site parking for guests. We\u2019re also a 5-minute walk from the metro station.' },
      { q: 'Can I buy a gift voucher?', a: 'Yes — any treatment, any amount. Physical or digital, delivered instantly.' },
      { q: 'Are you pregnancy-friendly?', a: 'We have specialist prenatal therapists. Please let us know at booking so we can prepare.' },
      { q: 'What if I\u2019m running late?', a: 'We\u2019ll do our best, but treatment time may be shortened to protect the next guest\u2019s booking.' },
    ],
    pricing: [
      { name: '60-min massage', price: 110, period: 'per visit', features: ['Tailored pressure', 'Aromatherapy oils', 'Post-treatment herbal tea'] },
      { name: 'Facial',          price: 120, period: 'per visit', features: ['Skin analysis', 'Cleanse + mask + massage', 'Take-home ritual'], highlighted: true },
      { name: 'Half-day retreat', price: 280, period: 'per visit', features: ['Massage + facial', 'Steam room access', 'Three hours of you-time'] },
    ],
    gallery: ['Lobby', 'Treatment room', 'Steam room', 'Relaxation lounge', 'Product shelf', 'Our therapists'],
  },

  tattoo: {
    teamRoles: ['Head Artist', 'Senior Artist', 'Resident Artist'],
    services: [
      { name: 'Consultation',       description: 'A 30-minute sit-down to discuss your idea, placement and cost. No commitment to book.', duration: 30, price: 0 },
      { name: 'Small piece (1–2 hr)', description: 'Fine-line, lettering or minimal tattoos. Includes design time and aftercare product.', duration: 120, price: 220 },
      { name: 'Half-day session',   description: 'Four-hour block for medium pieces. Ideal for traditional, neo-trad and detailed work.', duration: 240, price: 480, highlighted: true },
      { name: 'Full-day session',   description: 'Seven-hour block. For large-scale, colour or highly-detailed tattoos.', duration: 420, price: 850 },
    ],
    faq: [
      { q: 'How do I book a design?', a: 'Consultations are free — bring references and we\u2019ll work on the concept. A deposit secures your session slot.' },
      { q: 'Do you take walk-ins?', a: 'Small tattoos on walk-in days (check our social for dates). Booked sessions guarantee your artist and time.' },
      { q: 'Is the studio sterile?', a: 'Fully licensed and audited. Single-use needles, autoclave-sterilised equipment, and barrier-film protection.' },
      { q: 'How should I prepare?', a: 'Eat beforehand, stay hydrated, and wear clothes that expose the area. Avoid alcohol 24 hours prior.' },
      { q: 'What about aftercare?', a: 'We send you home with written aftercare and a sachet of recovery balm. Follow it for 2–4 weeks for best results.' },
      { q: 'Are you pregnancy-friendly?', a: 'We don\u2019t tattoo while pregnant or breastfeeding as a matter of policy. Happy to book for after.' },
    ],
    pricing: [
      { name: 'Small piece', price: 220, period: 'per session', features: ['Up to 2 hours', 'Design time included', 'Aftercare product'] },
      { name: 'Half-day',    price: 480, period: 'per session', features: ['Four-hour block', 'Best rate per hour', 'Lunch break included'], highlighted: true },
      { name: 'Full-day',    price: 850, period: 'per session', features: ['Seven-hour block', 'For large pieces', 'Design + aftercare'] },
    ],
    gallery: ['Front of shop', 'Artist stations', 'Flash wall', 'Design area', 'Finished work', 'Our artists'],
  },

  // ──── Education & Coaching ───────────────────────────────────────────────
  tutor: {
    teamRoles: ['Head Tutor', 'Senior Tutor', 'Subject Tutor'],
    services: [
      { name: 'Single 1-on-1 session', description: 'Sixty minutes of focused tuition on exactly what you need next.', duration: 60, price: 60 },
      { name: 'Weekly tuition',         description: 'Structured weekly 1-on-1 with homework review, progress reports and exam prep.', duration: 60, price: 55, highlighted: true },
      { name: 'Exam crash course',      description: 'Intensive 6-week programme leading up to major exams — papers, strategies, confidence.', duration: 60, price: 75 },
      { name: 'Group class (max 4)',    description: 'Small-group classes — the attention of 1-on-1 at a more accessible price.', duration: 60, price: 35 },
    ],
    faq: [
      { q: 'What age range do you teach?', a: 'Primary through university. Let us know the level at booking and we\u2019ll match you with the right tutor.' },
      { q: 'Is it online or in-person?', a: 'Both — we run online (Zoom) and in-person sessions at our study centre. Same rate either way.' },
      { q: 'How do you measure progress?', a: 'Monthly progress reports, mock exams, and parent/student feedback meetings.' },
      { q: 'What if my child isn\u2019t engaged?', a: 'We\u2019ll re-match tutors at no charge. The right fit matters more than the subject itself.' },
      { q: 'Do you follow a curriculum?', a: 'We follow your school\u2019s curriculum and exam board. We also fill gaps that school has missed.' },
      { q: 'Can I cancel a session?', a: '24 hours notice is free. Same-day cancellations are charged 50% out of fairness to the tutor.' },
    ],
    pricing: [
      { name: 'Single session', price: 60, period: 'per hour', features: ['1-on-1 attention', 'Tailored to your goals', 'Homework review'] },
      { name: 'Weekly',         price: 55, period: 'per hour', features: ['Regular progress', 'Monthly report', 'Mock exams included'], highlighted: true },
      { name: 'Group class',    price: 35, period: 'per hour', features: ['Max 4 students', 'Structured syllabus', 'Peer learning'] },
    ],
    gallery: ['Study room', 'Group class', '1-on-1 setup', 'Library', 'Lab area', 'Our tutors'],
  },

  music_teacher: {
    teamRoles: ['Lead Teacher', 'Senior Instructor', 'Instructor'],
    services: [
      { name: 'Single lesson',      description: 'Sixty-minute introductory lesson on your chosen instrument. No prior experience needed.', duration: 60, price: 55 },
      { name: 'Weekly tuition',     description: 'Ongoing weekly lessons with structured progression and practice plans.', duration: 60, price: 50, highlighted: true },
      { name: 'Grade exam prep',    description: 'Targeted prep for ABRSM / Trinity / Rockschool grades — repertoire, theory, sight-reading.', duration: 60, price: 60 },
      { name: 'Studio recording',   description: 'Record your own track in our studio with engineering support. Great for auditions and keepsakes.', duration: 120, price: 180 },
    ],
    faq: [
      { q: 'Do I need my own instrument?', a: 'We have practice instruments at the studio. For at-home practice, bringing your own is recommended.' },
      { q: 'What age do you teach from?', a: 'We start from age 5 on most instruments. Adult beginners are very welcome too.' },
      { q: 'What styles do you cover?', a: 'Classical, jazz, pop, rock, folk, musical theatre — let us know what inspires you.' },
      { q: 'Are there recitals?', a: 'We hold termly informal recitals. Participation is optional but highly encouraged.' },
      { q: 'Do you offer online lessons?', a: 'Yes — online lessons work well for piano, guitar, voice and theory. Equipment guidance provided.' },
      { q: 'How do I prepare for exams?', a: 'We enter you when ready, not on a fixed timeline. Pass rates are consistently above 95%.' },
    ],
    pricing: [
      { name: 'Single lesson', price: 55, period: 'per hour', features: ['1-on-1 lesson', 'All levels welcome', 'No commitment'] },
      { name: 'Weekly',        price: 50, period: 'per hour', features: ['Structured progression', 'Practice plan', 'Termly recital'], highlighted: true },
      { name: 'Grade prep',    price: 60, period: 'per hour', features: ['Exam-focused', 'Mock exams', 'Entry guidance'] },
    ],
    gallery: ['Studio', 'Piano room', 'Drum kit', 'Guitar wall', 'Recording booth', 'Our teachers'],
  },

  fitness_coach: {
    teamRoles: ['Head Coach', 'Senior Coach', 'Personal Trainer'],
    services: [
      { name: 'Initial assessment',  description: 'Fitness baseline, goal-setting and a starter programme tailored to you.', duration: 60, price: 80 },
      { name: '1-on-1 session',      description: 'Sixty-minute personal training with your coach. Strength, conditioning, or hybrid.', duration: 60, price: 75, highlighted: true },
      { name: 'Nutrition consult',   description: 'Detailed nutrition plan aligned to your goals — body composition, performance or health.', duration: 60, price: 90 },
      { name: 'Online programming',  description: 'Custom four-week programme delivered via app, with weekly check-ins.', duration: 30, price: 120 },
    ],
    faq: [
      { q: 'What if I\u2019m a complete beginner?', a: 'Most of our clients start from zero. The first session is all about setting a comfortable baseline.' },
      { q: 'Do you offer nutrition advice?', a: 'Yes — our coaches are qualified to give evidence-based nutrition guidance alongside training.' },
      { q: 'How often should I train?', a: 'Two to three times a week is ideal for most goals. We build around your schedule.' },
      { q: 'Can I pause a package?', a: 'Yes — packages can pause for illness, travel or injury. Unused sessions don\u2019t expire.' },
      { q: 'Are sessions 1-on-1?', a: 'Yes — unless you book a partner or small-group session (available at a lower rate).' },
      { q: 'Do you work with injuries?', a: 'We work with GPs and physios on rehabilitation programming. Let us know your condition at booking.' },
    ],
    pricing: [
      { name: 'Single session', price: 75, period: 'per session', features: ['1-on-1 coaching', 'No commitment', 'Session notes emailed'] },
      { name: '10-session pack', price: 650, period: 'package', features: ['Save $100', 'Flexible scheduling', 'Progress review included'], highlighted: true },
      { name: 'Online programming', price: 120, period: 'per month', features: ['Custom 4-week plan', 'Weekly check-ins', 'App delivery'] },
    ],
    gallery: ['Gym floor', 'Free weights', 'Cardio zone', 'Mobility area', 'Changing rooms', 'Our coaches'],
  },

  yoga: {
    teamRoles: ['Lead Teacher', 'Senior Teacher', 'Studio Teacher'],
    services: [
      { name: 'Drop-in class',       description: 'Pay-as-you-go access to any group class — Vinyasa, Yin, Hatha, Ashtanga.', duration: 60, price: 20 },
      { name: 'Private lesson',      description: '1-on-1 guidance on breath, posture and progression. Ideal for beginners or experienced practitioners with specific goals.', duration: 60, price: 75, highlighted: true },
      { name: 'Beginner workshop',   description: 'Four-week course covering foundations — posture, breathing, philosophy, meditation.', duration: 90, price: 120 },
      { name: 'Retreat day',         description: 'A full day of practice, meals and rest — off-site at a nearby nature retreat.', duration: 480, price: 180 },
    ],
    faq: [
      { q: 'I\u2019ve never practiced. Where do I start?', a: 'The beginner workshop is designed for complete newcomers. Or book one private to learn the fundamentals privately.' },
      { q: 'What should I bring?', a: 'Loose clothing, a water bottle. We provide mats, blocks, straps and bolsters.' },
      { q: 'How early should I arrive?', a: 'Ten minutes before class to settle in. Late entries interrupt everyone else\u2019s practice.' },
      { q: 'Are classes suitable during pregnancy?', a: 'Yes, with modifications. Let the teacher know, and consider our prenatal-specific class.' },
      { q: 'Do you offer unlimited packages?', a: 'Yes — the monthly pass includes all group classes. Auto-renews unless cancelled.' },
      { q: 'Can I try before I buy?', a: 'First class is free. Book online and mention it\u2019s your first visit.' },
    ],
    pricing: [
      { name: 'Drop-in',        price: 20,  period: 'per class',  features: ['Any group class', 'No commitment', 'Mat + props provided'] },
      { name: 'Unlimited monthly', price: 110, period: 'per month', features: ['All group classes', 'Guest pass per month', 'Studio discounts'], highlighted: true },
      { name: 'Private',        price: 75,  period: 'per session', features: ['1-on-1 teaching', 'Tailored to you', '60 minutes'] },
    ],
    gallery: ['Studio', 'Practice hall', 'Reception', 'Changing area', 'Tea corner', 'Our teachers'],
  },

  // ──── Professional Services ──────────────────────────────────────────────
  legal: {
    teamRoles: ['Managing Partner', 'Senior Associate', 'Client Intake Lead'],
    team: [
      {
        name: 'Maya Iyer',
        role: 'Managing Partner',
        bio: 'Leads complex commercial, property and private-client matters with a calm process, clear risk framing and disciplined client communication.',
      },
      {
        name: 'Thomas Ellison',
        role: 'Senior Associate',
        bio: 'Translates dense contracts, disputes and negotiations into practical options clients can act on with confidence.',
      },
      {
        name: 'Amara Bennett',
        role: 'Client Intake Lead',
        bio: 'Guides new enquiries through conflict checks, urgency triage and the first consultation so sensitive matters start safely.',
      },
    ],
    services: [
      { name: 'Commercial & Contract Advice', description: 'Review agreements, obligations and risk before you sign, negotiate or escalate a dispute.', duration: 60, price: 450, highlighted: true, features: ['Contract review', 'Risk memo', 'Negotiation next steps'] },
      { name: 'Property, Leasing & Transactions', description: 'Support for purchases, sales, leases, due diligence and time-sensitive settlement decisions.', duration: 60, price: 390, features: ['Due diligence', 'Lease terms', 'Settlement guidance'] },
      { name: 'Private Client & Family Matters', description: 'Discreet advice for personal matters where timing, communication and careful documentation matter.', duration: 60, price: 350, features: ['Confidential consult', 'Options review', 'Document checklist'] },
      { name: 'Business Retainer Counsel', description: 'Priority legal access for owners and leadership teams who need ongoing contract, governance and dispute support.', duration: 60, price: 1800, features: ['Priority response', 'Monthly advisory time', 'Board-ready summaries'] },
    ],
    testimonials: [
      { name: 'Daniel Morgan', role: 'Business Owner', rating: 5, text: 'They made the commercial risk clear without making the decision feel heavier. We knew exactly what to do next.' },
      { name: 'Priya Shah', role: 'Property Client', rating: 5, text: 'The team explained every key date, document and cost before settlement. It felt controlled from the first call.' },
      { name: 'Helen Carter', role: 'Private Client', rating: 5, text: 'Sensitive, direct and careful with our information. The first consultation gave us a genuine plan.' },
      { name: 'Nathan Brooks', role: 'Director', rating: 5, text: 'Their retainer gives our leadership team fast judgement on contracts, disputes and negotiation points.' },
    ],
    faq: [
      { q: 'What should I include in my first enquiry?', a: 'Share the matter type, urgency, location, key dates and the best way to contact you. Avoid sending highly sensitive documents until the firm requests them.' },
      { q: 'Is my enquiry confidential?', a: 'Legal enquiries are handled through the firm intake process with care for confidentiality, conflict checks and professional obligations.' },
      { q: 'How are legal fees explained?', a: 'Defined matters can use fixed fees. Complex work may be hourly or staged, with a written scope and estimate before work begins.' },
      { q: 'Can you tell me if the firm is the right fit?', a: 'Yes. The first response should confirm practice-area fit, urgency, conflict-check needs and whether another specialist is more appropriate.' },
      { q: 'Do you offer online consultations?', a: 'Yes. Video and phone consultations are available when suitable, with in-person meetings by appointment for document-heavy matters.' },
      { q: 'What happens after I submit the form?', a: 'The intake team reviews the enquiry, checks conflicts, confirms urgency and offers the next practical step.' },
    ],
    pricing: [
      { name: 'Confidential Consult', price: 0, period: 'first triage', features: ['Matter fit check', 'Urgency review', 'Conflict-check pathway'] },
      { name: 'Fixed Advice', price: 450, period: 'from', features: ['Scoped legal question', 'Written next-step note', 'Fee clarity before work'], highlighted: true },
      { name: 'Business Retainer', price: 1800, period: 'per month', features: ['Priority legal access', 'Contract and dispute support', 'Monthly leadership summary'] },
    ],
    gallery: ['Client lounge', 'Private consultation room', 'Boardroom', 'Document review suite', 'Legal library', 'Client intake desk'],
  },

  accountant: {
    teamRoles: ['Principal Accountant', 'Senior Accountant', 'Tax Advisor'],
    services: [
      { name: 'Tax return preparation', description: 'Complete preparation and filing of your annual tax return. Transparent fixed fee.', duration: 90, price: 280, highlighted: true },
      { name: 'Small business bookkeeping', description: 'Monthly bookkeeping, P&L reports and VAT submissions. Stay compliant effortlessly.', duration: 60, price: 350 },
      { name: 'Company formation',      description: 'Incorporate your new company — registration, banking setup, first-year compliance checklist.', duration: 60, price: 450 },
      { name: 'Tax planning session',   description: 'Proactive review to minimise your tax bill legally. Best done 2–3 months before year end.', duration: 60, price: 220 },
    ],
    faq: [
      { q: 'What records do I need to bring?', a: 'We\u2019ll send a checklist before your first visit. Broadly: bank statements, invoices, receipts, previous year\u2019s return.' },
      { q: 'Are fees fixed or hourly?', a: 'Fixed fees for standard work (returns, formation, VAT). Hourly only for complex advisory matters.' },
      { q: 'Can you handle my software?', a: 'Yes — Xero, QuickBooks, FreeAgent, Sage and more. We\u2019ll even help set you up if you\u2019re starting fresh.' },
      { q: 'Do you deal with tax investigations?', a: 'Yes — we handle HMRC correspondence on your behalf. Investigation insurance is available at modest cost.' },
      { q: 'How late can I file my return?', a: 'The earlier the better. We accept new clients up to six weeks before the deadline. Late-filer rush fees apply after.' },
      { q: 'Do you offer remote service?', a: 'Fully remote service is available — documents uploaded securely and returns signed digitally.' },
    ],
    pricing: [
      { name: 'Tax return',    price: 280, period: 'per year', features: ['Self-assessment prep', 'Filing with HMRC', 'Support for 30 days'] },
      { name: 'Monthly books', price: 350, period: 'per month', features: ['Bookkeeping', 'VAT returns', 'Monthly P&L report'], highlighted: true },
      { name: 'Formation',     price: 450, period: 'one-off', features: ['Company registration', 'Banking setup support', 'First-year checklist'] },
    ],
    gallery: ['Office', 'Meeting room', 'Reception', 'Working area', 'City view', 'Our team'],
  },

  ca_tax_consultant: {
    teamRoles: ['Principal CA', 'GST & ITR Specialist', 'MCA Compliance Advisor'],
    services: [
      { name: 'CA Certificates', description: 'Net worth, solvency, turnover, working capital and other certificates for banks, tenders and visas.', duration: 45, price: 2500, highlighted: true },
      { name: 'GST Compliance', description: 'GST registration, returns, LUT, amendments, e-invoicing and notice support.', duration: 60, price: 1500 },
      { name: 'Income Tax Filing', description: 'ITR filing, TDS/TAN, 15CA/15CB and income tax notice assistance.', duration: 60, price: 1200 },
      { name: 'MCA & Startup Compliance', description: 'Company registration, LLP/OPC compliance, ROC filings and director or capital changes.', duration: 90, price: 3500 },
    ],
    faq: [
      { q: 'Can the process be completed online?', a: 'Yes. Most CA certificate, GST, ITR and registration workflows can be handled online after document verification.' },
      { q: 'Do certificates include UDIN?', a: 'Where UDIN is applicable, the certificate workflow is prepared for CA certification and UDIN-based verification.' },
      { q: 'Which documents are required?', a: 'Requirements depend on the service. The team confirms a practical checklist before work begins.' },
      { q: 'How fast can the work be completed?', a: 'Simple certificate cases can move quickly after complete documents are received. Filings and registrations depend on portal and department timelines.' },
    ],
    pricing: [
      { name: 'Certificate request', price: 2500, period: 'from', features: ['Checklist', 'Document review', 'CA workflow'], highlighted: true },
      { name: 'Tax filing', price: 1200, period: 'from', features: ['ITR/GST support', 'Review', 'Acknowledgement'] },
      { name: 'Registration', price: 3500, period: 'from', features: ['Eligibility check', 'Application support', 'Compliance notes'] },
    ],
    gallery: ['Consultation desk', 'Compliance checklist', 'Certificate review', 'GST filing', 'Startup documents', 'Client support'],
  },

  it_services: {
    teamRoles: ['Solution Architect', 'Full-Stack Engineer', 'QA and Support Lead'],
    services: [
      { name: 'Custom Software Development', description: 'Web applications, portals, APIs and integrations designed around your process and business goals.', duration: 90, price: 1500, highlighted: true },
      { name: 'Cloud, Database and DevOps', description: 'Cloud setup, database design, deployment pipelines, monitoring and operational readiness.', duration: 90, price: 1200 },
      { name: 'AI, Automation and Data', description: 'Workflow automation, reporting, AI assistants and data tools that reduce manual effort.', duration: 90, price: 1500 },
      { name: 'QA, Managed IT and Recruitment', description: 'Release testing, support, maintenance, platform care and technology talent assistance.', duration: 60, price: 600 },
    ],
    faq: [
      { q: 'Can you start with discovery before development?', a: 'Yes. Discovery confirms goals, current systems, risks, budget and the right delivery path before build work starts.' },
      { q: 'Do you work on existing systems?', a: 'Yes. We can review, stabilise, modernise, integrate or support current websites, apps and internal platforms.' },
      { q: 'Can you handle cloud and DevOps?', a: 'Yes. We support cloud infrastructure, databases, CI/CD, monitoring, releases and operational handover.' },
      { q: 'Do you provide testing and managed support?', a: 'Yes. QA, regression testing, automation, monitoring and managed support can be included as part of the engagement.' },
    ],
    pricing: [
      { name: 'Discovery sprint', price: 900, period: 'from', features: ['Scope review', 'Technical plan', 'Delivery estimate'], highlighted: true },
      { name: 'Build project', price: 2500, period: 'from', features: ['Design and development', 'QA and deployment', 'Handover support'] },
      { name: 'Managed support', price: 600, period: 'per month', features: ['Monitoring', 'Maintenance', 'Priority response'] },
    ],
    gallery: ['Discovery workshop', 'Engineering team', 'Cloud dashboard', 'Testing workflow', 'Support desk', 'Client delivery'],
  },

  // ──── Healthcare (remaining) ─────────────────────────────────────────────
  psychology: {
    teamRoles: ['Clinical Psychologist', 'Psychotherapist', 'Counsellor'],
    services: [
      { name: 'Initial assessment',    description: '50-minute intake to understand what you\u2019re going through and agree a way forward.', duration: 50, price: 140 },
      { name: 'Therapy session',       description: 'Weekly 50-minute therapy — CBT, ACT, or psychodynamic depending on your needs.', duration: 50, price: 120, highlighted: true },
      { name: 'Couples therapy',       description: 'Sessions designed for two. A structured, evidence-based approach to communication and connection.', duration: 75, price: 170 },
      { name: 'EMDR session',          description: 'Trauma-focused therapy for PTSD and single-event trauma. Delivered by an EMDR-certified clinician.', duration: 75, price: 160 },
    ],
    faq: [
      { q: 'Is what I share confidential?', a: 'Yes — everything stays between us, subject to the legal limits explained in your first session.' },
      { q: 'How many sessions will I need?', a: 'Short-term work is typically 6–12 sessions. Longer-term therapy is open-ended and reviewed regularly.' },
      { q: 'Do you work with teenagers?', a: 'Yes — from age 13 with appropriate parental involvement at the outset.' },
      { q: 'Are online sessions effective?', a: 'Research shows online therapy is as effective as in-person for most issues. We offer both.' },
      { q: 'Do you take insurance?', a: 'Many of our clinicians are paneled with major insurers. We\u2019ll confirm coverage before your first session.' },
      { q: 'How do I choose the right therapist?', a: 'Book a free 15-minute call with us and we\u2019ll match you based on your needs and preferences.' },
    ],
    pricing: [
      { name: 'Single session', price: 120, period: 'per session', features: ['50-minute therapy', 'Confidential', 'Session notes held securely'] },
      { name: 'Monthly (4 sessions)', price: 440, period: 'per month', features: ['Weekly sessions', 'Consistent slot', 'Save $40'], highlighted: true },
      { name: 'Intensive', price: 160, period: 'per session', features: ['75-min sessions', 'Specialist approaches (EMDR, DBT)', 'Priority booking'] },
    ],
    gallery: ['Clinic', 'Consulting room', 'Reception', 'Waiting area', 'Online session setup', 'Our team'],
  },

  dermatology: {
    teamRoles: ['Consultant Dermatologist', 'Medical Aesthetician', 'Skin Therapist'],
    services: [
      { name: 'Full skin check',        description: 'Head-to-toe dermoscopic examination. Mole mapping and photographic records for future comparison.', duration: 30, price: 220 },
      { name: 'Acne consultation',      description: 'Personalised acne treatment plan — topical, systemic or procedural — with follow-up included.', duration: 45, price: 180, highlighted: true },
      { name: 'Laser hair removal',     description: 'Medical-grade diode laser. 6–8 sessions typically required for lasting results.', duration: 30, price: 160 },
      { name: 'Chemical peel',          description: 'Medical-strength peel tailored to your concern — brightening, texture, acne or pigmentation.', duration: 45, price: 220 },
    ],
    faq: [
      { q: 'Do I need a GP referral?', a: 'Not for cosmetic consultations. A referral may reduce your out-of-pocket cost if you\u2019re claiming insurance.' },
      { q: 'How long until I see results?', a: 'Depends on the treatment — whitening and peels show change in days; acne care takes 6–12 weeks.' },
      { q: 'Is laser hair removal safe for darker skin?', a: 'Yes — we use long-pulse Nd:YAG which is safe across skin tones.' },
      { q: 'What should I do before a peel?', a: 'Avoid sun exposure, retinoids and exfoliants for 7 days prior. We\u2019ll send a full prep guide.' },
      { q: 'Do you treat skin cancer?', a: 'Yes — our dermatologists perform dermoscopy, biopsy and minor excisions on-site.' },
      { q: 'Are your treatments doctor-led?', a: 'Absolutely. Consultations are always with a consultant dermatologist.' },
    ],
    pricing: [
      { name: 'Consultation',   price: 180, period: 'per visit',  features: ['45-minute consult', 'Written plan', 'Follow-up included'] },
      { name: 'Full skin check', price: 220, period: 'per visit', features: ['Head-to-toe exam', 'Mole mapping', 'Annual reminder'], highlighted: true },
      { name: 'Course of 4 peels', price: 720, period: 'package', features: ['Medical-strength', 'Save $160', '4-week spacing'] },
    ],
    gallery: ['Reception', 'Consulting room', 'Laser suite', 'Treatment room', 'Waiting lounge', 'Our team'],
  },

  chiropractic: {
    teamRoles: ['Principal Chiropractor', 'Senior Chiropractor', 'Associate Chiropractor'],
    services: [
      { name: 'Initial examination',    description: '60-minute exam, postural analysis and a clear diagnosis with treatment options.', duration: 60, price: 120 },
      { name: 'Adjustment session',     description: 'Targeted spinal and joint adjustments for existing patients. Includes mobility work.', duration: 20, price: 65, highlighted: true },
      { name: 'Sports injury visit',    description: 'Diagnosis and treatment for acute sports injuries — with return-to-play advice.', duration: 45, price: 95 },
      { name: 'Pregnancy care',         description: 'Gentle adjustments using specialist tables. Safe through all three trimesters.', duration: 30, price: 80 },
    ],
    faq: [
      { q: 'Is it safe?', a: 'Yes — chiropractic is a drug-free, non-invasive approach with a strong safety record when performed by registered practitioners.' },
      { q: 'Does adjustment hurt?', a: 'Most people find adjustments comfortable — some experience a brief mild soreness that resolves quickly.' },
      { q: 'How many visits do I need?', a: 'Acute issues often resolve in 3–6 visits. Chronic conditions need longer plans — we\u2019ll always be transparent.' },
      { q: 'Do you work with children?', a: 'Yes — we have practitioners trained in paediatric chiropractic using gentle, age-appropriate techniques.' },
      { q: 'Do you accept insurance?', a: 'Most major insurers cover our services. Bring your card at first visit.' },
      { q: 'What should I wear?', a: 'Comfortable, loose clothing. We may give you a gown for postural assessment.' },
    ],
    pricing: [
      { name: 'Initial exam', price: 120, period: 'per visit', features: ['60-min exam', 'Postural analysis', 'First adjustment included'] },
      { name: 'Follow-up',    price: 65,  period: 'per visit', features: ['20-min adjustment', 'Mobility work', 'Home exercises'], highlighted: true },
      { name: '6-visit pack', price: 350, period: 'package', features: ['Six follow-ups', 'Save $40', 'Flexible booking'] },
    ],
    gallery: ['Clinic', 'Adjustment room', 'Reception', 'Treatment area', 'Exercise space', 'Our team'],
  },

  optometry: {
    teamRoles: ['Principal Optometrist', 'Senior Optometrist', 'Dispensing Optician'],
    services: [
      { name: 'Comprehensive eye exam', description: '45-minute full exam including vision, eye health, OCT imaging and a prescription if needed.', duration: 45, price: 85, highlighted: true },
      { name: 'Contact lens fitting',   description: 'Detailed assessment and fitting for daily, monthly, or specialty lenses.', duration: 45, price: 120 },
      { name: 'Children\u2019s eye exam', description: 'Age-appropriate screening — behavioural, vision development and prescription checks.', duration: 30, price: 65 },
      { name: 'Dry eye clinic',         description: 'Specialist diagnostic scan + treatment plan for chronic dry eye relief.', duration: 45, price: 180 },
    ],
    faq: [
      { q: 'How often should I have an eye test?', a: 'Every 2 years for most adults, annually over 60 or with existing conditions. Children: yearly.' },
      { q: 'Do you make glasses on-site?', a: 'Yes — most standard prescriptions are glazed in our own lab within 3–5 days.' },
      { q: 'Do you direct-bill insurance?', a: 'Yes, most major vision plans. Bring your card to the visit.' },
      { q: 'Can I order contacts online after fitting?', a: 'Absolutely — once fitted, we issue your prescription and you\u2019re free to order anywhere.' },
      { q: 'Is parking available?', a: 'Yes, free parking out front plus a nearby public lot for busy days.' },
      { q: 'What if I just need a repair?', a: 'Walk in any time — most repairs are done on the spot at no charge for existing customers.' },
    ],
    pricing: [
      { name: 'Standard exam',  price: 85,  period: 'per visit', features: ['45-min exam', 'Vision + health check', 'Prescription issued'] },
      { name: 'Premium package', price: 140, period: 'per visit', features: ['OCT retinal imaging', 'Dry eye assessment', 'Follow-up included'], highlighted: true },
      { name: 'Child\u2019s exam', price: 65, period: 'per visit', features: ['Age-appropriate', '30-minute exam', 'Fun + friendly'] },
    ],
    gallery: ['Store front', 'Frame gallery', 'Testing room', 'OCT imaging', 'Lab', 'Our team'],
  },

  nutrition: {
    teamRoles: ['Accredited Dietitian', 'Sports Nutritionist', 'Nutrition Coach'],
    services: [
      { name: 'Initial consultation',   description: '75-minute in-depth assessment, goal-setting and a personalised plan.', duration: 75, price: 150 },
      { name: 'Follow-up visit',        description: '30-minute review and plan progression — tailoring to your progress.', duration: 30, price: 75, highlighted: true },
      { name: 'Sports nutrition plan',  description: 'For athletes — fuelling strategy, body composition and recovery protocols.', duration: 60, price: 180 },
      { name: 'Meal planning session',  description: 'Done-with-you weekly meal plans — shopping list, prep tips, realistic for busy weeks.', duration: 45, price: 110 },
    ],
    faq: [
      { q: 'Will you give me a meal plan?', a: 'Yes, but tailored — not a one-size fits all. We work with your food preferences and schedule.' },
      { q: 'Do I need to bring anything?', a: 'A 3-day food diary helps but isn\u2019t essential. We\u2019ll start with a chat about your goals.' },
      { q: 'Can nutrition help with medical conditions?', a: 'Yes — we support diabetes, IBS, high cholesterol, food allergies, PCOS and more in partnership with your GP.' },
      { q: 'Are you online-only?', a: 'Mix of in-person and video. Many clients prefer the flexibility of online after the first visit.' },
      { q: 'How often should we meet?', a: 'Most clients see us every 2–4 weeks at first, tapering as habits stick.' },
      { q: 'Do you support athletes?', a: 'Yes — we have a sports-specialist dietitian on staff for performance, recovery and body composition goals.' },
    ],
    pricing: [
      { name: 'Consultation',     price: 150, period: 'per visit', features: ['75-minute in-depth intake', 'Written plan', 'Email follow-up'] },
      { name: 'Monthly program',   price: 280, period: 'per month', features: ['2 follow-up visits', 'WhatsApp check-ins', 'Meal plans'], highlighted: true },
      { name: 'Sports plan',       price: 180, period: 'per visit', features: ['Performance-focused', 'Fuelling + recovery', 'Body composition'] },
    ],
    gallery: ['Reception', 'Consulting room', 'Kitchen demo', 'Library', 'Meeting space', 'Our team'],
  },

  veterinary: {
    teamRoles: ['Principal Veterinarian', 'Senior Veterinary Surgeon', 'Veterinary Nurse'],
    services: [
      { name: 'Annual wellness visit',  description: 'Full check-up, vaccinations if due, parasite review and nutritional advice.', duration: 30, price: 85, highlighted: true },
      { name: 'Vaccination',            description: 'Core vaccinations for puppies, kittens and adult pets. Includes health check.', duration: 20, price: 55 },
      { name: 'Dental clean & scale',   description: 'Full dental cleaning under anaesthesia. Modern monitoring and pain management.', duration: 90, price: 380 },
      { name: 'Sick pet appointment',   description: 'Same-day availability for unwell pets. Diagnosis, treatment and home-care advice.', duration: 30, price: 95 },
    ],
    faq: [
      { q: 'Do you take emergencies?', a: 'Yes — call ahead if you can. We hold same-day slots open for urgent cases.' },
      { q: 'Is the clinic calm for anxious pets?', a: 'We have separate dog and cat waiting areas, and can dispense pre-visit calming medication.' },
      { q: 'Do you do home visits?', a: 'Yes — for euthanasia and palliative care. Ask our reception for details.' },
      { q: 'What brands of food do you stock?', a: 'We carry Hill\u2019s, Royal Canin and Purina prescription diets. Special orders available.' },
      { q: 'Are your vets qualified?', a: 'Every vet is fully licensed and registered. Many hold advanced certifications in their specialty areas.' },
      { q: 'Is my pet record digital?', a: 'Yes — full digital records, shareable with specialists or new clinics on request.' },
    ],
    pricing: [
      { name: 'Wellness visit', price: 85,  period: 'per visit', features: ['30-min check-up', 'Health + nutrition review', 'Vaccines if due'] },
      { name: 'Dental package', price: 380, period: 'one-off',  features: ['Scale + polish', 'Anaesthetic + monitoring', 'Post-op pain relief'], highlighted: true },
      { name: 'Puppy/kitten plan', price: 220, period: 'package', features: ['Full vaccine course', 'Microchip', 'Nutrition + training advice'] },
    ],
    gallery: ['Reception', 'Consulting room', 'Surgery theatre', 'Recovery ward', 'Waiting area', 'Our vets'],
  },

  // ──── Professional services (remaining) ───────────────────────────────────
  financial_advisor: {
    teamRoles: ['Senior Advisor', 'Financial Planner', 'Investment Advisor'],
    services: [
      { name: 'Discovery meeting',      description: 'Free 45-minute first meeting. Understand your situation, goals and how we work.', duration: 45, price: 0 },
      { name: 'Financial plan',         description: 'Comprehensive written plan covering retirement, investments, insurance and tax.', duration: 120, price: 1500, highlighted: true },
      { name: 'Investment review',      description: 'Quarterly review of your portfolio with rebalancing and commentary.', duration: 60, price: 250 },
      { name: 'Retirement planning',    description: 'Detailed retirement readiness analysis and drawdown strategy.', duration: 90, price: 850 },
    ],
    faq: [
      { q: 'How are you compensated?', a: 'Transparent flat fees and/or a percentage of assets managed. No commissions on product sales.' },
      { q: 'Are you independent?', a: 'Yes — we\u2019re independent and fiduciary-bound. Your interests come before any product provider.' },
      { q: 'What\u2019s the minimum to invest?', a: 'No minimum for planning services. Investment management typically starts at $250k.' },
      { q: 'How often will we meet?', a: 'Full review annually, quarterly progress check, and we\u2019re available whenever life changes.' },
      { q: 'Do you work with businesses?', a: 'Yes — corporate retirement plans, key-person insurance and business succession planning.' },
      { q: 'Is my data secure?', a: 'Bank-grade encryption, two-factor auth, and we never store passwords to your accounts.' },
    ],
    pricing: [
      { name: 'Plan', price: 1500, period: 'one-off', features: ['Full financial plan', '2-hour presentation', '30-day follow-up'] },
      { name: 'Annual advice', price: 3500, period: 'per year', features: ['Quarterly meetings', 'Portfolio management', 'Tax planning'], highlighted: true },
      { name: 'Investment only', price: 1.0, period: '% AUM', features: ['Portfolio construction', 'Rebalancing', 'Tax-aware trading'] },
    ],
    gallery: ['Reception', 'Meeting room', 'Office view', 'Library', 'Boardroom', 'Our team'],
  },

  consultant: {
    teamRoles: ['Managing Partner', 'Principal Consultant', 'Senior Consultant'],
    services: [
      { name: 'Discovery call',         description: 'Free 30-minute call to understand your challenge and explore fit.', duration: 30, price: 0 },
      { name: 'Strategy workshop',      description: 'Half-day workshop to align your team, diagnose the real problem, and agree a plan.', duration: 240, price: 3500, highlighted: true },
      { name: 'Project engagement',     description: '4–12 week engagement delivering a specific outcome — change, growth, or transformation.', duration: 60, price: 15000 },
      { name: 'Advisory retainer',      description: 'Monthly advisory access for senior teams. Pre-scheduled meetings + responsive support.', duration: 60, price: 5000 },
    ],
    faq: [
      { q: 'How long is a typical engagement?', a: 'Most focused engagements run 4–12 weeks. Longer retainers support transformational work.' },
      { q: 'What industries do you serve?', a: 'Professional services, technology, healthcare and financial services are our strongest focus.' },
      { q: 'Can we start small?', a: 'Yes — start with a workshop or a fixed-scope diagnostic. Expand only if it\u2019s clearly valuable.' },
      { q: 'Do you work on-site or remote?', a: 'Both — mix of on-site workshops and remote between-session work. Client preference-led.' },
      { q: 'How do you measure success?', a: 'We agree clear outcome metrics at engagement kick-off. No vague deliverables.' },
      { q: 'Do you sign NDAs?', a: 'Standard practice. Mutual NDA is always signed before substantive discussion.' },
    ],
    pricing: [
      { name: 'Workshop',  price: 3500,  period: 'one-off',   features: ['Half-day facilitated', 'Written output', 'Team alignment'] },
      { name: 'Project',   price: 15000, period: 'per project', features: ['4–12 week engagement', 'Defined outcome', 'Weekly progress'], highlighted: true },
      { name: 'Retainer',  price: 5000,  period: 'per month', features: ['Advisory access', 'Monthly strategy meeting', 'Responsive support'] },
    ],
    gallery: ['Office', 'Boardroom', 'Workshop space', 'Meeting room', 'Team area', 'Our consultants'],
  },

  immigration: {
    teamRoles: ['Managing Partner', 'Immigration Solicitor', 'Caseworker'],
    services: [
      { name: 'Consultation',           description: '60-minute consultation. Case assessment and fixed-fee quote for your matter.', duration: 60, price: 180 },
      { name: 'Visa application',       description: 'End-to-end visa preparation and submission. Fixed fee based on visa type.', duration: 120, price: 1200, highlighted: true },
      { name: 'Appeal representation',  description: 'Preparing and representing your case before the tribunal or in judicial review.', duration: 180, price: 2500 },
      { name: 'Citizenship application', description: 'Full support through naturalisation — eligibility, documents, submission, follow-up.', duration: 90, price: 850 },
    ],
    faq: [
      { q: 'How long will my application take?', a: 'Processing times vary by visa — typical ranges are 4–12 weeks. We track progress weekly.' },
      { q: 'Are fees fixed?', a: 'Yes — all quotes are fixed-fee. Government fees separate. No hidden extras.' },
      { q: 'Do you speak my language?', a: 'Our team covers English, Hindi, Mandarin, Arabic and Spanish. Translators available for others.' },
      { q: 'What if my application is refused?', a: 'We\u2019ll review the refusal letter free of charge and explain your appeal or fresh-application options.' },
      { q: 'Can I do it myself?', a: 'Technically yes — but the error rate on self-submitted applications is significant. We do this daily.' },
      { q: 'Is my information confidential?', a: 'Yes — all client matters are covered by legal privilege.' },
    ],
    pricing: [
      { name: 'Consultation', price: 180,  period: 'per visit',   features: ['60-minute session', 'Case assessment', 'Written quote'] },
      { name: 'Visa package', price: 1200, period: 'per application', features: ['Full preparation', 'Submission + tracking', 'Success-fee option'], highlighted: true },
      { name: 'Appeal',       price: 2500, period: 'per case',    features: ['Grounds drafting', 'Tribunal representation', 'Evidence bundle'] },
    ],
    gallery: ['Reception', 'Consultation room', 'Meeting rooms', 'Office', 'Library', 'Our team'],
  },

  // ──── Fitness & wellness (remaining) ──────────────────────────────────────
  gym: {
    teamRoles: ['Gym Director', 'Head Coach', 'Personal Trainer'],
    services: [
      { name: 'Day pass',               description: 'Full-day access to all equipment and group classes. Great for a first look.', duration: 480, price: 20 },
      { name: 'Induction session',      description: 'One-to-one introduction to the gym — equipment, safety, starter program.', duration: 60, price: 0 },
      { name: 'Personal training',      description: 'Certified trainer, individual programme, measured progress.', duration: 60, price: 65, highlighted: true },
      { name: 'Group class',            description: 'Strength, HIIT, mobility, yoga — full schedule included with membership.', duration: 45, price: 15 },
    ],
    faq: [
      { q: 'Is there a joining fee?', a: 'No joining fee. Monthly rolling memberships with no minimum term.' },
      { q: 'What are opening hours?', a: 'Staffed 6am–10pm. 24-hour member access with keycard on the Plus plan.' },
      { q: 'Do you offer showers?', a: 'Yes — full changing rooms, showers, towels, hairdryers. Secure day lockers free.' },
      { q: 'Can I freeze my membership?', a: 'Yes — 1 month per year at no charge. Longer freezes possible for medical reasons.' },
      { q: 'Do you run group classes?', a: '25+ classes per week including strength, HIIT, yoga, Pilates and mobility.' },
      { q: 'Is there a free trial?', a: 'First class or gym visit is free. Full tour by a coach — book online.' },
    ],
    pricing: [
      { name: 'Standard', price: 45,  period: 'per month', features: ['Gym floor access', 'Group classes', 'Changing rooms'] },
      { name: 'Plus',     price: 65,  period: 'per month', features: ['24-hour access', 'Towel service', 'Guest passes'], highlighted: true },
      { name: 'Couples',  price: 80,  period: 'per month', features: ['Two memberships', 'Group classes', 'Monthly PT session'] },
    ],
    gallery: ['Gym floor', 'Free weights', 'Cardio', 'Studio', 'Changing rooms', 'Our coaches'],
  },

  meditation: {
    teamRoles: ['Lead Teacher', 'Meditation Guide', 'Studio Teacher'],
    services: [
      { name: 'Drop-in class',          description: 'Any class for one drop-in fee — guided meditation, breathwork, or silent sits.', duration: 45, price: 18 },
      { name: 'Private session',        description: '1-on-1 with a teacher to design a daily practice tailored to you.', duration: 60, price: 85, highlighted: true },
      { name: 'Introduction course',    description: '4-week beginner course — foundations of breath, posture, awareness.', duration: 60, price: 120 },
      { name: 'Corporate workshop',     description: 'On-site sessions for teams. Stress reduction and focus training.', duration: 90, price: 450 },
    ],
    faq: [
      { q: 'I\u2019ve never meditated. Where do I start?', a: 'The 4-week beginner course is perfect — or drop into a guided session first to see how it feels.' },
      { q: 'What should I wear?', a: 'Comfortable clothes. We provide cushions, mats and blankets.' },
      { q: 'Is it religious?', a: 'No — our approach is secular, though we draw from contemplative traditions worldwide.' },
      { q: 'How long should I sit?', a: 'Start with 10 minutes a day, build to 20–30 as the habit grows.' },
      { q: 'Do you offer online classes?', a: 'Live online sessions daily. Unlimited members can join in-person or online.' },
      { q: 'Can I try before I buy?', a: 'Yes — first class is free. Book online.' },
    ],
    pricing: [
      { name: 'Drop-in', price: 18, period: 'per class', features: ['Any guided class', 'Mat + cushion', 'All levels welcome'] },
      { name: 'Unlimited monthly', price: 95, period: 'per month', features: ['All classes', 'Online + in-person', 'Guest pass'], highlighted: true },
      { name: 'Beginner course', price: 120, period: '4 weeks', features: ['Foundations covered', 'Weekly sessions', 'Take-home practice'] },
    ],
    gallery: ['Studio', 'Cushion wall', 'Tea corner', 'Quiet room', 'Reception', 'Our teachers'],
  },

  // ──── Home & local services ───────────────────────────────────────────────
  electrician: {
    teamRoles: ['Master Electrician', 'Senior Electrician', 'Apprentice Electrician'],
    services: [
      { name: 'Callout + diagnosis',    description: 'We come to you, diagnose the issue and quote the fix. No charge if we do the work.', duration: 60, price: 85 },
      { name: 'Safety inspection',      description: 'Full electrical inspection with written report. Required before some property sales.', duration: 120, price: 220, highlighted: true },
      { name: 'Consumer unit upgrade',  description: 'Replace old fuse box with modern consumer unit. Completed in one day.', duration: 240, price: 750 },
      { name: 'EV charger install',     description: 'Home EV charger installation, certified and notified to your network.', duration: 180, price: 900 },
    ],
    faq: [
      { q: 'Are you qualified?', a: 'Yes — fully qualified, insured and registered with the national electrical body.' },
      { q: 'How quickly can you come?', a: 'Standard callouts within 24 hours. Emergency slots available same-day for safety issues.' },
      { q: 'Do you do weekend work?', a: 'Yes — Saturday available at standard rates, Sunday at a small premium.' },
      { q: 'Is my work certified?', a: 'All work is certified and notified to building control where required. You keep the certificate.' },
      { q: 'Do you provide warranty?', a: 'Yes — 12 months on all workmanship, manufacturer warranty on parts.' },
      { q: 'Is the first visit free?', a: 'Callout is charged, but waived when you proceed with the quoted repair.' },
    ],
    pricing: [
      { name: 'Callout',   price: 85,  period: 'per visit', features: ['Up to 1 hour on-site', 'Diagnosis + quote', 'Waived if work proceeds'] },
      { name: 'Safety check', price: 220, period: 'one-off', features: ['Full inspection', 'Written report', 'Certificate issued'], highlighted: true },
      { name: 'Hourly rate', price: 75, period: 'per hour', features: ['Qualified electrician', 'Parts at trade price', '12-month warranty'] },
    ],
    gallery: ['On the job', 'Consumer unit work', 'EV install', 'Lighting', 'Van fit-out', 'Our team'],
  },

  plumber: {
    teamRoles: ['Master Plumber', 'Senior Plumber', 'Plumbing Apprentice'],
    services: [
      { name: 'Emergency callout',      description: 'Same-day response for burst pipes, leaks, blocked drains.', duration: 60, price: 120, highlighted: true },
      { name: 'Boiler service',         description: 'Annual boiler service — safety check, clean, efficiency test, certificate.', duration: 90, price: 95 },
      { name: 'Bathroom refit',         description: 'Full bathroom installation from a free quote. Timeline agreed in writing.', duration: 480, price: 4500 },
      { name: 'Drain unblocking',       description: 'High-pressure jet + camera inspection where needed. Same-visit fix in most cases.', duration: 90, price: 180 },
    ],
    faq: [
      { q: 'Do you cover emergencies?', a: 'Yes — 24/7 emergency callout for burst pipes and major leaks. Standard rates weekdays 8–6.' },
      { q: 'Are you Gas Safe?', a: 'Yes — Gas Safe registered. We can show our card on arrival.' },
      { q: 'Do you give free quotes?', a: 'Yes — for work over $300 we provide a free written quote before starting.' },
      { q: 'Is the work guaranteed?', a: '12 months on workmanship. Manufacturer warranty on any parts supplied.' },
      { q: 'Can you do small jobs?', a: 'Absolutely — dripping taps, running toilets, loose pipes. No job too small.' },
      { q: 'Do you clean up after?', a: 'Always — we leave your home cleaner than we found it.' },
    ],
    pricing: [
      { name: 'Callout',      price: 85,  period: 'per visit', features: ['Up to 1 hour', 'Diagnosis + quote', 'Parts separate'] },
      { name: 'Boiler service', price: 95,  period: 'per year',  features: ['Full service', 'Efficiency test', 'Certificate'], highlighted: true },
      { name: 'Emergency',    price: 120, period: 'per callout', features: ['24/7 response', '1 hour max arrival', 'Weekend same rate'] },
    ],
    gallery: ['On the job', 'Bathroom work', 'Boiler fit', 'Kitchen install', 'Van', 'Our team'],
  },

  cleaner: {
    teamRoles: ['Cleaning Manager', 'Senior Cleaner', 'Cleaner'],
    services: [
      { name: 'Regular house clean',    description: 'Weekly or fortnightly clean. Same team each time, trusted and insured.', duration: 180, price: 90, highlighted: true },
      { name: 'Deep clean',             description: 'Top-to-bottom clean including inside appliances, skirting boards, light fittings.', duration: 360, price: 240 },
      { name: 'End-of-tenancy clean',   description: 'Complete move-out clean with deposit-back guarantee.', duration: 360, price: 280 },
      { name: 'Office cleaning',        description: 'After-hours office cleaning contracts. Customised checklist, per-visit billing.', duration: 120, price: 65 },
    ],
    faq: [
      { q: 'Are your cleaners insured?', a: 'Yes — public liability insurance covers every visit. All cleaners background-checked.' },
      { q: 'Do I need to be home?', a: 'Not necessarily. Many clients give us a key or smart-lock code — stored securely, rotated regularly.' },
      { q: 'What products do you use?', a: 'We supply eco-friendly, safe cleaning products. Happy to use yours on request.' },
      { q: 'Do you clean windows?', a: 'Interior windows included. Exterior available at extra cost (over-reach safety matters).' },
      { q: 'Cancellation policy?', a: 'Free cancellation with 24 hours notice. Same-day cancellation may incur a small fee.' },
      { q: 'Same cleaner every time?', a: 'Yes — we assign the same team to your home where possible, for trust and consistency.' },
    ],
    pricing: [
      { name: 'Weekly',     price: 75,  period: 'per clean', features: ['Same team', 'Own products', 'Insured'] },
      { name: 'Fortnightly', price: 90, period: 'per clean', features: ['Same team', 'Slightly deeper clean', 'Insured'], highlighted: true },
      { name: 'One-off',    price: 180, period: 'per clean', features: ['Deep clean', '3–4 cleaners', 'All products included'] },
    ],
    gallery: ['Before/after', 'Kitchens', 'Bathrooms', 'Living areas', 'Office', 'Our team'],
  },

  mechanic: {
    teamRoles: ['Master Mechanic', 'Senior Technician', 'Diagnostic Specialist'],
    services: [
      { name: 'Full service',           description: 'Oil, filters, inspection, brake check, diagnostic scan. Written report included.', duration: 120, price: 250, highlighted: true },
      { name: 'Interim service',        description: 'Oil + filter change + safety inspection. Best between annual services.', duration: 60, price: 130 },
      { name: 'Brake pads & discs',     description: 'Replace front or rear pads and discs with quality parts. Parts warranty included.', duration: 120, price: 320 },
      { name: 'Diagnostic scan',        description: 'Full OBD scan + mechanical inspection. Diagnose any warning light on your dash.', duration: 60, price: 85 },
    ],
    faq: [
      { q: 'Are you manufacturer-trained?', a: 'Yes — our team is trained across European and Asian marques. Warranties preserved.' },
      { q: 'Do you offer loan cars?', a: 'Complimentary courtesy cars available for services over $200 — book early.' },
      { q: 'How much is a quote?', a: 'Quotes are always free and written. We call you before any unexpected extra work.' },
      { q: 'Are parts warranted?', a: 'All parts come with 12-month or 12,000-mile manufacturer warranty, whichever comes first.' },
      { q: 'Do you do MOTs?', a: 'Yes — MOT testing station on-site with same-day turnaround.' },
      { q: 'Can I stay while you work?', a: 'Yes — waiting lounge with free coffee, Wi-Fi and live work viewing via camera.' },
    ],
    pricing: [
      { name: 'Interim service', price: 130, period: 'one-off', features: ['Oil + filter', 'Safety inspection', 'Written report'] },
      { name: 'Full service',    price: 250, period: 'one-off', features: ['Full fluid change', 'Brake + suspension check', 'Diagnostic scan'], highlighted: true },
      { name: 'Hourly labour',   price: 95,  period: 'per hour', features: ['Manufacturer-trained', 'Quality parts', '12-month warranty'] },
    ],
    gallery: ['Workshop', 'Courtesy car bay', 'Diagnostic ramp', 'Paint booth', 'Waiting lounge', 'Our team'],
  },

  // ──── Creative & freelancers ──────────────────────────────────────────────
  photographer: {
    teamRoles: ['Lead Photographer', 'Second Photographer', 'Editor'],
    services: [
      { name: 'Portrait session',       description: '90-minute portrait session in-studio or on-location. 10 retouched images delivered.', duration: 90, price: 350 },
      { name: 'Wedding coverage',       description: '8-hour full-day wedding coverage. Two photographers, 400+ edited images.', duration: 480, price: 2800, highlighted: true },
      { name: 'Event photography',      description: 'Up to 4 hours event coverage, same-day gallery preview.', duration: 240, price: 900 },
      { name: 'Branding shoot',         description: 'Half-day commercial photography for products, team or location. 30 edited images.', duration: 240, price: 1200 },
    ],
    faq: [
      { q: 'How long until we see photos?', a: 'Portrait galleries in 10 days, weddings in 6 weeks. Sneak previews within 48 hours.' },
      { q: 'Can we request specific shots?', a: 'Absolutely — we work from a pre-agreed shot list you help create.' },
      { q: 'What equipment do you use?', a: 'Full-frame mirrorless with redundant systems. Backup bodies and memory cards on every shoot.' },
      { q: 'Do you travel?', a: 'Yes — travel within 50km included. Beyond that, travel charged at cost.' },
      { q: 'Do you offer prints / albums?', a: 'Yes — archival prints, leather albums, wall art. View samples at our studio.' },
      { q: 'What if it rains on my wedding day?', a: 'We always have indoor and covered alternatives planned. Rain often produces the best photos.' },
    ],
    pricing: [
      { name: 'Portrait',   price: 350,  period: 'per session', features: ['90-minute shoot', '10 retouched images', 'Online gallery'] },
      { name: 'Wedding',    price: 2800, period: 'per wedding', features: ['8 hours coverage', 'Two photographers', '400+ edited images'], highlighted: true },
      { name: 'Event',      price: 900,  period: 'per event',   features: ['4 hours coverage', 'Same-day preview', 'Full gallery in 7 days'] },
    ],
    gallery: ['Studio', 'Wedding sample', 'Portrait sample', 'Event sample', 'Branding sample', 'Our team'],
  },

  event_planner: {
    teamRoles: ['Lead Planner', 'Senior Coordinator', 'Event Coordinator'],
    services: [
      { name: 'Consultation',           description: 'Free 45-minute consultation to understand your vision and advise next steps.', duration: 45, price: 0 },
      { name: 'Full planning',          description: 'End-to-end planning and day-of coordination for weddings and major events.', duration: 60, price: 4500, highlighted: true },
      { name: 'Month-of coordination',  description: 'You\u2019ve planned it — we manage the logistics from four weeks out and run the day.', duration: 60, price: 1800 },
      { name: 'Corporate event',        description: 'Conferences, product launches, team offsites. Venue, AV, catering, logistics.', duration: 60, price: 3500 },
    ],
    faq: [
      { q: 'How early should I book?', a: 'Weddings: 9–12 months. Corporate events: 3–6 months. We\u2019ll always tell you if we\u2019re too late to do our best work.' },
      { q: 'Do you work with my vendors?', a: 'Yes — your vendors or ours, whichever works. We coordinate with everyone on the day.' },
      { q: 'Can we pay in instalments?', a: 'Yes — 30% deposit, 40% three months out, balance one week before the event.' },
      { q: 'Are you insured?', a: 'Full public liability and professional indemnity. Copy of certificate on request.' },
      { q: 'What if the event is cancelled?', a: 'Our terms cover credit toward a future event in most situations. Force majeure clause is standard.' },
      { q: 'Will you run the actual day?', a: 'Yes — we\u2019re on-site from set-up to pack-down. You\u2019re never the point of contact for vendors.' },
    ],
    pricing: [
      { name: 'Coordination', price: 1800, period: 'per event', features: ['4-week runway', 'Vendor coordination', 'Day-of management'] },
      { name: 'Full planning', price: 4500, period: 'per event', features: ['End-to-end planning', 'Unlimited meetings', 'On-site team'], highlighted: true },
      { name: 'Corporate',    price: 3500, period: 'per event', features: ['Venue + AV + catering', 'On-site producer', 'Post-event report'] },
    ],
    gallery: ['Weddings', 'Corporate events', 'Product launches', 'Dinners', 'Set design', 'Our team'],
  },

  designer: {
    teamRoles: ['Creative Director', 'Senior Designer', 'Junior Designer'],
    services: [
      { name: 'Discovery call',         description: 'Free 30-minute call to understand your project and scope.', duration: 30, price: 0 },
      { name: 'Brand identity',         description: 'Logo, type, colour, guidelines. Everything you need to show up consistently.', duration: 60, price: 3500, highlighted: true },
      { name: 'Website design',         description: 'Design + build of a modern, responsive marketing site. CMS included.', duration: 60, price: 6500 },
      { name: 'Design retainer',        description: 'Ongoing design support — marketing assets, decks, social, iteration.', duration: 60, price: 2800 },
    ],
    faq: [
      { q: 'How long for a brand project?', a: 'Typically 4–6 weeks from kick-off to final files. We build in two rounds of revision.' },
      { q: 'Do I own the files?', a: 'Yes — full copyright transfers on final payment. We keep working files for 2 years.' },
      { q: 'What if I don\u2019t love the first round?', a: 'That\u2019s why we start with mood boards before full concepts. Communication is everything.' },
      { q: 'Can you do small things?', a: 'We prefer retainer work for small ongoing needs. Fewer re-briefs, better quality.' },
      { q: 'Do you code websites yourself?', a: 'Yes — in-house dev team. We design and build end to end.' },
      { q: 'Can I see case studies?', a: 'Absolutely — full portfolio at the discovery call. NDA on any not-yet-public work.' },
    ],
    pricing: [
      { name: 'Brand',    price: 3500, period: 'per project', features: ['Logo + guidelines', 'Two concept rounds', 'Full file handoff'] },
      { name: 'Website',  price: 6500, period: 'per project', features: ['Design + build', 'CMS included', '1-month support'], highlighted: true },
      { name: 'Retainer', price: 2800, period: 'per month', features: ['10 design hours', 'Priority slot', 'Same-day small tasks'] },
    ],
    gallery: ['Studio', 'Brand work', 'Web work', 'Print work', 'Moodboards', 'Our team'],
  },

  // ──── Pet services ────────────────────────────────────────────────────────
  pet_groomer: {
    teamRoles: ['Head Groomer', 'Senior Groomer', 'Groomer'],
    services: [
      { name: 'Bath & brush',           description: 'Bath, dry, brush-out, nail trim and ear clean. Ideal between full grooms.', duration: 45, price: 40 },
      { name: 'Full groom',             description: 'Bath, clip, style and finish. Breed-specific cuts done properly.', duration: 90, price: 75, highlighted: true },
      { name: 'De-shed treatment',      description: 'Specialist de-shedding for double-coated breeds. Reduces shed by up to 70%.', duration: 60, price: 65 },
      { name: 'Puppy first groom',      description: 'Gentle introduction to grooming for puppies under 6 months.', duration: 45, price: 45 },
    ],
    faq: [
      { q: 'How often should my dog be groomed?', a: 'Depends on coat — short-haired every 6–8 weeks, long-haired every 4–6.' },
      { q: 'Is grooming stressful?', a: 'We use force-free, patient handling. Anxious dogs get extra time and breaks.' },
      { q: 'Do you do cats?', a: 'Selected salons have cat-certified groomers. Ask at booking.' },
      { q: 'Can I stay while you groom?', a: 'You\u2019re welcome to during induction. After that, most dogs settle better without their person present.' },
      { q: 'Vaccination requirements?', a: 'All dogs need up-to-date core vaccinations. We\u2019ll ask to see proof at the first visit.' },
      { q: 'What if my dog has never been groomed?', a: 'Book the puppy first groom — designed for exactly this situation. Lots of treats and patience.' },
    ],
    pricing: [
      { name: 'Bath',      price: 40, period: 'per visit', features: ['Bath + dry', 'Brush out', 'Nails + ears'] },
      { name: 'Full groom', price: 75, period: 'per visit', features: ['Bath + style', 'Breed-specific finish', 'Nails + ears'], highlighted: true },
      { name: 'De-shed',   price: 65, period: 'per visit', features: ['Specialist treatment', 'Double-coat brands', 'Up to 70% less shed'] },
    ],
    gallery: ['Salon', 'Before/after', 'Grooming station', 'Drying area', 'Product wall', 'Our groomers'],
  },

  dog_trainer: {
    teamRoles: ['Head Trainer', 'Senior Trainer', 'Puppy Trainer'],
    services: [
      { name: 'Behaviour consultation', description: '90-minute home visit to diagnose a specific issue and design a plan.', duration: 90, price: 180 },
      { name: '1-on-1 training',        description: 'One-to-one training tailored to your dog\u2019s needs. Five-session packages available.', duration: 60, price: 85, highlighted: true },
      { name: 'Puppy classes',          description: '6-week group classes for puppies aged 8–20 weeks. Socialisation + foundations.', duration: 60, price: 180 },
      { name: 'Day training',           description: 'We train your dog during the day — you learn the handover in the evenings.', duration: 480, price: 120 },
    ],
    faq: [
      { q: 'What methods do you use?', a: 'Positive-reinforcement only. Evidence-based, ethical, no harsh tools.' },
      { q: 'Do you work with reactive dogs?', a: 'Yes — our head trainer specialises in reactivity. Behaviour consultation first.' },
      { q: 'How many sessions will I need?', a: 'Puppies: 6–8 weeks of group classes. Specific issues: 3–6 private sessions typically.' },
      { q: 'Do you come to me?', a: 'Yes — home visits for behaviour work. Some training is better in-home, some at our training field.' },
      { q: 'Will my dog actually listen?', a: 'With consistency on your side, yes. We train owners as much as dogs.' },
      { q: 'What if I\u2019m struggling?', a: 'Video support between sessions is included. Don\u2019t wait for things to get worse.' },
    ],
    pricing: [
      { name: '1-on-1',     price: 85,  period: 'per session', features: ['60-min tailored training', 'Written plan', 'Video follow-up'] },
      { name: '5-pack',     price: 400, period: 'package',     features: ['Five 1-on-1 sessions', 'Save $25', 'Flexible booking'], highlighted: true },
      { name: 'Puppy class', price: 180, period: '6 weeks',    features: ['Group socialisation', 'Basic obedience', 'Certificate on completion'] },
    ],
    gallery: ['Training field', 'Class session', 'Puppy group', 'Agility setup', 'Reception', 'Our trainers'],
  },

  // ──── Mental health (remaining) ───────────────────────────────────────────
  therapist: {
    teamRoles: ['Senior Therapist', 'Therapist', 'Associate Therapist'],
    services: [
      { name: 'Initial session',        description: 'First 50-minute session — gentle intake, your story, goals, and a plan forward.', duration: 50, price: 120 },
      { name: 'Weekly therapy',         description: 'Ongoing weekly sessions. Steady, structured progress at your pace.', duration: 50, price: 110, highlighted: true },
      { name: 'Couples counselling',    description: 'Supported conversations for partners — communication, conflict, connection.', duration: 75, price: 160 },
      { name: 'Brief intervention',     description: '6-session focused programme for a specific issue — anxiety, grief, life change.', duration: 50, price: 620 },
    ],
    faq: [
      { q: 'Is this confidential?', a: 'Yes — subject only to the legal limits explained in your first session.' },
      { q: 'How often should we meet?', a: 'Weekly is typical. Some clients come fortnightly once things stabilise.' },
      { q: 'Online or in-person?', a: 'Both offered. Many clients mix — in-person for important sessions, online for convenience.' },
      { q: 'What if we\u2019re not a fit?', a: 'We\u2019ll talk about it openly and I can refer you to a colleague. Finding the right fit matters.' },
      { q: 'Do you take insurance?', a: 'We work with many plans. Bring your details to the first session and we\u2019ll confirm.' },
      { q: 'Will medication be recommended?', a: 'Therapy is non-medical, but we coordinate with your GP where medication may help.' },
    ],
    pricing: [
      { name: 'Weekly',       price: 110, period: 'per session', features: ['50-minute session', 'Consistent slot', 'Session notes'] },
      { name: 'Intensive',    price: 620, period: '6 sessions',  features: ['Focused programme', 'Save $40', 'Weekly meetings'], highlighted: true },
      { name: 'Couples',      price: 160, period: 'per session', features: ['75-min session', 'Both partners', 'Structured approach'] },
    ],
    gallery: ['Clinic', 'Consulting room', 'Waiting area', 'Online setup', 'Reception', 'Our team'],
  },

  life_coach: {
    teamRoles: ['Head Coach', 'Senior Coach', 'Associate Coach'],
    services: [
      { name: 'Discovery call',         description: 'Free 30-minute call to explore fit and define what success looks like.', duration: 30, price: 0 },
      { name: 'Single session',         description: '75-minute focused coaching on a specific goal or decision.', duration: 75, price: 150 },
      { name: '12-week programme',      description: 'Structured coaching engagement with weekly sessions, homework and accountability.', duration: 60, price: 1500, highlighted: true },
      { name: 'Executive coaching',     description: 'Leadership coaching for senior professionals. Monthly sessions over 6 months.', duration: 60, price: 3600 },
    ],
    faq: [
      { q: 'How is coaching different from therapy?', a: 'Therapy looks backward to heal; coaching looks forward to act. Some clients do both.' },
      { q: 'What results can I expect?', a: 'Clarity, habits, decisions and measurable progress on specific goals. We agree metrics upfront.' },
      { q: 'Is it confidential?', a: 'Yes — all sessions are confidential. Coaching relationships work on trust and openness.' },
      { q: 'How often should we meet?', a: 'Weekly for 12 weeks is our standard. Monthly works for maintenance and executive clients.' },
      { q: 'Is this online?', a: 'Mostly online via video — works well for coaching. In-person available for local clients.' },
      { q: 'Can I try one session first?', a: 'Yes — single sessions are available. The 12-week programme discount only applies to full enrolment.' },
    ],
    pricing: [
      { name: 'Session',    price: 150, period: 'per session', features: ['75-min session', 'No commitment', 'Session notes'] },
      { name: '12-week',    price: 1500, period: 'package',   features: ['12 weekly sessions', 'Accountability check-ins', 'Save $300'], highlighted: true },
      { name: 'Executive',  price: 3600, period: '6 months',  features: ['Monthly sessions', 'Leadership focus', 'WhatsApp support'] },
    ],
    gallery: ['Office', 'Coaching room', 'Reception', 'Meeting space', 'Library', 'Our coaches'],
  },

  // ──── Corporate ───────────────────────────────────────────────────────────
  hr_interviews: {
    teamRoles: ['Head of Talent', 'Senior Recruiter', 'Talent Partner'],
    services: [
      { name: 'Screening call',         description: '30-minute first-round phone screen. Basic fit check and Q&A.', duration: 30, price: 0 },
      { name: 'Technical interview',    description: '60-minute structured technical interview. Detailed feedback in 48 hours.', duration: 60, price: 0 },
      { name: 'Onsite loop',            description: 'Half-day on-site panel interview. Multiple rounds + lunch with team.', duration: 240, price: 0 },
      { name: 'Offer discussion',       description: 'Final conversation to walk through the offer and answer questions.', duration: 45, price: 0 },
    ],
    faq: [
      { q: 'How do I prepare?', a: 'We send a detailed prep guide with the invite. Review the role, our mission, and come with questions.' },
      { q: 'What should I wear?', a: 'Business casual is our norm. If we\u2019re a traditional client, we\u2019ll say so in the invite.' },
      { q: 'Will I meet the team?', a: 'Onsite loop includes 1:1s with peers and manager, plus lunch with the team.' },
      { q: 'When will I hear back?', a: 'Within 3 business days of each stage. We believe in fast feedback loops.' },
      { q: 'Can I reschedule?', a: 'Absolutely — use your calendar link or reply to the invite. We\u2019re flexible.' },
      { q: 'Do you do remote interviews?', a: 'Yes — Zoom or Teams. Same rigor, no travel.' },
    ],
    pricing: [
      { name: 'Screening',  price: 0, period: 'first call',  features: ['30 minutes', 'Fit check', 'Your questions answered'] },
      { name: 'Full loop',  price: 0, period: 'interview day', features: ['Panel interviews', '1:1s with peers', 'Team lunch'], highlighted: true },
      { name: 'Final round', price: 0, period: 'final stage', features: ['Leadership meeting', 'Offer discussion', 'Fast turnaround'] },
    ],
    gallery: ['Office', 'Interview room', 'Team space', 'Reception', 'Collaboration area', 'Our team'],
  },

  saas_demo: {
    teamRoles: ['Sales Engineer', 'Account Executive', 'Solutions Consultant'],
    services: [
      { name: 'Intro call',             description: '20-minute discovery. Understand your use case and align on next steps.', duration: 20, price: 0 },
      { name: 'Product demo',            description: 'Tailored 30-minute demo focused on your specific workflow and goals.', duration: 30, price: 0, highlighted: true },
      { name: 'Technical deep-dive',     description: '45-minute session for engineering teams. Architecture, API, security.', duration: 45, price: 0 },
      { name: 'Pilot kickoff',          description: '60-minute session to set up a 30-day pilot with success criteria.', duration: 60, price: 0 },
    ],
    faq: [
      { q: 'How long is a typical demo?', a: 'We aim for 30 minutes — focused on your use case, not a 90-minute feature tour.' },
      { q: 'Who should attend?', a: 'Whoever will use or buy it. We can run different sessions for buyers vs users.' },
      { q: 'Is it free?', a: 'Yes — discovery, demo, pilot kickoff are always free. Only pay when you subscribe.' },
      { q: 'Can we do a pilot?', a: 'Yes — 30-day pilots are standard with a dedicated solutions consultant.' },
      { q: 'What if we\u2019re just exploring?', a: 'That\u2019s fine. We\u2019d rather be honest about fit than push a bad match.' },
      { q: 'Do you integrate with our tools?', a: 'Most modern stacks, yes. The deep-dive covers your specific environment.' },
    ],
    pricing: [
      { name: 'Demo',      price: 0, period: 'free', features: ['30 minutes', 'Tailored to your use case', 'Q&A'] },
      { name: 'Pilot',     price: 0, period: '30 days', features: ['Full platform access', 'Dedicated SE', 'Success criteria'], highlighted: true },
      { name: 'Deep-dive', price: 0, period: 'free', features: ['For engineering', 'Architecture review', 'API walkthrough'] },
    ],
    gallery: ['Office', 'Demo room', 'Product shots', 'Conference', 'Customer team', 'Our team'],
  },
};

const PREMIUM_WEB_CONTENT = {
  corporate: {
    teamRoles: ['Strategy Lead', 'Client Partner', 'Delivery Lead'],
    services: [
      { name: 'Positioning & Company Story', description: 'Clarify who you serve, what you solve, why you are credible and what decision visitors should make next.', duration: 60, price: 2500, highlighted: true },
      { name: 'Service & Sector Pathways', description: 'Turn broad capabilities into buyer-friendly routes for services, sectors, proof and contact.', duration: 90, price: 4200 },
      { name: 'Proof & Case Study System', description: 'Build the evidence layer serious buyers expect: outcomes, process notes, leadership credibility and metrics.', duration: 90, price: 5000 },
    ],
    testimonials: [
      { name: 'Rebecca Lane', role: 'Operations Director', rating: 5, text: 'The new structure made our offer easier to understand and gave prospects a reason to contact us with better context.' },
      { name: 'Arun Mehta', role: 'Founder', rating: 5, text: 'It finally felt like a serious company website: clear services, stronger proof and a sharper enquiry path.' },
      { name: 'Clara Hughes', role: 'Head of Growth', rating: 5, text: 'The case-study flow helped buyers validate our credibility before the first call.' },
    ],
    faq: [
      { q: 'What should a premium company website include?', a: 'Clear positioning, service or sector pathways, proof, leadership credibility, useful FAQs and an enquiry form matched to the buying decision.' },
      { q: 'How much proof is enough?', a: 'Use fewer, stronger proof points: specific outcomes, named sectors, process detail and realistic expectations outperform generic claims.' },
      { q: 'Can this support future pages?', a: 'Yes. The structure can expand into case studies, resources, hiring pages and sector pages as the company grows.' },
      { q: 'What should visitors include in an enquiry?', a: 'Company name, goal, audience, decision stage, timeline, budget range if known and the right contact person.' },
    ],
    pricing: [
      { name: 'Messaging Sprint', price: 2500, period: 'from', features: ['Positioning review', 'Homepage narrative', 'CTA and proof plan'] },
      { name: 'Corporate Site System', price: 6500, period: 'from', features: ['Service pathways', 'Proof structure', 'Enquiry flow'], highlighted: true },
      { name: 'Growth Content Layer', price: 3200, period: 'from', features: ['Case-study framework', 'Resource plan', 'Leadership credibility'] },
    ],
    gallery: ['Leadership story', 'Service pathways', 'Case study proof', 'Client sectors', 'Process map', 'Enquiry workflow'],
  },
  architect: {
    teamRoles: ['Principal Architect', 'Project Architect', 'Studio Operations Lead'],
    team: [
      {
        name: 'Elena Marlow',
        role: 'Principal Architect',
        bio: 'Leads the studio vision, feasibility strategy and client decision-making from early site questions through design direction.',
      },
      {
        name: 'Noah Sato',
        role: 'Project Architect',
        bio: 'Coordinates concept development, planning inputs, consultant notes and documentation so design intent survives delivery.',
      },
      {
        name: 'Priya Nair',
        role: 'Studio Operations Lead',
        bio: 'Keeps enquiries, project stages, meeting notes and client handover organised so complex projects feel legible.',
      },
    ],
    services: [
      { name: 'Feasibility & Site Intelligence', description: 'Test site constraints, planning risk, budget direction, orientation and project viability before committing to full design.', duration: 60, price: 1200, highlighted: true, features: ['Site constraints', 'Planning risk', 'Budget direction'] },
      { name: 'Concept Architecture', description: 'Translate the brief into spatial options, massing, material direction and a clear design narrative for client decisions.', duration: 90, price: 4800, features: ['Spatial options', 'Concept narrative', 'Material direction'] },
      { name: 'Planning, Permits & Consultant Coordination', description: 'Coordinate planning inputs, consultant scopes, authority requirements and the approvals path around the chosen concept.', duration: 90, price: 6200, features: ['Planning pathway', 'Consultant notes', 'Approval support'] },
      { name: 'Documentation & Construction Support', description: 'Prepare drawing sets, details, schedules and construction-stage support that protects design intent through delivery.', duration: 120, price: 9500, features: ['Drawing set', 'Details and schedules', 'Site-stage support'] },
    ],
    testimonials: [
      { name: 'Mira Collins', role: 'Residential Client', rating: 5, text: 'The feasibility stage gave us confidence before drawings began. We understood the site, budget pressure and the design choices clearly.' },
      { name: 'Jon Bell', role: 'Developer', rating: 5, text: 'The studio made planning risk and project potential visible early enough for us to make a commercially sound decision.' },
      { name: 'Nadia Singh', role: 'Retail Client', rating: 5, text: 'They balanced atmosphere, compliance and budget without losing the intent that made the space special.' },
      { name: 'Avery Stone', role: 'Renovation Client', rating: 5, text: 'Every stage had a purpose: brief, concept, consultants, documentation and builder conversations all felt connected.' },
    ],
    faq: [
      { q: 'When should I contact an architect?', a: 'Start early, ideally before drawings, permits, builder quotes or a final site purchase. Feasibility can prevent expensive wrong turns.' },
      { q: 'Can you help before we own the site?', a: 'Yes. A pre-purchase or early feasibility review can test constraints, planning risk, orientation, access, budget and likely project scope.' },
      { q: 'What makes a strong project enquiry?', a: 'Share the site address or area, project type, current stage, planning status, budget range, target timeline and any drawings or title information.' },
      { q: 'Do you coordinate consultants?', a: 'The studio can coordinate engineers, planners, surveyors, quantity surveyors and other consultants as the stage requires.' },
      { q: 'Can you work with our builder?', a: 'Yes, once the project stage and procurement route are clear. Documentation and construction support can help keep the design intent aligned on site.' },
      { q: 'How are fees scoped?', a: 'Fees depend on project type, stage, complexity and consultant needs. Early work is often scoped as feasibility, concept, approvals and documentation phases.' },
    ],
    pricing: [
      { name: 'Feasibility Study', price: 1200, period: 'from', features: ['Site and brief review', 'Constraint summary', 'Stage recommendation'] },
      { name: 'Concept Package', price: 4800, period: 'from', features: ['Brief workshop', 'Spatial options', 'Material direction'], highlighted: true },
      { name: 'Documentation Stage', price: 9500, period: 'from', features: ['Drawing set', 'Consultant coordination', 'Construction support options'] },
    ],
    gallery: ['Featured residential project', 'Site analysis study', 'Concept sketch wall', 'Material and detail palette', 'Planning documentation set', 'Construction-stage review'],
  },
  real_estate: {
    teamRoles: ['Lead Listing Agent', 'Buyer Advisor', 'Market Campaign Manager'],
    team: [
      {
        name: 'Amelia Hart',
        role: 'Lead Listing Agent',
        bio: 'Guides sellers through valuation, pricing, preparation, campaign choices and negotiation with suburb-level evidence.',
      },
      {
        name: 'Marcus Lee',
        role: 'Buyer Advisor',
        bio: 'Helps buyers clarify suburbs, budgets, must-haves, inspection focus and offer timing before they move.',
      },
      {
        name: 'Sofia Patel',
        role: 'Market Campaign Manager',
        bio: 'Coordinates listing assets, open-home follow-up, buyer feedback and fast response loops for serious enquiries.',
      },
    ],
    services: [
      { name: 'Seller Valuation & Campaign Plan', description: 'Street-level price guidance, presentation priorities, buyer demand signals and campaign options for owners considering a move.', duration: 45, price: 0, highlighted: true, features: ['Street-level estimate', 'Presentation advice', 'Campaign route'] },
      { name: 'Pre-Market Seller Strategy', description: 'Assess timing, off-market buyer match, preparation work and launch readiness before committing to a listing campaign.', duration: 45, price: 0, features: ['Timing options', 'Buyer demand', 'Off-market plan'] },
      { name: 'Buyer Brief & Showing Plan', description: 'Clarify budget, target suburbs, must-haves, inspection focus and offer readiness so buyer enquiries become useful conversations.', duration: 45, price: 0, features: ['Search criteria', 'Inspection plan', 'Offer readiness'] },
      { name: 'Investor Market Review', description: 'Discuss yield, rental demand, suburb risk, vacancy signals and portfolio fit before the next acquisition.', duration: 60, price: 300, features: ['Yield discussion', 'Rental demand', 'Risk context'] },
    ],
    testimonials: [
      { name: 'Eleanor Price', role: 'Home Seller', rating: 5, text: 'The valuation was specific to our street, not generic. We understood timing, price range, presentation work and campaign options.' },
      { name: 'Sam Wu', role: 'Buyer', rating: 5, text: 'The buyer brief helped us compare properties with clearer questions before inspections and offers.' },
      { name: 'Ava Martin', role: 'Investor', rating: 5, text: 'The advice covered rental demand, yield pressure, suburb risk and next steps in plain language.' },
      { name: 'Noah Bennett', role: 'Downsizer', rating: 5, text: 'They made the selling decision feel manageable by showing what mattered now and what could wait.' },
    ],
    faq: [
      { q: 'Can I request a valuation online?', a: 'Yes. Share the address or suburb, property type, condition, recent upgrades, timeframe and preferred contact method.' },
      { q: 'What makes a strong seller enquiry?', a: 'Include the address, ownership stage, target timeframe, price expectations if known, presentation concerns and whether you want an appraisal or campaign plan.' },
      { q: 'Do you help buyers too?', a: 'Yes. Send budget, finance status, target suburbs, property type, must-haves, deal-breakers and when you want to inspect.' },
      { q: 'Can you arrange a showing?', a: 'Yes. Include the listing, preferred times, finance position and any questions you need answered before the inspection.' },
      { q: 'Can you advise investors?', a: 'Yes. Include goals, budget, target yield, current portfolio context, risk tolerance and preferred suburbs.' },
      { q: 'Do you provide market reports?', a: 'Yes. Market reports work best when tied to a suburb, property type and decision: sell, buy, refinance, hold or invest.' },
    ],
    pricing: [
      { name: 'Home Valuation', price: 0, period: 'request', features: ['Street-level context', 'Price guidance', 'Next-step advice'] },
      { name: 'Seller Campaign Plan', price: 0, period: 'request', features: ['Preparation priorities', 'Launch route', 'Buyer demand signals'], highlighted: true },
      { name: 'Investor Review', price: 300, period: 'from', features: ['Yield discussion', 'Rental demand', 'Portfolio fit'] },
    ],
    gallery: ['Featured listing presentation', 'Suburb market snapshot', 'Open-home follow-up', 'Street-level valuation proof', 'Campaign asset suite', 'Buyer brief conversation'],
  },
  marketing_agency: {
    teamRoles: ['Strategy Director', 'Creative Director', 'Performance Lead'],
    team: [
      {
        name: 'Maya Chen',
        role: 'Strategy Director',
        bio: 'Leads discovery, positioning, audience diagnosis and campaign architecture before creative or media spend begins.',
      },
      {
        name: 'Theo Grant',
        role: 'Creative Director',
        bio: 'Turns offers, proof and buyer objections into landing pages, messaging systems and campaign assets that stay coherent.',
      },
      {
        name: 'Rina Kapoor',
        role: 'Performance Lead',
        bio: 'Connects tracking, acquisition, CRO experiments and reporting so campaign decisions are tied to lead quality.',
      },
    ],
    services: [
      { name: 'Positioning & Demand Strategy', description: 'Clarify audience, offer, message, proof, channel fit and conversion path before spend or creative production.', duration: 90, price: 4500, highlighted: true, features: ['Audience diagnosis', 'Offer messaging', 'Channel plan'] },
      { name: 'Case Study & Offer Messaging', description: 'Turn outcomes, proof points and buyer objections into homepage, service-page and sales-enablement copy that reduces risk.', duration: 75, price: 3200, features: ['Proof extraction', 'Case study structure', 'Sales copy'] },
      { name: 'Campaign Launch System', description: 'Build landing pages, ads, email, social assets and reporting setup around one measurable campaign idea.', duration: 90, price: 8500, features: ['Landing page', 'Creative assets', 'Tracking setup'] },
      { name: 'Paid Acquisition & CRO Retainer', description: 'Launch, optimize and report on paid campaigns with experiments tied to pipeline quality, not only traffic.', duration: 60, price: 3500, features: ['Media optimisation', 'CRO tests', 'Lead-quality reporting'] },
    ],
    testimonials: [
      { name: 'Lena Ortiz', role: 'CMO', rating: 5, text: 'The team connected positioning, creative and reporting so every campaign decision had a commercial reason.' },
      { name: 'Ben Foster', role: 'Founder', rating: 5, text: 'We stopped buying random tactics and finally had a clear campaign system with proof our sales team could use.' },
      { name: 'Nikhil Rao', role: 'Growth Lead', rating: 5, text: 'The reporting gave us decisions, not just dashboards. We could see which leads were worth chasing.' },
      { name: 'Claire Morgan', role: 'Revenue Director', rating: 5, text: 'They challenged the brief in the right places and sharpened the offer before we spent on media.' },
    ],
    faq: [
      { q: 'What should I include in a campaign enquiry?', a: 'Share the offer, audience, current channels, budget range, timeline, target metric, sales cycle and what has or has not worked.' },
      { q: 'Can you help with positioning first?', a: 'Yes. A strategy sprint can sharpen audience, message, offer, proof and conversion path before creative or media spend.' },
      { q: 'Do you write case studies?', a: 'Yes. Case-study work can extract the problem, intervention, measurable outcome and objections it helps future buyers overcome.' },
      { q: 'Do you report on results?', a: 'Yes. Reporting should connect spend, traffic, conversion rate, lead quality, pipeline movement and the next decision.' },
      { q: 'Can you work with our internal team?', a: 'Yes. The agency can support strategy, campaign architecture, creative systems, paid media or reporting alongside internal marketers.' },
      { q: 'Do you work as a retainer?', a: 'Campaign and growth retainers are available once goals, channel mix, budget, reporting cadence and decision ownership are clear.' },
    ],
    pricing: [
      { name: 'Strategy Sprint', price: 4500, period: 'from', features: ['Audience diagnosis', 'Messaging direction', 'Campaign path'] },
      { name: 'Campaign Launch', price: 8500, period: 'from', features: ['Landing page', 'Creative assets', 'Tracking setup'], highlighted: true },
      { name: 'Growth Retainer', price: 3500, period: 'per month', features: ['Optimisation', 'Reporting', 'Monthly experiments'] },
    ],
    gallery: ['Positioning workshop', 'Case-study proof system', 'Landing page conversion path', 'Campaign creative set', 'Lead-quality dashboard', 'Experiment planning board'],
  },
  online_courses: {
    teamRoles: ['Lead Instructor', 'Learning Designer', 'Learner Success Lead'],
    team: [
      {
        name: 'Ariana Cole',
        role: 'Lead Instructor',
        bio: 'Teaches the core framework and connects each lesson to a practical deliverable learners can use outside the course.',
      },
      {
        name: 'Dev Malik',
        role: 'Learning Designer',
        bio: 'Structures modules, exercises, checkpoints and resources so learners understand the path and effort before enrolling.',
      },
      {
        name: 'June Park',
        role: 'Learner Success Lead',
        bio: 'Supports onboarding, office hours, feedback loops and progress check-ins for students and team cohorts.',
      },
    ],
    services: [
      { name: 'Self-Paced Foundation Course', description: 'A structured curriculum for independent learners with clear outcomes, module previews, practice tasks and downloadable resources.', duration: 60, price: 499, highlighted: true, features: ['Module preview', 'Practice tasks', 'Resource library'] },
      { name: 'Live Cohort Programme', description: 'Guided sessions, deadlines, peer accountability, office hours and feedback moments for learners who need momentum.', duration: 90, price: 1400, features: ['Live sessions', 'Office hours', 'Feedback loop'] },
      { name: 'Implementation Lab', description: 'Project-based support for learners who want to apply the framework to a real deliverable with instructor review.', duration: 90, price: 2200, features: ['Project brief', 'Review session', 'Action plan'] },
      { name: 'Team Training Pathway', description: 'Private training for companies with tailored examples, attendance reporting and practical implementation support.', duration: 120, price: 4200, features: ['Private cohort', 'Tailored examples', 'Progress report'] },
    ],
    testimonials: [
      { name: 'Maya Green', role: 'Learner', rating: 5, text: 'I knew the outcome, the modules and the support model before I enrolled, so the first week felt focused.' },
      { name: 'Owen Carter', role: 'Team Lead', rating: 5, text: 'The training gave our team a shared language and practical assignments we could use immediately.' },
      { name: 'Fatima Noor', role: 'Student', rating: 5, text: 'The curriculum preview helped me choose the right level and avoid guessing whether I was ready.' },
      { name: 'Lucas Meyer', role: 'Career Switcher', rating: 5, text: 'The implementation lab turned lessons into a portfolio-ready project with feedback I could act on.' },
    ],
    faq: [
      { q: 'Who is the course for?', a: 'Each course should explain the starting level, target outcome, prerequisites, expected effort and the learner who is not a fit.' },
      { q: 'What will I be able to do after the course?', a: 'Strong course pages state action-oriented outcomes and the deliverables learners leave with, not only topics covered.' },
      { q: 'Can I preview the curriculum?', a: 'Yes. A curriculum preview should show modules, lesson themes, practice tasks, time commitment and any bonus resources.' },
      { q: 'Is the course self-paced or live?', a: 'Course details should explain whether learning is self-paced, cohort-based, workshop-led, project-based or private training.' },
      { q: 'What support is included?', a: 'List feedback, community, office hours, templates, instructor access, response expectations and how learners get unstuck.' },
      { q: 'Can teams enrol?', a: 'Yes. Team training can include tailored examples, attendance reporting, private workshops and implementation support.' },
    ],
    pricing: [
      { name: 'Self-Paced Course', price: 499, period: 'from', features: ['Modules', 'Assignments', 'Templates'] },
      { name: 'Live Cohort', price: 1400, period: 'from', features: ['Live sessions', 'Feedback', 'Community'], highlighted: true },
      { name: 'Team Training', price: 4200, period: 'from', features: ['Private cohort', 'Tailored examples', 'Progress report'] },
    ],
    gallery: ['Outcome-led curriculum map', 'Module preview screen', 'Live cohort workshop', 'Learner progress dashboard', 'Downloadable templates', 'Student project showcase'],
  },
  designer: {
    teamRoles: ['Creative Director', 'Brand Systems Designer', 'Digital Experience Designer'],
    team: [
      {
        name: 'Iris Vale',
        role: 'Creative Director',
        bio: 'Leads creative direction, concept selection, review discipline and the strategic reason behind each visual route.',
      },
      {
        name: 'Marco Silva',
        role: 'Brand Systems Designer',
        bio: 'Builds identity systems, logo suites, type, colour, usage rules and launch assets that survive real team use.',
      },
      {
        name: 'Noah Stein',
        role: 'Digital Experience Designer',
        bio: 'Designs responsive marketing sites, product screens, prototypes and handoff notes for smooth implementation.',
      },
    ],
    services: [
      { name: 'Brand Identity System', description: 'Logo suite, visual language, type, colour, guidelines and launch assets designed to survive real use.', duration: 90, price: 4500, highlighted: true, features: ['Logo suite', 'Guidelines', 'Launch assets'] },
      { name: 'Case Study & Portfolio Direction', description: 'Curate the strongest work, shape project narratives, write rationale and build a portfolio system around quality over volume.', duration: 75, price: 3200, features: ['Work audit', 'Case-study structure', 'Portfolio flow'] },
      { name: 'Website & Interface Design', description: 'Marketing sites, product screens and landing pages with journeys, responsive states, prototypes and handoff notes considered.', duration: 90, price: 7500, features: ['Page structure', 'Responsive UI', 'Prototype'] },
      { name: 'Creative Retainer', description: 'Ongoing campaign, content and brand-governance support for teams that need reliable design velocity.', duration: 60, price: 3200, features: ['Campaign assets', 'Priority queue', 'Brand governance'] },
    ],
    testimonials: [
      { name: 'Iris Cole', role: 'Brand Lead', rating: 5, text: 'The studio gave us a visual system that felt distinctive and was easy for our team to keep using.' },
      { name: 'Marco Silva', role: 'Founder', rating: 5, text: 'The design work had taste, but also a clear commercial reason behind each decision and deliverable.' },
      { name: 'Noah Stein', role: 'Product Lead', rating: 5, text: 'The responsive interface work removed ambiguity before development began.' },
      { name: 'Leah Brooks', role: 'Marketing Director', rating: 5, text: 'The handoff was practical: files, rules, usage examples and launch assets were ready for the team.' },
    ],
    faq: [
      { q: 'Can we start with a small brief?', a: 'Yes. A focused brief can define goal, audience, deliverables, timeline, budget and whether the studio is the right fit.' },
      { q: 'Do you provide guidelines?', a: 'Yes. Brand projects can include practical guidelines, asset exports, usage examples and launch-ready files.' },
      { q: 'Do you design websites?', a: 'Yes. Website work can include structure, UI, responsive states, prototypes, component notes and handoff guidance.' },
      { q: 'Can you improve an existing brand?', a: 'Yes. A brand refresh can keep useful equity while improving consistency, clarity, assets and digital use.' },
      { q: 'What should I send first?', a: 'Share the business goal, audience, deliverables, existing assets, references, timeline, budget range and decision makers.' },
      { q: 'How many portfolio pieces should we show?', a: 'Fewer stronger projects usually work better than many thumbnails. Select work that proves range, depth, process and results.' },
    ],
    pricing: [
      { name: 'Brand System', price: 4500, period: 'from', features: ['Identity', 'Guidelines', 'Launch assets'], highlighted: true },
      { name: 'Website Design', price: 7500, period: 'from', features: ['Page structure', 'Responsive UI', 'Prototype'] },
      { name: 'Design Retainer', price: 3200, period: 'per month', features: ['Campaign assets', 'Priority queue', 'Brand governance'] },
    ],
    gallery: ['Hero case-study spread', 'Logo suite and variations', 'Responsive website design', 'Campaign asset system', 'Concept review wall', 'Brand guideline pages'],
  },
  dj: {
    teamRoles: ['Lead DJ', 'Event Producer', 'Technical Coordinator'],
    team: [
      {
        name: 'Kai Mercer',
        role: 'Lead DJ',
        bio: 'Shapes the music direction, reads the room and adapts the set around event moments, crowd response and must-play notes.',
      },
      {
        name: 'Lena Brooks',
        role: 'Event Producer',
        bio: 'Coordinates run sheets, planner communication, MC cues, venue timing and booking details before the event.',
      },
      {
        name: 'Theo Miles',
        role: 'Technical Coordinator',
        bio: 'Confirms PA, booth, lighting, power, rider notes and backup setup so the night runs without technical surprises.',
      },
    ],
    services: [
      { name: 'Private Event Set', description: 'Custom music direction, compact sound setup, crowd reading and timing support for parties and private celebrations.', duration: 120, price: 750, highlighted: true, features: ['Music brief', 'Sound setup', 'Crowd reading'] },
      { name: 'Wedding DJ & MC Package', description: 'Ceremony cues, reception set, dancefloor, MC support, run-sheet coordination and must-play planning for the full celebration.', duration: 300, price: 1800, features: ['Reception set', 'MC option', 'Run-sheet support'] },
      { name: 'Corporate & Brand Event Set', description: 'Clean edits, brand-safe music direction, arrival playlists, awards cues and professional venue communication.', duration: 180, price: 1400, features: ['Brand-safe music', 'Cue planning', 'Venue coordination'] },
      { name: 'Venue, Festival & Club Rider Set', description: 'Performance package with current mixes, stage timing, tech rider, booth requirements and promoter-ready press details.', duration: 180, price: 1600, features: ['Tech rider', 'Press kit', 'Stage timing'] },
    ],
    testimonials: [
      { name: 'Grace Bell', role: 'Bride', rating: 5, text: 'The music matched every part of the day, the MC cues were calm and the dance floor stayed full.' },
      { name: 'Theo King', role: 'Venue Manager', rating: 5, text: 'Professional setup, clear tech notes and exactly the energy the room needed.' },
      { name: 'Amelia Ross', role: 'Event Host', rating: 5, text: 'The brief was simple, the set was personal and the event flowed beautifully.' },
      { name: 'Nico Ward', role: 'Promoter', rating: 5, text: 'The rider, press kit and response time made the booking easy to confirm.' },
    ],
    faq: [
      { q: 'How do we check availability?', a: 'Send the date, city, venue, event type, guest count, timing window and whether you need DJ only, DJ/MC or full sound support.' },
      { q: 'Can we request specific songs?', a: 'Yes. Share must-play, do-not-play, genres, key moments and the atmosphere you want.' },
      { q: 'Do you bring equipment?', a: 'Sound and lighting options depend on the package and venue. Share venue details, PA availability, booth setup and power access.' },
      { q: 'Do you provide a tech rider?', a: 'Yes. Venue and promoter bookings can include a rider covering booth setup, mixer, decks, monitors, power, outputs and contact details.' },
      { q: 'Can you support corporate events?', a: 'Yes. Corporate sets can include clean edits, brand-safe playlists, run sheets, award cues and venue coordination.' },
      { q: 'What makes a booking enquiry useful?', a: 'Include date, city, venue, event type, guest count, timing, music preferences, setup needs, budget range and planner contact.' },
    ],
    pricing: [
      { name: 'Private Event', price: 750, period: 'from', features: ['Custom set', 'Sound setup', 'Brief call'], highlighted: true },
      { name: 'Wedding Package', price: 1800, period: 'from', features: ['Reception set', 'Timeline support', 'MC option'] },
      { name: 'Venue Set', price: 1600, period: 'from', features: ['Tech rider', 'Stage timing', 'Press kit'] },
    ],
    gallery: ['Packed dance floor', 'Wedding reception setup', 'Venue booth and lighting', 'Festival stage moment', 'Technical rider preview', 'Private event sound check'],
  },
  artist: {
    teamRoles: ['Artist', 'Studio Manager', 'Collector Liaison'],
    team: [
      { name: 'Elise Maren', role: 'Artist', bio: 'Develops the body of work, material process, commission direction and studio statement behind each collection.' },
      { name: 'Jonas Reid', role: 'Studio Manager', bio: 'Keeps artwork details, availability, shipping, framing, installation and commission timelines organised.' },
      { name: 'Mira Sol', role: 'Collector Liaison', bio: 'Handles collector, curator, interior designer, press and collaboration enquiries with the right context.' },
    ],
    services: [
      { name: 'Available Original Works', description: 'Artwork details, medium, scale, collection notes, availability and shipping context for collectors and curators.', duration: 45, price: 1200, highlighted: true, features: ['Medium and scale', 'Availability check', 'Shipping context'] },
      { name: 'Commissioned Artwork', description: 'Custom work shaped around space, scale, material direction, budget range, timeline and studio review process.', duration: 60, price: 3200, features: ['Space review', 'Concept direction', 'Studio timeline'] },
      { name: 'Exhibitions & Curatorial Requests', description: 'Gallery shows, installations, public art and curatorial enquiries with statement, CV, press and available-work context.', duration: 90, price: 0, features: ['Artist CV', 'Statement', 'Exhibition notes'] },
      { name: 'Interior & Collection Advisory', description: 'Support for collectors and designers comparing scale, placement, framing, installation and collection fit.', duration: 45, price: 350, features: ['Scale guidance', 'Placement notes', 'Collection fit'] },
    ],
    testimonials: [
      { name: 'Claire Morton', role: 'Collector', rating: 5, text: 'The commission process was thoughtful, well documented and beautifully communicated from brief to delivery.' },
      { name: 'Jules Harper', role: 'Curator', rating: 5, text: 'The work was presented with the context we needed: scale, medium, statement and availability.' },
      { name: 'Priya Das', role: 'Interior Designer', rating: 5, text: 'The studio made it easy to discuss space, scale, placement and installation.' },
      { name: 'Mara Ellis', role: 'Collector', rating: 5, text: 'Every work had the details I needed before asking about availability.' },
    ],
    faq: [
      { q: 'How do I ask about a specific piece?', a: 'Mention the artwork title, collection, medium or size if known, and whether you are buying, reserving or requesting details.' },
      { q: 'Are commissions available?', a: 'Use the enquiry to share the space, size, medium preference, timeline, location, delivery needs and budget range.' },
      { q: 'Can work be shipped?', a: 'Shipping depends on size, medium, framing and destination. Packaging, insurance and collection options can be confirmed before purchase.' },
      { q: 'Can galleries request a CV?', a: 'Yes. Curatorial enquiries can ask for artist CV, statement, press, available works and exhibition history.' },
      { q: 'Can you advise on scale and placement?', a: 'Yes. Share wall dimensions, room photos, lighting conditions, location and installation constraints.' },
      { q: 'Is pricing shown publicly?', a: 'Pricing can be shown, listed as from, or handled by enquiry depending on the artist, gallery relationship and work type.' },
    ],
    pricing: [
      { name: 'Available Works', price: 1200, period: 'from', features: ['Artwork details', 'Availability check', 'Shipping options'], highlighted: true },
      { name: 'Commission', price: 3200, period: 'from', features: ['Brief review', 'Concept direction', 'Studio timeline'] },
      { name: 'Exhibition Enquiry', price: 0, period: 'enquire', features: ['CV request', 'Portfolio context', 'Collaboration notes'] },
    ],
    gallery: ['Hero artwork with scale', 'Collection detail wall', 'Commission process study', 'Exhibition installation view', 'Material and surface study', 'Collector handoff package'],
  },
  writer_content: {
    teamRoles: ['Lead Writer', 'Editor', 'Content Strategist'],
    services: [
      { name: 'Website & Landing Page Copy', description: 'Messaging, page structure, proof and conversion copy for websites, services and launches.', duration: 90, price: 1800, highlighted: true },
      { name: 'Content Strategy & SEO', description: 'Editorial planning, content audits, topic systems and search-led briefs that still read naturally.', duration: 90, price: 2400 },
      { name: 'Brand Storytelling & Case Studies', description: 'Founder stories, customer stories, newsletters and long-form content with a distinct point of view.', duration: 90, price: 1600 },
    ],
    testimonials: [
      { name: 'Molly Hart', role: 'Founder', rating: 5, text: 'The copy finally explained what we do, why it matters and why clients should trust us.' },
      { name: 'Andre Lewis', role: 'Marketing Lead', rating: 5, text: 'The content strategy gave us useful topics, structure and editorial standards.' },
      { name: 'Sara Kim', role: 'Creator', rating: 5, text: 'The writing kept my voice but made the offer much clearer.' },
    ],
    faq: [
      { q: 'Can you help with messaging first?', a: 'Yes. A messaging phase can clarify audience, offer, proof and voice before writing pages or content.' },
      { q: 'Do you write SEO content?', a: 'Yes. Content can be planned around search intent while still sounding human and useful.' },
      { q: 'What should I include in a brief?', a: 'Share the audience, goal, deliverables, tone, examples, timeline, stakeholders and whether interviews are needed.' },
      { q: 'Can you write newsletters?', a: 'Yes. Newsletter work can include positioning, welcome sequence, editorial rhythm and issue writing.' },
    ],
    pricing: [
      { name: 'Messaging Sprint', price: 1200, period: 'from', features: ['Audience clarity', 'Offer language', 'Proof map'] },
      { name: 'Website Copy', price: 1800, period: 'from', features: ['Page copy', 'CTA structure', 'Revision round'], highlighted: true },
      { name: 'Content Strategy', price: 2400, period: 'from', features: ['Audit', 'Topic map', 'Brief templates'] },
    ],
    gallery: ['Editorial plan', 'Website copy', 'Case study interview', 'Newsletter issue', 'Content calendar', 'Messaging workshop'],
  },
  bar_pub: {
    teamRoles: ['Venue Manager', 'Bar Lead', 'Events Coordinator'],
    services: [
      { name: 'Drinks & Bar Menu', description: 'Cocktails, taps, wine, zero-proof options and seasonal specials kept easy to scan on mobile.', duration: 30, price: 12, highlighted: true },
      { name: 'Food & Shared Plates', description: 'Pub classics, snacks, shared plates, dietary notes and kitchen highlights for casual visits or groups.', duration: 45, price: 18 },
      { name: 'Private Functions', description: 'Birthdays, corporate drinks, sports nights, set menus and venue hire with capacity details.', duration: 120, price: 500 },
    ],
    testimonials: [
      { name: 'Hannah Moore', role: 'Guest', rating: 5, text: 'It was easy to check what was on, view the menu and book the right space for our group.' },
      { name: 'Chris Patel', role: 'Event Host', rating: 5, text: 'The function details were clear and the team handled our group smoothly.' },
      { name: 'Jamie Ellis', role: 'Local', rating: 5, text: 'Menu, hours, events and booking info were all exactly where I expected.' },
    ],
    faq: [
      { q: 'Do you take group bookings?', a: 'Yes. Include date, time, guest count, seating needs and whether food or drinks packages are required.' },
      { q: 'Where can guests see the menu?', a: 'The site should show current food and drink highlights, with PDFs avoided where possible on mobile.' },
      { q: 'Do you host private functions?', a: 'Yes. Share guest count, event type, preferred date, timing and any package or accessibility needs.' },
      { q: 'Are hours and events current?', a: 'Keep regular hours, holiday changes, live nights, sport and special events updated in the website content.' },
    ],
    pricing: [
      { name: 'Casual Visit', price: 0, period: 'walk in', features: ['Current hours', 'Menu highlights', 'Location details'] },
      { name: 'Group Booking', price: 0, period: 'enquire', features: ['Guest count', 'Seating request', 'Food notes'], highlighted: true },
      { name: 'Private Function', price: 500, period: 'from', features: ['Venue hire', 'Package options', 'Event coordinator'] },
    ],
    gallery: ['Bar counter', 'Signature drinks', 'Food menu', 'Live night', 'Private function', 'Venue exterior'],
  },
  ca_tax_consultant: {
    testimonials: [
      { name: 'Rohit Sharma', role: 'Founder', rating: 5, text: 'The checklist was clear, the documents were verified carefully and the filing status was easy to follow.' },
      { name: 'Ananya Mehta', role: 'Professional', rating: 5, text: 'The CA certificate process felt organised from enquiry to completion.' },
      { name: 'Vikram Iyer', role: 'Business Owner', rating: 5, text: 'GST and MCA steps were explained in plain language with no confusion about documents.' },
    ],
  },
  it_services: {
    testimonials: [
      { name: 'Oliver Grant', role: 'Operations Lead', rating: 5, text: 'Discovery translated a messy process into a build plan our team could actually approve.' },
      { name: 'Meera Kapoor', role: 'Founder', rating: 5, text: 'The cloud, QA and deployment process felt structured and predictable.' },
      { name: 'Daniel Brooks', role: 'Product Manager', rating: 5, text: 'They handled the integration work and support handover with proper engineering discipline.' },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Generic fallback — used for any profession without a hand-crafted entry
// above. Pulls vocab from the profession's theme config so copy still reads
// on-brand even without custom content.
// ─────────────────────────────────────────────────────────────────────────────
function genericProfessionContent(profession) {
  const vocab = profession.vocab || {};
  const serviceLabel = vocab.services || 'services';
  const staffLabel = vocab.staff || 'team';
  const apptLabel = vocab.appointment || 'appointment';
  const apptCap = apptLabel.charAt(0).toUpperCase() + apptLabel.slice(1);
  const serviceCap = serviceLabel.charAt(0).toUpperCase() + serviceLabel.slice(1);
  const staffCap = staffLabel.charAt(0).toUpperCase() + staffLabel.slice(1);

  return {
    teamRoles: [`Lead ${profession.industry || 'Specialist'}`, `Senior ${profession.industry || 'Practitioner'}`, profession.industry || 'Specialist'],
    services: [
      { name: `Initial ${apptLabel}`,     description: `Your first visit — assessment, conversation, and a clear plan for your needs.`,         duration: 60, price: 95 },
      { name: `Follow-up ${apptLabel}`,   description: `A focused session to review progress and continue what\u2019s working.`,                 duration: 45, price: 70, highlighted: true },
      { name: `Premium ${serviceLabel.slice(0, -1) || 'service'}`, description: `Our most in-depth offering — extended time and comprehensive care.`, duration: 90, price: 150 },
      { name: `Quick consult`,            description: `A shorter check-in for existing clients. Ideal for small concerns between full sessions.`, duration: 30, price: 45 },
    ],
    faq: [
      { q: `How do I book my first ${apptLabel}?`, a: 'Use the online booking form — pick a time that suits you and you\u2019ll get an email confirmation instantly.' },
      { q: 'Do you offer online consultations?',    a: 'Yes — video sessions are available for most matters. Select \u201cOnline\u201d when booking.' },
      { q: 'Are fees fixed?',                       a: 'Fixed fees for standard services listed on this page. Custom work is always quoted in writing in advance.' },
      { q: 'What is your cancellation policy?',     a: 'Cancel or reschedule with 24 hours notice at no charge. Same-day cancellations may incur a small fee.' },
      { q: 'Do you take new clients?',              a: 'Yes — we\u2019re currently accepting new clients. First-time visits get a complimentary consultation.' },
      { q: 'How do I prepare?',                     a: 'Arrive a few minutes early. Bring any relevant information or references — we\u2019ll send a prep note before your visit.' },
    ],
    pricing: [
      { name: `Standard ${apptLabel}`, price: 95,  period: `per ${apptLabel}`, features: [`60-minute ${apptLabel}`, 'Email follow-up', 'Written notes'] },
      { name: 'Package of 5',           price: 400, period: 'package',            features: ['Five sessions', 'Save $75', 'Flexible scheduling'], highlighted: true },
      { name: 'Premium',                price: 150, period: `per ${apptLabel}`, features: ['90-minute extended session', 'Detailed written report', 'Priority follow-up'] },
    ],
    gallery: ['Reception', 'Our space', 'Work area', 'Meeting room', 'Equipment', `Our ${staffLabel}`],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Image keywords — one per profession. Used to build topic-relevant CC-licensed
// photo URLs from loremflickr for gallery / hero fallbacks. Tenants can always
// override with their own uploads in the web editor.
// ─────────────────────────────────────────────────────────────────────────────
const PROFESSION_IMG_KEYWORDS = {
  general_practice:    'clinic,medical',
  dental:              'dental,clinic',
  physio:              'physiotherapy,clinic',
  psychology:          'therapy,office',
  dermatology:         'skincare,clinic',
  chiropractic:        'chiropractor,clinic',
  optometry:           'optometrist,glasses',
  nutrition:           'nutrition,healthyfood',
  veterinary:          'veterinary,pets',
  barbershop:          'barbershop,haircut',
  hair_salon:          'hairsalon,styling',
  makeup:              'makeup,beauty',
  nail_tech:           'nails,manicure',
  spa:                 'spa,wellness',
  tattoo:              'tattoo,studio',
  tutor:               'tutoring,classroom',
  music_teacher:       'music,instruments',
  fitness_coach:       'fitness,gym',
  yoga:                'yoga,studio',
  legal:               'lawoffice,lawyer',
  accountant:          'accounting,office',
  ca_tax_consultant:   'accounting,tax,office',
  it_services:         'software,technology,office',
  financial_advisor:   'finance,office',
  consultant:          'consulting,office',
  immigration:         'lawoffice,documents',
  gym:                 'gym,fitness',
  meditation:          'meditation,studio',
  electrician:         'electrician,tools',
  plumber:             'plumbing,tools',
  cleaner:             'cleaning,home',
  mechanic:            'mechanic,garage',
  photographer:        'photography,studio',
  event_planner:       'event,wedding',
  designer:            'designstudio,creative',
  bar_pub:             'bar,pub',
  writer_content:      'writer,desk',
  artist:              'art,studio',
  dj:                  'dj,nightclub',
  online_courses:      'onlinelearning,education',
  marketing_agency:    'marketing,creative',
  real_estate:         'realestate,house',
  architect:           'architecture,building',
  corporate:           'business,office',
  pet_groomer:         'dog,grooming',
  dog_trainer:         'dog,training',
  therapist:           'therapy,office',
  life_coach:          'coaching,office',
  hr_interviews:       'interview,office',
  saas_demo:           'office,technology',
};

// Builds a stable loremflickr URL — topic-keyword based, free CC-licensed
// Flickr photos. `lock` param fixes the image per (profession, slot) pair so
// it doesn't change on reload. Gracefully no-op if the env has no image host.
function imgFor(professionKey, slot, w = 800, h = 600) {
  const kw = PROFESSION_IMG_KEYWORDS[professionKey] || 'office,workplace';
  // Deterministic lock = hash of profession + slot, so slot 0 always returns
  // the same image for a given profession across reloads.
  let h1 = 0;
  const seed = `${professionKey}:${slot}`;
  for (const c of seed) h1 = (h1 * 33 + c.charCodeAt(0)) & 0xffff;
  return `https://loremflickr.com/${w}/${h}/${kw}?lock=${h1}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export — composes full default sections for a profession.
// ─────────────────────────────────────────────────────────────────────────────
export function getDefaultSections(profession) {
  if (!profession) return null;
  const hand = PROFESSION_CONTENT[profession.key];
  const premium = PREMIUM_WEB_CONTENT[profession.key];
  const content = premium ? { ...(hand || {}), ...premium } : (hand || genericProfessionContent(profession));
  const initialsFor = (name) => String(name || 'Team member')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'TM';
  const team = Array.isArray(content.team) && content.team.length
    ? content.team.map((person, i) => {
        const name = person.name || `Team member ${i + 1}`;
        const role = person.role || person.subtitle || content.teamRoles?.[i] || profession.industry || 'Team member';
        return {
          name,
          subtitle: person.subtitle || role,
          role,
          bio: person.bio || `${name.split(' ')[0]} brings years of experience and a warm, considered approach. Clients describe them as attentive, skilled and easy to talk to.`,
          avatarUrl: person.avatarUrl || null,
          _initials: person.initials || initialsFor(name),
        };
      })
    : pickTeamNames(profession.key).map((person, i) => ({
        name: person.name,
        subtitle: content.teamRoles[i] || profession.industry || 'Team member',
        role: content.teamRoles[i] || profession.industry || 'Team member',
        bio: `${person.name.split(' ')[0]} brings years of experience and a warm, considered approach. Clients describe them as attentive, skilled and easy to talk to.`,
        avatarUrl: null,
        _initials: person.initials,
      }));

  const key = profession.key;
  return {
    // Each default service gets a topic-appropriate cover image.
    services: content.services.map((s, i) => ({
      id: `default-service-${i}`,
      features: [],
      ...s,
      imageUrl: s.imageUrl || imgFor(key, `service-${i}`, 800, 600),
    })),
    team,
    testimonials: Array.isArray(content.testimonials) && content.testimonials.length ? content.testimonials : pickTestimonials(profession.key),
    pricing: content.pricing,
    faq: content.faq,
    // Gallery tiles get a topic-keyword image per slot. Stable URL — same
    // image across reloads thanks to the deterministic lock.
    gallery: content.gallery.map((caption, i) => ({
      caption,
      image: imgFor(key, `gallery-${i}`, 800, 600),
    })),
    businessHours: 'Mon–Fri 9am–6pm · Sat 10am–4pm · Sun closed',
    trustItems: profession.defaultContent?.trustItems || ['Trusted by the community', 'Transparent pricing', 'Book online 24/7'],
    // Hero banner — available to the storefront when content.heroBannerUrl is
    // empty, so a brand-new tenant still shows a full-bleed hero image.
    heroBannerUrl: imgFor(key, 'hero', 1600, 600),
  };
}
