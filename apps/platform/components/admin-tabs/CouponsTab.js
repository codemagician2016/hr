'use client';

// Discount/coupon manager. Used in SettingsTab as a sub-tab.
// Extracted from [slug]/admin/page.js 2026-04-29.

import { useEffect, useState } from 'react';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, PrimaryButton, DateInput } from '@/components/admin-ui';
import { useConfirm } from '@/components/ConfirmDialog';

function CouponsTab() {
  const [coupons, setCoupons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const confirm = useConfirm();
  const [form, setForm] = useState({
    code: '', description: '', discountType: 'PERCENTAGE', discountValue: 10,
    minOrderAmount: '', maxDiscount: '', maxUses: '', maxUsesPerCustomer: 1,
    validFrom: new Date().toISOString().slice(0, 10),
    validUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    isFirstBookingOnly: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try { const d = await api('/api/coupons'); setCoupons(d.coupons || []); }
    catch {} finally { setLoading(false); }
  }

  async function createCoupon(e) {
    e.preventDefault(); setSaving(true); setError('');
    try {
      await api('/api/coupons', { method: 'POST', body: JSON.stringify({
        ...form,
        discountValue: Number(form.discountValue),
        minOrderAmount: form.minOrderAmount ? Number(form.minOrderAmount) : null,
        maxDiscount: form.maxDiscount ? Number(form.maxDiscount) : null,
        maxUses: form.maxUses ? Number(form.maxUses) : null,
        maxUsesPerCustomer: form.maxUsesPerCustomer ? Number(form.maxUsesPerCustomer) : null,
        validFrom: new Date(form.validFrom).toISOString(),
        validUntil: new Date(form.validUntil + 'T23:59:59').toISOString(),
      }) });
      setShowForm(false);
      setForm({ code: '', description: '', discountType: 'PERCENTAGE', discountValue: 10,
        minOrderAmount: '', maxDiscount: '', maxUses: '', maxUsesPerCustomer: 1,
        validFrom: new Date().toISOString().slice(0, 10),
        validUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        isFirstBookingOnly: false });
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function toggleActive(id, isActive) {
    try { await api(`/api/coupons/${id}`, { method: 'PUT', body: JSON.stringify({ isActive: !isActive }) }); await load(); }
    catch { alert('Failed'); }
  }

  async function removeCoupon(id) {
    if (!await confirm('Delete this coupon? This cannot be undone.', { confirmLabel: 'Delete', tone: 'danger' })) return;
    try { await api(`/api/coupons/${id}`, { method: 'DELETE' }); await load(); }
    catch { alert('Failed'); }
  }

  const activeCoupons = coupons.filter(c => c.isActive && new Date(c.validUntil) > new Date());
  const expiredCoupons = coupons.filter(c => !c.isActive || new Date(c.validUntil) <= new Date());

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--theme-text)', fontFamily: 'var(--font-heading)' }}>Discount Coupons</h2>
          <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>Create coupons for your customers to use at booking</p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 text-sm font-semibold rounded-lg text-white"
          style={{ backgroundColor: 'var(--theme-primary)' }}>
          {showForm ? 'Cancel' : '+ Create coupon'}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <form onSubmit={createCoupon} className="rounded-xl border p-5 space-y-4" style={{ borderColor: 'var(--theme-border)', backgroundColor: 'var(--theme-bg)' }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--theme-text)' }}>Coupon code *</label>
              <input type="text" required value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })}
                placeholder="WELCOME20" className="w-full px-3 py-2 border rounded-lg text-sm uppercase" style={{ borderColor: 'var(--theme-border)' }} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--theme-text)' }}>Description</label>
              <input type="text" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="20% off your first booking" className="w-full px-3 py-2 border rounded-lg text-sm" style={{ borderColor: 'var(--theme-border)' }} />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--theme-text)' }}>Discount type *</label>
              <select value={form.discountType} onChange={e => setForm({ ...form, discountType: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm" style={{ borderColor: 'var(--theme-border)' }}>
                <option value="PERCENTAGE">Percentage (%)</option>
                <option value="FIXED">Fixed amount ($)</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--theme-text)' }}>
                Value * {form.discountType === 'PERCENTAGE' ? '(%)' : '($)'}
              </label>
              <input type="number" required min="0.01" step="0.01" value={form.discountValue}
                onChange={e => setForm({ ...form, discountValue: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm" style={{ borderColor: 'var(--theme-border)' }} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--theme-text)' }}>Min order ($)</label>
              <input type="number" min="0" step="0.01" value={form.minOrderAmount}
                onChange={e => setForm({ ...form, minOrderAmount: e.target.value })}
                placeholder="No minimum" className="w-full px-3 py-2 border rounded-lg text-sm" style={{ borderColor: 'var(--theme-border)' }} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--theme-text)' }}>Max discount ($)</label>
              <input type="number" min="0" step="0.01" value={form.maxDiscount}
                onChange={e => setForm({ ...form, maxDiscount: e.target.value })}
                placeholder="No cap" className="w-full px-3 py-2 border rounded-lg text-sm" style={{ borderColor: 'var(--theme-border)' }} />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--theme-text)' }}>Total uses</label>
              <input type="number" min="1" value={form.maxUses}
                onChange={e => setForm({ ...form, maxUses: e.target.value })}
                placeholder="Unlimited" className="w-full px-3 py-2 border rounded-lg text-sm" style={{ borderColor: 'var(--theme-border)' }} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--theme-text)' }}>Uses per customer</label>
              <input type="number" min="1" value={form.maxUsesPerCustomer}
                onChange={e => setForm({ ...form, maxUsesPerCustomer: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm" style={{ borderColor: 'var(--theme-border)' }} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--theme-text)' }}>Valid from</label>
              <DateInput
                required
                min={new Date().toISOString().slice(0, 10)}
                value={form.validFrom}
                onChange={(v) => setForm({ ...form, validFrom: v })}
                className="w-full"
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--theme-text)' }}>Valid until</label>
              <DateInput
                required
                min={form.validFrom || new Date().toISOString().slice(0, 10)}
                value={form.validUntil}
                onChange={(v) => setForm({ ...form, validUntil: v })}
                className="w-full"
              />
            </div>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.isFirstBookingOnly}
                onChange={e => setForm({ ...form, isFirstBookingOnly: e.target.checked })}
                className="w-4 h-4 rounded" style={{ accentColor: 'var(--theme-primary)' }} />
              <span className="text-sm" style={{ color: 'var(--theme-text)' }}>First booking only</span>
            </label>
          </div>

          {error && <ErrorBanner message={error} />}
          <PrimaryButton type="submit" loading={saving}>Create coupon</PrimaryButton>
        </form>
      )}

      {/* Active coupons */}
      <div className="rounded-xl border p-5" style={{ borderColor: 'var(--theme-border)', backgroundColor: 'var(--theme-surface)' }}>
        <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--theme-text)' }}>Active coupons ({activeCoupons.length})</h3>
        {loading ? <div className="py-6 flex justify-center"><Spinner /></div> :
        activeCoupons.length === 0 ? (
          <div className="border border-dashed rounded-xl py-8 text-center text-sm" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
            No active coupons. Create one to offer discounts to your customers.
          </div>
        ) : (
          <div className="space-y-3">
            {activeCoupons.map(c => (
              <div key={c.id} className="rounded-lg border p-4" style={{ borderColor: 'var(--theme-border)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-base" style={{ color: 'var(--theme-primary)' }}>{c.code}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                        style={{ backgroundColor: 'color-mix(in srgb, var(--theme-primary) 15%, transparent)', color: 'var(--theme-primary)' }}>
                        {c.discountType === 'PERCENTAGE' ? `${c.discountValue}% off` : `$${c.discountValue} off`}
                      </span>
                      {c.isFirstBookingOnly && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">1st booking</span>}
                    </div>
                    {c.description && <p className="text-xs mt-1" style={{ color: 'var(--theme-muted)' }}>{c.description}</p>}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs" style={{ color: 'var(--theme-muted)' }}>
                      <span>Used: {c.usedCount}{c.maxUses ? `/${c.maxUses}` : ''}</span>
                      {c.minOrderAmount && <span>Min: ${c.minOrderAmount}</span>}
                      {c.maxDiscount && <span>Max discount: ${c.maxDiscount}</span>}
                      {c.maxUsesPerCustomer && <span>{c.maxUsesPerCustomer}x per customer</span>}
                      <span>Expires: {new Date(c.validUntil).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => toggleActive(c.id, c.isActive)} className="text-xs text-amber-600 hover:underline">Pause</button>
                    <button onClick={() => removeCoupon(c.id)} className="text-xs text-red-600 hover:underline">Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Expired / paused */}
      {expiredCoupons.length > 0 && (
        <div className="rounded-xl border p-5 opacity-60" style={{ borderColor: 'var(--theme-border)', backgroundColor: 'var(--theme-surface)' }}>
          <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--theme-muted)' }}>Expired / Paused ({expiredCoupons.length})</h3>
          <div className="space-y-2">
            {expiredCoupons.map(c => (
              <div key={c.id} className="flex items-center justify-between py-2 text-sm">
                <span className="font-mono" style={{ color: 'var(--theme-text)' }}>{c.code} — {c.discountType === 'PERCENTAGE' ? `${c.discountValue}%` : `$${c.discountValue}`} · used {c.usedCount}x</span>
                <div className="flex gap-2">
                  {!c.isActive && <button onClick={() => toggleActive(c.id, c.isActive)} className="text-xs text-emerald-600 hover:underline">Resume</button>}
                  <button onClick={() => removeCoupon(c.id)} className="text-xs text-red-600 hover:underline">Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default CouponsTab;
