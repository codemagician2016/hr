import type {
  NormalizedThemeConfig,
  ThemeContract,
  ThemeInheritanceMode,
  ThemeMode,
  ThemeSlotGroup,
  Vertical,
} from '@sitepresso/types';

export const THEME_CONTRACT_VERSION: 1;
export const VERTICALS: Record<string, Vertical>;
export const THEME_MODES: Record<string, ThemeMode>;
export const THEME_INHERITANCE_MODES: Record<string, ThemeInheritanceMode>;
export const SLOT_GROUPS: Record<string, ThemeSlotGroup>;

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
