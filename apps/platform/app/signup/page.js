'use client';

import { useState, useEffect, Suspense } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import AuthShell, { Input, PrimaryButton, ErrorBanner } from '@/components/AuthShell';
import LanguageSelector from '@/components/LanguageSelector';

function safeRedirect(redirect) {
  if (typeof redirect !== 'string' || !redirect.startsWith('/')) return null;
  if (redirect.startsWith('//')) return null;
  return redirect;
}

function SignupForm() {
  const t = useTranslations('signup');
  const searchParams = useSearchParams();
  const redirectParam = safeRedirect(searchParams.get('redirect'));
  const verifyEmailParam = searchParams.get('verifyEmail');
  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [loading, setLoading] = useState(false);

  const [showOtp, setShowOtp] = useState(false);
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [otpError, setOtpError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  // Recovery path: the login page redirects an unverified account here with
  // ?verifyEmail=<email>. Jump straight to the OTP step and send a fresh code
  // so the user can verify and get a session without being locked out.
  useEffect(() => {
    if (!verifyEmailParam) return;
    setForm((f) => ({ ...f, email: verifyEmailParam }));
    setShowOtp(true);
    axios.post('/api/auth/send-otp', { email: verifyEmailParam }, { withCredentials: true }).catch(() => {});
    startCooldown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentLocale = typeof document !== 'undefined'
    ? (document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/)?.[1] || 'en')
    : 'en';

  function handleChange(e) {
    setForm({ ...form, [e.target.name]: e.target.value });
    setErrors({ ...errors, [e.target.name]: '' });
    setServerError('');
  }

  function validate() {
    const newErrors = {};
    if (!form.name.trim()) newErrors.name = t('errors.nameRequired');
    if (!form.email) newErrors.email = t('errors.emailRequired');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) newErrors.email = t('errors.emailInvalid');
    if (!form.password) newErrors.password = t('errors.passwordRequired');
    else if (form.password.length < 8) newErrors.password = t('errors.passwordTooShort');
    else if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(form.password)) {
      newErrors.password = t('errors.passwordTooWeak');
    }
    if (form.password !== form.confirmPassword) newErrors.confirmPassword = t('errors.passwordsMismatch');
    if (!acceptTerms) newErrors.acceptTerms = t('errors.acceptTermsRequired');
    return newErrors;
  }

  function startCooldown() {
    setResendCooldown(60);
    const interval = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) { clearInterval(interval); return 0; }
        return prev - 1;
      });
    }, 1000);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) { setErrors(validationErrors); return; }

    setLoading(true);
    setServerError('');
    try {
      // Atomic register: backend sends the OTP itself and only persists
      // the user if the mail provider accepted the address. So we no
      // longer need a separate /send-otp call here on the happy path.
      await axios.post('/api/auth/register', {
        name: form.name, email: form.email, password: form.password,
        acceptTerms: true,
      }, { withCredentials: true, headers: { 'Content-Type': 'application/json' } });

      setShowOtp(true);
      startCooldown();
      setLoading(false);
    } catch (err) {
      console.error('Registration error:', err.response?.status, err.response?.data);
      const status = err.response?.status;
      const body = err.response?.data;
      // 409 = email already registered — nudge to login
      // 502 = mail provider rejected the address — keep them on the form
      const fallback = status === 502
        ? t('errors.emailUndeliverable', { defaultValue: 'We could not deliver a verification email to that address.' })
        : t('errors.registrationFailed');
      // The backend sometimes returns a raw i18n key (e.g. "signup.errors.emailUndeliverable")
      // as its message — translate those instead of leaking the key to the UI.
      const raw = body?.message;
      const looksLikeKey = typeof raw === 'string' && /^[\w-]+(\.[\w-]+)+$/.test(raw) && !raw.includes(' ');
      const message = looksLikeKey
        ? t(raw.replace(/^signup\./, ''), { defaultValue: fallback })
        : (raw || fallback);
      setServerError(message);
      setLoading(false);
    }
  }

  function handleOtpChange(index, value) {
    if (value && !/^\d$/.test(value)) return;
    const newOtp = [...otp];
    newOtp[index] = value;
    setOtp(newOtp);
    setOtpError('');
    if (value && index < 5) {
      const next = document.getElementById(`otp-${index + 1}`);
      if (next) next.focus();
    }
  }

  function handleOtpKeyDown(index, e) {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      const prev = document.getElementById(`otp-${index - 1}`);
      if (prev) prev.focus();
    }
  }

  function handleOtpPaste(e) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length === 6) {
      setOtp(pasted.split(''));
      const last = document.getElementById('otp-5');
      if (last) last.focus();
    }
  }

  async function handleVerifyOtp() {
    const code = otp.join('');
    if (code.length !== 6) { setOtpError(t('otp.invalidLength')); return; }
    setVerifying(true); setOtpError('');
    try {
      const res = await axios.post('/api/auth/verify-otp', {
        email: form.email, otp: code,
      }, { withCredentials: true });
      if (res.data.verified) {
        // A fresh signup has no business yet → onboarding. A recovered legacy
        // account (login→verify) already has one → its admin. The backend
        // returns businessSlug so we route correctly for both, instead of
        // dumping an onboarded user back into onboarding.
        window.location.href = res.data.businessSlug ? `/${res.data.businessSlug}/admin` : '/onboarding';
      }
    } catch (err) {
      setOtpError(err.response?.data?.message || t('otp.verifyFailed'));
    } finally {
      setVerifying(false);
    }
  }

  async function handleResendOtp() {
    if (resendCooldown > 0) return;
    setResending(true); setOtpError('');
    try {
      await axios.post('/api/auth/send-otp', { email: form.email }, { withCredentials: true });
      startCooldown();
      setOtp(['', '', '', '', '', '']);
    } catch (err) {
      setOtpError(err.response?.data?.message || t('otp.resendFailed'));
    } finally {
      setResending(false);
    }
  }

  // Floating language picker — visible on every state of the page so
  // visitors can switch even mid-OTP.
  const FloatingPicker = (
    <div className="fixed top-4 right-4 z-50">
      <LanguageSelector currentLocale={currentLocale} compact />
    </div>
  );

  if (showOtp) {
    return (
      <>
        {FloatingPicker}
        <AuthShell
          eyebrow={t('otp.eyebrow')}
          title={<>{t('otp.titleStart')} <span className="italic text-indigo-600" style={{ fontFamily: 'Georgia, "Times New Roman", ui-serif, serif' }}>{t('otp.titleItalic')}</span></>}
          subtitle={<>{t('otp.subtitleStart')} <strong className="text-gray-800">{form.email}</strong></>}
        >
          <div className="flex justify-center gap-2" onPaste={handleOtpPaste}>
            {otp.map((digit, i) => (
              <input
                key={i}
                id={`otp-${i}`}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handleOtpChange(i, e.target.value)}
                onKeyDown={(e) => handleOtpKeyDown(i, e)}
                className="w-12 h-14 text-center text-xl font-bold bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 transition-shadow"
                autoFocus={i === 0}
              />
            ))}
          </div>

          {otpError && <div className="mt-4"><ErrorBanner message={otpError} /></div>}

          <div className="mt-6">
            <PrimaryButton onClick={handleVerifyOtp} loading={verifying} disabled={otp.join('').length !== 6}>
              {verifying ? t('otp.verifying') : `${t('otp.verify')} →`}
            </PrimaryButton>
          </div>

          <p className="mt-5 text-center text-xs text-gray-500">
            {t('otp.didntReceive')}{' '}
            {resendCooldown > 0 ? (
              <span className="text-gray-400">{t('otp.resendIn', { n: resendCooldown })}</span>
            ) : (
              <button onClick={handleResendOtp} disabled={resending} className="text-indigo-600 font-semibold hover:underline">
                {resending ? t('otp.resending') : t('otp.resend')}
              </button>
            )}
          </p>
          <p className="text-center text-[11px] text-gray-400 mt-2">
            {t('otp.expires')}
          </p>
        </AuthShell>
      </>
    );
  }

  return (
    <>
      {FloatingPicker}
      <AuthShell
        eyebrow={t('eyebrow')}
        title={<>{t('titleStart')} <span className="italic text-indigo-600" style={{ fontFamily: 'Georgia, "Times New Roman", ui-serif, serif' }}>{t('titleItalic')}</span></>}
        subtitle={t('subtitle')}
        footerNote={t('footerNote')}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="text" name="name" autoComplete="name" autoFocus required maxLength={120}
            label={t('fullName')} placeholder={t('fullNamePlaceholder')}
            value={form.name} onChange={handleChange} error={errors.name}
          />
          <Input
            type="email" name="email" autoComplete="email" required maxLength={200}
            label={t('email')} placeholder={t('emailPlaceholder')}
            value={form.email} onChange={handleChange} error={errors.email}
          />
          <Input
            type="password" name="password" autoComplete="new-password" required minLength={8} maxLength={128}
            label={t('password')} placeholder={t('passwordPlaceholder')}
            value={form.password} onChange={handleChange} error={errors.password}
            hint={t('passwordHint')}
          />
          <Input
            type="password" name="confirmPassword" autoComplete="new-password" required minLength={8} maxLength={128}
            label={t('confirmPassword')} placeholder={t('confirmPasswordPlaceholder')}
            value={form.confirmPassword} onChange={handleChange} error={errors.confirmPassword}
          />

          {/* Legal consent — required. Captured as acceptTerms:true in the
              payload; backend records timestamp + version for NZ Privacy Act /
              GDPR evidentiary purposes. */}
          <label className="flex items-start gap-3 text-sm text-gray-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={acceptTerms}
              onChange={(e) => { setAcceptTerms(e.target.checked); setErrors((x) => ({ ...x, acceptTerms: '' })); }}
              className="mt-0.5 w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="leading-relaxed">
              {t('agreeText')}{' '}
              <Link href="/legal/terms" target="_blank" className="text-indigo-600 font-medium hover:underline">{t('termsLink')}</Link>
              {' '}{t('and')}{' '}
              <Link href="/legal/privacy" target="_blank" className="text-indigo-600 font-medium hover:underline">{t('privacyLink')}</Link>.
            </span>
          </label>
          {errors.acceptTerms && <p className="text-xs text-red-600 -mt-2">{errors.acceptTerms}</p>}

          <ErrorBanner message={serverError} />
          <PrimaryButton type="submit" loading={loading}>
            {loading ? t('submitLoading') : `${t('submit')} →`}
          </PrimaryButton>
        </form>

        <p className="text-center text-sm text-gray-500 mt-8">
          {t('alreadyHave')}{' '}
          <Link
            href={redirectParam ? `/login?redirect=${encodeURIComponent(redirectParam)}` : '/login'}
            className="text-indigo-600 font-semibold hover:underline"
          >
            {t('signInLink')}
          </Link>
        </p>
      </AuthShell>
    </>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}
