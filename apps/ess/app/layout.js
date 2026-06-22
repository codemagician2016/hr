import './globals.css';
import TenantProvider from '@/components/TenantProvider';

// Root layout. TenantProvider resolves the white-label tenant by Host and
// injects the brand CSS variables on <html>, so every page below is branded
// per tenant (5 styles x 12 colors). Pages opt into the chrome (header +
// bottom nav + session guard) by rendering <AppShell>; the login page renders
// bare so it can be reached unauthenticated.

export const metadata = {
  title: 'Employee Self-Service',
  description: 'View payslips, apply for leave, and manage your profile.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#4F46E5',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <TenantProvider>{children}</TenantProvider>
      </body>
    </html>
  );
}
