import type {
  NormalizedThemeConfig,
  ThemeContract,
  ThemeInheritanceMode,
  ThemeMode,
  ThemeSlotGroup,
  Vertical,
} from '@hr/types';

export const THEME_CONTRACT_VERSION: 1;
export const VERTICALS: Record<string, Vertical>;
export const THEME_MODES: Record<string, ThemeMode>;
export const THEME_INHERITANCE_MODES: Record<string, ThemeInheritanceMode>;
export const SLOT_GROUPS: Record<string, ThemeSlotGroup>;

/** The single HR vertical this engine serves (canonical, from @hr/types). */
export const HR: 'HR';
/** Back-compat alias of HR. */
export const HR_VERTICAL: 'HR';

/** One of the 5 fixed style keys. */
export type FixedStyleKey = 'slate' | 'indigo' | 'emerald' | 'rose' | 'mono';

/** One of the 12 curated brand color keys. */
export type ColorKey =
  | 'indigo' | 'blue' | 'teal' | 'emerald' | 'green' | 'amber'
  | 'orange' | 'red' | 'rose' | 'pink' | 'violet' | 'slate';

/** A curated brand color entry. */
export interface BrandColor {
  key: ColorKey;
  name: string;
  hex: string;
}

/** Tenant brand record: one chosen style + one brand color + a logo. */
export interface TenantBrandInput {
  styleKey?: FixedStyleKey | string;
  /** Curated brand color key (one of COLOR_KEYS); takes precedence over `primary`. */
  colorKey?: ColorKey | string;
  /** Raw brand color hex (used only when no colorKey is given). */
  primary?: string;
  primaryColor?: string;
  palette?: { primary?: string };
  logoUrl?: string;
  logo?: string;
}

export interface ThemeRegistry {
  register(key: string, config: Record<string, unknown>): NormalizedThemeConfig;
  get(key?: string, fallbackKey?: string): NormalizedThemeConfig | null;
  list(filter?: { vertical?: string; mode?: string }): NormalizedThemeConfig[];
  keys(): string[];
  byVertical(vertical: string): NormalizedThemeConfig[];
  resolve(key?: string, fallbackKey?: string): NormalizedThemeConfig | null;
  size(): number;
}

export function cleanKey(value: unknown, fallback?: string): string;
export function normalizeVertical(value: unknown, fallback?: Vertical): Vertical;
export function normalizeMode(value: unknown, fallback?: ThemeMode): ThemeMode;
export function normalizeInheritance(value: unknown, fallback?: ThemeInheritanceMode): ThemeInheritanceMode;
export function deepMerge<T, U>(base: T, override: U): T & U;
export function composeTheme(
  base?: ThemeContract | Record<string, unknown>,
  override?: ThemeContract | Record<string, unknown>,
  options?: { inheritance?: ThemeInheritanceMode; defaults?: Record<string, unknown> }
): NormalizedThemeConfig;
export function normalizeThemeConfig(raw?: Record<string, unknown>, defaults?: Record<string, unknown>): NormalizedThemeConfig;
export function validateThemeContract(theme: Record<string, unknown>): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  theme: NormalizedThemeConfig;
};
export function createThemeRegistry(
  entries?: Record<string, Record<string, unknown>> | Record<string, unknown>[],
  options?: { defaultKey?: string }
): ThemeRegistry;
export function resolveThemeSlots(
  theme: Record<string, unknown>,
  defaults?: Record<string, Record<string, unknown>>
): Record<ThemeSlotGroup, Record<string, unknown>>;
export function resolveThemeSlot(
  theme: Record<string, unknown>,
  group: ThemeSlotGroup | string,
  slotKey: string,
  defaults?: Record<string, Record<string, unknown>>
): unknown;
export function createLazySlotResolver(options?: {
  importers?: Record<string, () => Promise<unknown>>;
  defaults?: Record<string, Record<string, unknown>>;
  dynamicLoader?: (importer: () => Promise<unknown>) => unknown;
}): (theme: Record<string, unknown>, group: ThemeSlotGroup | string, slotKey: string, fallbackSlot?: string) => unknown;
export function buildThemeManifest(
  entries?: Record<string, Record<string, unknown>> | Record<string, unknown>[],
  options?: { defaultKey?: string; includeSlots?: boolean }
): Array<Omit<NormalizedThemeConfig, 'raw'>>;
export function buildBackendThemeManifest(
  entries?: Record<string, Record<string, unknown>> | Record<string, unknown>[],
  options?: { defaultKey?: string }
): Array<Pick<NormalizedThemeConfig, 'key' | 'label' | 'vertical' | 'mode' | 'contractVersion' | 'panels' | 'features' | 'vocab' | 'metadata'>>;

// ── HR fixed-style system ───────────────────────────────────────────────────

/** Default fixed style key when a tenant has not chosen one. */
export const DEFAULT_STYLE_KEY: FixedStyleKey;

/** The 5 fixed style seeds, keyed by style key. */
export const FIXED_STYLE_SEEDS: Record<FixedStyleKey, Record<string, unknown>>;

/** The 5 fixed style keys, in order. */
export const FIXED_STYLE_KEYS: readonly FixedStyleKey[];

/** A ready-built registry containing exactly the 5 fixed styles. */
export const hrStyleRegistry: ThemeRegistry;

/** Build a fresh registry of the 5 fixed styles. */
export function createHrStyleRegistry(): ThemeRegistry;

/** Coerce an arbitrary style key to one of the 5 fixed keys (falls back to default). */
export function normalizeStyleKey(styleKey: unknown): FixedStyleKey;

// ── Curated brand colors ────────────────────────────────────────────────────

/** The 12 curated brand colors, in order. */
export const COLORS: readonly BrandColor[];

/** The 12 curated brand color keys, in order. */
export const COLOR_KEYS: readonly ColorKey[];

/** Default brand color key when a tenant has not chosen one. */
export const DEFAULT_COLOR_KEY: ColorKey;

/** Coerce an arbitrary color key to one of the 12 curated keys (falls back to default). */
export function normalizeColorKey(colorKey: unknown): ColorKey;

/** Resolve a curated brand color key to its hex (falls back to the default color). */
export function resolveColor(colorKey: unknown): string;

/**
 * Resolve a runtime theme for a tenant from their brand record
 * `{ styleKey, colorKey, primary, logoUrl }`: the chosen fixed style supplies
 * the base palette + neutral defaults; the brand primary comes from `colorKey`
 * (via COLORS, taking precedence) or a raw `primary` hex, else DEFAULT_COLOR_KEY;
 * the logo is carried through on the returned theme.
 */
export function resolveTenantTheme(
  tenant?: TenantBrandInput
): NormalizedThemeConfig & { styleKey: FixedStyleKey; colorKey: ColorKey | null; logoUrl: string | null };
