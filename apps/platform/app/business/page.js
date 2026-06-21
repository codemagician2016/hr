'use client';

import { useEffect, useState } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { getPlatformDomain } from '@/lib/platformDomain';

const PLATFORM_DOMAIN = getPlatformDomain();

function isRiderUser(user) {
  return String(user?.businessRole?.name || '').toLowerCase() === 'rider';
}

function isPickerUser(user) {
  return /picker|packer|warehouse/.test(String(user?.businessRole?.name || '').toLowerCase());
}

export default function BusinessHub() {
  const [status, setStatus] = useState('loading'); // loading | redirect | no-business | error
  const [message, setMessage] = useState('');

  useEffect(() => {
    async function check() {
      try {
        const { data: authData } = await axios.get('/api/auth/me', { withCredentials: true });
        const user = authData.user;

        if (user.role === 'SUPER_ADMIN') {
          window.location.href = '/superadmin';
          return;
        }

        if (!user.businessId) {
          // No business yet — send to onboarding
          window.location.href = '/onboarding';
          return;
        }

        // Has a business — redirect to the canonical platform path.
        // The [slug]/admin or [slug]/staff page renders natively.
        try {
          const { data: bizData } = await axios.get('/api/business/me', { withCredentials: true });
          const slug = bizData.business.slug;
          const isEcommerce = String(bizData.business.vertical || '').toUpperCase() === 'ECOMMERCE';
          const path = user.role === 'STAFF'
            ? (isEcommerce ? `/${slug}/staff/${isRiderUser(user) ? 'delivery' : (isPickerUser(user) ? 'picker' : 'manager')}` : `/${slug}/staff`)
            : `/${slug}/admin`;
          setMessage(`Redirecting to ${PLATFORM_DOMAIN}${path}...`);
          setStatus('redirect');
          window.location.href = path;
        } catch {
          // Business ID exists but can't fetch it — rare edge case
          window.location.href = '/onboarding';
        }
      } catch (err) {
        if (err.response?.status === 401) {
          window.location.href = '/login?redirect=/business';
          return;
        }
        setStatus('error');
        setMessage('Something went wrong. Please try again.');
      }
    }
    check();
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        {status === 'loading' && (
          <>
            <svg className="animate-spin h-8 w-8 text-indigo-600 mx-auto" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            <p className="mt-4 text-sm text-gray-500">Checking your account...</p>
          </>
        )}

        {status === 'redirect' && (
          <>
            <svg className="animate-spin h-8 w-8 text-indigo-600 mx-auto" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            <p className="mt-4 text-sm text-gray-600">{message}</p>
          </>
        )}

        {status === 'error' && (
          <div className="bg-white rounded-2xl border border-gray-200 p-8">
            <p className="text-red-600 text-sm">{message}</p>
            <div className="mt-4 flex gap-3 justify-center">
              <button onClick={() => window.location.reload()} className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700">
                Try again
              </button>
              <Link href="/login" className="px-4 py-2 border border-gray-200 text-gray-700 text-sm font-semibold rounded-lg hover:border-gray-300">
                Log in
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
