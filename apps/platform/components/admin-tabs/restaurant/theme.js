// Shared "hospitality" design tokens for the restaurant_reservations ADMIN.
// Mirrors the storefront (deep wine + teal + warm cream + serif headings) so the
// operator's management experience is on-brand instead of generic gray. Import
// these in every restaurant admin panel so they stay visually consistent with
// the diner-facing website.
export const RX = {
  wine: '#7F1D1D',       // primary — matches storefront primaryColor
  wineDark: '#5E1414',
  wineSoft: '#FBF1F0',   // tinted wine background
  teal: '#0F766E',       // accent — matches storefront accentColor
  tealSoft: '#ECF6F4',
  cream: '#FAF6EC',      // page canvas (hospitality warm paper)
  panel: '#FFFFFF',
  ink: '#241B17',        // warm near-black text
  inkSoft: '#5C5048',
  muted: '#8A7C6F',
  line: '#E9DFCE',       // warm hairline border
  lineSoft: '#F2EADB',
  gold: '#B08D4F',       // sparing premium accent
  good: '#0F766E',       // seated/active uses teal
  serif: "'DM Serif Display', Georgia, 'Times New Roman', serif",
};

// Reusable class fragments (Tailwind) for consistency.
export const RXC = {
  panel: 'rounded-2xl border bg-white',          // + style borderColor RX.line
  eyebrow: 'text-[11px] font-bold uppercase tracking-[0.18em]',  // + style color RX.gold
  pillActive: 'text-white',                       // + style background RX.wine
};

export default RX;
