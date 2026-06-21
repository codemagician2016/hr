#!/usr/bin/env node
/*
 * Idempotently seeds TaxFixy into the STATIC web vertical.
 *
 * Usage:
 *   node backend/scripts/seed-taxfixy-web.js
 *   TAXFIXY_SCRAPE=0 node backend/scripts/seed-taxfixy-web.js
 *
 * The script uses TaxFixy's public URL list as source inventory and creates
 * editable BusinessPage rows. If live scraping works, page body text is pulled
 * from the source page. If a page cannot be fetched, a professional fallback
 * body is generated from the service title and category.
 */
'use strict';

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const THEME = 'ca_tax_consultant';
const ADMIN = {
  email: (process.env.TAXFIXY_ADMIN_EMAIL || 'admin@taxfixy.com').trim().toLowerCase(),
  password: process.env.TAXFIXY_ADMIN_PASSWORD || 'Taxfixy@12345',
  name: process.env.TAXFIXY_ADMIN_NAME || 'TaxFixy Admin',
};
const BUSINESS = {
  slug: 'taxfixy',
  name: 'TaxFixy',
  vertical: 'STATIC',
  description: 'CA-certified documents, GST, income tax, startup registrations, MCA compliance and business advisory support across India.',
  address: 'India',
  phone: '+91 70433 48168',
  email: 'support@taxfixy.com',
  country: 'IN',
  timezone: 'Asia/Kolkata',
  category: 'ca-tax-consultant',
  defaultCurrency: 'INR',
};

const COMMON_FAQS = [
  {
    q: 'Can this service be completed online?',
    a: 'Yes. The initial consultation, document checklist, verification and most filing or certificate workflows can be handled online.',
  },
  {
    q: 'Which documents are required?',
    a: 'The exact list depends on the service. TaxFixy confirms the checklist after reviewing the entity type, purpose and deadline.',
  },
  {
    q: 'Is CA certification or UDIN available?',
    a: 'Where CA certification and UDIN are applicable, the workflow is prepared for professional review and compliant issuance.',
  },
];

