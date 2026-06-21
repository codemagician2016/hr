// Diagnostic endpoint — dumps everything the middleware sees so users
// debugging VPN / geo-IP / locale issues can read it without needing
// to inspect cookies + headers manually. Safe to keep public; nothing
// sensitive returned.

import { COUNTRY_LOCALE_MAP, SUPPORTED_LOCALES, DEFAULT_LOCALE, localeFromCountry } from '@/i18n/config';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

function bestLocaleFromHeader(header) {
  if (!header) return null;
  const tags = header.split(',').map((entry) => entry.split(';')[0].trim()).filter(Boolean);
  for (const raw of tags) {
    const tag = raw.toLowerCase();
    const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === tag);
    if (exact) return exact;
    const prefix = tag.split('-')[0];
    const prefixHit = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === prefix);
    if (prefixHit) return prefixHit;
  }
  return null;
}

export async function GET(request) {
  const country = request.headers.get('cf-ipcountry')
    || request.geo?.country
    || request.headers.get('x-vercel-ip-country')
    || null;
  const city = request.headers.get('cf-ipcity')
    || request.geo?.city
    || request.headers.get('x-vercel-ip-city')
    || null;
  const acceptLang = request.headers.get('accept-language') || null;
  const cookieHeader = request.headers.get('cookie') || '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/);
  const cookieLocale = cookieMatch ? cookieMatch[1] : null;

  const fromGeo = country ? localeFromCountry(country) : null;
  const fromHeader = bestLocaleFromHeader(acceptLang);

  let detected;
  let detectedSource;
  if (cookieLocale && SUPPORTED_LOCALES.includes(cookieLocale)) {
    detected = cookieLocale;
    detectedSource = 'cookie (sticky from earlier visit or pick)';
  } else if (fromGeo && SUPPORTED_LOCALES.includes(fromGeo)) {
    detected = fromGeo;
    detectedSource = 'geo-IP';
  } else if (fromHeader) {
    detected = fromHeader;
    detectedSource = 'Accept-Language header';
  } else {
    detected = DEFAULT_LOCALE;
    detectedSource = 'default fallback';
  }

  return Response.json({
    visitor: {
      country,
      city,
      acceptLanguage: acceptLang,
    },
    cookie: {
      NEXT_LOCALE: cookieLocale,
    },
    detection: {
      fromGeo,
      fromAcceptLanguage: fromHeader,
      finalLocale: detected,
      source: detectedSource,
    },
    config: {
      supportedLocales: SUPPORTED_LOCALES,
      defaultLocale: DEFAULT_LOCALE,
      countryMap: COUNTRY_LOCALE_MAP,
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
