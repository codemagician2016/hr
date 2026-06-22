import './globals.css';
import { Manrope } from 'next/font/google';
import TenantProvider from '@/components/TenantProvider';

// DriftHR brand typeface. Exposed as --font-manrope (see tailwind.config.js + globals.css).
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-manrope',
  display: 'swap',
});

// Root layout. TenantProvider resolves the white-label tenant by Host and
// injects the brand CSS variables on <html>, so every page below is branded
// per tenant (5 styles x 12 colors). Pages opt into the chrome (header +
// bottom nav + session guard) by rendering <AppShell>; the login page renders
// bare so it can be reached unauthenticated. When a tenant has no custom brand,
// DriftHR is shown as the default product identity.

export const metadata = {
  title: { default: 'DriftHR', template: '%s · DriftHR' },
  description: 'Effortless HR & payroll.',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  openGraph: {
    title: 'DriftHR',
    description: 'Effortless HR & payroll.',
    siteName: 'DriftHR',
    type: 'website',
    images: [{ url: '/drifthr-social-1200x630.png' }],
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#16B6A6',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={manrope.variable}>
      <body className="min-h-screen">
        <TenantProvider>{children}</TenantProvider>
      </body>
    </html>
  );
}
