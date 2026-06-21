import staticThemeConfigs from '../../web/lib/themeConfigs';
import { createProfessionThemeSurface } from '@hr/theme-engine/profession-registry.mjs';

const surface = createProfessionThemeSurface({ surface: 'platform', staticThemeConfigs });

export const {
  THEMES,
  THEME_CATEGORIES,
  THEME_KEYS,
  DEFAULT_PROFESSION_KEY,
  STYLES,
  getThemesByCategory,
  getTheme,
  composeTheme,
  getThemeVars,
  resolveThemeKey,
} = surface;
