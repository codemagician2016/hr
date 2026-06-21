'use client';

import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { redirectToLogin } from '@/lib/loginRedirect';
import { useTenant } from '@/components/TenantProvider';
import { currencyForCountry } from '@/lib/currency';
import { getDocumentPluginForTheme } from '@/lib/documentPlugins';

const PAYMENT_STATUSES = [
  { value: 'UNPAID', label: 'Unpaid' },
  { value: 'PARTIAL', label: 'Partial' },
  { value: 'PAID', label: 'Paid' },
];

const PAYMENT_METHODS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CARD', label: 'Card' },
  { value: 'BANK', label: 'Bank transfer' },
  { value: 'UPI', label: 'UPI' },
  { value: 'OTHER', label: 'Other' },
];

function normalizeThemeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function frontDeskVocab(tenant = {}) {
  const themeKey = normalizeThemeKey(tenant?.subscription?.theme || tenant?.business?.theme);
  const themeVocab = tenant?.themeVocab || {};
  const plugin = getDocumentPluginForTheme(themeKey);
  if (plugin?.id === 'doctor_medical') {
    return {
      title: 'Walk-ins',
      eyebrow: 'Front desk',
      createTitle: 'Add walk-in patient',
      person: 'Patient',
      personLower: 'patient',
      service: 'Visit type',
      assigned: 'Doctor',
      queue: 'Patient queue',
    };
  }
  if (plugin?.id === 'lawyer_legal') {
    return {
      title: 'Walk-ins',
      eyebrow: 'Reception',
      createTitle: 'Add walk-in client',
      person: 'Client',
      personLower: 'client',
      service: 'Consultation type',
      assigned: 'Lawyer',
      queue: 'Client queue',
    };
  }
  if (plugin && plugin.id !== 'business_consultant') {
    const person = plugin.ownerLabel || 'Client';
    return {
      title: 'Walk-ins',
      eyebrow: 'Front desk',
      createTitle: `Add walk-in ${person.toLowerCase()}`,
      person,
      personLower: person.toLowerCase(),
      service: 'Service',
      assigned: plugin.assignedLabel || 'Staff member',
      queue: `${person} queue`,
    };
  }
  const fallbackPerson = themeVocab.customers ? singularize(themeVocab.customers) : plugin?.ownerLabel || 'Customer';
  const fallbackAssigned = themeVocab.team ? singularize(themeVocab.team) : plugin?.assignedLabel || 'Staff member';
  return {
    title: 'Walk-ins',
    eyebrow: 'Front desk',
    createTitle: 'Add walk-in',
    person: fallbackPerson,
    personLower: fallbackPerson.toLowerCase(),
    service: themeVocab.services ? singularize(themeVocab.services) : 'Service',
    assigned: fallbackAssigned,
    queue: 'Walk-in queue',
  };
}

function singularize(value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  if (clean.endsWith('ies')) return `${clean.slice(0, -3)}y`;
  if (clean.endsWith('s') && clean.length > 3) return clean.slice(0, -1);
  return clean;
}

function todayInputValue() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

