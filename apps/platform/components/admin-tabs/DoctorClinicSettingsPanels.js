'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/adminApi';
import { ErrorBanner, PrimaryButton, Spinner, TextArea, TextInput } from '@/components/admin-ui';
import ImageEditorModal from '@/components/ImageEditorModal';
import { getDocumentPluginForTheme } from '@/lib/documentPlugins';

const DEFAULT_FOLLOW_UP_KEYWORDS = ['follow', 'follow-up', 'follow up', 'review'];

function parseSettings(raw, fallback = {}) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function clinicContact(business = {}) {
  return [business.phone, business.email].filter(Boolean).join(' | ');
}

function letterheadDefaults(business = {}) {
  return {
    businessName: business.name || '',
    registrationLabel: 'Reg. No.',
    registrationValue: '',
    address: business.address || '',
    contact: clinicContact(business),
    footerNote: 'Medicines and advice are valid only for this consultation and patient. Seek urgent care for worsening symptoms.',
    logoUrl: '',
    watermarkUrl: '',
    sidebarText: '',
    format: 'classic',
    fontFamily: 'inter',
    titleScale: 'normal',
    bodyScale: 'normal',
    logoAspect: 'wide',
    watermarkStrength: 'normal',
    accentColor: '#0f766e',
    secondaryColor: '#facc15',
  };
}

function normalizeLetterhead(raw, defaults) {
  return {
    ...defaults,
    ...parseSettings(raw, {}),
  };
}

function legacyLetterheadSeed(raw) {
  const legacy = parseSettings(raw, {});
  const registration = [legacy.registrationLabel, legacy.registrationValue].filter(Boolean).join(': ');
  return {
    ...(legacy.businessName ? { organization_name: legacy.businessName } : {}),
    ...(legacy.logoUrl ? { logo: legacy.logoUrl } : {}),
    ...(registration ? { registration_block: registration } : {}),
    ...(legacy.address ? { address_block: legacy.address } : {}),
    ...(legacy.contact ? { contact_block: legacy.contact } : {}),
    ...(legacy.footerNote ? { disclaimer_text: legacy.footerNote } : {}),
    ...(legacy.accentColor ? { brand_color: legacy.accentColor } : {}),
  };
}

function letterhead2Defaults(business = {}, plugin = {}) {
  const contact = [business.phone, business.email].filter(Boolean).join(' | ');
  return {
    logo: '',
    organization_name: business.name || '',
    tagline: '',
    brand_color: '#0f766e',
    address_block: business.address || '',
    contact_phone: business.phone || '',
    contact_email: business.email || '',
    contact_block: contact,
    registration_block: '',
    disclaimer_text: '',
    primary_font: 'Georgia',
    logo_size: 'medium',
    logo_shape: 'wide',
    header_style: 'balanced',
    document_label: plugin.documentTypes?.[0]?.label || 'Letterhead',
  };
}

function normalizeLetterhead2(raw, defaults) {
  const parsed = parseSettings(raw, {});
  const fields = parsed.fields && typeof parsed.fields === 'object'
    ? parsed.fields
    : parsed.global && typeof parsed.global === 'object'
      ? parsed.global
      : parsed;
  const compact = compactLetterheadFields(fields, defaults);
  return {
    version: parsed.version || 3,
    selectedTarget: parsed.selectedTarget || 'all',
    global: compact,
    branches: parsed.branches && typeof parsed.branches === 'object' ? parsed.branches : {},
  };
}

function compactLetterheadFields(fields = {}, defaults = {}) {
  const legacyContact = splitContactBlock(fields.contact_block || defaults.contact_block);
  const address = hasField(fields, 'address_block')
    ? fields.address_block || ''
    : [
      fields.street_address,
      fields.address_line_2,
      [fields.city, fields.state, fields.zip].filter(Boolean).join(' '),
      fields.country,
    ].filter(Boolean).join(', ') || defaults.address_block || '';
  const contactPhone = hasField(fields, 'contact_phone')
    ? fields.contact_phone || ''
    : fields.phone || fields.alt_phone || legacyContact.phone || defaults.contact_phone || '';
  const contactEmail = hasField(fields, 'contact_email')
    ? fields.contact_email || ''
    : fields.email || legacyContact.email || defaults.contact_email || '';
  const registration = hasField(fields, 'registration_block')
    ? fields.registration_block || ''
    : [
      fields.registration_number,
      fields.license_number,
      fields.accreditation,
      fields.practice_type,
    ].filter(Boolean).join(' | ') || defaults.registration_block || '';
  return {
    ...defaults,
    logo: getTextField(fields, 'logo', defaults),
    organization_name: getTextField(fields, 'organization_name', defaults),
    tagline: getTextField(fields, 'tagline', defaults),
    brand_color: getTextField(fields, 'brand_color', defaults, '#0f766e'),
    address_block: address,
    contact_phone: contactPhone,
    contact_email: contactEmail,
    contact_block: [contactPhone, contactEmail].filter(Boolean).join(' | '),
    registration_block: registration,
    disclaimer_text: getTextField(fields, 'disclaimer_text', defaults),
    primary_font: getTextField(fields, 'primary_font', defaults, 'Georgia'),
    logo_size: getTextField(fields, 'logo_size', defaults, 'medium'),
    logo_shape: getTextField(fields, 'logo_shape', defaults, 'wide'),
    header_style: getTextField(fields, 'header_style', defaults, 'balanced'),
    document_label: getTextField(fields, 'document_label', defaults, 'Letterhead'),
  };
}

