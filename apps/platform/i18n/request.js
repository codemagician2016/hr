// next-intl server-side config. Reads the active locale from the
// NEXT_LOCALE cookie set by the middleware, loads the matching JSON
// message bundle, and feeds both into the rendering pipeline.
//
// Cookie set by `<LanguageSelector>` (and the middleware on first
// visit). Falls back to the configured default if the cookie is
// missing or names a locale we don't ship.

import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from './config';

export default getRequestConfig(async () => {
  const cookieStore = cookies();
  const requested = cookieStore.get('NEXT_LOCALE')?.value;
  const locale = SUPPORTED_LOCALES.includes(requested) ? requested : DEFAULT_LOCALE;

  let messages;
  try {
    messages = (await import(`../messages/${locale}.json`)).default;
  } catch {
    // Locale file missing — fall back to default so the app keeps
    // rendering. Surfaces in dev as the page-in-English; in prod we
    // log so the missing file shows up.
    messages = (await import(`../messages/${DEFAULT_LOCALE}.json`)).default;
  }

  return { locale, messages };
});