const GROUPS = [
  {
    key: 'certificates',
    parentNav: 'services',
    label: 'CA Certificates',
    intro: 'CA-certified documents used for tenders, loans, visas, bank submissions, grants, compliance and management reporting.',
    pages: [
      ['networthcertificate', 'Net Worth Certificate'],
      ['turnovercertificate', 'Turnover Certificate'],
      ['workingcapitalcertificate', 'Working Capital Certificate'],
      ['shareholdingpatterncertificate', 'Shareholding Pattern Certificate'],
      ['listofdirectorscertificate', 'List of Directors Certificate'],
      ['projectedfinancialscertificate', 'Projected Financials Certificate / Provisional Financial Statements'],
      ['fundflowcertificate', 'Fund Flow / Cash Flow Statement Certificate'],
      ['termloanrepaymentcertificate', 'Term Loan Repayment Certificate'],
      ['capitalcontributioncertificate', 'Capital Contribution Certificate / Capital Certificate'],
      ['dscrcertificate', 'DSCR Certificate (Debt Service Coverage Ratio)'],
      ['certificateforsourcesoffunds', 'Certificate for Sources of Funds'],
      ['capitaladequacycertificate', 'Capital Adequacy Certificate'],
      ['certificateofgrossreceiptsfor44adand44adapurposes', 'Certificate of Gross Receipts for 44AD / 44ADA'],
      ['incomecertificateforvisascholarshipembassy', 'Income Certificate for Visa / Scholarship / Embassy'],
      ['noduescertificatefordirectorIndirecttaxes', 'No Dues Certificate for Direct or Indirect Taxes'],
      ['certificateofcompliancewithcompaniesactmgt7aoc4', 'Certificate of Compliance with Companies Act (MGT-7 / AOC-4)'],
      ['paidupcapitalcertificate', 'Paid-up Capital Certificate'],
      ['shareapplicationmoneyutilizationcertificate', 'Share Application Money Utilization Certificate'],
      ['certificateforforeignremittanceunderfemaform15cb', 'Certificate for Foreign Remittance under FEMA (Form 15CB)'],
      ['netassetscertificateforemigrationorvisa', 'Net Assets Certificate for Emigration or Visa'],
      ['certificateforexportturnoverinwardremittances', 'Certificate for Export Turnover / Inward Remittances'],
      ['certificateforecbexternalcommercialborrowingutilization', 'Certificate for ECB Utilization'],
      ['odifdirelatedcertificateforvaluationandreporting', 'ODI / FDI Related Certificate for Valuation and Reporting'],
      ['solvencycertificate', 'Solvency Certificate'],
      ['cacertificateforstartupregistrationdpiitcompliance', 'CA Certificate for Startup Registration / DPIIT Compliance'],
      ['turnovercertificateforgovernmenttendermsme', 'Turnover Certificate for Government Tender / MSME'],
      ['inventoryvaluationcertificate', 'Inventory Valuation Certificate'],
      ['certificateforinvestmentinplantmachinery', 'Certificate for Investment in Plant & Machinery'],
      ['utilizationcertificateforngogovernmentgrants', 'Utilization Certificate for NGO / Government Grants'],
      ['noliencertificate', 'No Lien Certificate'],
    ],
  },
  {
    key: 'startup',
    parentNav: 'services',
    label: 'Startup & Entity Setup',
    intro: 'Entity selection, incorporation, startup documentation and registration support for Indian and international business structures.',
    pages: [
      ['proprietorship', 'Proprietorship'],
      ['partnership', 'Partnership'],
      ['onepersoncompany', 'One Person Company'],
      ['limitedliabilitypartnership', 'Limited Liability Partnership'],
      ['privatelimitedcompany', 'Private Limited Company'],
      ['section8company', 'Section 8 Company'],
      ['trustregistration', 'Trust Registration'],
      ['publiclimitedcompany', 'Public Limited Company'],
      ['producercompany', 'Producer Company'],
      ['indiansubsidiary', 'Indian Subsidiary'],
      ['uaecompany', 'UAE Company'],
      ['usacompany', 'USA Company'],
      ['singaporecompany', 'Singapore Company'],
      ['ukcompany', 'UK Company'],
    ],
  },
  {
    key: 'gst',
    parentNav: 'services',
    label: 'Goods & Services Tax',
    intro: 'GST registration, return filing, amendments, LUT, e-invoicing, annual returns and notice response support.',
    pages: [
      ['gstregistration', 'GST Registration'],
      ['gstregistrationforforeigners', 'GST Registration for Foreigners'],
      ['gstreturnfilingbyaccountant', 'GST Return Filing by Accountant'],
      ['gstinvoicingandfilingsoftware', 'GST Invoicing & Filing Software'],
      ['gstannualreturnfiling', 'GST Annual Return Filing (GSTR-9)'],
      ['gstamendment', 'GST Amendment'],
      ['gsteinvoicingsoftware', 'GST E-Invoicing Software'],
      ['gstrevocation', 'GST Revocation'],
      ['gstlutform', 'GST LUT Form'],
      ['gstr10', 'GSTR-10'],
      ['gstnotice', 'GST Notice'],
      ['gstsoftwareforaccountants', 'GST Software for Accountants'],
    ],
  },
  {
    key: 'income-tax',
    parentNav: 'services',
    label: 'Income Tax',
    intro: 'Income tax return filing, TDS, TAN, 15CA/15CB and notice support for individuals, businesses, companies and NGOs.',
    pages: [
      ['incometaxefiling', 'Income Tax E-Filing'],
      ['itr1returnfiling', 'ITR-1 Return Filing'],
      ['itr2returnfiling', 'ITR-2 Return Filing'],
      ['itr3returnfiling', 'ITR-3 Return Filing'],
      ['itr4returnfiling', 'ITR-4 Return Filing'],
      ['itr5returnfiling', 'ITR-5 Return Filing'],
      ['itr6returnfiling', 'ITR-6 Return Filing'],
      ['itr7returnfiling', 'ITR-7 Return Filing'],
      ['businesstaxfiling', 'Business Tax Filing'],
      ['15ca15cbfiling', '15CA - 15CB Filing'],
      ['tanregistration', 'TAN Registration'],
      ['tdsreturnfiling', 'TDS Return Filing'],
      ['incometaxnotice', 'Income Tax Notice'],
    ],
  },
  {
    key: 'registrations',
    parentNav: 'services',
    label: 'Registrations & Licences',
    intro: 'Business, NGO, import-export, labour, food, ISO and digital signature registrations with guided documentation.',
    pages: [
      ['startupindia', 'Startup India'],
      ['legaentityidentifiercode', 'Legal Entity Identifier Code'],
      ['12aand80gregistration', '12A and 80G Registration'],
      ['darpanregistration', 'Darpan Registration'],
      ['tradelicense', 'Trade License'],
      ['isoregistration', 'ISO Registration'],
      ['digitalsignature', 'Digital Signature'],
      ['fssairegistration', 'FSSAI Registration'],
      ['pfregistration', 'PF Registration'],
      ['shopactregistration', 'Shop Act Registration'],
      ['fsdailicense', 'FSSAI License'],
      ['esiregistration', 'ESI Registration'],
      ['udyamregistration', 'Udyam Registration'],
      ['icegateregistration', 'ICEGATE Registration'],
      ['fcraregistration', 'FCRA Registration'],
      ['importexportcode', 'Import Export Code'],
    ],
  },
  {
    key: 'mca',
    parentNav: 'services',
    label: 'MCA & ROC Compliance',
    intro: 'Company, LLP and OPC compliance including ROC forms, director changes, capital updates and closure workflows.',
    pages: [
      ['companycompliance', 'Company Compliance'],
      ['llpcompliance', 'LLP Compliance'],
      ['opccompliance', 'OPC Compliance'],
      ['namechangecompany', 'Name Change - Company'],
      ['registeredofficechange', 'Registered Office Change'],
      ['dinekycfiling', 'DIN eKYC Filing'],
      ['dinreactivation', 'DIN Reactivation'],
      ['directorchange', 'Director Change'],
      ['removedirector', 'Remove Director'],
      ['adt1filing', 'ADT-1 Filing'],
      ['dpt3filing', 'DPT-3 Filing'],
      ['xbrlformfiling', 'XBRL Form Filing'],
      ['dormantstatusfiling', 'Dormant Status Filing'],
      ['moaamendment', 'MOA Amendment'],
      ['aoaamendment', 'AOA Amendment'],
      ['sharecapitalincrease', 'Share Capital Increase'],
      ['sharetransfer', 'Share Transfer'],
      ['dematofshares', 'Demat of Shares'],
      ['windingupllp', 'Winding Up - LLP'],
      ['windingupcompany', 'Winding Up - Company'],
    ],
  },
  {
    key: 'info',
    parentNav: 'info',
    label: 'Company Information',
    intro: 'Helpful information pages for clients learning about TaxFixy and its policies.',
    pages: [
      ['aboutus', 'About TaxFixy'],
      ['contact', 'Contact TaxFixy'],
      ['termsofservice', 'Terms of Service'],
      ['privacypolicy', 'Privacy Policy'],
    ],
  },
];

