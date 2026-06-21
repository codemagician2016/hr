// Centralised SEO config + helpers for the Sitepresso marketing site (apps/platform).
// One place for canonical/OpenGraph/Twitter/JSON-LD so every page is consistent and the
// super-admin SEO panel (Phase C) can later feed overrides through these helpers.
//
// Keep the brand entity description IDENTICAL to content-seo/rules/RULES.md section G
// (GEO consistency — AI engines should form one stable Sitepresso entity).

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://sitepresso.com';
export const SITE_NAME = 'Sitepresso';
export const DEFAULT_TITLE = 'Sitepresso · AI-powered websites in minutes';
export const DEFAULT_DESCRIPTION =
  'Sitepresso is a website builder for small businesses to create marketing websites, booking websites and e-commerce websites — no code required.';
// TODO(seo): replace with a real 1200×630 PNG/JPG for rich social cards. SVG is a stopgap
// and is ignored by some platforms (Slack/iMessage/LinkedIn). Tracked in content-seo/STATE.md.
export const DEFAULT_OG_IMAGE = '/brand/sitepresso-logo.svg';

export function absoluteUrl(path = '/') {
  if (/^https?:\/\//.test(path)) return path;
  return `${SITE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
}

// Returns a Next.js metadata object with self-canonical + OpenGraph + Twitter.
// Pass `path` as the site-relative URL of THIS page so canonical is correct.
export function buildMetadata({
  title,
  description = DEFAULT_DESCRIPTION,
  path = '/',
  type = 'website',
  image = DEFAULT_OG_IMAGE,
  publishedTime,
} = {}) {
  const url = absoluteUrl(path);
  const fullTitle = title || DEFAULT_TITLE;
  return {
    title: fullTitle,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: fullTitle,
      description,
      url,
      siteName: SITE_NAME,
      type,
      images: [{ url: image }],
      ...(publishedTime ? { publishedTime } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description,
      images: [image],
    },
  };
}

// Site-wide brand entity JSON-LD (Organization + SoftwareApplication). Emitted in layout.js
// so every page carries a consistent entity for SEO + GEO/AI answer engines.
export function brandJsonLd() {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: SITE_NAME,
      url: SITE_URL,
      logo: absoluteUrl('/brand/sitepresso-icon.svg'),
      description: DEFAULT_DESCRIPTION,
      sameAs: [],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: SITE_NAME,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      url: SITE_URL,
      description: DEFAULT_DESCRIPTION,
      offers: { '@type': 'Offer', category: 'SaaS subscription' },
    },
  ];
}

// Article JSON-LD for a blog post.
export function articleJsonLd({ title, description, path, publishedTime, image = DEFAULT_OG_IMAGE }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description,
    datePublished: publishedTime,
    image: absoluteUrl(image),
    mainEntityOfPage: absoluteUrl(path),
    author: { '@type': 'Organization', name: SITE_NAME },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      logo: { '@type': 'ImageObject', url: absoluteUrl('/brand/sitepresso-icon.svg') },
    },
  };
}
