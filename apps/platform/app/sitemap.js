import { SITE_URL } from '@/lib/seo';

// Next.js sitemap route → /sitemap.xml for the DriftHR marketing site.
const STATIC_PATHS = [
  { path: '/', priority: 1.0, changeFrequency: 'weekly' },
  { path: '/legal/privacy', priority: 0.2, changeFrequency: 'yearly' },
  { path: '/legal/terms', priority: 0.2, changeFrequency: 'yearly' },
];

export default function sitemap() {
  const now = new Date();
  return STATIC_PATHS.map((p) => ({
    url: `${SITE_URL}${p.path}`,
    lastModified: now,
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }));
}
