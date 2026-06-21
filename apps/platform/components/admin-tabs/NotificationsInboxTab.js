'use client';

// Extracted from [slug]/admin/page.js 2026-04-29 as part of the admin
// page split.

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, PrimaryButton, Modal, ModalActions, TextInput, TextArea, Empty, formatAdminDate, formatAdminDateTime, formatMoneyMinor } from '@/components/admin-ui';
import NotificationInboxPanel from '@/components/NotificationInboxPanel';
import { getPlatformDomain } from '@/lib/platformDomain';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

function NotificationsInboxTab() {
  return (
    <NotificationInboxPanel
      title="Notifications"
      description="See new bookings, customer cancellations, confirmations, and reschedules in one inbox."
    />
  );
}

// Bell icon sitting in the top-right header. Polls the inbox endpoint
// every 45s to keep the unread badge roughly fresh without hammering the
// server. Click opens the full Notifications view in the main content
// area (same data, more room, familiar pattern).
function NotificationsBell({ onOpen, active }) {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function fetchCount() {
      try {
        const data = await api('/api/inbox?filter=unread');
        if (!cancelled) setUnread(data.unreadCount || 0);
      } catch { /* silent — bell just shows zero */ }
    }
    fetchCount();
    const timer = setInterval(fetchCount, 45000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // When the user is already viewing the notifications tab, clicking the
  // bell won't do much visually — but it's also not wrong. Keep the
  // behaviour consistent and let them click.
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={unread > 0 ? `Notifications — ${unread} unread` : 'Notifications'}
      title={unread > 0 ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'Notifications'}
      className={`relative w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${
        active ? 'bg-indigo-50 text-indigo-600' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
      }`}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 01-3.46 0" />
      </svg>
      {unread > 0 && (
        <span
          className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center"
          aria-hidden
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}

// ============================================================================
// Settings tab
// ============================================================================
const PLATFORM_DOMAIN = getPlatformDomain();
const SLUG_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;


export default NotificationsInboxTab;
export { NotificationsBell };
