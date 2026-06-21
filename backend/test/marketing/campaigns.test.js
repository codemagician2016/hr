// Tests for marketing campaign registry + render. Pure unit tests.

const {
  CAMPAIGNS,
  CAMPAIGNS_BY_KEY,
  renderCampaign,
  listCampaigns,
  getCampaign,
} = require('../../src/core/lib/marketing/campaigns');

describe('CAMPAIGNS registry', () => {
  test('all 6 campaigns present', () => {
    const keys = CAMPAIGNS.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining([
      'BIRTHDAY',
      'POST_VISIT',
      'NO_SHOW_WINBACK',
      'LAPSED_90D',
      'ANNIVERSARY',
      'LOYALTY_MILESTONE',
    ]));
  });

  test('each campaign has required fields', () => {
    for (const c of CAMPAIGNS) {
      expect(c.key).toMatch(/^[A-Z_0-9]+$/);
      expect(c.displayName).toBeTruthy();
      expect(c.description).toBeTruthy();
      expect(c.triggerType).toBeTruthy();
      expect(typeof c.delayHours).toBe('number');
      expect(c.frequencyCap).toEqual(expect.objectContaining({
        perWindowDays: expect.any(Number),
        maxSendsInWindow: expect.any(Number),
      }));
      expect(c.defaultSubject).toBeTruthy();
      expect(c.defaultBody).toBeTruthy();
      expect(Array.isArray(c.variables)).toBe(true);
      expect(c.defaultChannels).toEqual(expect.objectContaining({
        email: expect.any(Boolean),
        sms: expect.any(Boolean),
        whatsapp: expect.any(Boolean),
      }));
    }
  });

  test('default channels all start with email-on, SMS/WA opt-in', () => {
    for (const c of CAMPAIGNS) {
      expect(c.defaultChannels.email).toBe(true);
      expect(c.defaultChannels.sms).toBe(false);
      expect(c.defaultChannels.whatsapp).toBe(false);
    }
  });

  test('every variable in body or subject is declared', () => {
    for (const c of CAMPAIGNS) {
      const text = `${c.defaultSubject}\n${c.defaultBody}`;
      const used = (text.match(/\{([A-Z_]+)\}/g) || []).map((m) => m.slice(1, -1));
      for (const v of new Set(used)) {
        expect(c.variables).toContain(v);
      }
    }
  });
});

describe('renderCampaign', () => {
  test('renders BIRTHDAY with merge tags', () => {
    const { subject, body } = renderCampaign({
      campaignKey: 'BIRTHDAY',
      vars: { NAME: 'Sarah', BIZ: 'Bright Smile Dental', LINK: 'https://bs.sp', COUPON_LINE: '' },
    });
    expect(subject).toContain('Sarah');
    expect(body).toContain('Bright Smile Dental');
    expect(body).toContain('https://bs.sp');
  });

  test('uses customSubject + customBody overrides', () => {
    const { subject, body } = renderCampaign({
      campaignKey: 'BIRTHDAY',
      customSubject: 'Custom Hi {NAME}',
      customBody: 'Custom body for {BIZ}',
      vars: { NAME: 'Vikram', BIZ: 'Cafe' },
    });
    expect(subject).toBe('Custom Hi Vikram');
    expect(body).toBe('Custom body for Cafe');
  });

  test('missing optional vars render as empty (not thrown)', () => {
    const { body } = renderCampaign({
      campaignKey: 'POST_VISIT',
      vars: { NAME: 'Sarah', BIZ: 'Cafe' }, // STAFF + LINK + REVIEW_LINK missing
    });
    expect(body).toContain('Sarah');
    expect(body).toContain('Cafe');
    expect(body).not.toContain('{STAFF}');
    expect(body).not.toContain('{LINK}');
    expect(body).not.toContain('{REVIEW_LINK}');
  });

  test('throws on unknown campaign key', () => {
    expect(() => renderCampaign({ campaignKey: 'NOPE', vars: {} })).toThrow(/Unknown campaign/);
  });

  test('cleans up extra whitespace from missing optional values', () => {
    const { body } = renderCampaign({
      campaignKey: 'BIRTHDAY',
      vars: { NAME: 'Sarah', BIZ: 'Cafe', LINK: 'https://x', COUPON_LINE: '' },
    });
    // Body should not have multiple consecutive spaces
    expect(body).not.toMatch(/  /);
  });

  test('numeric values get stringified', () => {
    const { body } = renderCampaign({
      campaignKey: 'LOYALTY_MILESTONE',
      vars: { NAME: 'Vikram', BIZ: 'Cafe', VISIT_COUNT: 25, GIFT_LABEL: 'pastry', LINK: '...' },
    });
    expect(body).toContain('25th visit');
  });
});

describe('listCampaigns + getCampaign', () => {
  test('listCampaigns returns at least the 6 original campaigns', () => {
    // 7 since Sprint 2.4 added ABANDONED_CART
    expect(listCampaigns().length).toBeGreaterThanOrEqual(6);
  });

  test('getCampaign returns correct entry', () => {
    expect(getCampaign('BIRTHDAY').triggerType).toBe('CUSTOMER_BIRTHDAY');
    expect(getCampaign('NOPE')).toBeNull();
  });

  test('ABANDONED_CART campaign present (Sprint 2.4)', () => {
    expect(getCampaign('ABANDONED_CART')).toBeTruthy();
    expect(getCampaign('ABANDONED_CART').triggerType).toBe('ABANDONED_CART');
  });
});
