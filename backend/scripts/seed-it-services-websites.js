#!/usr/bin/env node
/*
 * Idempotently seeds LoomInfo and PaperByte as STATIC web tenants using the
 * shared IT Services theme.
 *
 * Usage:
 *   node backend/scripts/seed-it-services-websites.js
 */
'use strict';

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const THEME = 'it_services';
const THEME_STYLE = 'tech';

function json(value) {
  return JSON.stringify(value);
}

function truncate(value, max) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

function xmlEscape(value) {
  return String(value || '').replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[char]));
}

function bannerDataUri(site, title, label = 'IT Services') {
  const brand = xmlEscape(site.business.name);
  const safeTitle = xmlEscape(title);
  const safeLabel = xmlEscape(label);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="520" viewBox="0 0 1600 520">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0F4C81"/>
      <stop offset="0.56" stop-color="#0B6F86"/>
      <stop offset="1" stop-color="#16A34A"/>
    </linearGradient>
    <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
      <path d="M 64 0 L 0 0 0 64" fill="none" stroke="rgba(255,255,255,.13)" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="1600" height="520" fill="url(#g)"/>
  <rect width="1600" height="520" fill="url(#grid)"/>
  <circle cx="1340" cy="105" r="210" fill="rgba(255,255,255,.12)"/>
  <circle cx="1450" cy="420" r="245" fill="rgba(255,255,255,.10)"/>
  <rect x="92" y="88" width="1416" height="344" rx="28" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.28)"/>
  <text x="142" y="172" fill="#BBF7D0" font-family="Inter, Arial, sans-serif" font-size="32" font-weight="800" letter-spacing="5">${safeLabel}</text>
  <text x="142" y="260" fill="#FFFFFF" font-family="Inter, Arial, sans-serif" font-size="72" font-weight="850">${safeTitle}</text>
  <text x="142" y="334" fill="#E0F2FE" font-family="Inter, Arial, sans-serif" font-size="31" font-weight="500">${brand}</text>
  <text x="1235" y="350" fill="rgba(255,255,255,.22)" font-family="Inter, Arial, sans-serif" font-size="138" font-weight="900">IT</text>
</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const COMMON_FAQS = [
  {
    q: 'Can we start with a small discovery call?',
    a: 'Yes. A short discovery call helps clarify the goal, timeline, existing systems and the best next step before any proposal.',
  },
  {
    q: 'Can you support an existing website or application?',
    a: 'Yes. The team can review existing systems, improve performance, fix issues, add features and create a practical support plan.',
  },
  {
    q: 'Do you handle cloud, DevOps and databases?',
    a: 'Yes. Cloud infrastructure, databases, CI/CD, deployment pipelines, monitoring and operational handover can be included.',
  },
  {
    q: 'Is QA and security review included?',
    a: 'Testing can include manual QA, automation, regression, mobile, performance and security checks depending on the engagement.',
  },
];

