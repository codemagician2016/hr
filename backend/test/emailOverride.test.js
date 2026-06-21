// Single source of truth for email routing — every outgoing email
// goes through resolveRecipient(). A regression here silently reroutes
// real customer mail or vice-versa, so the rule needs full coverage.

const { resolveRecipient, isProductionDeploy } = require('../src/core/lib/emailOverride');

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.DEPLOY_ENV;
  delete process.env.STAGING_EMAIL_OVERRIDE;
});
afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('resolveRecipient', () => {
  test('production: mail goes to the real recipient', () => {
    process.env.DEPLOY_ENV = 'production';
    const r = resolveRecipient('customer@example.com');
    expect(r.actualRecipient).toBe('customer@example.com');
    expect(r.overrideApplied).toBe(false);
  });

  test('production is case-insensitive ("PRODUCTION" still counts)', () => {
    process.env.DEPLOY_ENV = 'PRODUCTION';
    const r = resolveRecipient('customer@example.com');
    expect(r.actualRecipient).toBe('customer@example.com');
  });

  test('staging: mail reroutes to the staging inbox', () => {
    process.env.DEPLOY_ENV = 'staging';
    const r = resolveRecipient('customer@example.com');
    expect(r.actualRecipient).toBe('codemagician2016@gmail.com');
    expect(r.overrideApplied).toBe(true);
    expect(r.requestedRecipient).toBe('customer@example.com');
  });

  test('any non-production value reroutes (dev, e2e, preview, …)', () => {
    for (const env of ['development', 'dev', 'e2e', 'preview', 'demo', 'whatever']) {
      process.env.DEPLOY_ENV = env;
      expect(resolveRecipient('customer@example.com').overrideApplied).toBe(true);
    }
  });

  test('missing DEPLOY_ENV reroutes (safe-by-default)', () => {
    delete process.env.DEPLOY_ENV;
    const r = resolveRecipient('customer@example.com');
    expect(r.overrideApplied).toBe(true);
    expect(r.actualRecipient).toBe('codemagician2016@gmail.com');
  });

  test('STAGING_EMAIL_OVERRIDE env var wins over the hardcoded inbox', () => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.STAGING_EMAIL_OVERRIDE = 'someone@else.com';
    const r = resolveRecipient('customer@example.com');
    expect(r.actualRecipient).toBe('someone@else.com');
  });

  test('overrideApplied=false when staging inbox happens to match recipient', () => {
    process.env.DEPLOY_ENV = 'staging';
    const r = resolveRecipient('codemagician2016@gmail.com');
    expect(r.overrideApplied).toBe(false);
    expect(r.actualRecipient).toBe('codemagician2016@gmail.com');
  });
});

describe('isProductionDeploy', () => {
  test('true only when DEPLOY_ENV is the literal "production"', () => {
    process.env.DEPLOY_ENV = 'production';
    expect(isProductionDeploy()).toBe(true);
  });
  test('false for staging', () => {
    process.env.DEPLOY_ENV = 'staging';
    expect(isProductionDeploy()).toBe(false);
  });
  test('false when unset', () => {
    delete process.env.DEPLOY_ENV;
    expect(isProductionDeploy()).toBe(false);
  });
});