function roundedNowTime() {
  const now = new Date();
  const total = now.getHours() * 60 + now.getMinutes();
  const rounded = Math.min(23 * 60 + 55, Math.ceil(total / 5) * 5);
  return `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
}

function addMinutes(hhmm, minutes) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
  const total = Math.min(23 * 60 + 59, h * 60 + m + Number(minutes || 0));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function amountString(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '0';
  return String(Math.round(num * 100) / 100);
}

function appointmentCharge(appt) {
  const value = Number(appt?.finalPrice ?? appt?.originalPrice ?? appt?.service?.price ?? 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isWalkInAppointment(appt) {
  return String(appt?.bookingChannel || '').toUpperCase() === 'WALK_IN';
}

function isSyntheticWalkInEmail(email) {
  return String(email || '').toLowerCase().endsWith('@walkin.sitepresso.local');
}

function visibleEmail(customer = {}) {
  const email = String(customer.email || '').trim();
  return email && !isSyntheticWalkInEmail(email) ? email : '';
}

export default function WalkInsPanel() {
  const { tenant } = useTenant();
  const vocab = useMemo(() => frontDeskVocab(tenant), [tenant]);
  const currency = tenant?.business?.defaultCurrency || currencyForCountry(tenant?.business?.country || 'US');
  const [options, setOptions] = useState({ services: [], staff: [] });
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [paymentAppt, setPaymentAppt] = useState(null);
  const [form, setForm] = useState(() => ({
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    serviceId: '',
    staffId: '',
    date: todayInputValue(),
    startTime: roundedNowTime(),
    status: 'CONFIRMED',
    notes: '',
    chargeAmount: '0',
    paymentStatus: 'UNPAID',
    paidAmount: '0',
    paymentMethod: 'CASH',
    paymentReference: '',
    forceOverlap: false,
  }));

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [optionsRes, appointmentsRes] = await Promise.all([
        axios.get('/api/appointments/walk-in-options', { withCredentials: true, timeout: 15000 }),
        axios.get('/api/appointments', {
          params: { bookingChannel: 'WALK_IN', limit: 100 },
          withCredentials: true,
          timeout: 15000,
        }),
      ]);
      const services = optionsRes.data.services || [];
      const staff = optionsRes.data.staff || [];
      setOptions({ services, staff });
      setAppointments((appointmentsRes.data.appointments || []).filter(isWalkInAppointment));
      setForm((current) => {
        const service = services.find((item) => item.id === current.serviceId) || services[0];
        const person = staff.find((item) => item.id === current.staffId) || staff[0];
        return {
          ...current,
          serviceId: current.serviceId || service?.id || '',
          staffId: current.staffId || person?.id || '',
          chargeAmount: current.chargeAmount !== '0' ? current.chargeAmount : amountString(service?.price || 0),
        };
      });
    } catch (err) {
      if (err.response?.status === 401) {
        redirectToLogin();
        return;
      }
      setError(err.response?.data?.message || 'Could not load walk-ins');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const selectedService = useMemo(
    () => options.services.find((service) => service.id === form.serviceId),
    [options.services, form.serviceId]
  );
  const estimatedEnd = selectedService?.duration ? addMinutes(form.startTime, selectedService.duration) : '';

  const today = todayInputValue();
  const todaysWalkIns = appointments.filter((appt) => new Date(appt.date).toISOString().slice(0, 10) === today);
  const unpaidCount = appointments.filter((appt) => String(appt.paymentStatus || 'UNPAID').toUpperCase() !== 'PAID').length;
  const completedToday = todaysWalkIns.filter((appt) => appt.status === 'COMPLETED').length;

  function patch(next) {
    setError('');
    setToast('');
    setForm((current) => ({ ...current, ...next }));
  }

  function setService(serviceId) {
    const service = options.services.find((item) => item.id === serviceId);
    patch({ serviceId, chargeAmount: amountString(service?.price || 0) });
  }

  function setPaymentStatus(paymentStatus) {
    const charge = amountString(form.chargeAmount);
    patch({
      paymentStatus,
      paidAmount: paymentStatus === 'PAID' ? charge : paymentStatus === 'UNPAID' ? '0' : form.paidAmount,
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.customerName.trim()) {
      setError(`${vocab.person} name is required.`);
      return;
    }
    if (!form.serviceId || !form.staffId) {
      setError(`Select ${vocab.service.toLowerCase()} and ${vocab.assigned.toLowerCase()}.`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await axios.post('/api/appointments/walk-in', {
        ...form,
        chargeAmount: Number(form.chargeAmount || 0),
        paidAmount: Number(form.paidAmount || 0),
      }, { withCredentials: true });
      setToast('Walk-in added.');
      setForm((current) => ({
        ...current,
        customerName: '',
        customerPhone: '',
        customerEmail: '',
        notes: '',
        startTime: roundedNowTime(),
        paymentStatus: 'UNPAID',
        paidAmount: '0',
        paymentReference: '',
        forceOverlap: false,
      }));
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not add walk-in');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Today" value={todaysWalkIns.length} />
        <Kpi label="Completed today" value={completedToday} />
        <Kpi label="Payment pending" value={unpaidCount} tone={unpaidCount ? 'amber' : 'gray'} />
      </div>

      {error && <Notice tone="red">{error}</Notice>}
      {toast && <Notice tone="emerald">{toast}</Notice>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,440px)_1fr]">
        <form onSubmit={submit} className="rounded-2xl border border-gray-200 bg-white p-5">
          <p className="text-xs font-bold uppercase tracking-wide text-teal-700">{vocab.eyebrow}</p>
          <h2 className="mt-1 text-lg font-bold text-gray-950">{vocab.createTitle}</h2>

          <div className="mt-5 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`${vocab.person} name`} value={form.customerName} onChange={(value) => patch({ customerName: value })} required />
              <Field label="Phone" value={form.customerPhone} onChange={(value) => patch({ customerPhone: value })} />
              <Field label="Email" type="email" value={form.customerEmail} onChange={(value) => patch({ customerEmail: value })} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label={vocab.service}
                value={form.serviceId}
                onChange={setService}
                options={options.services.map((service) => ({
                  value: service.id,
                  label: `${service.name} (${service.duration || 15} min)`,
                }))}
                emptyLabel={loading ? 'Loading visit types' : 'No active services'}
              />
              <Select
                label={vocab.assigned}
                value={form.staffId}
                onChange={(value) => patch({ staffId: value })}
                options={options.staff.map((person) => ({
                  value: person.id,
                  label: person.subtitle ? `${person.name} - ${person.subtitle}` : person.name,
                }))}
                emptyLabel={loading ? 'Loading staff' : 'No active staff'}
              />
              <Field label="Date" type="date" value={form.date} onChange={(value) => patch({ date: value })} required />
              <Field label={`Start time${estimatedEnd ? `, ends ${estimatedEnd}` : ''}`} type="time" value={form.startTime} onChange={(value) => patch({ startTime: value })} required />
            </div>

            <section className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Charge" type="number" min="0" step="0.01" value={form.chargeAmount} onChange={(value) => patch({ chargeAmount: value })} />
                <Select label="Payment" value={form.paymentStatus} onChange={setPaymentStatus} options={PAYMENT_STATUSES} />
                <Field label="Paid now" type="number" min="0" step="0.01" value={form.paidAmount} onChange={(value) => patch({ paidAmount: value })} />
                <Select label="Method" value={form.paymentMethod} onChange={(value) => patch({ paymentMethod: value })} options={PAYMENT_METHODS} disabled={form.paymentStatus === 'UNPAID'} />
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Payment reference" value={form.paymentReference} onChange={(value) => patch({ paymentReference: value })} />
                <Select label="Status" value={form.status} onChange={(value) => patch({ status: value })} options={[
                  { value: 'CONFIRMED', label: 'Waiting / in progress' },
                  { value: 'COMPLETED', label: 'Completed' },
                ]} />
              </div>
            </section>

            <Field label="Internal note" value={form.notes} onChange={(value) => patch({ notes: value })} multiline />

            <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <input
                type="checkbox"
                checked={form.forceOverlap}
                onChange={(e) => patch({ forceOverlap: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded accent-amber-600"
              />
              <span>
                <span className="block text-sm font-semibold text-amber-950">Allow schedule override</span>
                <span className="mt-0.5 block text-xs leading-5 text-amber-800">Use only when the front desk intentionally accepts an overlap or after-hours visit.</span>
              </span>
            </label>

            <button
              type="submit"
              disabled={saving || loading || !form.customerName.trim() || !form.serviceId || !form.staffId}
              className="w-full rounded-xl bg-teal-700 px-4 py-3 text-sm font-bold text-white hover:bg-teal-800 disabled:opacity-50"
            >
              {saving ? 'Adding...' : 'Add walk-in'}
            </button>
          </div>
        </form>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-gray-500">{vocab.queue}</p>
              <h2 className="mt-1 text-lg font-bold text-gray-950">Recent walk-ins</h2>
            </div>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Refresh
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {loading ? (
              <>
                <SkeletonRow />
                <SkeletonRow />
              </>
            ) : appointments.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 py-10 text-center text-sm text-gray-500">
                No walk-ins yet.
              </div>
            ) : appointments.map((appt) => (
              <WalkInRow
                key={appt.id}
                appt={appt}
                vocab={vocab}
                currency={currency}
                onPayment={() => setPaymentAppt(appt)}
              />
            ))}
          </div>
        </section>
      </div>

      {paymentAppt && (
        <PaymentModal
          appointment={paymentAppt}
          currency={currency}
          onClose={() => setPaymentAppt(null)}
          onSaved={async () => {
            setPaymentAppt(null);
            setToast('Payment saved.');
            await load();
          }}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, tone = 'gray' }) {
  const cls = tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-gray-200 bg-white text-gray-950';
  return (
    <div className={`rounded-xl border p-4 ${cls}`}>
      <p className="text-[11px] font-bold uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-2xl font-black">{value}</p>
    </div>
  );
}

function Notice({ tone, children }) {
  const cls = tone === 'red'
    ? 'border-red-200 bg-red-50 text-red-700'
    : 'border-emerald-200 bg-emerald-50 text-emerald-700';
  return <p className={`rounded-xl border px-4 py-3 text-sm font-semibold ${cls}`}>{children}</p>;
}

function Field({ label, value, onChange, type = 'text', multiline = false, ...props }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-gray-500">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-teal-600"
          {...props}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-teal-600"
          {...props}
        />
      )}
    </label>
  );
}

function Select({ label, value, onChange, options, emptyLabel = 'Select', disabled = false }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-gray-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || options.length === 0}
        className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-teal-600 disabled:bg-gray-100 disabled:text-gray-400"
      >
        {options.length === 0 && <option value="">{emptyLabel}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function WalkInRow({ appt, vocab, currency, onPayment }) {
  const customer = appt.customer || appt.user || {};
  const email = visibleEmail(customer);
  const status = String(appt.paymentStatus || 'UNPAID').toUpperCase();
  const charge = appointmentCharge(appt);
  const paid = Number(appt.paidAmount || 0);
  return (
    <article className="rounded-xl border border-gray-200 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-bold text-gray-950">{customer.name || vocab.person}</p>
            <span className="rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[11px] font-bold text-teal-700">Walk-in</span>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${paymentClass(status)}`}>
              {paymentLabel(status)}
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-700">
            {appt.service?.name || vocab.service}
            {appt.staff?.name ? ` with ${appt.staff.name}` : ''}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
            <span>{formatDate(appt.date)} · {appt.startTime}-{appt.endTime}</span>
            {customer.phone && <a href={`tel:${customer.phone}`} className="hover:text-gray-900">{customer.phone}</a>}
            {email && <span>{email}</span>}
          </div>
          {appt.notes && <p className="mt-2 text-xs italic text-gray-500">"{appt.notes}"</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <span className="text-sm font-bold text-gray-900">
            {formatMoney(charge, currency)}
            {status === 'PARTIAL' ? <span className="font-medium text-gray-500"> · paid {formatMoney(paid, currency)}</span> : null}
          </span>
          <button
            type="button"
            onClick={onPayment}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-bold text-gray-700 hover:bg-gray-50"
          >
            {status === 'PAID' ? 'Payment' : 'Record payment'}
          </button>
        </div>
      </div>
    </article>
  );
}

