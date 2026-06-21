jest.mock('../src/core/lib/prisma', () => ({
  businessContent: { upsert: jest.fn() },
  business: { findUnique: jest.fn() },
}));

jest.mock('../src/core/utils/email', () => ({
  sendTrackedEmail: jest.fn(),
  sendStaffInviteEmail: jest.fn(),
}));

const { _private } = require('../src/core/controllers/business.controller');

describe('business content update payload filtering', () => {
  test('keeps schema-backed content fields and drops unknown future fields', () => {
    const data = _private.pickBusinessContentData({
      heroHeadline: 'Premium homepage',
      logoAspect: 'rectangle',
      logoSourceUrl: 'https://cdn.example.com/original-logo.png',
      faviconUrl: 'https://cdn.example.com/favicon.png',
      notAColumnYet: 'do not send to prisma',
    });

    expect(data).toMatchObject({
      heroHeadline: 'Premium homepage',
    });
    expect(data).not.toHaveProperty('notAColumnYet');

    if (_private.WRITABLE_BUSINESS_CONTENT_FIELDS.has('logoAspect')) {
      expect(data.logoAspect).toBe('rectangle');
    }
    if (_private.WRITABLE_BUSINESS_CONTENT_FIELDS.has('logoSourceUrl')) {
      expect(data.logoSourceUrl).toBe('https://cdn.example.com/original-logo.png');
    }
    if (_private.WRITABLE_BUSINESS_CONTENT_FIELDS.has('faviconUrl')) {
      expect(data.faviconUrl).toBe('https://cdn.example.com/favicon.png');
    }
  });

  test('normalizes matching social links and prevents cross-network links', () => {
    const data = _private.pickBusinessContentData({
      socialInstagram: '@tarikgrocery',
      showSocialInstagram: true,
      socialFacebook: 'instagram.com/wrong-place',
      showSocialFacebook: true,
    });

    expect(data.socialInstagram).toBe('https://instagram.com/tarikgrocery');
    expect(data.showSocialInstagram).toBe(true);
    expect(data.socialFacebook).toBeNull();
    expect(data.showSocialFacebook).toBe(false);
  });
});
