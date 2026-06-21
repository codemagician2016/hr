const { getThemeForCategory } = require('../src/core/lib/categoryTheme');
const { getBookingTheme } = require('../src/booking/themes');
const { isRestaurantCategory, isRestaurantTheme } = require('../src/booking/controllers/restaurant.controller');

describe('restaurant booking theme resolution', () => {
  test('all restaurant aliases resolve to the restaurant reservations theme', () => {
    for (const key of ['Restaurant', 'restaurant', 'restaurant-bookings', 'restaurant_bookings', 'restaurant-reservations', 'restaurant_reservations']) {
      expect(getThemeForCategory(key)).toBe('restaurant_reservations');
    }
  });

  test('static education aliases resolve to education website themes', () => {
    expect(getThemeForCategory('math_tutor')).toBe('math_tutor');
    expect(getThemeForCategory('math-tuition')).toBe('math_tuition');
    expect(getThemeForCategory('science_tutor')).toBe('science_tutor');
    expect(getThemeForCategory('english-tutor')).toBe('english_tutor');
  });

  test('booking theme registry accepts restaurant category and theme aliases', () => {
    for (const key of ['restaurant', 'restaurant-bookings', 'restaurant_bookings', 'restaurant-reservations', 'restaurant_reservations']) {
      expect(getBookingTheme(key).id).toBe('restaurant_reservations');
    }
  });

  test('restaurant controller accepts category aliases even when theme data is stale', () => {
    expect(isRestaurantTheme('restaurant')).toBe(true);
    expect(isRestaurantTheme('restaurant_reservations')).toBe(true);
    expect(isRestaurantCategory('restaurant-bookings')).toBe(true);
    expect(isRestaurantCategory('restaurant')).toBe(true);
    expect(isRestaurantCategory('doctor-clinic')).toBe(false);
  });
});
