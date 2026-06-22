import './globals.css';
import ShellGate from '@/components/ShellGate';

export const metadata = {
  title: 'HR Console',
  description: 'Tenant HR & Payroll administration console.',
};

// Root layout for the tenant HR console (app.hr.com, port 3010).
// ShellGate wraps authenticated pages in the sidebar AdminShell and lets
// public routes (login) render bare.
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 min-h-screen text-gray-900">
        <ShellGate>{children}</ShellGate>
      </body>
    </html>
  );
}
