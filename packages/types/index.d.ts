export const THEME_CONTRACT_VERSION: 1;

export const VERTICALS: {
  HR: 'HR';
  APPOINTMENT: 'APPOINTMENT';
  ECOMMERCE: 'ECOMMERCE';
  STATIC: 'STATIC';
};

export const THEME_MODES: {
  GENERIC: 'generic';
  MIXED: 'mixed';
  BESPOKE: 'bespoke';
};

export const THEME_INHERITANCE_MODES: {
  MERGE: 'merge';
  REPLACE: 'replace';
};

export const SLOT_GROUPS: {
  ADMIN: 'admin';
  STOREFRONT: 'storefront';
  CUSTOMER: 'customer';
  STAFF: 'staff';
};

export const APP_SURFACES: {
  ADMIN: 'admin';
  STOREFRONT: 'storefront';
  CUSTOMER: 'customer';
  STAFF: 'staff';
};

export const ADMIN_SURFACE_MODEL: {
  CANONICAL_APP: 'apps/platform';
  CANONICAL_ROUTE: '/dashboard';
};

export type Vertical = 'HR' | 'APPOINTMENT' | 'ECOMMERCE' | 'STATIC';
export type ThemeMode = 'generic' | 'mixed' | 'bespoke';
export type ThemeInheritanceMode = 'merge' | 'replace';
export type ThemeSlotGroup = 'admin' | 'storefront' | 'customer' | 'staff';
export type AppSurface = 'admin' | 'storefront' | 'customer' | 'staff';

export interface ThemePalette {
  primary?: string;
  accent?: string;
  background?: string;
  foreground?: string;
}

export interface ThemeVocab {
  appointment?: string;
  appointments?: string;
  service?: string;
  services?: string;
  staff?: string;
  team?: string;
  customer?: string;
  customers?: string;
  location?: string;
  locations?: string;
  bookCta?: string;
  confirmMsg?: string;
}

export interface ThemeContract {
  contractVersion?: number;
  key: string;
  label: string;
  vertical: Vertical | string;
  mode?: ThemeMode;
  extends?: string;
  inheritance?: ThemeInheritanceMode;
  palette?: ThemePalette;
  vocab?: ThemeVocab | Record<string, unknown>;
  features?: Record<string, unknown>;
  panels?: string[];
  adminPanels?: string[];
  admin?: {
    panels?: string[];
    slots?: Record<string, unknown>;
  };
  slots?: {
    admin?: Record<string, unknown>;
    storefront?: Record<string, unknown>;
    customer?: Record<string, unknown>;
    staff?: Record<string, unknown>;
  };
}

export interface NormalizedThemeConfig {
  contractVersion: number;
  key: string;
  label: string;
  vertical: Vertical;
  mode: ThemeMode;
  extends?: string;
  inheritance: ThemeInheritanceMode;
  palette: ThemePalette;
  vocab: ThemeVocab;
  features: Record<string, unknown>;
  panels: string[];
  slots: Record<ThemeSlotGroup, Record<string, unknown>>;
  metadata: Record<string, unknown>;
  raw: Record<string, unknown>;
}
