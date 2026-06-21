'use client';

// Service catalogue (APPOINTMENT vertical). Add / edit / delete services.
// Extracted from [slug]/admin/page.js 2026-04-29.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, Empty, Modal, ModalActions, PrimaryButton, TextInput, TextArea } from '@/components/admin-ui';
import ImageEditorModal from '@/components/ImageEditorModal';
import { useConfirm } from '@/components/ConfirmDialog';
import { useApi } from '@/lib/useApi';

function parseJsonObject(raw, fallback = {}) {
  if (!raw) return fallback;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function clampFollowUpDays(value, fallback = 7) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(365, Math.round(n)));
}

function normalizeFollowUpSettings(content) {
  const parsed = parseJsonObject(content?.followUpSettings, {});
  return {
    ...parsed,
    freeWithinDays: clampFollowUpDays(parsed.freeWithinDays, 7),
    sameDoctorOnly: parsed.sameDoctorOnly !== false,
    serviceRules: parseJsonObject(parsed.serviceRules, {}),
  };
}

function normalizeServiceFollowUpRule(rule, defaults = {}) {
  return {
    enabled: rule?.enabled === true,
    freeWithinDays: clampFollowUpDays(rule?.freeWithinDays, defaults.freeWithinDays || 7),
    sameDoctorOnly: rule?.sameDoctorOnly ?? defaults.sameDoctorOnly ?? true,
  };
}

function serializeServiceFollowUpSettings(settings, serviceId, rule) {
  const next = {
    ...settings,
    serviceRules: {
      ...(settings?.serviceRules || {}),
      [serviceId]: {
        enabled: rule.enabled === true,
        freeWithinDays: clampFollowUpDays(rule.freeWithinDays, settings?.freeWithinDays || 7),
        sameDoctorOnly: rule.sameDoctorOnly !== false,
      },
    },
  };
  return next;
}

const DEFAULT_LABELS = {
  collection: 'Services',
  singular: 'service',
  add: '+ Add service',
  empty: 'No services yet. Add your first service.',
  deleteConfirm: 'Delete this service?',
  modalAdd: 'Add service',
  modalEdit: 'Edit service',
  name: 'Name *',
  duration: 'Duration (min) *',
  durationHint: 'Minimum 15 minutes, maximum 8 hours',
  price: 'Price (optional)',
  priceHint: 'Leave price blank to hide the price tag on the service card.',
  features: 'Features (bullet points)',
  featureHint: 'Short selling points shown under the service name on the website. Optional — leave empty if not needed.',
  highlight: 'Highlight this service (shows a “Most popular” badge on the card)',
  virtual: 'Online / virtual consultation',
  image: 'Service image (optional)',
  imageTitle: 'Edit service image',
  saveAdd: 'Add service',
};

