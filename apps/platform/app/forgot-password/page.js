'use client';

import { useState } from 'react';
import axios from 'axios';
import Link from 'next/link';

function PasswordField({ value, onChange, placeholder, autoFocus }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        className="w-full px-4 py-2.5 pr-11 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((v) => !v)}
        className="absolute inset-y-0 right-3 flex items-center text-gray-400 hover:text-gray-600"
        aria-label={show ? 'Hide password' : 'Show password'}
      >
        {show ? (
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
        )}
      </button>
    </div>
  );
}

export default function ForgotPasswordPage() {
  const [step, setStep] = useState('email'); // email | otp | password | done
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  function startCooldown() {
    setResendCooldown(60);
    const interval = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) { clearInterval(interval); return 0; }
        return prev - 1;
      });
    }, 1000);
  }

  async function handleSendOtp(e) {
    if (e) e.preventDefault();
    if (!email) { setError('Email is required'); return; }
    // No placeholder-domain block here. Existing accounts may legitimately
    // own an @example.com address (legacy signups, seed data, manually-
    // created tenants), and they need a working password-reset path. The
    // backend silently no-ops if no account matches the email, so an OTP
    // request against a non-existent address leaks nothing. Disposable-
    // email rejection happens at SIGNUP time via emailValidation.js, not
    // at reset.
    setLoading(true);
    setError('');
    try {
      await axios.post('/api/auth/forgot-password', { email }, { withCredentials: true });
      setStep('otp');
      startCooldown();
    } catch (err) {
      setError(err.response?.data?.message || 'Something went wrong.');
    } finally { setLoading(false); }
  }

  // OTP input helpers
  function handleOtpChange(index, value) {
    if (value && !/^\d$/.test(value)) return;
    const newOtp = [...otp];
    newOtp[index] = value;
    setOtp(newOtp);
    setError('');
    if (value && index < 5) {
      const next = document.getElementById(`rotp-${index + 1}`);
      if (next) next.focus();
    }
  }

  function handleOtpKeyDown(index, e) {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      const prev = document.getElementById(`rotp-${index - 1}`);
      if (prev) prev.focus();
    }
  }

  function handleOtpPaste(e) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length === 6) {
      setOtp(pasted.split(''));
      const last = document.getElementById('rotp-5');
      if (last) last.focus();
    }
  }

  function handleVerifyOtp() {
    const code = otp.join('');
    if (code.length !== 6) { setError('Please enter the full 6-digit code'); return; }
    setStep('password');
    setError('');
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    if (!password) { setError('Password is required'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(password)) {
      setError('Password must include at least one uppercase letter, one lowercase letter, and one number');
      return;
    }
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }

    setLoading(true);
    setError('');
    try {
      await axios.post('/api/auth/reset-password', {
        email,
        otp: otp.join(''),
        password,
      }, { withCredentials: true });
      setStep('done');
    } catch (err) {
      // If OTP is wrong/expired, go back to OTP step
      const msg = err.response?.data?.message || 'Something went wrong.';
      if (msg.includes('OTP') || msg.includes('code') || msg.includes('expired')) {
        setStep('otp');
        setOtp(['', '', '', '', '', '']);
      }
      setError(msg);
    } finally { setLoading(false); }
  }

  async function handleResend() {
    if (resendCooldown > 0) return;
    setLoading(true);
    setError('');
    try {
      await axios.post('/api/auth/forgot-password', { email }, { withCredentials: true });
      startCooldown();
      setOtp(['', '', '', '', '', '']);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to resend code');
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-indigo-600">Sitepresso</h1>
          <p className="text-gray-500 mt-1">Reset your password</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          {/* Step 1: Enter email */}
          {step === 'email' && (
            <form onSubmit={handleSendOtp} className="space-y-5">
              <div className="text-center mb-2">
                <div className="w-14 h-14 bg-indigo-100 rounded-full mx-auto flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                  </svg>
                </div>
                <p className="text-sm text-gray-600">
                  Enter your email and we'll send you a 6-digit code to reset your password.
                </p>
              </div>

              <div>
                <label htmlFor="reset-account-email" className="block text-sm font-medium text-gray-700 mb-1">Email address</label>
                {/* Honeypot input — Chrome autofill targets the FIRST email-
                    looking input on a form. Putting an off-screen one first
                    captures the autofill, leaving the real input empty so
                    the admin types their actual email. */}
                <input
                  type="email"
                  name="email"
                  autoComplete="email"
                  tabIndex={-1}
                  aria-hidden="true"
                  style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px', opacity: 0 }}
                  onChange={() => { /* swallow */ }}
                />
                <input
                  id="reset-account-email"
                  type="email"
                  name="reset-account-email"
                  autoComplete="off"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(''); }}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
                  placeholder="you@example.com"
                />
              </div>

              {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}

              <button type="submit" disabled={loading}
                className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
                {loading && <SpinnerIcon />}
                {loading ? 'Sending...' : 'Send OTP'}
              </button>
            </form>
          )}

          {/* Step 2: Enter OTP */}
          {step === 'otp' && (
            <div className="space-y-5">
              <div className="text-center">
                <div className="w-14 h-14 bg-indigo-100 rounded-full mx-auto flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold text-gray-900">Check your email</h2>
                <p className="text-sm text-gray-500 mt-1">
                  We sent a 6-digit code to <strong className="text-gray-700">{email}</strong>
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setStep('email');
                    setOtp(['', '', '', '', '', '']);
                    setError('');
                  }}
                  className="mt-2 text-xs text-indigo-600 hover:underline"
                >
                  Wrong email? Edit
                </button>
              </div>

              <div className="flex justify-center gap-2" onPaste={handleOtpPaste}>
                {otp.map((digit, i) => (
                  <input
                    key={i}
                    id={`rotp-${i}`}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleOtpChange(i, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(i, e)}
                    className="w-12 h-14 text-center text-xl font-bold border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    autoFocus={i === 0}
                  />
                ))}
              </div>

              {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-center">{error}</p>}

              <button onClick={handleVerifyOtp} disabled={otp.join('').length !== 6}
                className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-semibold rounded-lg transition-colors">
                Continue
              </button>

              <div className="text-center">
                <p className="text-xs text-gray-500">
                  Didn't receive the code?{' '}
                  {resendCooldown > 0 ? (
                    <span className="text-gray-400">Resend in {resendCooldown}s</span>
                  ) : (
                    <button onClick={handleResend} disabled={loading} className="text-indigo-600 font-medium hover:underline">
                      {loading ? 'Sending...' : 'Resend code'}
                    </button>
                  )}
                </p>
                <p className="text-xs text-gray-400 mt-2">The code expires in 10 minutes.</p>
              </div>
            </div>
          )}

          {/* Step 3: Set new password */}
          {step === 'password' && (
            <form onSubmit={handleResetPassword} className="space-y-5">
              <div className="text-center mb-2">
                <div className="w-14 h-14 bg-emerald-100 rounded-full mx-auto flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold text-gray-900">Set new password</h2>
                <p className="text-sm text-gray-500 mt-1">Choose a strong password for your account.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">New password</label>
                <PasswordField
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(''); }}
                  placeholder="Min. 8 characters"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Confirm password</label>
                <PasswordField
                  value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
                  placeholder="••••••••"
                />
              </div>

              {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}

              <button type="submit" disabled={loading}
                className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
                {loading && <SpinnerIcon />}
                {loading ? 'Resetting...' : 'Reset password'}
              </button>
            </form>
          )}

          {/* Step 4: Success */}
          {step === 'done' && (
            <div className="text-center space-y-4">
              <div className="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center mx-auto">
                <svg className="w-7 h-7 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <polyline points="20 6 9 17 4 12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-gray-900">Password reset successful</h2>
              <p className="text-sm text-gray-500">You can now log in with your new password.</p>
              <Link href="/login" className="inline-block px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg">
                Go to login
              </Link>
            </div>
          )}
        </div>

        <p className="text-center text-sm text-gray-500 mt-6">
          <Link href="/login" className="text-indigo-600 font-medium hover:underline">
            Back to login
          </Link>
        </p>
      </div>
    </div>
  );
}

function SpinnerIcon() {
  return (
    <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}