const BASE_SERVICES = [
  {
    slug: 'e-commerce',
    title: 'E-commerce',
    icon: 'cart',
    short: 'Custom commerce experiences for single seller, multi seller, Shopify, Magento and payment-enabled stores.',
    body: [
      'E-commerce work covers storefront design, product catalogue structure, checkout, payment integration and back-office workflows.',
      'The focus is to keep the buyer journey clear while giving the business a maintainable platform for orders, promotions and content updates.',
    ],
    features: ['Storefront and catalogue planning', 'Checkout and payment setup', 'Mobile-ready buying experience'],
  },
  {
    slug: 'tech-stacks',
    title: 'Tech Stacks',
    icon: 'code',
    short: 'Web, mobile and full-stack development using modern frameworks, APIs and maintainable delivery practices.',
    body: [
      'Technology stack consulting helps choose the right tools for the project, team skillset, timeline and long-term maintenance needs.',
      'The service can include front-end, back-end, mobile, API and integration planning so the build has a stable technical foundation.',
    ],
    features: ['Full-stack architecture', 'Mobile and web frameworks', 'API and integration strategy'],
  },
  {
    slug: 'database-devops',
    title: 'Database and DevOps',
    icon: 'server',
    short: 'Cloud hosting, databases, deployment pipelines, observability and release support for dependable operations.',
    body: [
      'Database and DevOps services help teams move from manual deployments to repeatable, monitored and easier-to-support environments.',
      'Typical work includes database design, cloud setup, CI/CD, backups, monitoring, access controls and release handover.',
    ],
    features: ['Cloud and database setup', 'CI/CD and release workflows', 'Monitoring and backup planning'],
  },
  {
    slug: 'ai-ml',
    title: 'AI and ML',
    icon: 'spark',
    short: 'AI assistants, automation, reporting and data workflows that make operations faster and more useful.',
    body: [
      'AI and automation work starts with a practical use case: reduce manual effort, improve reporting, speed up support or surface better insights.',
      'Solutions can include AI chat, document workflows, dashboards, data preparation, prediction support and business automation.',
    ],
    features: ['Automation opportunity review', 'AI workflow design', 'Dashboards and reporting'],
  },
  {
    slug: 'cybersecurity-services',
    title: 'Cybersecurity Services',
    icon: 'shield',
    short: 'Security-minded reviews, hardening, monitoring and practical controls to reduce operational risk.',
    body: [
      'Cybersecurity support focuses on practical protection for websites, applications, infrastructure and user access.',
      'The work can include configuration review, secure deployment practices, access control, dependency checks and incident-readiness advice.',
    ],
    features: ['Security review and hardening', 'Access and deployment controls', 'Monitoring-ready recommendations'],
  },
  {
    slug: 'digital-marketing',
    title: 'Digital Marketing',
    icon: 'chart',
    short: 'SEO, content, paid campaigns and analytics support connected to business goals and measurable outcomes.',
    body: [
      'Digital marketing support helps the technology investment become visible, measurable and easier to improve over time.',
      'The service can include landing pages, SEO basics, campaign tracking, content planning, analytics and conversion improvements.',
    ],
    features: ['SEO and content planning', 'Campaign and analytics setup', 'Conversion-focused landing pages'],
  },
  {
    slug: 'payment-gateway',
    title: 'Payment Gateway',
    icon: 'card',
    short: 'Payment provider integration, checkout flows and transaction handover for web and commerce platforms.',
    body: [
      'Payment gateway work connects the website or application to providers such as Stripe, PayPal and regional payment platforms.',
      'The service can cover provider selection, payment flow design, webhook handling, testing and handover documentation.',
    ],
    features: ['Provider selection support', 'Checkout and webhook setup', 'Payment testing and handover'],
  },
];

