'use strict';

/**
 * Shared config for the qa/e2e suites — hosts and demo logins.
 *
 * Replaces two problems these suites all had:
 *
 *  1. Every one of them `require`d the absolute path /Users/kp/hr/qa/playbook.json
 *     purely to look up a demo login. The playbook process was RETIRED (see
 *     CLAUDE.md), so the whole e2e suite depended on a file nobody maintains any
 *     more — and on one developer's home directory, so it could never run in CI.
 *  2. Every one of them hardcoded https://app-staging.drifthr.com, so they could
 *     only ever be pointed at staging. Verifying a fix on prod, or against a
 *     local stack, meant editing 23 files.
 *
 * Hosts are env-overridable, defaulting to staging so existing usage is unchanged:
 *
 *   E2E_ADMIN   admin/API origin       (default https://app-staging.drifthr.com)
 *   E2E_ESS     employee portal origin (default https://demo-staging.drifthr.com)
 *   E2E_MOBILE  mobile-web origin      (default https://m-demo-staging.drifthr.com)
 *   E2E_PASSWORD  demo password for every seeded login
 *
 * e.g. run the whole set against prod:
 *   E2E_ADMIN=https://app.drifthr.com E2E_ESS=https://demo.drifthr.com \
 *     node qa/e2e/e2e-p3-feed.js
 */

const ADMIN = process.env.E2E_ADMIN || 'https://app-staging.drifthr.com';
const ESS = process.env.E2E_ESS || 'https://demo-staging.drifthr.com';
const MOBILE = process.env.E2E_MOBILE || 'https://m-demo-staging.drifthr.com';
const PASSWORD = process.env.E2E_PASSWORD || 'Demo@12345';

// The seeded demo tenant's operators and employees. Labels match what the suites
// already searched for via substring, so `cred('HR Admin')` keeps working.
const LOGINS = [
  { label: 'HR Admin (maker)', role: 'Owner / HR Admin', email: 'operator@demo.test', password: PASSWORD, portalUrl: ADMIN },
  { label: 'Finance (checker)', role: 'Finance', email: 'finance@demo.test', password: PASSWORD, portalUrl: ADMIN },
  { label: 'Manager (Aarav)', role: 'Manager', email: 'aarav.sharma@demo.test', password: PASSWORD, portalUrl: ESS },
  { label: 'Employee (Priya)', role: 'Employee', email: 'priya.nair@demo.test', password: PASSWORD, portalUrl: ESS },
  { label: 'Employee (Meera)', role: 'Employee', email: 'meera.iyer@demo.test', password: PASSWORD, portalUrl: ESS },
  { label: 'Employee (Karthik)', role: 'Employee', email: 'karthik.reddy@demo.test', password: PASSWORD, portalUrl: ESS },
];

/** Find a seeded login by a substring of its label — the lookup the suites use. */
function cred(label) {
  const hit = LOGINS.find((x) => x.label.includes(label));
  if (!hit) throw new Error(`qa/e2e/config: no seeded login matching "${label}"`);
  return hit;
}

module.exports = { ADMIN, ESS, MOBILE, PASSWORD, LOGINS, logins: LOGINS, cred };
