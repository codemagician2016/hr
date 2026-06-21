// SEO helpers — schema.org JSON-LD generators + sitemap XML builder.
'use strict';

// Generate LocalBusiness JSON-LD for a tenant's storefront homepage.
function localBusinessJsonLd(business) {
  const obj = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: business.name,
    image: business.logoUrl || undefined,
    address: business.address ? {
      '@type': 'PostalAddress',
      streetAddress: business.address,
      addressLocality: business.city || undefined,
      addressRegion: business.state || undefined,
      postalCode: business.postalCode || undefined,
      addressCountry: business.country || undefined,
    } : undefined,
    telephone: business.phone || undefined,
    // BYO retired 2026-05-10 — always use the platform subdomain
    url: `https://${business.slug}.sitepresso.com`,
    priceRange: business.priceRange || undefined,
  };
  return JSON.stringify(obj);
}

// Service / Article JSON-LD for blog posts.
function articleJsonLd({ title, excerpt, coverImageUrl, authorName, publishedAt, businessName, url }) {
  const obj = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description: excerpt,
    image: coverImageUrl || undefined,
    author: { '@type': 'Person', name: authorName || businessName },
    publisher: { '@type': 'Organization', name: businessName },
    datePublished: publishedAt,
    mainEntityOfPage: url,
  };
  return JSON.stringify(obj);
}

// BreadcrumbList JSON-LD for nested navigation.
function breadcrumbJsonLd(items) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  });
}

// XML sitemap from a list of { url, lastmod }.
function buildSitemapXml(entries) {
  const items = entries.map(({ url, lastmod, changefreq = 'weekly', priority = 0.5 }) => `
  <url>
    <loc>${url}</loc>
    ${lastmod ? `<lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}
</urlset>`;
}

// robots.txt content. Allow indexing by default; disallow specific paths.
function buildRobotsTxt({ sitemapUrl, disallowed = [] }) {
  const dis = disallowed.map((p) => `Disallow: ${p}`).join('\n');
  return `User-agent: *
${dis || 'Allow: /'}
${sitemapUrl ? `Sitemap: ${sitemapUrl}` : ''}
`;
}

module.exports = {
  localBusinessJsonLd,
  articleJsonLd,
  breadcrumbJsonLd,
  buildSitemapXml,
  buildRobotsTxt,
};
