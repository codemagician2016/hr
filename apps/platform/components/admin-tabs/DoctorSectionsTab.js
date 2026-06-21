'use client';

// Doctor v2 (Phase 4) — section editor. Reorder (up/down) + show/hide the
// bespoke doctor storefront sections. Saved as content.sectionOrder (JSON
// array, order) + content.hiddenSections (JSON array of hidden keys).

import { useState, useEffect } from 'react';
import { api } from '@/lib/adminApi';
import { Spinner, PrimaryButton } from '@/components/admin-ui';

const SECTION_LABELS = {
  branches: 'Clinic model / branches',
  'visit-types': 'Visit types',
  doctors: 'Doctors',
  reviews: 'Patient reviews',
  prescriptions: 'Prescription workflow',
  trust: 'Trust badges',
  faq: 'FAQs',
};
const DEFAULT_ORDER = ['branches', 'visit-types', 'doctors', 'prescriptions', 'reviews', 'trust', 'faq'];

function parseOrder(v) {
  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string' && v.trim()) {
    try { const a = JSON.parse(v); arr = Array.isArray(a) ? a : []; } catch { arr = v.split(',').map((s) => s.trim()).filter(Boolean); }
  }
  arr = arr.filter((k) => DEFAULT_ORDER.includes(k));
  return [...arr, ...DEFAULT_ORDER.filter((k) => !arr.includes(k))];
}
function parseHidden(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [];
}

export default function DoctorSectionsTab() {
  const [order, setOrder] = useState(null); // null = loading
  const [hidden, setHidden] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api('/api/business/content').then(({ content }) => {
      setOrder(parseOrder(content?.sectionOrder));
      setHidden(new Set(parseHidden(content?.hiddenSections)));
    }).catch(() => setOrder([...DEFAULT_ORDER]));
  }, []);

  function move(i, dir) {
    setSaved(false);
    setOrder((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function toggle(key) {
    setSaved(false);
    setHidden((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }
  async function save() {
    setBusy(true);
    try {
      await api('/api/business/content', {
        method: 'PUT',
        body: JSON.stringify({
          sectionOrder: JSON.stringify(order),
          hiddenSections: JSON.stringify(Array.from(hidden)),
        }),
      });
      setSaved(true);
    } finally { setBusy(false); }
  }

  if (order === null) return <Spinner />;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Storefront sections</h2>
        <p className="text-sm text-gray-500">Reorder, show or hide the sections on your public clinic homepage. Changes appear on your site after saving.</p>
      </div>

      <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
        {order.map((key, i) => (
          <li key={key} className="flex items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-3">
              <div className="flex flex-col text-[11px] leading-none">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="text-gray-400 hover:text-gray-700 disabled:opacity-30" aria-label="Move up">▲</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === order.length - 1} className="mt-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30" aria-label="Move down">▼</button>
              </div>
              <span className="text-sm font-medium text-gray-900">{SECTION_LABELS[key] || key}</span>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={!hidden.has(key)}
                onChange={() => toggle(key)}
                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              {hidden.has(key) ? 'Hidden' : 'Visible'}
            </label>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-3">
        <PrimaryButton onClick={save} loading={busy}>Save sections</PrimaryButton>
        {saved && <span className="text-sm text-emerald-600">Saved ✓</span>}
      </div>
    </div>
  );
}