const SITES = [
  {
    key: 'loominfo',
    admin: {
      email: (process.env.LOOMINFO_ADMIN_EMAIL || 'admin@loominfo.co.nz').trim().toLowerCase(),
      password: process.env.LOOMINFO_ADMIN_PASSWORD || 'Loominfo@12345',
      name: process.env.LOOMINFO_ADMIN_NAME || 'LoomInfo Admin',
    },
    business: {
      slug: 'loominfo',
      name: 'LoomInfo',
      vertical: 'STATIC',
      description: 'Custom software development and IT services for web, cloud, AI, mobile, e-commerce, cybersecurity and digital growth.',
      address: 'Auckland, New Zealand',
      phone: '',
      email: 'info@loominfo.co.nz',
      country: 'NZ',
      timezone: 'Pacific/Auckland',
      category: 'it-services',
      defaultCurrency: 'NZD',
    },
    heroHeadline: 'Build. Integrate. Scale.',
    heroSubheading: 'Design, build and scale secure applications across AI, full-stack, cloud, mobile and digital delivery.',
    tagline: 'Client-centric IT excellence',
    servicesTitle: 'We guarantee dependable technology delivery',
    servicesIntro: 'LoomInfo brings together software engineering, cloud, AI, digital marketing, cybersecurity and managed delivery for teams that need practical technology support.',
    aboutTitle: 'More than a decade devoted to client-centric IT excellence',
    aboutBody: 'LoomInfo helps businesses plan, build and improve digital systems with a focus on innovation, quality, long-term partnership and dependable delivery.',
    serviceOverrides: [
      {
        slug: 'dotnet',
        title: '.NET Development',
        icon: 'code',
        short: '.NET Core and enterprise application development for secure, scalable business systems.',
        body: [
          '.NET development supports businesses that need stable, maintainable applications, APIs and internal systems.',
          'The work can include architecture, back-end services, integrations, database design, deployment and long-term support.',
        ],
        features: ['.NET Core application delivery', 'API and integration work', 'Enterprise-ready maintenance'],
      },
    ],
    pricing: [
      { title: 'Starter Website', price: 'NZ$499', priceCaption: 'from', description: 'For lean brochure sites and first launches.', features: ['4-6 pages', 'Responsive design', 'Contact form'], ctaLabel: 'Request quote' },
      { title: 'Growth Build', price: 'NZ$999', priceCaption: 'from', description: 'For richer websites, integrations and content workflows.', features: ['Up to 15 pages', 'CMS-ready sections', 'Analytics and SEO basics'], ctaLabel: 'Plan project', highlighted: true },
      { title: 'Platform Project', price: 'Custom', priceCaption: 'quote', description: 'For apps, commerce, cloud, AI and ongoing support.', features: ['Discovery workshop', 'Delivery roadmap', 'QA and handover'], ctaLabel: 'Talk to us' },
    ],
  },
  {
    key: 'paperbyte',
    admin: {
      email: (process.env.PAPERBYTE_ADMIN_EMAIL || 'admin@paperbyte.co.nz').trim().toLowerCase(),
      password: process.env.PAPERBYTE_ADMIN_PASSWORD || 'Paperbyte@12345',
      name: process.env.PAPERBYTE_ADMIN_NAME || 'PaperByte Admin',
    },
    business: {
      slug: 'paperbyte',
      name: 'PaperByte',
      vertical: 'STATIC',
      description: 'IT solutions and services for future-ready applications across AI, full-stack, cloud, mobile, testing and managed delivery.',
      address: 'New Zealand',
      phone: '',
      email: 'support@paperbyte.co.nz',
      country: 'NZ',
      timezone: 'Pacific/Auckland',
      category: 'it-services',
      defaultCurrency: 'NZD',
    },
    heroHeadline: 'Innovate. Implement. Impact.',
    heroSubheading: 'Innovate, secure and scale future-ready applications through AI, full-stack, cloud and mobile delivery.',
    tagline: 'Future-ready IT solutions',
    servicesTitle: 'We guarantee unparalleled service quality',
    servicesIntro: 'PaperByte combines development, cloud, AI, testing, security, digital marketing and managed support into practical client-centric technology services.',
    aboutTitle: 'Client-centric IT excellence for modern businesses',
    aboutBody: 'PaperByte focuses on innovation, service quality and lasting partnerships, helping teams transform ideas into dependable digital systems.',
    serviceOverrides: [],
    pricing: [
      { title: 'Discovery', price: 'NZ$499', priceCaption: 'from', description: 'Clarify the idea, scope and delivery path.', features: ['Requirement review', 'Solution outline', 'Estimate'], ctaLabel: 'Start discovery' },
      { title: 'Digital Build', price: 'NZ$999', priceCaption: 'from', description: 'For websites, apps, integrations and automation.', features: ['Design and development', 'QA checks', 'Launch support'], ctaLabel: 'Plan build', highlighted: true },
      { title: 'Managed Support', price: 'Custom', priceCaption: 'monthly', description: 'For maintenance, monitoring and ongoing improvements.', features: ['Support plan', 'Maintenance backlog', 'Priority response'], ctaLabel: 'Discuss support' },
    ],
  },
];

function servicesForSite(site) {
  return [...site.serviceOverrides, ...BASE_SERVICES];
}

