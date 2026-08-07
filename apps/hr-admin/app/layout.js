import './globals.css';
import { Manrope } from 'next/font/google';
import ShellGate from '@/components/ShellGate';
import UpdateAvailable from '@/components/UpdateAvailable';

// DriftHR brand typeface. Exposed as --font-manrope (see tailwind.config.js + globals.css).
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-manrope',
  display: 'swap',
});

export const metadata = {
  // Neutral, non-vendor build-time default — the runtime TenantProvider swaps in
  // the tenant's own brand name + favicon. The vendor name (DriftHR) must never
  // appear on a tenant portal, including the pre-hydration tab title.
  title: { default: 'HR Console', template: '%s · HR Console' },
  description: 'HR & payroll workspace.',
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
    title: 'HR Console',
    description: 'HR & payroll workspace.',
    siteName: 'HR Console',
    type: 'website',
  },
};

export const viewport = {
  themeColor: '#16B6A6',
};

// Root layout for the tenant HR console (app.hr.com, port 3010).
// ShellGate wraps authenticated pages in the sidebar AdminShell and lets
// public routes (login) render bare.
export default function RootLayout({ children }) {
  return (
    <html lang="en" className={manrope.variable}>
      <body className="bg-gray-50 min-h-screen text-gray-900">
        <ShellGate>{children}</ShellGate>
        {/* Outside ShellGate on purpose: a tab sitting on the LOGIN page across a
            deploy is just as stale as a signed-in one, and its chunks break the
            same way. */}
        <UpdateAvailable />
      </body>
    </html>
  );
}
