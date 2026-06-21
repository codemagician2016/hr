#!/usr/bin/env node
/*
 * Openprovider sandbox smoke test — a tiny "CLI" around the real adapter.
 *
 * It exercises the exact code path production uses (src/domains/adapters/
 * openprovider.js), so a green run here means the live integration is wired
 * correctly. It only makes real API calls when OPENPROVIDER_USERNAME +
 * OPENPROVIDER_PASSWORD are set; otherwise it prints the mock fallback so you
 * can see the shape without an account.
 *
 * Usage (from backend/):
 *   node scripts/openprovider-smoke.js                 # auth + availability check
 *   node scripts/openprovider-smoke.js --register foo  # also register foo<rand>.com (sandbox only!)
 *
 * Reads env from the process (the box already has backend/.env loaded by PM2;
 * locally, export the vars or prefix the command).
 */

try { require('dotenv').config(); } catch { /* dotenv optional */ }

const { OpenproviderAdapter } = require('../src/domains/adapters/openprovider');
const { getRegistrarConfig, getDomainResellerMode } = require('../src/domains/config');

function line(label, value) {
  console.log(`${label.padEnd(22)} ${value}`);
}

async function main() {
  const args = process.argv.slice(2);
  const doRegister = args.includes('--register');
  const registerLabel = doRegister ? (args[args.indexOf('--register') + 1] || 'sp-test') : null;

  const config = getRegistrarConfig('OPENPROVIDER');
  console.log('=== Openprovider smoke test ===');
  line('mode', getDomainResellerMode());
  line('baseUrl', config.baseUrl);
  line('username', config.username ? `${config.username.slice(0, 3)}***` : '(unset)');
  line('customerHandle', config.customerHandle || '(unset)');
  line('nameservers', config.nameservers.length ? config.nameservers.join(', ') : '(unset)');
  console.log('');

  const adapter = new OpenproviderAdapter();

  if (!adapter.canCallApi()) {
    console.log('⚠️  No credentials detected — running in MOCK mode (no real API calls).');
    console.log('   Set OPENPROVIDER_USERNAME + OPENPROVIDER_PASSWORD to hit the sandbox.\n');
  }

  // 1) Auth (only meaningful with creds; surfaces IP-whitelist / bad-cred errors).
  if (adapter.canCallApi()) {
    process.stdout.write('1) auth/login ............. ');
    try {
      const token = await adapter.ensureToken(true);
      console.log(`OK (token ${String(token).slice(0, 8)}…)`);
    } catch (err) {
      console.log('FAIL');
      console.error('   ', err.message);
      if (err.openprovider) console.error('   ', JSON.stringify(err.openprovider));
      console.error('\n   Most common cause: this machine\'s outbound IP is not on the Openprovider');
      console.error('   CP IP whitelist, or the username/password is wrong for the SANDBOX account.');
      process.exit(1);
    }
  }

  // 2) Availability check (works in mock mode too).
  const label = `sp-check-${Math.abs(Date.now() % 100000)}`;
  process.stdout.write(`2) domains/check (${label}) ... `);
  try {
    const results = await adapter.searchAvailable(label, ['com', 'io']);
    console.log('OK');
    for (const r of results) {
      line(`   ${r.domainName}`, `${r.available ? 'AVAILABLE' : 'taken'}${r.premium ? ' (premium)' : ''}`);
    }
  } catch (err) {
    console.log('FAIL');
    console.error('   ', err.message, err.openprovider ? JSON.stringify(err.openprovider) : '');
    process.exit(1);
  }

  // 3) Optional register (sandbox only — needs a customer handle + >=2 nameservers).
  if (doRegister) {
    if (!adapter.canRegisterWithApi()) {
      console.log('\n3) register ............... SKIPPED (needs OPENPROVIDER_CUSTOMER_HANDLE + >=2 nameservers)');
    } else {
      const domain = `${registerLabel}-${Math.abs(Date.now() % 100000)}.com`;
      process.stdout.write(`\n3) register (${domain}) ... `);
      try {
        const reg = await adapter.register({ domainName: domain, years: 1, privacyEnabled: true });
        console.log('OK');
        line('   registrarRef', reg.registrarRef);
        line('   expiresAt', reg.expiresAt);
      } catch (err) {
        console.log('FAIL');
        console.error('   ', err.message, err.openprovider ? JSON.stringify(err.openprovider) : '');
        process.exit(1);
      }
    }
  }

  console.log('\n✓ smoke test complete');
}

main().catch((err) => { console.error(err); process.exit(1); });