function hasField(fields = {}, key) {
  return Object.prototype.hasOwnProperty.call(fields, key);
}

function getTextField(fields = {}, key, defaults = {}, fallback = '') {
  if (hasField(fields, key)) return fields[key] || '';
  if (hasField(defaults, key)) return defaults[key] || '';
  return fallback;
}

function splitContactBlock(contactBlock = '') {
  const parts = String(contactBlock || '')
    .split(/[|\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const email = parts.find((part) => part.includes('@')) || '';
  const phone = parts.find((part) => !part.includes('@')) || '';
  return { phone, email };
}

function formatLocationAddress(location = {}) {
  return [
    location.addressLine1,
    location.addressLine2,
    [location.city, location.state, location.postalCode].filter(Boolean).join(' '),
    location.country,
  ].filter(Boolean).join(', ');
}

function branchSeedFields(globalFields, location) {
  const contactPhone = location?.phone || globalFields.contact_phone || '';
  return {
    ...globalFields,
    address_block: formatLocationAddress(location) || globalFields.address_block || '',
    contact_phone: contactPhone,
    contact_email: globalFields.contact_email || '',
    contact_block: [contactPhone, globalFields.contact_email].filter(Boolean).join(' | '),
  };
}

function normalizeFollowUp(raw) {
  const parsed = parseSettings(raw, {});
  const keywords = Array.isArray(parsed.serviceNameKeywords) && parsed.serviceNameKeywords.length
    ? parsed.serviceNameKeywords
    : DEFAULT_FOLLOW_UP_KEYWORDS;
  return {
    enabled: parsed.enabled === true,
    freeWithinDays: String(Number.isFinite(Number(parsed.freeWithinDays)) ? Math.max(1, Math.min(365, Number(parsed.freeWithinDays))) : 7),
    serviceNameKeywords: keywords.join('\n'),
    sameDoctorOnly: parsed.sameDoctorOnly !== false,
  };
}

function serializeFollowUp(form) {
  const days = Number(form.freeWithinDays);
  const serviceNameKeywords = String(form.serviceNameKeywords || '')
    .split(/[\n,]+/)
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean)
    .filter((keyword, index, all) => all.indexOf(keyword) === index);

  return {
    enabled: form.enabled === true,
    freeWithinDays: Number.isFinite(days) ? Math.max(1, Math.min(365, days)) : 7,
    serviceNameKeywords: serviceNameKeywords.length ? serviceNameKeywords : DEFAULT_FOLLOW_UP_KEYWORDS,
    sameDoctorOnly: form.sameDoctorOnly !== false,
  };
}

function SettingsShell({ title, eyebrow, intro, loading, children }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="mb-5">
        <p className="text-xs font-bold uppercase tracking-wide text-teal-700">{eyebrow}</p>
        <h2 className="mt-1 text-lg font-semibold text-gray-900">{title}</h2>
        <p className="mt-1 text-sm text-gray-500">{intro}</p>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Spinner small />
          Loading settings...
        </div>
      ) : children}
    </div>
  );
}

