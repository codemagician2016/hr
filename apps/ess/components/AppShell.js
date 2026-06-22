'use client';

// Page chrome for authenticated ESS pages: branded header + content + bottom
// nav. Guards the customer session: if /api/customer/me 401s, redirect to
// /login. Children receive nothing special — pages fetch their own data.

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Centered, Spinner } from '@hr/ui';
import { fetchMe } from '@/lib/api';
import BrandHeader from '@/components/BrandHeader';
import BottomNav from '@/components/BottomNav';

const SessionContext = createContext(null);

export function useSession() {
  return useContext(SessionContext);
}

export default function AppShell({ children }) {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let aborted = false;
    fetchMe()
      .then((data) => { if (!aborted) { setMe(data); setChecking(false); } })
      .catch((e) => {
        if (aborted) return;
        if (e.status === 401) router.replace('/login');
        else setChecking(false);
      });
    return () => { aborted = true; };
  }, [router]);

  if (checking) {
    return (
      <div className="min-h-screen">
        <BrandHeader />
        <Centered><Spinner /></Centered>
      </div>
    );
  }

  return (
    <SessionContext.Provider value={me}>
      <div className="flex min-h-screen flex-col">
        <BrandHeader />
        <main className="ess-scroll mx-auto w-full max-w-3xl flex-1 px-4 py-5">
          {children}
        </main>
        <BottomNav />
      </div>
    </SessionContext.Provider>
  );
}
