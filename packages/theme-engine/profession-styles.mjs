// ============================================================================
// Sitepresso — Visual Style Variants (Phase 2 · April 2026)
//
// Each style is a set of TOKENS that override a profession's defaults. Styles
// are profession-agnostic: "Dental · Light", "Dental · Dark", "Barber · Bold"
// all compose from the same 10 style tokens.
//
// A style NEVER changes the content (headlines, vocab, section names) — those
// stay with the profession. Styles only touch:
//   • palette mapping     (what's bg, surface, text, muted in this aesthetic)
//   • font family         (sans / serif / mono pairings)
//   • hero overlay opacity
//   • heroStyle tag       ('light' | 'dark' | 'warm' — legacy cue used in page.js)
//
// The style can either SET the palette directly (e.g. Dark forces an ink bg
// regardless of profession), OR KEEP the profession's palette (e.g. Light
// keeps the clinic blue). This is flagged by `palette: 'profession' | 'own'`.
// ============================================================================

// Shared font-family strings — centralized so style definitions stay readable.
const FONT = {
  sans:      "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
  sansTight: "'Inter Tight', 'Inter', ui-sans-serif, system-ui, sans-serif",
  serif:     "'DM Serif Display', 'Playfair Display', ui-serif, Georgia, serif",
  serifText: "'Cormorant Garamond', ui-serif, Georgia, serif",
  mono:      "'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
  display:   "'Bebas Neue', 'Inter Tight', sans-serif",
};

