'use client';

// Mobile-first bottom tab bar. Active tab uses the tenant brand color.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Home', icon: 'M3 11l9-8 9 8M5 10v10h14V10' },
  { href: '/payslips', label: 'Payslips', icon: 'M6 2h9l5 5v15H6zM15 2v5h5' },
  { href: '/attendance', label: 'Clock', icon: 'M12 8v4l3 2M12 3a9 9 0 100 18 9 9 0 000-18z' },
  { href: '/leave', label: 'Leave', icon: 'M7 3v4M17 3v4M3 9h18M5 5h14v16H5z' },
  { href: '/profile', label: 'Profile', icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0' },
];

function isActive(pathname, href) {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

export default function BottomNav() {
  const pathname = usePathname() || '/';
  return (
    <nav className="sticky bottom-0 z-20 border-t bg-white/95 backdrop-blur"
         style={{ borderColor: 'var(--theme-border)' }}>
      <div className="mx-auto flex max-w-3xl items-stretch justify-around">
        {TABS.map((t) => {
          const active = isActive(pathname, t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className="flex flex-1 flex-col items-center gap-1 py-2 text-[11px] font-medium"
              style={{ color: active ? 'var(--theme-primary)' : 'var(--theme-muted)' }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d={t.icon} />
              </svg>
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
