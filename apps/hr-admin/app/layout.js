import './globals.css';
import { Manrope } from 'next/font/google';
import ShellGate from '@/components/ShellGate';

// DriftHR brand typeface. Exposed as --font-manrope (see tailwind.config.js + globals.css).
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-manrope',
  display: 'swap',
});

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
      </body>
    </html>
  );
}