function contentForHome(site) {
  const services = servicesForSite(site).slice(0, 8).map((service) => ({
    name: service.title,
    description: service.short,
    priceCaption: 'quote',
    duration: 'Project',
    features: service.features,
    highlighted: service.slug === 'dotnet' || service.slug === 'e-commerce',
    currency: site.business.defaultCurrency,
  }));

  return {
    heroHeadline: site.heroHeadline,
    heroSubheading: site.heroSubheading,
    heroCtaText: 'Request Consultation',
    heroLine3: 'Software, cloud, AI, QA and managed support delivered with clear communication.',
    tagline: site.tagline,
    servicesEyebrow: 'IT Services',
    servicesTitle: site.servicesTitle,
    servicesIntro: site.servicesIntro,
    aboutEyebrow: 'About Us',
    aboutTitle: site.aboutTitle,
    aboutBody: site.aboutBody,
    aboutHighlights: json([
      'Client-focused technology planning',
      'Modern software, web and cloud delivery',
      'Testing, security and managed support',
      'Long-term partnerships built around practical outcomes',
    ]),
    cmsServices: json(services),
    cmsTeam: json([
      { name: `${site.business.name} Strategy Desk`, role: 'Discovery and Planning', bio: 'Clarifies requirements, project scope, technical direction and delivery priorities.', showOnWebsite: true },
      { name: `${site.business.name} Engineering Team`, role: 'Development and DevOps', bio: 'Builds websites, applications, integrations, cloud foundations and deployment workflows.', showOnWebsite: true },
      { name: `${site.business.name} Support Team`, role: 'QA and Managed Services', bio: 'Supports testing, maintenance, monitoring, security review and release confidence.', showOnWebsite: true },
    ]),
    testimonials: json([
      { name: 'Operations lead', role: 'Technology client', rating: 5, text: 'Clear planning, strong delivery discipline and dependable support after launch.' },
      { name: 'Business owner', role: 'Website client', rating: 5, text: 'The team made the project practical, responsive and easy to understand.' },
      { name: 'Founder', role: 'Platform client', rating: 5, text: 'A helpful technology partner for turning ideas into a working product.' },
    ]),
    statsItems: json([
      { value: '360', label: 'Strategy to support' },
      { value: 'Agile', label: 'Transparent delivery' },
      { value: 'Secure', label: 'Quality-first build' },
    ]),
    pricingTiers: json(site.pricing),
    faqItems: json(COMMON_FAQS),
    contactEyebrow: 'Start Here',
    contactTitle: 'Tell us what you want to build, improve or support',
    contactBody: 'Share your project idea, current platform, timeline or support need and the team will respond with a practical next step.',
    contactCardTitle: 'Project enquiry',
    contactCardBody: 'Mention your goal, timeline, current technology and the type of help you need.',
    ctaHeadline: 'Need a practical IT partner?',
    ctaBody: 'Start with a clear conversation about scope, risk, timeline and delivery.',
    businessHoursText: 'Monday-Friday, 9:00 am-6:00 pm',
    footerDescription: `${site.business.name} provides IT consulting, software development, cloud, AI, QA and managed support services.`,
    footerCopyright: `(c) 2026 ${site.business.name}. All rights reserved.`,
    heroTrust1: 'Scalable solutions',
    heroTrust2: 'Seamless delivery',
    heroTrust3: 'Trusted expertise',
    heroBannerUrl: bannerDataUri(site, site.heroHeadline, 'Digital Solutions'),
    aboutImageUrl: bannerDataUri(site, 'Client-Centric Delivery', 'Our Approach'),
    servicesImageUrl: bannerDataUri(site, 'Technology Services', 'Solutions'),
    showBooking: false,
    showPricing: true,
    showGallery: false,
    showTeam: true,
    showTestimonials: true,
    showFaq: true,
    showBlogServices: true,
    showBlogAbout: true,
    showBlogTestimonials: true,
    sectionOrder: 'services,about,team,testimonials,pricing,faq,contact',
    navServicesLabel: 'Services',
    navTeamLabel: 'Team',
    navPricingLabel: 'Pricing',
    navContactLabel: 'Contact',
    customPrimary: '#0F4C81',
    customAccent: '#16A34A',
    customBg: '#F7FAFC',
    customSurface: '#FFFFFF',
    customText: '#102033',
    customMuted: '#5D6F80',
  };
}

