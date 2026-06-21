import { SITE_URL } from '@/lib/seo';

// Next.js robots route → serves /robots.txt for the marketing site.
//
// ⚠️ VERIFY AFTER DEPLOY: sitepresso.com is fronted by Cloudflare, which currently injects a
// managed "Content-Signals" robots.txt at the edge. Confirm this app-served robots.txt is what
// actually appears (and that the Sitemap line survives). If Cloudflare overrides it, either
// disable Cloudflare's managed robots OR rely on submitting the sitemap directly in Google
// Search Console + Bing Webmaster (which does not need the robots Sitemap line).
export default function robots() {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: ['/admin', '/api'] },
      // AI crawlers — allowed for AEO/GEO visibility (owner intent).
      {
        userAgent: [
          'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
          'ClaudeBot', 'Claude-Web', 'anthropic-ai',
          'PerplexityBot', 'Google-Extended', 'CCBot', 'Bingbot',
        ],
        allow: '/',
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