const ALL_PAGES = GROUPS.flatMap((group) => group.pages.map(([slug, title]) => ({ slug, title, group })));

function json(value) {
  return JSON.stringify(value);
}

function truncate(str, max) {
  const s = String(str || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '...';
}

function decodeHtml(str) {
  return String(str || '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtml(str) {
  return decodeHtml(String(str || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function extractTaxFixyDetails(html) {
  const source = String(html || '');
  const footerIdx = source.search(/<footer|<div class="footer-area/i);
  const serviceStart = source.match(/<div class="details(?:\s|")[^"]*">/i);
  const aboutIdx = source.indexOf('<div class="about-area');
  const visibleContact = source.match(/<div class="team-area(?![^"]*\bd-none\b)[^"]*">/i);
  let from = -1;
  if (serviceStart && serviceStart.index !== undefined && (footerIdx < 0 || serviceStart.index < footerIdx)) {
    from = serviceStart.index;
  } else if (aboutIdx >= 0) {
    from = aboutIdx;
  } else if (visibleContact && visibleContact.index !== undefined) {
    from = visibleContact.index;
  }
  if (from < 0) return null;
  const endMarkers = [
    '<div class="faq-area',
    '<div class="footer-area',
    '<footer',
  ];
  const end = endMarkers
    .map((marker) => source.indexOf(marker, from))
    .filter((idx) => idx > from)
    .sort((a, b) => a - b)[0] || html.length;
  return source.slice(from, end);
}

function htmlToEditableText(html) {
  let s = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<button[\s\S]*?<\/button>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<thead[\s\S]*?<\/thead>/gi, (m) => `\n${stripHtml(m)}\n`)
    .replace(/<tr[\s\S]*?<\/tr>/gi, (m) => `\n${stripHtml(m).replace(/\s{2,}/g, ' | ')}\n`)
    .replace(/<h([1-6])[^>]*>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    .replace(/<\/?(strong|b)[^>]*>/gi, '')
    .replace(/<a[^>]*href="tel:([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2')
    .replace(/<a[^>]*href="[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, ' ');
  s = decodeHtml(s)
    .replace(/\[email(?:\s|&nbsp;|&#160;)*protected\]/gi, 'support@taxfixy.com')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return s;
}

function titleCaseFromSlug(slug) {
  return String(slug)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function fallbackBody(page) {
  const { title, group } = page;
  const purpose = group.key === 'certificates'
    ? `${title} helps clients present a CA-reviewed financial position for banks, tenders, visa work, grants, statutory records or management review.`
    : group.key === 'startup'
      ? `${title} support helps founders choose the right structure, prepare documents and complete the registration workflow with fewer compliance surprises.`
      : group.key === 'gst'
        ? `${title} support helps businesses stay compliant with GST rules, filings, notices and documentation.`
        : group.key === 'income-tax'
          ? `${title} support helps individuals, businesses and entities file or respond correctly with proper records.`
          : group.key === 'mca'
            ? `${title} support helps companies and LLPs manage ROC/MCA obligations, filings and corporate changes.`
            : `${title} is handled with a clear checklist, document review and practical guidance.`;

  return [
    purpose,
    '',
    `TaxFixy starts with a requirement review, confirms the applicable checklist, checks document quality and prepares the work for filing, certification or submission as required.`,
    '',
    'Typical information reviewed may include identity and address proofs, PAN, entity documents, bank statements, financial statements, tax records, board or partner approvals, invoices, agreements and supporting declarations depending on the service.',
    '',
    'The team keeps the process practical: clarify the purpose, collect documents once, review gaps early, prepare the draft or filing, and share the final document or acknowledgement after completion.',
    '',
    'Use this page as an editable service brief. The admin can refine fees, timelines, eligibility notes, required documents and FAQs from the Sitepresso page editor.',
  ].join('\n\n');
}

async function scrapeBody(page) {
  if (process.env.TAXFIXY_SCRAPE === '0') return null;
  const url = `https://taxfixy.com/${page.slug}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const html = await res.text();
    const details = extractTaxFixyDetails(html);
    let text = htmlToEditableText(details || html);
    const minLength = page.group.key === 'info' ? 80 : 450;
    if (text.length < minLength) return null;
    return truncate(text, 12000);
  } catch {
    return null;
  }
}

function bannerDataUri(page) {
  const title = page.title.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const label = page.group.label.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="520" viewBox="0 0 1600 520">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0F766E"/>
      <stop offset="0.62" stop-color="#115E59"/>
      <stop offset="1" stop-color="#F59E0B"/>
    </linearGradient>
    <pattern id="grid" width="56" height="56" patternUnits="userSpaceOnUse">
      <path d="M 56 0 L 0 0 0 56" fill="none" stroke="rgba(255,255,255,.13)" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="1600" height="520" fill="url(#g)"/>
  <rect width="1600" height="520" fill="url(#grid)"/>
  <circle cx="1310" cy="80" r="220" fill="rgba(255,255,255,.12)"/>
  <circle cx="1420" cy="420" r="260" fill="rgba(255,255,255,.10)"/>
  <rect x="90" y="90" width="1420" height="340" rx="32" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.28)"/>
  <text x="140" y="170" fill="#FDE68A" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="6">${label}</text>
  <text x="140" y="260" fill="#FFFFFF" font-family="Inter, Arial, sans-serif" font-size="72" font-weight="800">${title}</text>
  <text x="140" y="338" fill="#DDF7F3" font-family="Inter, Arial, sans-serif" font-size="32" font-weight="500">Online CA support by TaxFixy</text>
  <text x="1230" y="348" fill="rgba(255,255,255,.22)" font-family="Georgia, serif" font-size="160" font-weight="700">CA</text>
</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function buildBlocks(page, body) {
  return {
    taxfixyGroupKey: page.group.key,
    blocks: [
      {
        id: `header-${page.slug}`,
        type: 'header',
        enabled: true,
        props: {
          title: page.title,
          subtitle: page.group.intro,
          fullWidthBanner: true,
          bannerImageUrl: bannerDataUri(page),
        },
      },
      {
        id: `body-${page.slug}`,
        type: 'richtext',
        enabled: true,
        props: {
          heading: `About ${page.title}`,
          body,
          twoColumns: false,
        },
      },
      {
        id: `features-${page.slug}`,
        type: 'features',
        enabled: true,
        props: {
          columns: 3,
          items: [
            { title: 'Requirement review', desc: 'Clarify purpose, entity type, deadline and applicable compliance route.' },
            { title: 'Document checklist', desc: 'Receive a practical checklist before submitting financial or identity records.' },
            { title: 'Expert completion', desc: 'Preparation, filing or certification is handled with a clear delivery step.' },
          ],
        },
      },
      {
        id: `faq-${page.slug}`,
        type: 'richtext',
        enabled: true,
        props: {
          heading: 'Common questions',
          body: COMMON_FAQS.map((f) => `${f.q}\n${f.a}`).join('\n\n'),
          twoColumns: true,
        },
      },
      {
        id: `cta-${page.slug}`,
        type: 'cta',
        enabled: true,
        props: {
          heading: `Need help with ${page.title}?`,
          buttonText: 'Request consultation',
          buttonLink: '/pages/info/contact',
          style: 'primary',
          background: 'solid',
        },
      },
    ],
  };
}

function contentForHome() {
  const cmsServices = GROUPS.filter((g) => g.key !== 'info').map((g) => ({
    name: g.label,
    description: g.intro,
    priceCaption: 'from',
    duration: 'Online',
    features: g.pages.slice(0, 4).map(([, title]) => title),
    highlighted: g.key === 'certificates',
  }));

  return {
    heroHeadline: 'CA, Tax & Compliance Services Across India',
    heroSubheading: 'TaxFixy helps founders, businesses, NGOs and professionals with CA certificates, GST, ITR, registrations and MCA compliance through a fast online process.',
    heroCtaText: 'Request Consultation',
    heroLine3: 'Certificates, filings and registrations handled with clear document checklists.',
    tagline: 'Compliance made clear',
    servicesEyebrow: 'Services',
    servicesTitle: 'Everything from CA certificates to MCA compliance',
    servicesIntro: 'Choose the service you need. TaxFixy confirms documents, timelines and next steps before work begins.',
    aboutEyebrow: 'About TaxFixy',
    aboutTitle: 'A practical CA and compliance partner for growing businesses',
    aboutBody: 'TaxFixy provides online-first support for financial certificates, business registrations, GST, income tax, NGO registrations and ROC/MCA compliance. The experience is built around clarity: know the checklist, understand the timeline, and complete the work without chasing multiple advisors.',
    aboutHighlights: json([
      'CA certificates for tenders, loans, visas, grants and reporting',
      'GST, ITR, TDS and notice support',
      'Company, LLP, OPC, trust and NGO registrations',
      'MCA and ROC compliance for active companies and LLPs',
    ]),
    cmsServices: json(cmsServices),
    cmsTeam: json([
      { name: 'TaxFixy CA Desk', role: 'CA Certificates & Advisory', bio: 'Handles certificate requirements, financial review workflows and compliance documentation.', showOnWebsite: true },
      { name: 'Startup Desk', role: 'Registrations & MCA', bio: 'Guides founders through entity setup, documentation, ROC forms and post-registration compliance.', showOnWebsite: true },
      { name: 'Tax Desk', role: 'GST, ITR & Notices', bio: 'Supports GST registration, returns, income tax filing, TDS/TAN and tax notice responses.', showOnWebsite: true },
    ]),
    testimonials: json([
      { name: 'Business owner', role: 'Certificate client', rating: 5, text: 'The checklist was clear and the certificate process was handled quickly.' },
      { name: 'Startup founder', role: 'Registration client', rating: 5, text: 'TaxFixy explained the structure and documents before we started.' },
      { name: 'Finance manager', role: 'Compliance client', rating: 5, text: 'Professional coordination and timely support for filing work.' },
    ]),
    statsItems: json([
      { value: `${ALL_PAGES.length}+`, label: 'Services documented' },
      { value: 'PAN India', label: 'Online support' },
      { value: 'CA-led', label: 'Review workflows' },
    ]),
    faqItems: json(COMMON_FAQS),
    contactEyebrow: 'Start Here',
    contactTitle: 'Tell us what you need certified, registered or filed',
    contactBody: 'Share the service, purpose and deadline. TaxFixy will confirm the checklist, process and next step.',
    contactCardTitle: 'Compliance enquiry',
    contactCardBody: 'Mention the certificate, registration, GST, income tax or MCA requirement. Documents can be shared after the first response.',
    ctaHeadline: 'Need a CA-certified document or compliance filing?',
    ctaBody: 'Start with a practical checklist and clear next step.',
    businessHoursText: 'Online support across India',
    footerDescription: 'TaxFixy helps clients with CA certificates, GST, ITR, startup registrations, MCA compliance and regulatory documentation.',
    footerCopyright: '© 2026 TaxFixy. All rights reserved.',
    showBooking: false,
    showPricing: false,
    showGallery: false,
    showTeam: true,
    showTestimonials: true,
    showFaq: true,
    showBlogServices: true,
    customPrimary: '#0F766E',
    customAccent: '#F59E0B',
    customBg: '#F7FAF8',
    customText: '#10201D',
    customMuted: '#5B6F6B',
  };
}

async function ensureBusiness() {
  const existing = await prisma.business.findUnique({ where: { slug: BUSINESS.slug } });
  if (existing) {
    return prisma.business.update({
      where: { slug: BUSINESS.slug },
      data: { ...BUSINESS, isActive: true },
    });
  }
  return prisma.business.create({
    data: { ...BUSINESS, isActive: true },
  });
}

async function ensureSubscription(businessId) {
  const tier = await prisma.pricingTier.findUnique({ where: { slug: 'static-free' } })
    || await prisma.pricingTier.findUnique({ where: { slug: 'free' } });
  if (!tier) throw new Error('No pricing tier found. Run backend/prisma/seeds/pricing.seed.js first.');
  const forever = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
  await prisma.subscription.upsert({
    where: { businessId },
    update: {
      tierId: tier.id,
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      theme: THEME,
      themeStyle: 'light',
      currentPeriodEnd: forever,
      seatsUsed: 1,
    },
    create: {
      businessId,
      tierId: tier.id,
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      theme: THEME,
      themeStyle: 'light',
      currentPeriodEnd: forever,
      seatsUsed: 1,
    },
  });
}

async function ensureAdminUser(businessId) {
  const hashed = await bcrypt.hash(ADMIN.password, 12);
  const baseData = {
    password: hashed,
    name: ADMIN.name,
    role: 'BUSINESS_ADMIN',
    businessId,
    emailVerified: true,
    isActive: true,
    showOnWebsite: true,
    isServiceProvider: false,
    emailOtp: null,
    emailOtpExpiry: null,
    resetToken: null,
    resetTokenExpiry: null,
    termsAcceptedAt: new Date(),
    termsVersion: 'seed-taxfixy-2026-05',
  };
  await prisma.user.upsert({
    where: { email: ADMIN.email },
    update: baseData,
    create: {
      email: ADMIN.email,
      ...baseData,
    },
  });
}

async function ensurePages(businessId) {
  const rows = [];
  for (const group of GROUPS.filter((g) => g.key !== 'info')) {
    const page = {
      slug: group.key,
      title: group.label,
      group,
    };
    const body = [
      group.intro,
      '',
      `This section collects TaxFixy's ${group.label.toLowerCase()} pages in one place. Use the related service pages to edit individual requirements, documents, process notes and calls to action.`,
      '',
      group.pages.map(([, title]) => `- ${title}`).join('\n'),
    ].join('\n');
    const data = {
      businessId,
      parentNav: 'services',
      slug: page.slug,
      title: page.title,
      templateKey: 'block-page',
      content: buildBlocks(page, body),
      isPublished: false,
      sortOrder: rows.length + 1,
      placement: 'HIDDEN',
      iconKey: 'doc',
      metaTitle: `${page.title} | TaxFixy`,
      metaDescription: truncate(`${page.title} from TaxFixy. ${group.intro}`, 155),
      metaKeywords: [page.title, group.label, 'TaxFixy', 'CA services India', 'tax consultant'].join(', '),
    };
    const row = await prisma.businessPage.upsert({
      where: {
        businessId_parentNav_slug: {
          businessId,
          parentNav: data.parentNav,
          slug: data.slug,
        },
      },
      update: data,
      create: data,
    });
    rows.push({ ...row, groupKey: group.key, isGroupOverview: true });
  }

  for (let i = 0; i < ALL_PAGES.length; i += 1) {
    const page = ALL_PAGES[i];
    const scraped = await scrapeBody(page);
    const body = scraped || fallbackBody(page);
    const data = {
      businessId,
      parentNav: page.group.parentNav,
      slug: page.slug.toLowerCase(),
      title: page.title,
      templateKey: 'block-page',
      content: buildBlocks(page, body),
      isPublished: true,
      sortOrder: rows.length + 1,
      placement: page.group.key === 'info' ? 'FOOTER' : 'DROPDOWN',
      iconKey: page.group.key === 'certificates' ? 'doc' : page.group.key === 'gst' ? 'card' : 'shield',
      metaTitle: `${page.title} | TaxFixy`,
      metaDescription: truncate(`${page.title} support from TaxFixy. ${page.group.intro}`, 155),
      metaKeywords: [page.title, page.group.label, 'TaxFixy', 'CA services India', 'tax consultant'].join(', '),
    };
    const row = await prisma.businessPage.upsert({
      where: {
        businessId_parentNav_slug: {
          businessId,
          parentNav: data.parentNav,
          slug: data.slug,
        },
      },
      update: data,
      create: data,
    });
    rows.push({ ...row, groupKey: page.group.key, isGroupOverview: false });
  }
  return rows;
}

async function ensureNav(businessId, pages) {
  const byGroup = new Map();
  for (const page of pages) {
    if (!byGroup.has(page.groupKey)) byGroup.set(page.groupKey, []);
    byGroup.get(page.groupKey).push(page);
  }
  const nav = [
    { kind: 'system', key: 'home', children: [] },
    ...GROUPS.filter((g) => g.key !== 'info').map((group) => ({
      kind: 'custom',
      pageId: (byGroup.get(group.key) || []).find((p) => p.isGroupOverview)?.id,
      children: (byGroup.get(group.key) || []).filter((p) => !p.isGroupOverview).slice(0, 12).map((p) => ({ kind: 'custom', pageId: p.id, children: [] })),
    })),
    { kind: 'system', key: 'about', children: [] },
    { kind: 'system', key: 'contact', children: [] },
  ].filter((item) => item.kind === 'system' || item.pageId);
  await prisma.business.update({
    where: { id: businessId },
    data: { siteNav: nav },
  });
}

async function main() {
  console.log('[taxfixy] Creating/updating TaxFixy web tenant...');
  const business = await ensureBusiness();
  await ensureSubscription(business.id);
  await ensureAdminUser(business.id);
  await prisma.businessContent.upsert({
    where: { businessId: business.id },
    update: contentForHome(),
    create: { businessId: business.id, ...contentForHome() },
  });
  const pages = await ensurePages(business.id);
  const pageCount = await prisma.businessPage.count({ where: { businessId: business.id } });
  if (pageCount < ALL_PAGES.length) {
    throw new Error(`Expected at least ${ALL_PAGES.length} TaxFixy pages, found ${pageCount}`);
  }
  await ensureNav(business.id, pages);
  console.log(`[taxfixy] Done. Business: ${business.name} (${business.slug})`);
  console.log(`[taxfixy] Published ${pageCount} editable pages (${ALL_PAGES.length} service pages plus category overviews).`);
  console.log(`[taxfixy] Admin login: ${ADMIN.email}`);
  console.log(`[taxfixy] Admin password: ${ADMIN.password}`);
  console.log('[taxfixy] Visit: https://taxfixy.aapkatech.com');
}

main()
  .catch((err) => {
    console.error('[taxfixy] Failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
