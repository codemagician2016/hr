'use client';

// A pointer from the core setup guide to a SEPARATE track, and nothing more.
//
// It carries no percentage of its own by default: the core endpoint returns the
// track as a pointer ({ key, title, subtitle, route, anyPermission, entitled })
// precisely so that reading /setup never runs a second track's probes, and so a talent number
// can never be mistaken for part of the core score. If the server later starts
// sending counts on the pointer they render as a quiet suffix — until then the
// card says where to go, not how far along you are.
//
// Nothing renders for a track the tenant isn't entitled to. That case is already
// covered, once, by the locked upsell row inside the core stage list — a second
// advert here would be the "wall of paywall rows" this design exists to avoid.
//
// Nothing renders for an operator the track's own ROUTE would refuse, either. The
// two gates are different keys — /setup opens on canManageCompanyProfile and
// /setup/hiring on canManageHiring OR canManageEmployees — so a custom role can
// reach this page holding neither hiring key. The payload carries the destination's
// gate (`track.anyPermission`) rather than this file restating it, so the card and
// the middleware can never drift apart.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { get } from '@/lib/api';
import { permissionsFromSession, hasAnyPermission } from '@/lib/nav';

export default function TrackCard({ track }) {
  // Deny until the session resolves: this is a pointer, so showing it a beat late
  // costs nothing, while showing it to someone who cannot open it is the bug.
  // /api/auth/me is on lib/api's cacheable allowlist, so this reuses AdminShell's
  // response rather than adding a round-trip.
  const [permitted, setPermitted] = useState(false);
  // A string, not the array itself: every refreshed payload brings a new array
  // identity, which would re-run the effect on each repaint for no reason.
  const gate = (Array.isArray(track?.anyPermission) ? track.anyPermission : []).join(',');

  useEffect(() => {
    const keys = gate ? gate.split(',') : [];
    // An older server that sends no gate: fall back to the entitlement check alone,
    // which is what this card did before.
    if (keys.length === 0) { setPermitted(true); return undefined; }
    let alive = true;
    get('/api/auth/me')
      .then((res) => {
        if (alive) setPermitted(hasAnyPermission(permissionsFromSession(res?.user || res), keys));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [gate]);

  if (!track || track.entitled === false || !track.route || !permitted) return null;

  const done = Number(track.completedCount);
  const total = Number(track.totalCount);
  const progress = Number.isFinite(done) && Number.isFinite(total) && total > 0
    ? `${done} of ${total} done`
    : null;

  return (
    <section className="mt-6" aria-labelledby={`setup-track-${track.key}`}>
      <Link
        href={track.route}
        className="flex items-center justify-between gap-4 rounded-2xl border border-gray-200 bg-white px-4 py-4 hover:bg-gray-50 sm:px-5"
      >
        <span className="min-w-0">
          <span id={`setup-track-${track.key}`} className="block text-base font-semibold text-gray-900">
            {track.title}
            {progress && <span className="ml-2 text-sm font-normal text-gray-600">— {progress}</span>}
          </span>
          {track.subtitle && (
            <span className="mt-0.5 block text-sm text-gray-600">{track.subtitle}</span>
          )}
          {/* The whole point of a second track: its steps are scored on their own
              page and never move the number above. Say so, or the card reads as
              work missing from this list. */}
          <span className="mt-1 block text-xs text-gray-600">
            Scored separately — it doesn’t count towards the percentage above.
          </span>
        </span>
        <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-gray-700">
          Open <span aria-hidden>→</span>
        </span>
      </Link>
    </section>
  );
}
