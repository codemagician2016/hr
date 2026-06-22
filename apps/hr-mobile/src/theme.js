// DriftHR brand palette + shared design tokens for the mobile ESS app.
// Brand: teal #16B6A6 (primary) / ink #16243B (text + dark surfaces),
// font Manrope, tagline "Effortless HR & payroll."

export const colors = {
  // Brand
  teal: '#16B6A6',
  tealDark: '#0E9488',
  tealSoft: '#E6F7F4',
  ink: '#16243B',
  inkSoft: '#243651',

  // Semantic
  primary: '#16B6A6',
  onPrimary: '#FFFFFF',
  text: '#16243B',
  muted: '#64748B',
  border: '#E2E8F0',
  bg: '#F6F8FA',
  card: '#FFFFFF',

  // States
  success: '#16A34A',
  successSoft: '#DCFCE7',
  warning: '#D97706',
  warningSoft: '#FEF3C7',
  danger: '#DC2626',
  dangerSoft: '#FEE2E2',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
};

// Manrope is the brand typeface. We reference the family by name; the native
// system fallback is used until the font is bundled via expo-font at staging.
export const font = {
  family: 'Manrope',
  // Fallback to platform default so text always renders even without the font.
  regular: undefined,
};

export const typography = {
  h1: { fontSize: 26, fontWeight: '800', color: colors.text },
  h2: { fontSize: 20, fontWeight: '700', color: colors.text },
  title: { fontSize: 16, fontWeight: '700', color: colors.text },
  body: { fontSize: 15, fontWeight: '400', color: colors.text },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted },
  caption: { fontSize: 12, fontWeight: '500', color: colors.muted },
};

// React Navigation theme so the navigator chrome matches the brand.
export const navTheme = {
  dark: false,
  colors: {
    primary: colors.primary,
    background: colors.bg,
    card: colors.card,
    text: colors.text,
    border: colors.border,
    notification: colors.teal,
  },
};

export const tagline = 'Effortless HR & payroll.';

export default { colors, spacing, radius, font, typography, navTheme, tagline };
