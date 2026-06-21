// /api/internal/email-mode is the diagnostic that proves a deploy is
// in real-mail (production) mode. Smoke tests assert it; a regression
// here would silently reroute production mail.

const request = require('supertest');
const express = require('express');

function makeApp() {
  const app = express();
  app.use('/api/internal', require('../src/core/routes/internal.routes'));
  return app;
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.DEPLOY_ENV;
  delete process.env.STAGING_EMAIL_OVERRIDE;
  // Bust the route module cache so changes to env vars are picked up
  // (the route file pulls emailOverride at require time but the helper
  // reads env at call time, so this is belt-and-suspenders).
  delete require.cache[require.resolve('../src/core/routes/internal.routes')];
  delete require.cache[require.resolve('../src/core/lib/emailOverride')];
});
afterAll(() => { process.env = ORIGINAL_ENV; });

describe('GET /api/internal/email-mode', () => {
  test('reports production when DEPLOY_ENV=production', async () => {
    process.env.DEPLOY_ENV = 'production';
    const res = await request(makeApp()).get('/api/internal/email-mode');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('production');
    expect(res.body.deployEnv).toBe('production');
    expect(res.body.stagingInbox).toBeNull();
  });

  test('reports staging when DEPLOY_ENV=staging', async () => {
    process.env.DEPLOY_ENV = 'staging';
    const res = await request(makeApp()).get('/api/internal/email-mode');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('staging');
    expect(res.body.deployEnv).toBe('staging');
    expect(typeof res.body.stagingInbox).toBe('string');
  });

  test('reports staging when DEPLOY_ENV is unset (safe-by-default)', async () => {
    delete process.env.DEPLOY_ENV;
    const res = await request(makeApp()).get('/api/internal/email-mode');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('staging');
    expect(res.body.deployEnv).toBeNull();
  });
});
