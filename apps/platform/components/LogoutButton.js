'use client';

import { redirectToLogin } from '@/lib/loginRedirect';

/**
 * Inline logout button for the business app. Unlike v1 it doesn't pin itself
 * absolutely — each dashboard places it in its own nav bar.
 *
 * On click: POST /api/auth/logout then hard-redirect to /login on the same
 * origin (i.e. the business's subdomain or custom domain, NOT the platform).
 */
export default function LogoutButton({ className = '' }) {
  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Proceed with local cleanup even if the request fails
    }
    redirectToLogin();
  }

  return (
    <button
      onClick={handleLogout}
      className={
        className ||
        'px-3 py-1.5 text-xs font-medium text-red-600 border border-red-300 rounded-lg hover:bg-red-50 transition-colors'
      }
    >
      Logout
    </button>
  );
}
