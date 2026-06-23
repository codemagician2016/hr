'use client';

// useLetterheadLayout — slice 9C picker state. Holds the 5 zone rects in
// NORMALIZED [0,1] top-left space (the storage + render convention), loads them
// from a letterhead's layoutJson, and saves them back via PUT /:id/layout. The
// canvas overlay works in pixels; this hook owns the canonical normalized model
// so px↔normalized conversion stays in one place (the picker page does the px
// math against the rendered canvas size).

import { useCallback, useState } from 'react';
import { request } from '@/lib/api';

// The five placeable zones. `writingArea` lives at layoutJson.writingArea; the
// other four live under layoutJson.fields.<key>.
export const ZONES = [
  { key: 'writingArea', label: 'Writing area', color: '#6366f1', path: 'writingArea' },
  { key: 'date', label: 'Date', color: '#0ea5e9', path: 'fields.date' },
  { key: 'refNo', label: 'Reference no.', color: '#10b981', path: 'fields.refNo' },
  { key: 'authority', label: 'Authority name', color: '#f59e0b', path: 'fields.authority' },
  { key: 'signature', label: 'Signature image', color: '#ec4899', path: 'fields.signature' },
];

// Sensible normalized defaults so a freshly uploaded letterhead opens with all
// five boxes visible and roughly placed (operator then drags to fit).
const DEFAULT_RECTS = {
  writingArea: { x: 0.1, y: 0.3, w: 0.8, h: 0.45, align: 'left', fontSize: 11, lineGap: 4 },
  date: { x: 0.65, y: 0.18, w: 0.25, h: 0.03 },
  refNo: { x: 0.1, y: 0.18, w: 0.3, h: 0.03 },
  authority: { x: 0.1, y: 0.82, w: 0.4, h: 0.04 },
  signature: { x: 0.1, y: 0.76, w: 0.25, h: 0.05 },
};

function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

// Pull the stored rect for a zone out of a layoutJson (handles the writingArea vs
// fields.* split), falling back to the default placement.
function rectFromLayout(layout, zone) {
  const lay = layout && typeof layout === 'object' ? layout : {};
  let stored;
  if (zone.path === 'writingArea') stored = lay.writingArea;
  else stored = lay.fields && lay.fields[zone.key];
  const base = DEFAULT_RECTS[zone.key];
  if (!stored || typeof stored !== 'object') return { ...base };
  return {
    ...base,
    x: clamp01(Number(stored.x ?? base.x)),
    y: clamp01(Number(stored.y ?? base.y)),
    w: clamp01(Number(stored.w ?? base.w)),
    h: clamp01(Number(stored.h ?? base.h)),
    ...(stored.align ? { align: stored.align } : {}),
    ...(stored.fontSize != null ? { fontSize: stored.fontSize } : {}),
    ...(stored.lineGap != null ? { lineGap: stored.lineGap } : {}),
  };
}

export function useLetterheadLayout() {
  // rects: { writingArea:{x,y,w,h,...}, date:{...}, ... } in normalized space.
  const [rects, setRects] = useState(() => {
    const out = {};
    for (const z of ZONES) out[z.key] = { ...DEFAULT_RECTS[z.key] };
    return out;
  });
  const [extras, setExtras] = useState({ overflowPolicy: 'repeat-letterhead', signatureOnLastPage: true });
  const [saving, setSaving] = useState(false);

  // Hydrate from a loaded letterhead row's layoutJson.
  const hydrate = useCallback((layoutJson) => {
    const out = {};
    for (const z of ZONES) out[z.key] = rectFromLayout(layoutJson, z);
    setRects(out);
    const lay = layoutJson && typeof layoutJson === 'object' ? layoutJson : {};
    setExtras({
      overflowPolicy: lay.overflowPolicy === 'blank-continuation' ? 'blank-continuation' : 'repeat-letterhead',
      signatureOnLastPage: lay.signatureOnLastPage !== false,
    });
  }, []);

  // Patch one zone's normalized rect (called as the operator drags/resizes).
  const updateRect = useCallback((zoneKey, patch) => {
    setRects((prev) => {
      const cur = prev[zoneKey] || {};
      const next = { ...cur, ...patch };
      // keep the box on the page
      next.x = clamp01(next.x);
      next.y = clamp01(next.y);
      next.w = clamp01(Math.min(next.w, 1 - next.x));
      next.h = clamp01(Math.min(next.h, 1 - next.y));
      return { ...prev, [zoneKey]: next };
    });
  }, []);

  const setExtra = useCallback((key, value) => {
    setExtras((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Build the layoutJson payload from the current normalized model.
  const toLayoutJson = useCallback(() => {
    const wa = rects.writingArea || DEFAULT_RECTS.writingArea;
    return {
      writingArea: {
        x: round4(wa.x), y: round4(wa.y), w: round4(wa.w), h: round4(wa.h),
        align: wa.align || 'left',
        fontSize: wa.fontSize ?? 11,
        lineGap: wa.lineGap ?? 4,
      },
      fields: {
        date: pickRect(rects.date),
        refNo: pickRect(rects.refNo),
        authority: pickRect(rects.authority),
        signature: pickRect(rects.signature),
      },
      overflowPolicy: extras.overflowPolicy,
      signatureOnLastPage: !!extras.signatureOnLastPage,
    };
  }, [rects, extras]);

  // Persist via PUT /:id/layout (normalized rects).
  const save = useCallback(async (id) => {
    setSaving(true);
    try {
      const layoutJson = toLayoutJson();
      await request(`/api/hr/letters/letterheads/${id}/layout`, {
        method: 'PUT',
        body: JSON.stringify({ layoutJson }),
      });
    } finally {
      setSaving(false);
    }
  }, [toLayoutJson]);

  return { rects, extras, saving, hydrate, updateRect, setExtra, toLayoutJson, save };
}

function round4(n) { return Math.round(Number(n) * 1e4) / 1e4; }
function pickRect(r) {
  const base = r || {};
  return { x: round4(base.x || 0), y: round4(base.y || 0), w: round4(base.w || 0), h: round4(base.h || 0) };
}
