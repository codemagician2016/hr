import assert from 'node:assert/strict';
import { createProfessionThemeSurface } from '../profession-registry.mjs';

const shop = createProfessionThemeSurface({ surface: 'shop' });
const booking = createProfessionThemeSurface({ surface: 'booking' });
const bookingCore = createProfessionThemeSurface({ surface: 'bookingCore' });
const platform = createProfessionThemeSurface({ surface: 'platform' });
const webCore = createProfessionThemeSurface({ surface: 'webCore' });
const business = createProfessionThemeSurface({ surface: 'business' });

assert.equal(shop.resolveThemeKey('missing'), 'other');
assert.equal(platform.resolveThemeKey('missing'), 'other');
assert.equal(webCore.resolveThemeKey('missing'), 'general_practice');
assert.equal(business.resolveThemeKey('missing'), 'general_practice');

assert.equal(Boolean(shop.THEMES.restaurant_reservations), false);
assert.equal(booking.THEMES.restaurant_reservations.accentColor, '#0F766E');
assert.equal(bookingCore.THEMES.doctor_clinic.primaryColor, '#0E7C7B');
assert.equal(bookingCore.THEMES.law_firm.primaryColor, '#1E3A5F');
assert.equal(platform.THEMES.restaurant_reservations.accentColor, '#D97706');
assert.equal(business.THEMES.doctor_clinic.primaryColor, '#0E7C7B');

assert.ok(platform.STYLES.prestige);
assert.equal(shop.composeTheme('legal').primaryColor, '#B8972E');
assert.equal(platform.composeTheme('legal').primaryColor, '#141C27');

console.log('profession registry tests passed');
