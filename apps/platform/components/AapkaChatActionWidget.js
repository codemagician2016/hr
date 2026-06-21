'use client';

import { useEffect, useMemo } from 'react';

// The in-admin "Sitepresso assistant" bubble — now a plain CONSUMER of the
// standalone AapkaChat product (chat-api.aapkatech.com), exactly like any
// customer's site would be. No embedded gateway, no Sitepresso-side chat code:
// the widget runs the 'sitepresso' workspace (internal plan, AI Assist service,
// knowledge seeded on the chat box), the assistant answers from that knowledge
// via AapkaChat's AI backend, and human handoffs land in the chat-app inbox
// where the Sitepresso team replies like any other AapkaChat agent.
const CHAT_BASE = process.env.NEXT_PUBLIC_AAPKACHAT_URL || 'https://chat-api.aapkatech.com';
const CHAT_WORKSPACE = process.env.NEXT_PUBLIC_AAPKACHAT_WORKSPACE || 'sitepresso';

function actorRoleFromUser(me) {
  if (me?.role === 'SUPER_ADMIN') return 'super_admin';
  if (me?.role === 'BUSINESS_ADMIN') return 'owner';
  if (me?.role === 'STAFF') return 'staff';
  return 'visitor';
}

export default function AapkaChatActionWidget({ business, me, context = 'admin_portal' }) {
  const rootId = useMemo(
    () => `aapkachat-${context}-${business?.slug || business?.id || 'sitepresso'}`,
    [business?.id, business?.slug, context],
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !business?.slug) return undefined;
    const installKey = `${context}:${business.slug}:${me?.id || me?.email || actorRoleFromUser(me)}`;
    if (window.__sitepressoAapkaChatInstallKey === installKey) return undefined;

    function initWidget() {
      if (!window.AapkaChat?.init) return;
      window.__sitepressoAapkaChatInstallKey = installKey;
      window.AapkaChat.init({
        apiBase: CHAT_BASE,
        workspace: CHAT_WORKSPACE,
        installation: `sitepresso-${business.slug}-${context}`,
        launcherPosition: 'right',
      });
      // The seller is signed in — introduce them so the team sees who's asking.
      window.AapkaChat.identify({
        name: me?.name || me?.email || 'Seller',
        email: me?.email || null,
        metadata: { business: business.slug, role: actorRoleFromUser(me), context },
      });
    }

    if (window.AapkaChat?.init) {
      initWidget();
      return undefined;
    }

    const existing = document.getElementById('aapkachat-widget-script');
    if (existing) {
      existing.addEventListener('load', initWidget, { once: true });
      return () => existing.removeEventListener('load', initWidget);
    }

    const script = document.createElement('script');
    script.id = 'aapkachat-widget-script';
    script.src = `${CHAT_BASE}/widget.js`;
    script.async = true;
    script.addEventListener('load', initWidget, { once: true });
    document.body.appendChild(script);
    return () => script.removeEventListener('load', initWidget);
  }, [business?.slug, context, me, rootId]);

  return <div id={rootId} />;
}
