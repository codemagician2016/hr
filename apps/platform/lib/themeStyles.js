// White-label visual styles shim.
//
// Backed by the slimmed @hr/theme-engine (5 fixed styles). The old
// profession styles module was removed; this file now
// composes the compatibility surface that existing consumers import:
//   STYLES, STYLE_KEYS, DEFAULT_STYLE_KEY
//
// A tenant picks ONE of these 5 styles. Each STYLES entry exposes a `.name`
// (consumers render it as the style label) alongside the resolved palette.

import {
  FIXED_STYLE_SEEDS,
  FIXED_STYLE_KEYS,
  DEFAULT_STYLE_KEY as ENGINE_DEFAULT_STYLE_KEY,
} from '@hr/theme-engine';

export const DEFAULT_STYLE_KEY = ENGINE_DEFAULT_STYLE_KEY;

// STYLE_KEYS = the 5 fixed style keys, in order. (→ FIXED_STYLE_KEYS)
export const STYLE_KEYS = [...FIXED_STYLE_KEYS];

function styleEntry(key) {
  const seed = FIXED_STYLE_SEEDS[key] || {};
  const palette = seed.palette || {};
  return {
    key,
    name: seed.label || key,
    label: seed.label || key,
    primaryColor: palette.primary,
    bgColor: palette.background,
    textColor: palette.foreground,
    palette,
    metadata: seed.metadata || {},
  };
}

// STYLES = the 5 styles, keyed by style key.
export const STYLES = STYLE_KEYS.reduce((acc, key) => {
  acc[key] = styleEntry(key);
  return acc;
}, {});

// Back-compat alias: some consumers reference `STYLES.light` as a fallback
// label (e.g. `STYLES[x]?.name || STYLES.light.name`). Point it at the default
// style so that access never throws.
if (!STYLES.light) {
  STYLES.light = STYLES[DEFAULT_STYLE_KEY];
}
