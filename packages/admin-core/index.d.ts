export const ADMIN_CORE_VERSION: 1;

export interface PanelDefinition {
  version?: number;
  key: string;
  label?: string;
  vertical?: 'shared' | 'APPOINTMENT' | 'ECOMMERCE' | 'STATIC' | string;
  group?: string;
  requiredFeatures?: string[];
  component?: unknown;
  loader?: () => Promise<unknown>;
}

export function createPanelDefinition(definition: PanelDefinition): Required<Pick<PanelDefinition, 'version' | 'key' | 'vertical' | 'group' | 'requiredFeatures'>> & PanelDefinition;
export function filterPanelsForFeatures(panels: PanelDefinition[], features?: Record<string, unknown>): PanelDefinition[];
export function createPanelRegistry(panels?: PanelDefinition[]): {
  get(key: string): PanelDefinition | undefined;
  keys(): string[];
  list(filter?: { vertical?: string; group?: string }): PanelDefinition[];
  forFeatures(features?: Record<string, unknown>): PanelDefinition[];
};
export const GROCERY_ADMIN_PANEL_KEYS: readonly string[];
