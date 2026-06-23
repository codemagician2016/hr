// Derive the full `--theme-*` CSS-variable map from a theme resolved by
// @hr/theme-engine's resolveTenantTheme(). Mirrors apps/ess/lib/themeVars.js
// (same keys + derivations) so the admin shell and @hr/ui primitives read the
// identical branded variables the ESS portal does — the console picks up the
// operator's tenant brand instead of only --theme-primary.
//
// resolveTenantTheme returns a NormalizedThemeConfig whose palette holds the
// resolved brand `primary`, plus `background`/`foreground` from the chosen
// fixed style; the rest is computed here.

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function isHex(v) {
  return typeof v === 'string' && HEX_RE.test(v.trim());
}

function expandHex(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return h.length === 6 ? h : null;
}

// Relative-luminance contrast pick: readable on-color for text/icons on `hex`.
function onColor(hex) {
  const h = expandHex(hex);
  if (!h) return '#FFFFFF';
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.55 ? '#0F172A' : '#FFFFFF';
}

function darken(hex, amount = 0.18) {
  const h = expandHex(hex);
  if (!h) return hex;
  const ch = (i) => {
    const v = parseInt(h.slice(i, i + 2), 16);
    return Math.max(0, Math.round(v * (1 - amount)));
  };
  const to2 = (n) => n.toString(16).padStart(2, '0');
  return `#${to2(ch(0))}${to2(ch(2))}${to2(ch(4))}`.toUpperCase();
}

// Build the full `--theme-*` map from a resolved theme. Falls back to neutral
// defaults (matching globals.css :root — DriftHR teal) for any missing field.
export function themeVarsFromResolved(theme) {
  const palette = theme?.palette || {};
  const primary = isHex(palette.primary) ? palette.primary : '#16B6A6';
  const accent = isHex(palette.accent) ? palette.accent : primary;
  const bg = isHex(palette.background) ? palette.background : '#F6F8FA';
  const surface = '#FFFFFF';
  const text = isHex(palette.foreground) ? palette.foreground : '#16243B';
  return {
    '--theme-primary': primary,
    '--theme-primary-dark': darken(primary),
    // Soft brand tint for active nav backgrounds / subtle accents. Alpha keeps
    // it readable on the white sidebar across every one of the 12 brand colours.
    '--theme-primary-soft': `${primary}14`,
    '--theme-accent': accent,
    '--theme-bg': bg,
    '--theme-surface': surface,
    '--theme-text': text,
    '--theme-muted': `${text}99`,
    '--theme-border': `${text}22`,
    '--theme-on-primary': onColor(primary),
    '--theme-on-accent': onColor(accent),
    // Legacy alias some @hr/ui primitives may read for primary foreground.
    '--theme-primary-fg': onColor(primary),
  };
}
