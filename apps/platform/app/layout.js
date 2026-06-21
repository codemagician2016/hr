import './globals.css';
import NotificationBanner from '@/components/NotificationBanner';
import PostHogInit from '@/components/PostHogInit';
import CookieConsent from '@/components/CookieConsent';
import { ConfirmDialogProvider } from '@/components/ConfirmDialog';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { SITE_URL, SITE_NAME, DEFAULT_TITLE, DEFAULT_DESCRIPTION, DEFAULT_OG_IMAGE, brandJsonLd } from '@/lib/seo';

// Async because next-intl's locale + message lookup runs on the
// server. The locale comes from the NEXT_LOCALE cookie (read by
// platform/i18n/request.js); messages are the matching JSON bundle.
// Both are passed to <NextIntlClientProvider> so client components
// throughout the tree can call useTranslations() without per-page
// boilerplate.
export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: DEFAULT_TITLE,
  description: DEFAULT_DESCRIPTION,
  openGraph: {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    url: SITE_URL,
    siteName: SITE_NAME,
    type: 'website',
    images: [{ url: DEFAULT_OG_IMAGE }],
  },
  twitter: {
    card: 'summary_large_image',
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    images: [DEFAULT_OG_IMAGE],
  },
  icons: { icon: '/brand/sitepresso-icon.svg' },
};

export default async function RootLayout({ children }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale}>
      <body className="bg-gray-50 min-h-screen">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(brandJsonLd()) }}
        />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ConfirmDialogProvider>
            <PostHogInit />
            <NotificationBanner target="platform" />
            {children}
            <CookieConsent />
          </ConfirmDialogProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
