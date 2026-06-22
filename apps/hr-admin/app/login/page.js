'use client';

// Operator login (tenant-admin / HR users). POSTs to /api/auth/login which
// sets the ae_operator session cookie; on success we send the operator to
// the requested redirect (or the dashboard). Renders bare — ShellGate keeps
// this route outside the AdminShell. useSearchParams is read inside a child
// wrapped in <Suspense> (Next.js app-router CSR-bailout requirement).

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PrimaryButton, TextInput, ErrorBanner } from '@hr/ui';
import { post } from '@/lib/api';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirect = params.get('redirect') || '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await post('/api/auth/login', { email, password });
      router.replace(redirect.startsWith('/') ? redirect : '/');
    } catch (err) {
      setError(err.status === 401 ? 'Invalid email or password.' : err.message || 'Sign in failed.');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/drifthr-logo.svg" alt="DriftHR" className="h-8 w-auto mb-5" />
        <h1 className="text-xl font-semibold text-gray-900 mb-1">Sign in</h1>
        <p className="text-sm text-gray-500 mb-6">Effortless HR &amp; payroll.</p>
        <form onSubmit={onSubmit} className="space-y-4">
          <TextInput
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            required
            placeholder="you@company.com"
          />
          <TextInput
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            required
          />
          {error && <ErrorBanner message={error} />}
          <PrimaryButton type="submit" loading={loading}>
            Sign in
          </PrimaryButton>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <LoginForm />
    </Suspense>
  );
}