function PaymentModal({ appointment, currency, onClose, onSaved }) {
  const charge = amountString(appointmentCharge(appointment));
  const [form, setForm] = useState({
    chargeAmount: charge,
    paymentStatus: String(appointment.paymentStatus || 'UNPAID').toUpperCase(),
    paidAmount: amountString(appointment.paidAmount || 0),
    paymentMethod: appointment.paymentMethod || 'CASH',
    paymentReference: appointment.paymentReference || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const customer = appointment.customer || appointment.user || {};

  function patch(next) {
    setError('');
    setForm((current) => ({ ...current, ...next }));
  }

  function setPaymentStatus(paymentStatus) {
    patch({
      paymentStatus,
      paidAmount: paymentStatus === 'PAID' ? amountString(form.chargeAmount) : paymentStatus === 'UNPAID' ? '0' : form.paidAmount,
    });
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await axios.put(`/api/appointments/${appointment.id}/payment`, {
        ...form,
        chargeAmount: Number(form.chargeAmount || 0),
        paidAmount: Number(form.paidAmount || 0),
      }, { withCredentials: true });
      await onSaved?.();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update payment');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => !saving && onClose?.()}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full max-w-xl rounded-t-2xl bg-white shadow-xl sm:rounded-2xl">
        <div className="border-b border-gray-100 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-teal-700">Payment</p>
              <h3 className="text-lg font-bold text-gray-950">Record payment</h3>
              <p className="mt-1 text-sm text-gray-500">{customer.name || 'Customer'} · {formatMoney(form.chargeAmount, currency)}</p>
            </div>
            <button type="button" onClick={onClose} disabled={saving} className="text-2xl leading-none text-gray-400 hover:text-gray-700 disabled:opacity-50">×</button>
          </div>
        </div>
        <div className="space-y-4 p-5">
          {error && <Notice tone="red">{error}</Notice>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Charge" type="number" min="0" step="0.01" value={form.chargeAmount} onChange={(value) => patch({ chargeAmount: value })} />
            <Select label="Payment status" value={form.paymentStatus} onChange={setPaymentStatus} options={PAYMENT_STATUSES} />
            <Field label="Paid amount" type="number" min="0" step="0.01" value={form.paidAmount} onChange={(value) => patch({ paidAmount: value })} />
            <Select label="Method" value={form.paymentMethod} onChange={(value) => patch({ paymentMethod: value })} options={PAYMENT_METHODS} disabled={form.paymentStatus === 'UNPAID'} />
          </div>
          <Field label="Payment reference" value={form.paymentReference} onChange={(value) => patch({ paymentReference: value })} />
        </div>
        <div className="flex flex-col gap-2 border-t border-gray-100 px-5 py-4 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:border-gray-900 disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-teal-800 disabled:opacity-50">
            {saving ? 'Saving...' : 'Save payment'}
          </button>
        </div>
      </form>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <div className="animate-pulse space-y-2">
        <div className="h-4 w-1/3 rounded bg-gray-200" />
        <div className="h-3 w-1/2 rounded bg-gray-100" />
        <div className="h-3 w-2/3 rounded bg-gray-100" />
      </div>
    </div>
  );
}

function paymentLabel(status) {
  if (status === 'PAID') return 'Paid';
  if (status === 'PARTIAL') return 'Partial';
  return 'Unpaid';
}

function paymentClass(status) {
  if (status === 'PAID') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (status === 'PARTIAL') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-gray-200 bg-gray-50 text-gray-600';
}

function formatDate(value) {
  const date = new Date(value);
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatMoney(value, currency) {
  const amount = Number(value || 0);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2,
    }).format(Number.isFinite(amount) ? amount : 0);
  } catch {
    return `${currency || 'USD'} ${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'}`;
  }
}