function ServicesTab({ onChange, labels = DEFAULT_LABELS, followUpsEnabled = true }) {
  const copy = { ...DEFAULT_LABELS, ...(labels || {}) };
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: services = [], loading, error, reload: load } = useApi('/api/services', { select: (r) => r.services || [] });
  const confirm = useConfirm();
  const view = searchParams.get('view') || '';
  const editingId = searchParams.get('id') || '';
  const editing = useMemo(() => {
    if (view === 'service-create') return 'new';
    if (view === 'service-edit' && editingId) {
      return services.find((service) => service.id === editingId) || null;
    }
    return null;
  }, [editingId, services, view]);

  const replaceQuery = useCallback((mutator) => {
    const params = new URLSearchParams(searchParams.toString());
    mutator(params);
    router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
  }, [router, searchParams]);

  const openCreate = useCallback(() => {
    replaceQuery((params) => {
      params.set('view', 'service-create');
      params.delete('id');
    });
  }, [replaceQuery]);

  const openEdit = useCallback((service) => {
    replaceQuery((params) => {
      params.set('view', 'service-edit');
      params.set('id', service.id);
    });
  }, [replaceQuery]);

  const closeEditor = useCallback(() => {
    replaceQuery((params) => {
      params.delete('view');
      params.delete('id');
    });
  }, [replaceQuery]);

  async function del(id) {
    if (!await confirm(copy.deleteConfirm, { confirmLabel: 'Delete', tone: 'danger' })) return;
    try { await api(`/api/services/${id}`, { method: 'DELETE' }); await load(); onChange?.(); }
    catch (err) { alert(err.message); }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">{copy.collection}</h2>
        <button onClick={openCreate} className="text-sm font-medium hover:underline" style={{ color: 'var(--theme-primary)' }}>
          {copy.add}
        </button>
      </div>

      {error && <ErrorBanner message={error.message || String(error)} />}

      {loading ? (
        <div className="py-8 flex justify-center"><Spinner /></div>
      ) : services.length === 0 ? (
        <Empty text={copy.empty} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {services.map((s) => (
            <div key={s.id} className="border border-gray-200 rounded-xl overflow-hidden flex flex-col">
              {s.imageUrl && (
                <img src={s.imageUrl} alt={s.name} className="w-full h-28 object-cover" />
              )}
              <div className="p-4 flex items-start justify-between gap-3 flex-1">
                <div className="min-w-0">
                  <h3 className="font-semibold text-gray-900 truncate">{s.name}</h3>
                  {s.description && <p className="text-sm text-gray-500 mt-1 line-clamp-2">{s.description}</p>}
                  <p className="text-xs text-gray-500 mt-2">{s.duration} min{s.price != null ? ` · $${s.price}` : ''}</p>
                </div>
                <div className="flex flex-col gap-1 text-sm flex-shrink-0">
                  <button onClick={() => openEdit(s)} className="hover:underline" style={{ color: 'var(--theme-primary)' }}>Edit</button>
                  <button onClick={() => del(s.id)} className="text-red-600 hover:underline">Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <ServiceModal
          service={editing === 'new' ? null : editing}
          onClose={closeEditor}
          onSaved={() => { closeEditor(); load(); onChange?.(); }}
          labels={copy}
          followUpsEnabled={followUpsEnabled}
        />
      )}
    </div>
  );
}

function ServiceModal({ service, onClose, onSaved, labels = DEFAULT_LABELS, followUpsEnabled = true }) {
  const copy = { ...DEFAULT_LABELS, ...(labels || {}) };
  const parsedFeatures = (() => {
    if (!service?.features) return [];
    try { const a = JSON.parse(service.features); return Array.isArray(a) ? a : []; } catch { return []; }
  })();

  const [form, setForm] = useState(service ? {
    name: service.name,
    description: service.description || '',
    duration: service.duration,
    price: service.price ?? '',
    imageUrl: service.imageUrl || '',
    highlighted: !!service.highlighted,
    isVirtual: !!service.isVirtual,
    virtualMeetingUrl: service.virtualMeetingUrl || '',
    requiresPrepayment: !!service.requiresPrepayment,
  } : { name: '', description: '', duration: 30, price: '', imageUrl: '', highlighted: false, isVirtual: false, virtualMeetingUrl: '', requiresPrepayment: false });
  const [features, setFeatures] = useState(parsedFeatures);
  const [followUpSettings, setFollowUpSettings] = useState(null);
  const [followUpRule, setFollowUpRule] = useState(() => normalizeServiceFollowUpRule(null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editingImage, setEditingImage] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api('/api/business/content')
      .then(({ content }) => {
        if (cancelled) return;
        const settings = normalizeFollowUpSettings(content || {});
        const savedRule = service?.id ? settings.serviceRules?.[service.id] : null;
        setFollowUpSettings(settings);
        setFollowUpRule(normalizeServiceFollowUpRule(savedRule, settings));
      })
      .catch(() => {
        if (cancelled) return;
        const fallback = normalizeFollowUpSettings(null);
        setFollowUpSettings(fallback);
        setFollowUpRule(normalizeServiceFollowUpRule(null, fallback));
      });
    return () => { cancelled = true; };
  }, [service?.id]);

  function addFeature() { setFeatures((f) => [...f, '']); }
  function setFeature(i, v) { setFeatures((f) => f.map((x, idx) => (idx === i ? v : x))); }
  function removeFeature(i) { setFeatures((f) => f.filter((_, idx) => idx !== i)); }
  function patchFollowUp(next) {
    setFollowUpRule((current) => ({ ...current, ...next }));
  }

  async function submit(e) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const payload = {
        ...form,
        features: features.map((s) => s.trim()).filter(Boolean),
      };
      let savedService;
      if (service) {
        const result = await api(`/api/services/${service.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        savedService = result.service || service;
      } else {
        const result = await api('/api/services', { method: 'POST', body: JSON.stringify(payload) });
        savedService = result.service;
      }
      if (savedService?.id) {
        const nextFollowUpSettings = serializeServiceFollowUpSettings(
          followUpSettings || normalizeFollowUpSettings(null),
          savedService.id,
          followUpRule
        );
        await api('/api/business/content', {
          method: 'PUT',
          body: JSON.stringify({ followUpSettings: JSON.stringify(nextFollowUpSettings) }),
        });
      }
      onSaved();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  return (
    <Modal title={service ? copy.modalEdit : copy.modalAdd} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <TextInput label={copy.name} value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        <TextArea label="Description" value={form.description} onChange={(v) => setForm({ ...form, description: v })} maxLength={500} />
        <div className="grid grid-cols-2 gap-4">
          <TextInput label={copy.duration} type="number" min="15" max="480" step="5" value={form.duration} onChange={(v) => setForm({ ...form, duration: v })} required hint={copy.durationHint} />
          <TextInput label={copy.price} type="number" min="0" step="0.01" value={form.price ?? ''} onChange={(v) => setForm({ ...form, price: v })} />
        </div>
        <p className="text-xs text-gray-500 -mt-2">{copy.priceHint}</p>

        {followUpsEnabled && <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-3">
          <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={!!followUpRule.enabled}
              onChange={(e) => patchFollowUp({ enabled: e.target.checked })}
              className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>
              <span className="block font-semibold text-gray-900">Can be used as a free follow-up</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                Eligible returning customers can book this service at no charge after a completed appointment.
              </span>
            </span>
          </label>

          {followUpRule.enabled ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextInput
                label="Free within days"
                type="number"
                min="1"
                max="365"
                value={followUpRule.freeWithinDays}
                onChange={(v) => patchFollowUp({ freeWithinDays: v })}
                hint="Example: 7 means the follow-up is free within 7 days."
              />
              <label className="flex items-start gap-2 rounded-lg border border-gray-200 bg-white p-3 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={followUpRule.sameDoctorOnly !== false}
                  onChange={(e) => patchFollowUp({ sameDoctorOnly: e.target.checked })}
                  className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span>
                  <span className="block font-semibold text-gray-900">Same staff only</span>
                  <span className="block text-xs text-gray-500 mt-0.5">Require the follow-up with the original provider.</span>
                </span>
              </label>
            </div>
          ) : (
            <p className="text-xs text-gray-500">This service keeps its normal price unless a coupon or manual discount applies.</p>
          )}
        </div>}

        {/* Features bullets — optional list shown on the service card */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-gray-700">{copy.features}</label>
            {features.length < 10 && (
              <button type="button" onClick={addFeature} className="text-xs font-semibold text-indigo-600 hover:underline">+ Add bullet</button>
            )}
          </div>
          <p className="text-xs text-gray-500 mb-2">{copy.featureHint}</p>
          {features.length === 0 ? (
            <p className="text-xs text-gray-400 italic py-3 text-center border border-dashed border-gray-200 rounded-lg">
              No bullets yet. Click &ldquo;+ Add bullet&rdquo; to list what&rsquo;s included.
            </p>
          ) : (
            <div className="space-y-2">
              {features.map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-gray-400">•</span>
                  <input
                    type="text"
                    value={f}
                    onChange={(e) => setFeature(i, e.target.value)}
                    placeholder="e.g. 45-minute session"
                    maxLength={100}
                    className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <button type="button" onClick={() => removeFeature(i)} className="text-xs text-red-600 hover:underline flex-shrink-0">Remove</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={!!form.highlighted}
            onChange={(e) => setForm({ ...form, highlighted: e.target.checked })}
            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span>{copy.highlight}</span>
        </label>

        {/* Doctor v2 — collect the consult fee online at booking (Razorpay). */}
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={!!form.requiresPrepayment}
            onChange={(e) => setForm({ ...form, requiresPrepayment: e.target.checked })}
            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span>Collect payment online at booking</span>
        </label>

        {/* Virtual / online consultation toggle. When ON, show a
            meeting-URL field; the URL is included in confirmation +
            reminder emails. Per-appointment override available from
            the Appointments tab. */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-3">
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={!!form.isVirtual}
              onChange={(e) => setForm({ ...form, isVirtual: e.target.checked })}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>{copy.virtual}</span>
          </label>
          {form.isVirtual && (
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Meeting link (optional)</label>
              <input
                type="url"
                value={form.virtualMeetingUrl || ''}
                onChange={(e) => setForm({ ...form, virtualMeetingUrl: e.target.value })}
                placeholder="https://meet.google.com/abc-defg-hij or your Zoom / Teams / Whereby link"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <p className="text-[11px] text-gray-500 mt-1">
                Pasted in customer confirmation + reminder emails. Works with Google Meet, Zoom, MS Teams, Whereby, Jitsi — anything with a link. Leave blank to set per-appointment from the booking detail.
              </p>
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{copy.image}</label>
          <p className="text-xs text-gray-500 mb-2">
            Click {form.imageUrl ? 'the image' : 'below'} to crop, zoom, or rotate before saving.
          </p>
          {form.imageUrl ? (
            <button
              type="button"
              onClick={() => setEditingImage(true)}
              className="block w-full max-w-sm overflow-hidden rounded-lg border border-gray-200 hover:border-indigo-400"
              title="Click to edit"
            >
              <img src={form.imageUrl} alt="" className="block h-32 w-full object-cover" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setEditingImage(true)}
              className="flex h-28 w-full max-w-sm cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 transition-colors hover:border-indigo-400 hover:bg-indigo-50/50"
            >
              <svg className="mb-1 h-7 w-7 text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
              </svg>
              <span className="text-sm font-medium text-gray-500">Click to upload</span>
            </button>
          )}
          {form.imageUrl && (
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setEditingImage(true)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Edit image
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, imageUrl: '' })}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                Remove
              </button>
            </div>
          )}
          {editingImage && (
            <ImageEditorModal
              value={form.imageUrl}
              scope="service"
              frameAspect={16 / 9}
              onSave={(url) => setForm((f) => ({ ...f, imageUrl: url }))}
              onClose={() => setEditingImage(false)}
              title={copy.imageTitle}
            />
          )}
        </div>
        {error && <ErrorBanner message={error} />}
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
          <PrimaryButton type="submit" loading={loading}>{service ? 'Save changes' : copy.saveAdd}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ============================================================================
// Subscription tab  (NEW)
// ============================================================================
// difference clearly.


// Video meetings integrations panel — Settings → Video meetings sub-tab.
//
// Each row is a provider card that flips between Connect / Connected
// based on the row from /api/business/integrations. Connecting opens the
// provider's OAuth consent screen via the URL the backend returns;
// disconnect deletes the integration row.
//
// Phase A behaviour: list works, disconnect works. Connect button shows
// the provider's "verification status" sub-text and (until env vars are
// set) is disabled with a clear "not enabled on this server yet" tooltip.
// Phase B/C/D each enable one provider's Connect end-to-end.

export default ServicesTab;
