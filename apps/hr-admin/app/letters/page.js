'use client';

// Letters section landing — the "Letters" nav group header (/letters) lands
// here and redirects to the register (the most-used surface). Templates +
// Letterheads pages are built by 9C/9D; Issue + Register by this slice (9E).

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Centered, Spinner } from '@hr/ui';

export default function LettersIndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/letters/register');
  }, [router]);
  return (
    <Centered>
      <Spinner />
    </Centered>
  );
}
