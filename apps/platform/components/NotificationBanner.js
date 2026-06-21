'use client';

import { useEffect, useState } from 'react';

const TYPE_STYLES = {
  INFO:        { bg: 'bg-blue-600', icon: 'ℹ️' },
  WARNING:     { bg: 'bg-amber-500', icon: '⚠️' },
  URGENT:      { bg: 'bg-red-600', icon: '🚨' },
  MAINTENANCE: { bg: 'bg-gray-700', icon: '🔧' },
};

/**
 * Notification banner — shows at the top of every page.
 * Supports two modes:
 * - dismissible: true  → user can close with ✕ (default)
 * - dismissible: false → static, always visible, no close button
 *
 * Optional link: if linkUrl + linkText are set, shows a CTA button.
 */
export default function NotificationBanner({ target = 'business', businessId }) {
  const [banners, setBanners] = useState([]);
  const [dismissed, setDismissed] = useState(new Set());

  useEffect(() => {
    async function load() {
      try {
        const params = new URLSearchParams({ target });
        if (businessId) params.set('businessId', businessId);
        const res = await fetch(`/api/notifications/active?${params}`);
        if (res.ok) {
          const data = await res.json();
          setBanners(data.banners || []);
        }
      } catch {}
    }
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [target, businessId]);

  // Only hide dismissed ones that ARE dismissible
  const visible = banners.filter(b => b.dismissible === false || !dismissed.has(b.id));
  if (visible.length === 0) return null;

  return (
    <div className="w-full z-50">
      {visible.map(banner => {
        const style = TYPE_STYLES[banner.type] || TYPE_STYLES.INFO;
        const endTime = new Date(banner.endTime);
        const timeLeft = Math.max(0, Math.round((endTime - Date.now()) / 60000));
        const canDismiss = banner.dismissible !== false;

        return (
          <div key={banner.id} className={`${style.bg} text-white`}>
            <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="text-sm flex-shrink-0">{style.icon}</span>
                <p className="text-sm font-medium truncate">{banner.message}</p>
                {timeLeft > 0 && timeLeft < 1440 && (
                  <span className="text-xs opacity-75 flex-shrink-0 hidden sm:inline">
                    · {timeLeft < 60 ? `${timeLeft}m left` : `${Math.round(timeLeft / 60)}h left`}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {banner.linkUrl && banner.linkText && (
                  <a href={banner.linkUrl} target="_blank" rel="noopener noreferrer"
                    className="text-xs font-semibold px-3 py-1 rounded-full bg-white/20 hover:bg-white/30 transition-colors whitespace-nowrap">
                    {banner.linkText} →
                  </a>
                )}
                {canDismiss && (
                  <button
                    onClick={() => setDismissed(prev => new Set([...prev, banner.id]))}
                    className="text-white/70 hover:text-white text-sm w-6 h-6 flex items-center justify-center"
                    aria-label="Dismiss"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
