import articles from '@/lib/blogArticles';
import { publishedThemePages } from '@/lib/seoThemePages';
import { publishedAnswerPages } from '@/lib/seoAnswerPages';
import { publishedCategoryPages } from '@/lib/seoCategoryPages';
import { SITE_URL } from '@/lib/seo';

// Next.js sitemap route → /sitemap.xml for the marketing site.
// Phase B will append the generated theme/category/answer pages (content-seo engine) here,
// filtered to status: published. For now: landing + blog + key legal pages.
const STATIC_PATHS = [
  { path: '/', priority: 1.0, changeFrequency: 'weekly' },
  { path: '/blog', priority: 0.8, changeFrequency: 'daily' },
  { path: '/legal/privacy', priority: 0.2, changeFrequency: 'yearly' },
  { path: '/legal/terms', priority: 0.2, changeFrequency: 'yearly' },
];

export default function sitemap() {
  const now = new Date();

  const staticEntries = STATIC_PATHS.map((p) => ({
    url: `${SITE_URL}${p.path}`,
    lastModified: now,
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }));

  const blogEntries = (articles || []).map((a) => ({
    url: `${SITE_URL}/blog/${a.slug}`,
    lastModified: a.publishedAt ? new Date(a.publishedAt) : now,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  // content-seo engine: published theme/template pages (Phase B render route /themes/[slug]).
  const themeEntries = publishedThemePages().map((p) => ({
    url: `${SITE_URL}/themes/${p.slug}`,
    lastModified: p.updatedAt ? new Date(p.updatedAt) : now,
    changeFrequency: 'monthly',
    priority: 0.7,
  }));

  // content-seo engine: published AI-answer (AEO/GEO) pages → /answers/[slug].
  const answerEntries = publishedAnswerPages().map((p) => ({
    url: `${SITE_URL}/answers/${p.slug}`,
    lastModified: p.updatedAt ? new Date(p.updatedAt) : now,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  // content-seo engine: buyer-intent category "money pages" → /website-builder/[slug].
  const categoryEntries = publishedCategoryPages().map((p) => ({
    url: `${SITE_URL}/website-builder/${p.slug}`,
    lastModified: p.updatedAt ? new Date(p.updatedAt) : now,
    changeFrequency: 'monthly',
    priority: 0.8,
  }));

  return [...staticEntries, ...categoryEntries, ...themeEntries, ...answerEntries, ...blogEntries];
}
