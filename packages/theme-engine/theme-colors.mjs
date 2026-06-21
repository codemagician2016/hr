// ============================================================================
// Sitepresso — Colour Customisation (Phase 3 · April 2026)
//
// Per-tenant palette overrides on top of profession × style. Stored as JSON
// in Subscription.themeColors. Users pick from PRESETS (curated, theme-aware)
// OR enter custom hex codes for full control.
//
// Shape: { primary, accent, surface, bg, text } — any subset is valid. Unset
// fields fall through to the profession+style defaults.
// ============================================================================

// Curated colour presets — named groups that cover the common taste clusters.
// Each preset supplies a coherent primary / accent / surface triplet.
export const COLOR_PRESETS = [
  // Blues (medical, corporate, trust)
  { key: 'indigo_sky',   name: 'Indigo · Sky',   primary: '#4F46E5', accent: '#38BDF8', surface: '#F0F7FF' },
  { key: 'ocean',        name: 'Ocean',           primary: '#1B6CA8', accent: '#38BDF8', surface: '#F0F7FF' },
  { key: 'navy_gold',    name: 'Navy · Gold',     primary: '#0E1B33', accent: '#C9A95F', surface: '#F4EFE2' },

  // Greens (nature, wellness, fitness)
  { key: 'forest',       name: 'Forest',          primary: '#15803D', accent: '#22C55E', surface: '#F0FDF4' },
  { key: 'sage',         name: 'Sage',            primary: '#3D4A3A', accent: '#5A6B52', surface: '#F6F7F2' },
  { key: 'teal',         name: 'Teal',            primary: '#0F766E', accent: '#14B8A6', surface: '#F0FDF8' },

  // Warm (beauty, spa, hospitality)
  { key: 'rose',         name: 'Rose',            primary: '#BE185D', accent: '#EC4899', surface: '#FEF0F4' },
  { key: 'amber',        name: 'Amber',           primary: '#B45309', accent: '#F59E0B', surface: '#FFF8ED' },
  { key: 'terracotta',   name: 'Terracotta',      primary: '#8A4238', accent: '#D97757', surface: '#FBF4EE' },

  // Moody (barbershop, tattoo, streetwear)
  { key: 'crimson_ink',  name: 'Crimson · Ink',   primary: '#E31B23', accent: '#0A0A0A', surface: '#151515' },
  { key: 'monochrome',   name: 'Monochrome',      primary: '#1A1A1A', accent: '#4A4A4A', surface: '#F5F5F5' },

  // Modern vivid (tech, creative)
  { key: 'violet',       name: 'Violet',          primary: '#7C3AED', accent: '#A855F7', surface: '#F5F0FF' },
  { key: 'electric',     name: 'Electric',        primary: '#0EA5E9', accent: '#F59E0B', surface: '#F0F9FF' },
  { key: 'neon',         name: 'Neon',            primary: '#EC4899', accent: '#06B6D4', surface: '#FAFAFA' },
];

export const COLOR_PRESET_KEYS = COLOR_PRESETS.map((p) => p.key);

export function getColorPreset(key) {
  return COLOR_PRESETS.find((p) => p.key === key) || null;
}

// Validate + normalise a user-supplied overrides object. Silently drops
// anything that isn't a valid hex code (#RGB, #RRGGBB, case-insensitive).
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const ALLOWED_KEYS = ['primary', 'accent', 'surface', 'bg', 'text'];

export function sanitizeColorOverrides(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const k of ALLOWED_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && HEX_RE.test(v.trim())) {
      out[k] = v.trim().toUpperCase();
    }
  }
  return out;
}

// Parse Subscription.themeColors — can be JSON string (DB), object (in-memory)
// or nullable. Returns a sanitised object.
export function parseThemeColors(value) {
  if (!value) return {};
  if (typeof value === 'object') return sanitizeColorOverrides(value);
  try { return sanitizeColorOverrides(JSON.parse(value)); } catch { return {}; }
}

// Serialise for persistence. Empty object → null (so we don't clutter the DB).
export function serializeThemeColors(overrides) {
  const clean = sanitizeColorOverrides(overrides);
  return Object.keys(clean).length === 0 ? null : JSON.stringify(clean);
}

export function isValidHex(v) {
  return typeof v === 'string' && HEX_RE.test(v.trim());
}
