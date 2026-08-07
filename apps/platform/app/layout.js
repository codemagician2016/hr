import './globals.css';
import { Manrope } from 'next/font/google';
import NotificationBanner from '@/components/NotificationBanner';
import PostHogInit from '@/components/PostHogInit';
import CookieConsent from '@/components/CookieConsent';
import { ConfirmDialogProvider } from '@/components/ConfirmDialog';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { SITE_URL, SITE_NAME, DEFAULT_TITLE, DEFAULT_DESCRIPTION, DEFAULT_OG_IMAGE, brandJsonLd } from '@/lib/seo';
import UpdateAvailable from '@/components/UpdateAvailable';

// DriftHR brand typeface. Exposed as --font-manrope (see tailwind.config.js).
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-manrope',
  display: 'swap',
});

// Async because next-intl's locale + message lookup runs on the
// server. The locale comes from the NEXT_LOCALE cookie (read by
// platform/i18n/request.js); messages are the matching JSON bundle.
// Both are passed to <NextIntlClientProvider> so client components
// throughout the tree can call useTranslations() without per-page
// boilerplate.
export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
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
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export const viewport = {
  themeColor: '#16B6A6',
};

export default async function RootLayout({ children }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale} className={manrope.variable}>
      <body className="bg-gray-50 min-h-screen font-sans">
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
        {/* Outside the intl provider: a tab on the signed-out marketing/login
            pages goes stale across a deploy exactly like an app page. */}
        <UpdateAvailable />
      </body>
    </html>
  );
}