export function DoctorLetterheadSettingsPanel({ business, refreshTenant }) {
  const defaults = useMemo(() => letterheadDefaults(business), [business?.address, business?.email, business?.name, business?.phone]);
  const [form, setForm] = useState(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [editingAsset, setEditingAsset] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api('/api/business/content')
      .then(({ content }) => {
        if (!cancelled) setForm(normalizeLetterhead(content?.letterheadSettings, defaults));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load letterhead settings');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [business?.id, defaults]);

  function patch(next) {
    setSaved(false);
    setForm((current) => ({ ...current, ...next }));
  }

  async function save(e) {
    e?.preventDefault?.();
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await api('/api/business/content', {
        method: 'PUT',
        body: JSON.stringify({ letterheadSettings: JSON.stringify(form) }),
      });
      await refreshTenant?.();
      setSaved(true);
    } catch (err) {
      setError(err.message || 'Could not save letterhead settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsShell
      eyebrow="Doctor clinic"
      title="Prescription letterhead"
      intro="Controls the clinic letterhead used when doctors write and print Rx documents."
      loading={loading}
    >
      <form onSubmit={save} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <TextInput label="Clinic name" value={form.businessName} onChange={(value) => patch({ businessName: value })} />
          <TextInput label="Registration label" value={form.registrationLabel} onChange={(value) => patch({ registrationLabel: value })} />
          <TextInput label="Registration value" value={form.registrationValue} onChange={(value) => patch({ registrationValue: value })} />
          <TextInput label="Contact line" value={form.contact} onChange={(value) => patch({ contact: value })} />
        </div>

        <TextInput label="Clinic address" value={form.address} onChange={(value) => patch({ address: value })} />

        <div className="grid gap-4 md:grid-cols-2">
          <LetterheadAssetField
            label="Clinic logo"
            description="Upload, edit, or paste a logo used on printed prescriptions."
            value={form.logoUrl}
            onChange={(value) => patch({ logoUrl: value })}
            onEdit={() => setEditingAsset('logoUrl')}
            previewClassName="h-16 w-28 object-contain"
          />
          <LetterheadAssetField
            label="Watermark"
            description="Optional background mark shown softly behind Rx content."
            value={form.watermarkUrl}
            onChange={(value) => patch({ watermarkUrl: value })}
            onEdit={() => setEditingAsset('watermarkUrl')}
            previewClassName="h-16 w-16 object-contain"
          />
        </div>

        <TextArea
          label="Sidebar / clinic information"
          value={form.sidebarText}
          onChange={(value) => patch({ sidebarText: value })}
          rows={3}
          hint="Shown as extra clinic information on prescription formats that support it."
        />
        <TextArea
          label="Footer note"
          value={form.footerNote}
          onChange={(value) => patch({ footerNote: value })}
          rows={3}
        />

        <div className="grid gap-4 md:grid-cols-3">
          <SelectField label="Layout" value={form.format} onChange={(value) => patch({ format: value })} options={[
            ['classic', 'Classic'],
            ['sidebar', 'Sidebar'],
            ['minimal', 'Minimal'],
          ]} />
          <SelectField label="Font" value={form.fontFamily} onChange={(value) => patch({ fontFamily: value })} options={[
            ['inter', 'Modern'],
            ['serif', 'Serif'],
            ['rounded', 'Rounded'],
            ['mono', 'Mono'],
          ]} />
          <SelectField label="Logo shape" value={form.logoAspect} onChange={(value) => patch({ logoAspect: value })} options={[
            ['wide', 'Wide'],
            ['rectangle', 'Rectangle'],
            ['square', 'Square'],
          ]} />
          <SelectField label="Heading size" value={form.titleScale} onChange={(value) => patch({ titleScale: value })} options={[
            ['compact', 'Compact'],
            ['normal', 'Normal'],
            ['large', 'Large'],
          ]} />
          <SelectField label="Body size" value={form.bodyScale} onChange={(value) => patch({ bodyScale: value })} options={[
            ['compact', 'Compact'],
            ['normal', 'Normal'],
            ['large', 'Large'],
          ]} />
          <SelectField label="Watermark strength" value={form.watermarkStrength} onChange={(value) => patch({ watermarkStrength: value })} options={[
            ['soft', 'Soft'],
            ['normal', 'Normal'],
            ['strong', 'Strong'],
          ]} />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <ColorField label="Accent colour" value={form.accentColor} onChange={(value) => patch({ accentColor: value })} />
          <ColorField label="Secondary colour" value={form.secondaryColor} onChange={(value) => patch({ secondaryColor: value })} />
        </div>

        <LetterheadPreview settings={form} />

        {error && <ErrorBanner message={error} />}
        {saved && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">Letterhead saved</p>}
        <PrimaryButton type="submit" loading={saving}>Save letterhead</PrimaryButton>
        {editingAsset && (
          <ImageEditorModal
            value={form[editingAsset] || ''}
            scope={editingAsset === 'logoUrl' ? 'doctor-letterhead-logo' : 'doctor-letterhead-watermark'}
            frameAspect={editingAsset === 'logoUrl'
              ? form.logoAspect === 'square' ? 1 : form.logoAspect === 'rectangle' ? 3 : 4
              : 1}
            maxOutputWidth={editingAsset === 'logoUrl' ? 1200 : 900}
            title={editingAsset === 'logoUrl' ? 'Edit letterhead logo' : 'Edit letterhead watermark'}
            onSave={(url) => {
              patch({ [editingAsset]: url });
              setEditingAsset(null);
            }}
            onClose={() => setEditingAsset(null)}
          />
        )}
      </form>
    </SettingsShell>
  );
}

export function Letterhead2SettingsPanel({ business, subscription, refreshTenant }) {
  const themeKey = subscription?.theme || business?.theme || business?.category || business?.profession || '';
  const plugin = useMemo(() => getDocumentPluginForTheme(themeKey), [themeKey]);
  const defaults = useMemo(() => letterhead2Defaults(business, plugin), [
    business?.address,
    business?.country,
    business?.email,
    business?.name,
    business?.phone,
    business?.state,
    plugin,
  ]);
  const [settings, setSettings] = useState(() => ({
    version: 3,
    selectedTarget: 'all',
    global: defaults,
    branches: {},
  }));
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [editingAsset, setEditingAsset] = useState(null);
  const requestedTarget = settings.selectedTarget || 'all';
  const selectedLocation = locations.find((item) => item.id === requestedTarget) || null;
  const selectedTarget = requestedTarget === 'all' || selectedLocation ? requestedTarget : 'all';
  const activeFields = selectedLocation
    ? compactLetterheadFields(
      settings.branches?.[selectedLocation.id]?.fields || branchSeedFields(settings.global, selectedLocation),
      branchSeedFields(settings.global, selectedLocation)
    )
    : settings.global;
  const hasBranchOverride = !!(selectedLocation && settings.branches?.[selectedLocation.id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api('/api/business/content'),
      api('/api/locations').catch(() => ({ locations: [] })),
    ])
      .then(([{ content }, locationPayload]) => {
        if (cancelled) return;
        const seed = { ...defaults, ...legacyLetterheadSeed(content?.letterheadSettings) };
        const next = normalizeLetterhead2(content?.letterhead2Settings, seed);
        setSettings(next);
        setLocations((locationPayload.locations || []).filter((item) => item.isActive !== false));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load Letterhead2 settings');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [business?.id, defaults]);

  function patch(next) {
    setSaved(false);
    setSettings((current) => {
      if (selectedTarget === 'all') {
        return {
          ...current,
          global: compactLetterheadFields({ ...current.global, ...next }, defaults),
        };
      }
      const location = locations.find((item) => item.id === selectedTarget);
      const seed = branchSeedFields(current.global, location);
      const currentBranch = current.branches?.[selectedTarget]?.fields || seed;
      return {
        ...current,
        branches: {
          ...(current.branches || {}),
          [selectedTarget]: {
            fields: compactLetterheadFields({ ...currentBranch, ...next }, seed),
          },
        },
      };
    });
  }

  function selectTarget(target) {
    setSaved(false);
    setSettings((current) => ({ ...current, selectedTarget: target }));
  }

  function resetBranch() {
    if (!selectedLocation) return;
    setSaved(false);
    setSettings((current) => {
      const branches = { ...(current.branches || {}) };
      delete branches[selectedLocation.id];
      return { ...current, branches };
    });
  }

  function applyActiveToAllBranches() {
    setSaved(false);
    setSettings((current) => ({
      ...current,
      selectedTarget: 'all',
      global: compactLetterheadFields(activeFields, defaults),
      branches: {},
    }));
  }

  async function save(e) {
    e?.preventDefault?.();
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await api('/api/business/content', {
        method: 'PUT',
        body: JSON.stringify({
          letterhead2Settings: JSON.stringify({
            version: 4,
            pluginId: plugin.id,
            themeKey,
            selectedTarget,
            global: settings.global,
            branches: settings.branches,
            fields: settings.global,
          }),
        }),
      });
      await refreshTenant?.();
      setSaved(true);
    } catch (err) {
      setError(err.message || 'Could not save Letterhead2 settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsShell
      eyebrow="Universal documents"
      title="Letterhead2"
      intro="A clean branch-aware letterhead. The current Letterhead tab remains unchanged."
      loading={loading}
    >
      <form onSubmit={save} className="space-y-6">
        <div className="rounded-2xl border border-gray-200 bg-gray-50 p-3">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <BranchButton active={selectedTarget === 'all'} onClick={() => selectTarget('all')}>
              All branches
            </BranchButton>
            {locations.map((location) => (
              <BranchButton
                key={location.id}
                active={selectedTarget === location.id}
                onClick={() => selectTarget(location.id)}
              >
                {location.name}
              </BranchButton>
            ))}
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,360px)_1fr]">
          <section className="rounded-2xl border border-gray-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-gray-500">Brand</p>
            <Letterhead2BrandEditor
              fields={activeFields}
              onChange={patch}
              onEditLogo={() => setEditingAsset('logo')}
            />
          </section>

          <section className="rounded-2xl border border-gray-200 bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                  {selectedLocation ? selectedLocation.name : 'All branches'}
                </p>
                <h3 className="mt-1 text-base font-bold text-gray-950">{plugin.label} letterhead</h3>
              </div>
              {selectedLocation && (
                <div className="flex flex-wrap gap-2">
                  {hasBranchOverride && (
                    <button
                      type="button"
                      onClick={resetBranch}
                      className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-bold text-gray-700 hover:bg-gray-50"
                    >
                      Use all-branches style
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={applyActiveToAllBranches}
                    className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs font-bold text-teal-800 hover:bg-teal-100"
                  >
                    Apply to all branches
                  </button>
                </div>
              )}
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <TextInput
                label="Registration / license details"
                value={activeFields.registration_block}
                onChange={(value) => patch({ registration_block: value })}
                placeholder="Med Reg No. 12345 / Bar No. ABC"
              />
              <TextArea
                label="Address"
                value={activeFields.address_block}
                onChange={(value) => patch({ address_block: value })}
                rows={3}
              />
              <TextInput
                label="Contact no."
                type="tel"
                value={activeFields.contact_phone}
                onChange={(value) => patch({ contact_phone: value })}
              />
              <TextInput
                label="Email"
                type="email"
                value={activeFields.contact_email}
                onChange={(value) => patch({ contact_email: value })}
              />
            </div>
          </section>
        </div>

        <section className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px_220px_180px]">
            <TextArea
              label="Footer disclaimer"
              value={activeFields.disclaimer_text}
              onChange={(value) => patch({ disclaimer_text: value })}
              rows={3}
            />
            <SelectField label="Font" value={activeFields.primary_font} onChange={(value) => patch({ primary_font: value })} options={[
              ['Georgia', 'Georgia'],
              ['Arial', 'Arial'],
              ['Calibri', 'Calibri'],
              ['Times New Roman', 'Times New Roman'],
            ]} />
            <SelectField label="Header style" value={activeFields.header_style} onChange={(value) => patch({ header_style: value })} options={[
              ['balanced', 'Balanced'],
              ['compact', 'Compact'],
              ['statement', 'Statement'],
            ]} />
            <SelectField label="Logo size" value={activeFields.logo_size} onChange={(value) => patch({ logo_size: value })} options={[
              ['small', 'Small'],
              ['medium', 'Medium'],
              ['large', 'Large'],
            ]} />
            <SelectField label="Logo shape" value={activeFields.logo_shape} onChange={(value) => patch({ logo_shape: value })} options={[
              ['square', 'Square'],
              ['rectangle', 'Rectangle'],
              ['wide', 'Wide'],
            ]} />
            <ColorField label="Accent colour" value={activeFields.brand_color} onChange={(value) => patch({ brand_color: value })} />
          </div>
        </section>

        {error && <ErrorBanner message={error} />}
        {saved && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">Letterhead2 saved</p>}

        <Letterhead2Preview settings={activeFields} plugin={plugin} branch={selectedLocation} />

        <PrimaryButton type="submit" loading={saving}>Save Letterhead2</PrimaryButton>
        {editingAsset && (
          <ImageEditorModal
            value={activeFields[editingAsset] || ''}
            scope={`letterhead2-${editingAsset}`}
            frameAspect={editingAsset === 'logo' ? logoFrameAspect(activeFields.logo_shape) : 1}
            maxOutputWidth={editingAsset === 'logo' ? 1200 : 900}
            title={`Edit ${editingAsset.replace(/_/g, ' ')}`}
            onSave={(url) => {
              patch({ [editingAsset]: url });
              setEditingAsset(null);
            }}
            onClose={() => setEditingAsset(null)}
          />
        )}
      </form>
    </SettingsShell>
  );
}

export function DoctorFollowUpSettingsPanel({ refreshTenant }) {
  const [form, setForm] = useState(() => normalizeFollowUp(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api('/api/business/content')
      .then(({ content }) => {
        if (!cancelled) setForm(normalizeFollowUp(content?.followUpSettings));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load follow-up settings');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  function patch(next) {
    setSaved(false);
    setForm((current) => ({ ...current, ...next }));
  }

  async function save(e) {
    e?.preventDefault?.();
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await api('/api/business/content', {
        method: 'PUT',
        body: JSON.stringify({ followUpSettings: JSON.stringify(serializeFollowUp(form)) }),
      });
      await refreshTenant?.();
      setSaved(true);
    } catch (err) {
      setError(err.message || 'Could not save follow-up settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsShell
      eyebrow="Doctor clinic"
      title="Follow-up rules"
      intro="Controls when a patient can book a free follow-up consultation after a completed appointment."
      loading={loading}
    >
      <form onSubmit={save} className="space-y-5">
        <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="mt-0.5 h-4 w-4 rounded accent-teal-700"
          />
          <span>
            <span className="block text-sm font-semibold text-gray-900">Enable free follow-up booking</span>
            <span className="mt-0.5 block text-xs text-gray-500">When enabled, matching follow-up visit types can become free for eligible returning patients.</span>
          </span>
        </label>

        <div className="grid gap-4 md:grid-cols-2">
          <TextInput
            label="Free follow-up window in days"
            type="number"
            min={1}
            max={365}
            value={form.freeWithinDays}
            onChange={(value) => patch({ freeWithinDays: value })}
            hint="Example: 7 means a patient can book an eligible follow-up within 7 days of a completed appointment."
          />
          <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <input
              type="checkbox"
              checked={form.sameDoctorOnly}
              onChange={(e) => patch({ sameDoctorOnly: e.target.checked })}
              className="mt-0.5 h-4 w-4 rounded accent-teal-700"
            />
            <span>
              <span className="block text-sm font-semibold text-gray-900">Same doctor only</span>
              <span className="mt-0.5 block text-xs text-gray-500">Require the follow-up to be booked with the doctor who completed the original visit.</span>
            </span>
          </label>
        </div>

        <TextArea
          label="Follow-up visit type keywords"
          value={form.serviceNameKeywords}
          onChange={(value) => patch({ serviceNameKeywords: value })}
          rows={4}
          hint="One per line. If a visit type contains one of these words, it can be treated as a follow-up."
        />

        {error && <ErrorBanner message={error} />}
        {saved && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">Follow-up rules saved</p>}
        <PrimaryButton type="submit" loading={saving}>Save follow-up rules</PrimaryButton>
      </form>
    </SettingsShell>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm bg-white"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </label>
  );
}

function ColorField({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || '#0f766e'}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-12 rounded border border-gray-300"
        />
        <input
          type="text"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          maxLength={7}
          className="w-full px-3 py-2.5 border border-gray-300 rounded-lg font-mono text-sm focus:outline-none"
        />
      </div>
    </label>
  );
}

function BranchButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-sm font-bold transition ${
        active
          ? 'bg-gray-950 text-white shadow-sm'
          : 'border border-gray-200 bg-white text-gray-600 hover:border-gray-400 hover:text-gray-950'
      }`}
    >
      {children}
    </button>
  );
}

function logoFrameAspect(shape) {
  if (shape === 'square') return 1;
  if (shape === 'rectangle') return 2;
  return 4;
}

function logoBoxClass(shape = 'wide', size = 'medium') {
  const classes = {
    small: {
      square: 'h-12 w-12',
      rectangle: 'h-12 w-24',
      wide: 'h-12 w-32',
    },
    medium: {
      square: 'h-16 w-16',
      rectangle: 'h-16 w-32',
      wide: 'h-16 w-40',
    },
    large: {
      square: 'h-20 w-20',
      rectangle: 'h-20 w-40',
      wide: 'h-20 w-52',
    },
  };
  return classes[size]?.[shape] || classes.medium.wide;
}

function Letterhead2BrandEditor({ fields, onChange, onEditLogo }) {
  const logoClass = logoBoxClass(fields.logo_shape, fields.logo_size);
  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center gap-4 rounded-xl border border-gray-200 bg-gray-50 p-3">
        {fields.logo ? (
          <div className="flex shrink-0 items-center justify-center rounded-xl bg-white p-2 shadow-sm">
            <img
              src={fields.logo}
              alt=""
              className={`${logoClass} object-contain`}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          </div>
        ) : (
          <div className={`${logoClass} flex shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-lg font-black text-white shadow-sm`}>
            {(fields.organization_name || 'L').slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-lg font-black leading-tight text-gray-950">{fields.organization_name || 'Clinic / firm name'}</p>
          {fields.tagline ? (
            <p className="mt-1 truncate text-xs font-bold uppercase tracking-[0.24em] text-gray-500">{fields.tagline}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onEditLogo}
              className="rounded-lg bg-teal-700 px-3 py-2 text-xs font-bold text-white hover:bg-teal-800"
            >
              {fields.logo ? 'Edit logo' : 'Upload logo'}
            </button>
            <button
              type="button"
              onClick={() => onChange({ logo: '' })}
              disabled={!fields.logo}
              className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        </div>
      </div>
      <div className="grid gap-4">
        <TextInput
          label="Logo URL"
          type="url"
          value={fields.logo || ''}
          onChange={(value) => onChange({ logo: value })}
          placeholder="https://..."
        />
        <TextInput
          label="Name"
          value={fields.organization_name}
          onChange={(value) => onChange({ organization_name: value })}
        />
        <TextInput
          label="Punchline"
          value={fields.tagline}
          onChange={(value) => onChange({ tagline: value })}
          placeholder="Business admin"
        />
      </div>
    </div>
  );
}

function Letterhead2Preview({ settings, plugin, branch }) {
  const accent = settings.brand_color || '#0f766e';
  const logoClass = logoBoxClass(settings.logo_shape, settings.logo_size);
  const headerIsCompact = settings.header_style === 'compact';
  const headerIsStatement = settings.header_style === 'statement';
  const fontFamily = settings.primary_font || 'Georgia';

  return (
    <section className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-gray-500">A4 preview</p>
          <p className="text-xs text-gray-500">
            {branch?.name || 'All branches'} · {plugin.label}
          </p>
        </div>
        <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-500">
          210 x 297 mm
        </span>
      </div>

      <article
        className="mx-auto aspect-[210/297] w-full max-w-[794px] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
        style={{ fontFamily }}
      >
        <div className="flex h-full flex-col">
          <div className="h-1.5 shrink-0" style={{ backgroundColor: accent }} />
          <div className="flex min-h-0 flex-1 flex-col p-6 sm:p-8">
            <header
              className={`border-b pb-5 ${headerIsCompact ? 'flex flex-wrap items-center justify-between gap-5' : 'grid gap-5 md:grid-cols-[auto_1fr_auto]'}`}
              style={{ borderColor: `${accent}55` }}
            >
              <div className="flex items-center">
                {settings.logo ? (
                  <img src={settings.logo} alt="" className={`${logoClass} object-contain`} />
                ) : (
                  <div
                    className={`${logoClass} flex items-center justify-center rounded-xl text-lg font-black text-white`}
                    style={{ backgroundColor: accent }}
                  >
                    {(settings.organization_name || 'L').slice(0, 1).toUpperCase()}
                  </div>
                )}
              </div>
              <div className={headerIsStatement ? 'text-center' : headerIsCompact ? 'min-w-0 flex-1' : 'min-w-0'}>
                <p className={`${headerIsStatement ? 'text-3xl' : 'text-2xl'} font-black leading-tight text-gray-950`}>
                  {settings.organization_name || 'Clinic / firm name'}
                </p>
                {settings.tagline && (
                  <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.22em] text-gray-500">
                    {settings.tagline}
                  </p>
                )}
                {settings.registration_block && (
                  <p className="mt-2 text-xs font-bold uppercase tracking-wide" style={{ color: accent }}>
                    {settings.registration_block}
                  </p>
                )}
              </div>
              <div className={`${headerIsCompact ? 'max-w-xs' : 'md:justify-self-end'} space-y-2 text-left text-xs leading-5 text-gray-700`}>
                <LetterheadContactLine icon="phone" value={settings.contact_phone} placeholder="+123-456-7890" accent={accent} />
                <LetterheadContactLine icon="email" value={settings.contact_email} placeholder="hello@example.com" accent={accent} />
                <LetterheadContactLine icon="address" value={settings.address_block} placeholder="123 Anywhere St., Any City" accent={accent} />
              </div>
            </header>

            <main className="flex-1 py-8">
              <div className="space-y-5">
                <div className="h-3 w-44 rounded-full bg-gray-200" />
                <div className="space-y-3">
                  <div className="h-2.5 w-full rounded-full bg-gray-100" />
                  <div className="h-2.5 w-11/12 rounded-full bg-gray-100" />
                  <div className="h-2.5 w-10/12 rounded-full bg-gray-100" />
                </div>
                <div className="pt-6 space-y-3">
                  <div className="h-2.5 w-full rounded-full bg-gray-100" />
                  <div className="h-2.5 w-9/12 rounded-full bg-gray-100" />
                  <div className="h-2.5 w-5/12 rounded-full bg-gray-100" />
                </div>
              </div>
            </main>

            <footer className="border-t pt-4 text-[11px] leading-5 text-gray-500" style={{ borderColor: `${accent}33` }}>
              <p className="whitespace-pre-line">
                {settings.disclaimer_text || 'Footer disclaimer appears here.'}
              </p>
            </footer>
          </div>
        </div>
      </article>
    </section>
  );
}

function LetterheadContactLine({ icon, value, placeholder, accent }) {
  return (
    <div className="flex items-start gap-2">
      <LetterheadContactIcon icon={icon} accent={accent} />
      <span className="min-w-0 whitespace-pre-line">{value || placeholder}</span>
    </div>
  );
}

function LetterheadContactIcon({ icon, accent }) {
  const common = {
    className: 'mt-0.5 h-4 w-4 shrink-0',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: accent,
    strokeWidth: 2.25,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  };
  if (icon === 'email') {
    return (
      <svg {...common}>
        <path d="M4 6h16v12H4z" />
        <path d="m4 7 8 6 8-6" />
      </svg>
    );
  }
  if (icon === 'address') {
    return (
      <svg {...common}>
        <path d="M12 21s7-5.4 7-11a7 7 0 0 0-14 0c0 5.6 7 11 7 11z" />
        <circle cx="12" cy="10" r="2.5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
    </svg>
  );
}

function LetterheadAssetField({ label, description, value, onChange, onEdit, previewClassName }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-900">{label}</p>
          <p className="mt-1 text-xs leading-5 text-gray-500">{description}</p>
        </div>
        {value ? (
          <img
            src={value}
            alt=""
            className={`shrink-0 rounded-lg border border-gray-200 bg-gray-50 p-1.5 ${previewClassName}`}
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50 text-[10px] font-bold uppercase tracking-wide text-gray-400">
            Empty
          </div>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="rounded-lg bg-teal-700 px-3 py-2 text-xs font-bold text-white hover:bg-teal-800"
        >
          {value ? 'Edit / replace' : 'Upload'}
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50"
          >
            Remove
          </button>
        )}
      </div>
      <label className="mt-3 block">
        <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-gray-400">Image URL</span>
        <input
          type="url"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://..."
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs outline-none focus:border-teal-600"
        />
      </label>
    </section>
  );
}

function LetterheadPreview({ settings }) {
  const accent = settings.accentColor || '#0f766e';
  const secondary = settings.secondaryColor || '#facc15';
  const isSidebar = settings.format === 'sidebar';
  const isMinimal = settings.format === 'minimal';
  const titleClass = settings.titleScale === 'large' ? 'text-xl' : settings.titleScale === 'compact' ? 'text-base' : 'text-lg';
  const bodyClass = settings.bodyScale === 'large' ? 'text-sm' : settings.bodyScale === 'compact' ? 'text-[11px]' : 'text-xs';

  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-gray-500">Live preview</p>
          <p className="text-xs text-gray-500">Sample prescription letterhead using the current settings.</p>
        </div>
        <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-500">
          {settings.format || 'classic'}
        </span>
      </div>

      <div className="mx-auto max-w-xl overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className={isSidebar ? 'grid grid-cols-[112px_1fr]' : ''}>
          {isSidebar && (
            <aside className="min-h-[420px] border-r-2 p-4" style={{ borderColor: accent }}>
              {settings.logoUrl ? (
                <img src={settings.logoUrl} alt="" className="mb-4 h-12 w-full object-contain" />
              ) : (
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg text-sm font-black text-white" style={{ backgroundColor: accent }}>
                  {(settings.businessName || 'C').slice(0, 1).toUpperCase()}
                </div>
              )}
              <p className="text-sm font-black leading-tight" style={{ color: accent }}>{settings.businessName || 'Clinic name'}</p>
              {settings.sidebarText && <p className="mt-4 whitespace-pre-line text-[10px] font-semibold leading-4 text-gray-600">{settings.sidebarText}</p>}
            </aside>
          )}

          <section className="relative min-h-[420px] p-6">
            {isSidebar && <div className="absolute left-0 right-0 top-0 h-3" style={{ background: `linear-gradient(90deg, ${accent}, ${secondary})` }} />}
            {settings.watermarkUrl && (
              <img src={settings.watermarkUrl} alt="" className="pointer-events-none absolute left-1/2 top-1/2 h-48 w-48 -translate-x-1/2 -translate-y-1/2 object-contain opacity-10" />
            )}
            <div className={`relative flex items-start justify-between gap-4 pb-4 ${isMinimal ? 'border-b-2 border-gray-900' : 'border-b-2'}`} style={isMinimal ? undefined : { borderColor: accent }}>
              <div className="flex items-start gap-3">
                {!isMinimal && !isSidebar && (
                  settings.logoUrl ? (
                    <img src={settings.logoUrl} alt="" className="h-12 w-24 rounded bg-white object-contain" />
                  ) : (
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg text-sm font-black text-white" style={{ backgroundColor: accent }}>
                      {(settings.businessName || 'C').slice(0, 1).toUpperCase()}
                    </div>
                  )
                )}
                <div>
                  <p className={`${titleClass} font-black text-gray-950`}>{settings.businessName || 'Clinic name'}</p>
                  <p className="mt-1 text-[11px] leading-5 text-gray-500">
                    {settings.registrationLabel || 'Reg. No.'}: {settings.registrationValue || '__________'}
                  </p>
                  <p className="text-[11px] leading-5 text-gray-500">{settings.address || 'Clinic address'} | {settings.contact || 'Phone | Email'}</p>
                </div>
              </div>
              <div className="rounded-lg px-3 py-2 text-center" style={{ backgroundColor: `${accent}14` }}>
                <p className="text-base font-black" style={{ color: accent }}>Rx</p>
                <p className="text-[9px] font-bold uppercase tracking-wide" style={{ color: accent }}>Prescription</p>
              </div>
            </div>

            {!isSidebar && settings.sidebarText && (
              <div className="relative mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3 text-[11px] leading-5 text-gray-600">
                <p className="mb-1 text-[9px] font-bold uppercase tracking-wide text-gray-400">Clinic information</p>
                <p className="whitespace-pre-line">{settings.sidebarText}</p>
              </div>
            )}

            <div className={`relative mt-5 grid gap-3 ${bodyClass}`}>
              <div className="grid grid-cols-2 gap-2">
                <PreviewPill label="Patient" value="Sample Patient" />
                <PreviewPill label="Date" value="Today" />
              </div>
              <p className="text-2xl font-serif text-gray-950">Rx</p>
              <div className="rounded-lg border border-gray-200">
                <div className="flex gap-3 border-b border-gray-100 p-3">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: accent }}>1</span>
                  <div>
                    <p className="font-bold text-gray-950">Medicine name 500 mg</p>
                    <p className="mt-0.5 text-gray-600">1 tablet | Twice daily | 5 days | After food</p>
                  </div>
                </div>
                <div className="p-3 text-gray-600">Advice, tests and follow-up notes appear here.</div>
              </div>
              <div className="mt-4 flex justify-end">
                <div className="w-40 border-t border-gray-400 pt-2 text-center text-[11px] font-semibold text-gray-600">
                  Doctor signature
                </div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-[11px] font-semibold leading-5 text-amber-900">{settings.footerNote || 'Footer note appears here.'}</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function PreviewPill({ label, value }) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2 ring-1 ring-gray-100">
      <p className="text-[9px] font-black uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-0.5 truncate text-[11px] font-bold text-gray-950">{value}</p>
    </div>
  );
}