export const STYLES = {

  // ──────────────────────────────────────────────────────────────────────────
  // 1. LIGHT — default. Airy, white bg, profession's primary accent.
  // ──────────────────────────────────────────────────────────────────────────
  light: {
    key: 'light',
    name: 'Light',
    description: 'Airy, white background with your profession\'s accent colour.',
    palette: 'profession', // use profession's own palette
    heroStyle: 'light',
    fontHeading: FONT.sansTight,
    fontBody:    FONT.sans,
    // Subtle tweak to hero overlay so image heroes still read well
    heroOverlayAlpha: 0.55,
    radius: 16,
    buttonRadius: 10,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 2. DARK — inverted. Ink background, vivid profession accent, crisp type.
  // ──────────────────────────────────────────────────────────────────────────
  dark: {
    key: 'dark',
    name: 'Dark',
    description: 'Inverted — ink background, vivid accent, high-contrast type.',
    palette: 'own',
    palette_: {
      bgColor:      '#0A0F1A',
      surfaceColor: '#121826',
      textColor:    '#F1F5F9',
      bodyColor:    '#CBD5E1',
      mutedColor:   '#73839A',
      borderColor:  '#1E2A3A',
    },
    heroStyle: 'dark',
    fontHeading: FONT.sansTight,
    fontBody:    FONT.sans,
    heroOverlayAlpha: 0.85,
    radius: 16,
    buttonRadius: 10,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 3. PRESTIGE — deep editorial surface, serif authority, restrained gold.
  //    Built for high-trust professional services such as legal and advisory.
  // ──────────────────────────────────────────────────────────────────────────
  prestige: {
    key: 'prestige',
    name: 'Prestige',
    description: 'Deep editorial surface, serif authority, restrained gold accents.',
    palette: 'own',
    palette_: {
      bgColor:      '#111820',
      surfaceColor: '#18222E',
      textColor:    '#F7F1E6',
      bodyColor:    '#D8CDBB',
      mutedColor:   '#AFA391',
      borderColor:  '#314052',
    },
    heroStyle: 'dark',
    fontHeading: FONT.serif,
    fontBody:    FONT.sans,
    fontAccent:  FONT.serifText,
    heroOverlayAlpha: 0.82,
    radius: 6,
    buttonRadius: 6,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 3. ELEGANT — serif headlines, muted palette, generous whitespace.
  // ──────────────────────────────────────────────────────────────────────────
  elegant: {
    key: 'elegant',
    name: 'Elegant',
    description: 'Serif headlines, muted cream palette — magazine-grade.',
    palette: 'own',
    palette_: {
      bgColor:      '#FDFCF8',
      surfaceColor: '#F7F2E7',
      textColor:    '#0E1B33',
      bodyColor:    '#3E3A2A',
      mutedColor:   '#6B6853',
      borderColor:  '#E4DAC2',
    },
    heroStyle: 'warm',
    fontHeading: FONT.serif,
    fontBody:    FONT.sans,
    fontAccent:  FONT.serifText,
    heroOverlayAlpha: 0.75,
    radius: 4,
    buttonRadius: 4,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 4. MATTE — flat, muted tones, no gradients, utilitarian.
  // ──────────────────────────────────────────────────────────────────────────
  matte: {
    key: 'matte',
    name: 'Matte',
    description: 'Flat, muted, utilitarian. Zero gradients.',
    palette: 'own',
    palette_: {
      bgColor:      '#F5F5F3',
      surfaceColor: '#EAE9E4',
      textColor:    '#1A1A18',
      bodyColor:    '#3A3A36',
      mutedColor:   '#656561',
      borderColor:  '#D8D6CF',
    },
    heroStyle: 'light',
    fontHeading: FONT.sans,
    fontBody:    FONT.sans,
    heroOverlayAlpha: 0.6,
    radius: 2,
    buttonRadius: 2,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 5. MINIMAL — mostly text, tight palette, small type, generous spacing.
  // ──────────────────────────────────────────────────────────────────────────
  minimal: {
    key: 'minimal',
    name: 'Minimal',
    description: 'Text-first. Tight palette. Whitespace does the talking.',
    palette: 'own',
    palette_: {
      bgColor:      '#FFFFFF',
      surfaceColor: '#FAFAFA',
      textColor:    '#0A0A0A',
      bodyColor:    '#374151',
      mutedColor:   '#6B7484',
      borderColor:  '#E5E7EB',
    },
    heroStyle: 'light',
    fontHeading: FONT.sansTight,
    fontBody:    FONT.sans,
    heroOverlayAlpha: 0.7,
    radius: 8,
    buttonRadius: 6,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 6. BOLD — loud, high-contrast, display type, profession accent dialled up.
  // ──────────────────────────────────────────────────────────────────────────
  bold: {
    key: 'bold',
    name: 'Bold',
    description: 'Display type, high contrast, no shy accents.',
    palette: 'profession', // keep profession colour, amplify it
    heroStyle: 'light',
    fontHeading: FONT.display,
    fontBody:    FONT.sans,
    heroOverlayAlpha: 0.75,
    radius: 4,
    buttonRadius: 4,
    headingUppercase: true,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 7. SOFT — pastel palette, rounded corners, friendly, airy.
  // ──────────────────────────────────────────────────────────────────────────
  soft: {
    key: 'soft',
    name: 'Soft',
    description: 'Pastel palette, rounded corners, approachable.',
    palette: 'own',
    palette_: {
      bgColor:      '#FEF8F5',
      surfaceColor: '#FDF0EC',
      textColor:    '#2A1A15',
      bodyColor:    '#5A4540',
      mutedColor:   '#826960',
      borderColor:  '#F5DDD4',
    },
    heroStyle: 'warm',
    fontHeading: FONT.sansTight,
    fontBody:    FONT.sans,
    heroOverlayAlpha: 0.55,
    radius: 24,
    buttonRadius: 24,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 8. EDITORIAL — serif + sans pairing, magazine rhythm, long-form feel.
  // ──────────────────────────────────────────────────────────────────────────
  editorial: {
    key: 'editorial',
    name: 'Editorial',
    description: 'Serif + sans pairing. Magazine rhythm, long-form feel.',
    palette: 'own',
    palette_: {
      bgColor:      '#FFFFFF',
      surfaceColor: '#F6F4EF',
      textColor:    '#14151A',
      bodyColor:    '#3A3B45',
      mutedColor:   '#6E6F7A',
      borderColor:  '#E6E3DC',
    },
    heroStyle: 'light',
    fontHeading: FONT.serif,
    fontBody:    FONT.sans,
    fontAccent:  FONT.serifText,
    heroOverlayAlpha: 0.7,
    radius: 6,
    buttonRadius: 6,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 9. TECH — mono fonts, crisp palette, neon accents, developer-grade.
  // ──────────────────────────────────────────────────────────────────────────
  tech: {
    key: 'tech',
    name: 'Tech',
    description: 'Mono type, grid lines, neon accent, developer-grade.',
    palette: 'own',
    palette_: {
      bgColor:      '#0E1117',
      surfaceColor: '#161B22',
      textColor:    '#E6EDF3',
      bodyColor:    '#AAB4BE',
      mutedColor:   '#7D8590',
      borderColor:  '#30363D',
    },
    heroStyle: 'dark',
    fontHeading: FONT.mono,
    fontBody:    FONT.sans,
    heroOverlayAlpha: 0.85,
    radius: 6,
    buttonRadius: 6,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 10. ORGANIC — earthy palette, warm neutrals, natural.
  // ──────────────────────────────────────────────────────────────────────────
  organic: {
    key: 'organic',
    name: 'Organic',
    description: 'Earthy warm neutrals — natural, grounded, handmade.',
    palette: 'own',
    palette_: {
      bgColor:      '#F5F0E8',
      surfaceColor: '#EDE4D3',
      textColor:    '#2A1E10',
      bodyColor:    '#4A3A28',
      mutedColor:   '#72634F',
      borderColor:  '#D6C7A8',
    },
    heroStyle: 'warm',
    fontHeading: FONT.serif,
    fontBody:    FONT.sans,
    heroOverlayAlpha: 0.65,
    radius: 12,
    buttonRadius: 10,
  },
};

export const DEFAULT_STYLE_KEY = 'light';

export const STYLE_KEYS = Object.keys(STYLES);

export function getStyle(key) {
  return STYLES[key] || STYLES[DEFAULT_STYLE_KEY];
}

// applyStyle(profession, styleKey) — returns a profession object with the
// chosen style's tokens merged on top. Palette source depends on
// style.palette: 'own' (style supplies bg/surface/text etc.) vs 'profession'
// (style keeps the profession's palette, just swaps fonts + radius).
export function applyStyle(profession, styleKey) {
  const style = getStyle(styleKey);
  const out = { ...profession };

  // Fonts — always take from style.
  out.fontHeading = style.fontHeading;
  out.fontBody    = style.fontBody;
  if (style.fontAccent) out.fontAccent = style.fontAccent;

  // Hero style tag (used by the storefront's legacy isDark check).
  if (style.heroStyle) out.heroStyle = style.heroStyle;

  // Radius — exposed as a token so the storefront can reference it.
  if (style.radius != null)       out.radius = style.radius;
  if (style.buttonRadius != null) out.buttonRadius = style.buttonRadius;
  if (style.headingUppercase)     out.headingUppercase = true;

  // Palette — either replace or keep.
  if (style.palette === 'own' && style.palette_) {
    Object.assign(out, style.palette_);
  }

  // Hero overlay alpha lets each style define its own legibility floor.
  if (style.heroOverlayAlpha != null) {
    const rgb = profession.textColor?.startsWith('#')
      ? hexToRgb(profession.textColor)
      : { r: 12, g: 27, b: 42 };
    out.heroOverlayColor = `rgba(${rgb.r},${rgb.g},${rgb.b},${style.heroOverlayAlpha})`;
  }

  return out;
}

// Utility: hex → rgb for overlay composition.
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
