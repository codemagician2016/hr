'use strict';

/**
 * Regression test for the wave-A/B staging bug: countryContext.routes is mounted
 * at the /api/hr ROOT ('/'), so a router-level `router.use(protect)` ran operator
 * auth for EVERY /api/hr/* request — including the customer-session /me/* routes —
 * rejecting customer tokens with "Not authenticated" before requireCustomer was
 * reached. It silently broke the ENTIRE ESS surface (every /me endpoint 401'd).
 *
 * This test asserts the router only guards its OWN two endpoints and lets any
 * other path fall through (so the downstream /me/* customer routes are reachable).
 * Pure structural test — no DB, no seeded customer.
 */
const express = require('express');
const request = require('supertest');
const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-countryctx';

const countryRoutes = require('../src/hr/routes/countryContext.routes');

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/', countryRoutes);
  // Sentinel: anything countryContext lets through lands here.
  app.use((req, res) => res.status(404).json({ fellThrough: true }));

  let failures = 0;
  function check(name, cond) {
    if (cond) { console.log('  ✓ ' + name); } else { console.log('  ✗ ' + name); failures++; }
  }

  // 1) A customer /me path must FALL THROUGH countryContext (404 sentinel), NOT be
  //    intercepted by an operator protect (401). This is the core regression.
  const me = await request(app).get('/me/profile');
  check('GET /me/profile is NOT shadowed by countryContext (falls through)',
    me.status === 404 && me.body && me.body.fellThrough === true);

  // 2) Another unrelated /api/hr path also falls through, not 401'd.
  const exp = await request(app).get('/me/expenses/claims');
  check('GET /me/expenses/claims falls through (not 401 from countryContext)',
    exp.status === 404 && exp.body.fellThrough === true);

  // 3) countryContext's OWN endpoint still enforces operator auth (401 w/o token).
  const cc = await request(app).get('/country-context');
  check('GET /country-context still requires operator auth (401 unauthenticated)',
    cc.status === 401);

  // 4) The setup writer still requires auth too.
  const setup = await request(app).post('/setup/country').send({ countryCode: 'IN' });
  check('POST /setup/country still requires operator auth (401 unauthenticated)',
    setup.status === 401);

  if (failures) { console.log('\ncountryContext route-scope: ' + failures + ' FAILED'); process.exit(1); }
  console.log('\n=== countryContext route-scope: ALL PASSED ===');
  process.exit(0);
})().catch((e) => { console.error('test error', e); process.exit(1); });