function buildBlocks(site, page) {
  const body = [
    page.body[0],
    '',
    page.body[1],
    '',
    'How we help',
    page.features.map((feature) => `- ${feature}`).join('\n'),
    '',
    'Delivery approach',
    'We start by understanding goals, users, constraints and the current technology environment. From there, the team defines a practical scope, delivery plan and support path that can be edited by the business owner inside Sitepresso.',
  ].join('\n');

  return {
    blocks: [
      {
        id: `header-${page.slug}`,
        type: 'header',
        enabled: true,
        props: {
          title: page.title,
          subtitle: page.short,
          fullWidthBanner: true,
          bannerImageUrl: bannerDataUri(site, page.title, 'IT Services'),
        },
      },
      {
        id: `body-${page.slug}`,
        type: 'richtext',
        enabled: true,
        props: {
          heading: page.title,
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
          items: page.features.map((feature) => ({
            title: feature,
            desc: `${site.business.name} can shape this around your systems, timeline and business priority.`,
          })),
        },
      },
      {
        id: `faq-${page.slug}`,
        type: 'richtext',
        enabled: true,
        props: {
          heading: 'Common questions',
          body: COMMON_FAQS.map((faq) => `${faq.q}\n${faq.a}`).join('\n\n'),
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

function infoPages(site) {
  return [
    {
      parentNav: 'info',
      slug: 'aboutus',
      title: `About ${site.business.name}`,
      placement: 'FOOTER',
      icon: 'info',
      short: site.aboutTitle,
      body: [
        site.aboutBody,
        'The company is presented as a practical IT services partner focused on client success, innovation, secure delivery and long-term support.',
      ],
      features: ['Client-first planning', 'Practical technology delivery', 'Support after launch'],
    },
    {
      parentNav: 'info',
      slug: 'contact',
      title: `Contact ${site.business.name}`,
      placement: 'FOOTER',
      icon: 'mail',
      short: 'Start a project enquiry or ask for support.',
      body: [
        `Email ${site.business.email} with your project idea, website need, software requirement or support request.`,
        'Share the goal, timeline, current platform and any technical constraints so the team can recommend the next step.',
      ],
      features: ['Project enquiry', 'Support request', 'Discovery call'],
    },
  ];
}

function pagesForSite(site) {
  return [
    ...servicesForSite(site).map((service, index) => ({
      ...service,
      parentNav: 'services',
      placement: 'DROPDOWN',
      sortOrder: index + 1,
    })),
    ...infoPages(site).map((page, index) => ({
      ...page,
      sortOrder: servicesForSite(site).length + index + 1,
    })),
  ];
}

async function ensureBusiness(site) {
  const existing = await prisma.business.findUnique({ where: { slug: site.business.slug } });
  const data = { ...site.business, isActive: true };
  if (existing) {
    return prisma.business.update({ where: { slug: site.business.slug }, data });
  }
  return prisma.business.create({ data });
}

async function ensureSubscription(businessId) {
  const tier = await prisma.pricingTier.findUnique({ where: { slug: 'static-free' } })
    || await prisma.pricingTier.findUnique({ where: { slug: 'free' } });
  if (!tier) throw new Error('No pricing tier found. Run backend/prisma/seeds/pricing.seed.js first.');
  const forever = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
  const data = {
    tierId: tier.id,
    status: 'ACTIVE',
    billingCycle: 'MONTHLY',
    theme: THEME,
    themeStyle: THEME_STYLE,
    themeColors: null,
    designPreset: 'bold-split',
    sectionVariants: null,
    currentPeriodEnd: forever,
    seatsUsed: 1,
  };
  await prisma.subscription.upsert({
    where: { businessId },
    update: data,
    create: { businessId, ...data },
  });
}

async function ensureAdminUser(site, businessId) {
  const hashed = await bcrypt.hash(site.admin.password, 12);
  const baseData = {
    password: hashed,
    name: site.admin.name,
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
    termsVersion: 'seed-it-services-2026-05',
  };
  await prisma.user.upsert({
    where: { email: site.admin.email },
    update: baseData,
    create: {
      email: site.admin.email,
      ...baseData,
    },
  });
}

async function ensurePages(site, businessId) {
  const rows = [];
  for (const page of pagesForSite(site)) {
    const data = {
      businessId,
      parentNav: page.parentNav,
      slug: page.slug,
      title: page.title,
      templateKey: 'block-page',
      content: buildBlocks(site, page),
      isPublished: true,
      sortOrder: page.sortOrder,
      placement: page.placement,
      iconKey: page.icon,
      metaTitle: `${page.title} | ${site.business.name}`,
      metaDescription: truncate(`${page.short} ${site.business.name} provides IT services for practical business outcomes.`, 155),
      metaKeywords: [page.title, site.business.name, 'IT services', 'software development', 'cloud', 'AI', 'QA'].join(', '),
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
    rows.push(row);
  }
  return rows;
}

async function ensureNav(businessId, pages) {
  const servicePages = pages.filter((page) => page.parentNav === 'services');
  const nav = [
    { kind: 'system', key: 'home', children: [] },
    { kind: 'system', key: 'services', children: servicePages.map((page) => ({ kind: 'custom', pageId: page.id, children: [] })) },
    { kind: 'system', key: 'about', children: [] },
    { kind: 'system', key: 'contact', children: [] },
  ];
  await prisma.business.update({
    where: { id: businessId },
    data: { siteNav: nav },
  });
}

async function seedSite(site) {
  console.log(`[it-services] Creating/updating ${site.business.name}...`);
  const business = await ensureBusiness(site);
  await ensureSubscription(business.id);
  await ensureAdminUser(site, business.id);
  const homeContent = contentForHome(site);
  await prisma.businessContent.upsert({
    where: { businessId: business.id },
    update: homeContent,
    create: { businessId: business.id, ...homeContent },
  });
  const pages = await ensurePages(site, business.id);
  await ensureNav(business.id, pages);
  console.log(`[it-services] ${site.business.name}: ${pages.length} editable pages seeded.`);
  console.log(`[it-services] ${site.business.name}: admin ${site.admin.email} / ${site.admin.password}`);
  console.log(`[it-services] ${site.business.name}: https://${site.business.slug}.aapkatech.com`);
}

async function main() {
  for (const site of SITES) {
    await seedSite(site);
  }
  console.log('[it-services] Done.');
}

main()
  .catch((err) => {
    console.error('[it-services] Failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
