'use client';

import { useState, useEffect, Suspense } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import AuthShell, { Input, PrimaryButton, ErrorBanner } from '@/components/AuthShell';
import LanguageSelector from '@/components/LanguageSelector';
import { getPlatformDomain } from '@/lib/platformDomain';

const PLATFORM_DOMAIN = getPlatformDomain();

// Only allow same-origin redirects to avoid open-redirect attacks
function safeRedirect(redirect) {
  if (typeof redirect !== 'string' || !redirect.startsWith('/')) return null;
  if (redirect.startsWith('//')) return null;
  return redirect;
}

function swapPortalSegment(path, fromSegment, toSegment) {
  const re = new RegExp(`^(/[^/]+/)${fromSegment}(?=($|[/?#]))`);
  return path.replace(re, `$1${toSegment}`);
}

function getSlugFromPortalRedirect(path) {
  const match = path?.match(/^\/([^/]+)\/(?:admin|staff)(?=($|[/?#]))/);
  return match?.[1] || null;
}

function isPortalRedirectForRole(path, role) {
  if (!path) return false;
  if (role === 'BUSINESS_ADMIN') {
    return /^\/[^/]+\/admin(?=($|[/?#]))/.test(path);
  }
  if (role === 'STAFF') {
    return /^\/[^/]+\/staff(?=($|[/?#]))/.test(path);
  }
  return false;
}

function isEcommerceBusiness(business) {
  return String(business?.vertical || '').toUpperCase() === 'ECOMMERCE';
}

function isRiderUser(user) {
  return String(user?.businessRole?.name || '').toLowerCase() === 'rider';
}

function isPickerUser(user) {
  return /picker|packer|warehouse/.test(String(user?.businessRole?.name || '').toLowerCase());
}

function staffPortalPath(slug, business, user) {
  if (isEcommerceBusiness(business) && isRiderUser(user)) return `/${slug}/staff/delivery`;
  if (isEcommerceBusiness(business) && isPickerUser(user)) return `/${slug}/staff/picker`;
  return isEcommerceBusiness(business) ? `/${slug}/staff/manager` : `/${slug}/staff`;
}

function isGenericStaffPortal(path) {
  return /^\/[^/]+\/staff(?=($|[?#]))/.test(path || '');
}

function toEcommerceStaffPortal(path) {
  return String(path || '').replace(/^(\/[^/]+\/staff)(?=($|[?#]))/, '$1/manager');
}

function toEcommerceRiderPortal(path) {
  const raw = String(path || '');
  if (/^\/[^/]+\/staff\/delivery(?=($|[/?#]))/.test(raw)) return raw;
  return raw.replace(/^(\/[^/]+\/staff)(?:\/manager)?(?=($|[/?#]))/, '$1/delivery');
}

function toEcommercePickerPortal(path) {
  const raw = String(path || '');
  if (/^\/[^/]+\/staff\/picker(?=($|[/?#]))/.test(raw)) return raw;
  return raw.replace(/^(\/[^/]+\/staff)(?:\/manager)?(?=($|[/?#]))/, '$1/picker');
}

function normaliseRedirectForRole(path, role) {
  if (!path) return null;

  if (role === 'STAFF') {
    return swapPortalSegment(path, 'admin', 'staff');
  }

  if (role === 'BUSINESS_ADMIN') {
    return swapPortalSegment(path, 'staff', 'admin');
  }

  if (role === 'USER' && /^\/[^/]+\/(?:admin|staff)(?=($|[/?#]))/.test(path)) {
    return null;
  }

  return path;
}

function isUnifiedAdminHost() {
  return typeof window !== 'undefined' && window.location.hostname.startsWith('app.');
}

function FloatingLanguagePicker() {
  const currentLocale = typeof document !== 'undefined'
    ? (document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/)?.[1] || 'en')
    : 'en';
  return (
    <div className="fixed top-4 right-4 z-50">
      <LanguageSelector currentLocale={currentLocale} compact />
    </div>
  );
}

function LoginForm() {
  const t = useTranslations('login');
  const searchParams = useSearchParams();
  const redirectParam = safeRedirect(searchParams.get('redirect'));
  // Detect the post-Paddle case: user just paid but their JWT cookie didn't
  // survive the cross-domain round trip. Show a reassuring banner so they
  // know their payment worked and they just need to re-auth.
  const cameFromBillingSuccess =
    redirectParam &&
    /[?&]billing=success(?:&|$)/.test(redirectParam);
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [mode, setMode] = useState('form');
  const [postLoginInfo, setPostLoginInfo] = useState(null);

  // Detect super-admin context. When the user reaches the login via an
  // `admin.*` host (admin.sitepresso.com / admin.aapkatech.com), we
  // re-skin the page for the platform-operator audience: different copy,
  // no "Create an account" link (super-admins don't self-register), and
  // a console-style title. The same `/login` route still works for
  // business owners + staff on the apex domain — only the copy changes.
  const [isAdminHost, setIsAdminHost] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hostname.startsWith('admin.')) {
      setIsAdminHost(true);
    }
  }, []);

  function handleChange(e) {
    setForm({ ...form, [e.target.name]: e.target.value });
    setError('');
  }

  async function resolveBusinessSlug() {
    try {
      const { data } = await axios.get('/api/business/context', { withCredentials: true });
      return data.business.slug;
    } catch { return null; }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const { data } = await axios.post('/api/auth/login', form, {
        withCredentials: true,
        headers: { 'Content-Type': 'application/json' },
      });
      const user = data.user;
      const businessSlug = data.business?.slug || user?.businessSlug || null;
      const roleRedirect = normaliseRedirectForRole(redirectParam, user.role);

      if (user.role === 'SUPER_ADMIN') {
        // On admin.* host the only allowed routes are /login, /superadmin,
        // /__connect, /business, /forgot-password, /reset-password.
        // Redirect-param like "/" or "/admin/foo" would loop back to login,
        // so route SUPER_ADMIN to /superadmin unless the param is itself
        // one of the allowed admin-host paths.
        const ADMIN_HOST_OK = /^\/(superadmin|business|__connect|forgot-password|reset-password)(\/|$|\?)/;
        const safeForAdminHost = roleRedirect && ADMIN_HOST_OK.test(roleRedirect);
        const onAdminHost =
          typeof window !== 'undefined' && window.location.hostname.startsWith('admin.');
        window.location.href = onAdminHost
          ? (safeForAdminHost ? roleRedirect : '/superadmin')
          : (roleRedirect || '/superadmin');
        return;
      }

      if (user.role === 'BUSINESS_ADMIN') {
        if (!user.businessId) {
          window.location.href = roleRedirect || '/onboarding';
          return;
        }
        if (isUnifiedAdminHost()) {
          // replace (not href) so the login page is NOT left in the back stack —
          // otherwise the browser Back button from the dashboard returns to login.
          window.location.replace('/dashboard');
          return;
        }
        if (isPortalRedirectForRole(roleRedirect, user.role)) {
          window.location.href = roleRedirect;
          return;
        }
        const slugFromRedirect = getSlugFromPortalRedirect(roleRedirect);
        // The admin's OWN business is authoritative. A stale
        // `?redirect=/<otherSlug>/admin` (e.g. logging in as a different
        // account after a logout) must NOT route them into another tenant —
        // that dead-ends on the "Wrong business" screen. Only honour the
        // redirect's slug when it matches their own workspace.
        const ownSlug = businessSlug || await resolveBusinessSlug();
        const slug = slugFromRedirect && slugFromRedirect === ownSlug ? slugFromRedirect : ownSlug;
        if (slug) window.location.href = `/${slug}/admin`;
        else window.location.href = roleRedirect || '/onboarding';
        return;
      }

      if (user.role === 'STAFF') {
        if (isPortalRedirectForRole(roleRedirect, user.role)) {
          window.location.href = isEcommerceBusiness(data.business)
            ? (isRiderUser(user)
              ? toEcommerceRiderPortal(roleRedirect)
              : (isPickerUser(user)
                ? toEcommercePickerPortal(roleRedirect)
                : (isGenericStaffPortal(roleRedirect) ? toEcommerceStaffPortal(roleRedirect) : roleRedirect)))
            : roleRedirect;
          return;
        }
        const slugFromRedirect = getSlugFromPortalRedirect(roleRedirect);
        // Own business wins over a stale cross-tenant redirect (see admin branch).
        const ownSlug = businessSlug || await resolveBusinessSlug();
        const slug = slugFromRedirect && slugFromRedirect === ownSlug ? slugFromRedirect : ownSlug;
        if (slug) {
          window.location.href = staffPortalPath(slug, data.business, user);
        } else {
          setPostLoginInfo({ role: 'STAFF', slug: null });
          setMode('redirectBusiness');
          setLoading(false);
        }
        return;
      }

      if (user.role === 'USER') {
        window.location.href = roleRedirect || '/onboarding';
        return;
      }
      window.location.href = roleRedirect || '/';
    } catch (err) {
      const body = err.response?.data;
      // Unverified account — route into the signup page's OTP step to verify
      // and recover (verify issues the session). Recoverable, not a lockout.
      if (body?.verificationRequired) {
        const q = new URLSearchParams({ verifyEmail: body.email || form.email });
        if (redirectParam) q.set('redirect', redirectParam);
        window.location.href = `/signup?${q.toString()}`;
        return;
      }
      console.error('Login error:', err.response?.status, body);
      setError(body?.message || t('loginFailed'));
      setLoading(false);
    }
  }

  if (mode === 'redirectBusiness' && postLoginInfo) {
    return (
      <>
        <FloatingLanguagePicker />
        <BusinessRedirectNotice info={postLoginInfo} t={t} />
      </>
    );
  }

  return (
    <>
      <FloatingLanguagePicker />
      <AuthShell
        eyebrow={isAdminHost ? 'DriftHR Console' : t('eyebrow')}
        title={isAdminHost
          ? <>Super admin <span className="italic text-indigo-600" style={{ fontFamily: 'Georgia, "Times New Roman", ui-serif, serif' }}>sign-in.</span></>
          : <>{t('titleStart')} <span className="italic text-indigo-600" style={{ fontFamily: 'Georgia, "Times New Roman", ui-serif, serif' }}>{t('titleItalic')}</span></>}
        subtitle={isAdminHost ? 'Manage tenants, pricing, and platform settings.' : t('subtitle')}
        footerNote={t('footerNote')}
      >
        {cameFromBillingSuccess && (
          <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 flex items-start gap-3">
            <span className="mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-600 text-white text-xs font-bold">✓</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-emerald-900">Your payment was successful!</p>
              <p className="text-xs text-emerald-800 mt-0.5">
                Log back in to continue to your admin dashboard. Your subscription is already active.
              </p>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="email" name="email" required autoComplete="email"
            label={t('email')}
            placeholder={t('emailPlaceholder')}
            value={form.email} onChange={handleChange}
          />
          <Input
            type="password" name="password" required autoComplete="current-password"
            label={t('password')}
            rightSlot={
              <Link href="/forgot-password" className="text-xs text-indigo-600 font-medium hover:underline">
                {t('forgot')}
              </Link>
            }
            placeholder={t('passwordPlaceholder')}
            value={form.password} onChange={handleChange}
          />
          <ErrorBanner message={error} />
          <PrimaryButton type="submit" loading={loading}>
            {loading ? t('submitLoading') : `${t('submit')} →`}
          </PrimaryButton>
        </form>

        {/* Super-admins don't self-register — only show the signup link
            for business-owner / staff visitors on the apex domain. */}
        {!isAdminHost && (
          <p className="text-center text-sm text-gray-500 mt-8">
            {t('noAccount')}{' '}
            <Link
              href={redirectParam ? `/signup?redirect=${encodeURIComponent(redirectParam)}` : '/signup'}
              className="text-indigo-600 font-semibold hover:underline"
            >
              {t('createOne')}
            </Link>
          </p>
        )}
      </AuthShell>
    </>
  );
}

function BusinessRedirectNotice({ info, t }) {
  const path = info.role === 'STAFF' ? 'staff' : 'admin';
  const targetUrl = info.slug ? `/${info.slug}/${path}` : null;
  const label = info.role === 'STAFF' ? t('staffPortal') : t('businessAdmin');

  return (
    <AuthShell eyebrow={t('almostThere')} title={t('needsBusinessUrl', { label })}>
      {targetUrl ? (
        <>
          <p className="text-sm text-gray-600">{t('continueToPortal')}</p>
          <div className="mt-5 p-4 bg-gray-50 border border-gray-200 rounded-xl font-mono text-sm text-indigo-700 break-all">
            {PLATFORM_DOMAIN}{targetUrl}
          </div>
          <a
            href={targetUrl}
            className="mt-5 inline-flex items-center justify-center w-full px-5 py-3 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-indigo-600 to-purple-600 hover:shadow-md transition-all"
          >
            {t('takeMeThere')} →
          </a>
        </>
      ) : (
        <p className="text-sm text-gray-600">{t('couldntResolve')}</p>
      )}
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
