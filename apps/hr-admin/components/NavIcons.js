'use client';

// Consistent single-path line icons (24x24 viewBox, stroke=currentColor) for the
// admin console chrome — zero-dependency, matching the ESS portal's approach so
// every nav item inherits the active/idle colour via currentColor. Each entry is
// one SVG path string; <Icon name="…" /> renders it.

export const ICONS = {
  dashboard: 'M3 11l9-8 9 8M5 10v10h6v-6h2v6h6V10',
  people: 'M16 21v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 11a4 4 0 100-8 4 4 0 000 8M22 21v-1a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  org: 'M9 3h6v4H9zM3 17h6v4H3zM15 17h6v4h-6zM12 7v4M6 17v-2a1 1 0 011-1h10a1 1 0 011 1v2',
  onboarding: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
  exit: 'M16 17l5-5-5-5M21 12H9M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4',
  calendar: 'M7 3v4M17 3v4M3 9h18M5 5h14v16H5z',
  leaf: 'M5 21c0-9 7-16 16-16 0 9-7 16-16 16zM5 21c4-4 8-6 12-7',
  clock: 'M12 8v4l3 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  wallet: 'M3 7h16a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2zM3 7V6a2 2 0 012-2h12M17 13h.01',
  coin: 'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  receipt: 'M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4',
  loan: 'M3 10h18M3 6h18v12H3zM7 15h4',
  doc: 'M6 2h9l5 5v15H6zM15 2v5h5M9 13h6M9 17h6',
  chart: 'M3 17l6-6 4 4 8-8M14 7h7v7',
  report: 'M4 3h10l6 6v12H4zM14 3v6h6M8 13h8M8 17h8',
  letter: 'M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM3 7l9 6 9-6',
  letterhead: 'M6 2h12v20H6zM9 6h6M9 10h6M9 14h4',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  register: 'M4 4h16v16H4zM4 9h16M9 4v16',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z',
  bell: 'M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3',
  menu: 'M4 6h16M4 12h16M4 18h16',
};

export function Icon({ name, size = 18, className, strokeWidth = 1.7 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={ICONS[name] || ICONS.doc} />
    </svg>
  );
}

export default Icon;
