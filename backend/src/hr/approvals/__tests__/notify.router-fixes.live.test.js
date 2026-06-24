'use strict';

/**
 * notify.router-fixes.live.test.js — LIVE proof (plain-node, hr_test) for the two
 * notification review fixes:
 *
 *   (A) Phone STOP must NOT block the email fallback. A universal SmsOptOut (TCPA/TRAI
 *       phone-channel STOP) previously returned OPTED_OUT before the always-on email
 *       leg, so a STOP'd approver got NOTHING. The router must now suppress only SMS +
 *       WhatsApp (logging the BLOCKED_OPTOUT audit row) and STILL send the email.
 *
 *   (B) Concurrent same-token sends fire exactly once. The notify dedupe is now an
 *       atomic INSERT under a UNIQUE(businessId, token) (claimDedupe), so two
 *       simultaneous dispatches of the same token can't both send.
 *
 * Drives the REAL router.sendNotification + notify.dispatchOne — nothing reimplemented.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/approvals/__tests__/notify.router-fixes.live.test.js
 */

// ── Stub the email transport BEFORE the router/providers load. ──
const emailPath = require.resolve('../../../core/utils/email');
const sentEmails = [];
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true,
  exports: {
    renderEmail: (b) => b,
    sendEmail: async (to, subject, html) => { sentEmails.push({ to, subject, html }); return { ok: true, messageId: `fake-${sentEmails.length}` }; },
  },
};

const prisma = require('../../../core/lib/prisma');
const { sendNotification } = require('../../../core/lib/notifications/router');
const notify = require('../notify');
const { seedHrTemplates } = require('../../integrations/notifications');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PREFIX = 'NOTIFY-ROUTERFIX-TEST';
const STOP_PHONE = '+919900088001'; // unique to this test; cleaned up below
let seq = 0;

async function cleanup(businessId) {
  await prisma.messageDelivery.deleteMany({ where: { businessId, triggeredBy: { startsWith: 'HR_RTRFIX' } } }).catch(() => {});
  await prisma.$executeRawUnsafe('DELETE FROM "HrNotifyDedupe" WHERE "businessId" = $1 AND "token" LIKE $2', businessId, 'HR_RTRFIX%').catch(() => {});
  await prisma.smsOptOut.deleteMany({ where: { recipientPhone: STOP_PHONE } }).catch(() => {});
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { businessId, email: { startsWith: PREFIX.toLowerCase() } } }).catch(() => {});
}

async function mkUserEmp(businessId, name, phone, email) {
  seq += 1;
  const user = await prisma.user.create({
    data: { businessId, email: `${PREFIX.toLowerCase()}-${seq}-${Date.now()}@t.test`, password: 'x', name, role: 'USER', isActive: true },
  });
  const emp = await prisma.employee.create({
    data: {
      businessId, code: `${PREFIX}-${seq}`, firstName: name, lastName: 'T', status: 'ACTIVE',
      userId: user.id, workEmail: email, phone, countryCode: 'IN',
    },
  });
  return { user, emp };
}

async function main() {
  log('\n=== Notify/router review-fix proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);
  // HR templates must be seeded so the router can resolve HR_APPROVAL_PENDING.
  await seedHrTemplates({ logger: { log() {} } }).catch(() => {});

  try {
    // Enable the SMS gate so the SMS leg is genuinely ATTEMPTED (and thus the opt-out is
    // what suppresses it, not a disabled gate). Email remains always-on regardless.
    await prisma.notificationConfig.upsert({
      where: { businessId },
      update: { managedSmsEnabled: true, managedWhatsappEnabled: true },
      create: { businessId, managedSmsEnabled: true, managedWhatsappEnabled: true },
    });

    // ── (A) Phone STOP → SMS/WA suppressed, EMAIL still delivered ────────────────
    log('(A) a phone-STOP approver still gets the email (phone STOP only blocks SMS/WhatsApp):');
    await prisma.smsOptOut.create({ data: { recipientPhone: STOP_PHONE, source: 'STOP_REPLY' } });
    const emailAddr = `${PREFIX.toLowerCase()}-stop@t.test`;
    const before = sentEmails.length;
    const res = await sendNotification({
      businessId,
      recipientPhone: STOP_PHONE,
      recipientEmail: emailAddr,
      recipientCountry: 'IN',
      templateKey: 'HR_APPROVAL_PENDING',
      variables: { NAME: 'Stoppy', MODULE: 'Leave', REQUESTER: 'Ic', BIZ: 'DriftHR', LINK: 'https://x/approvals?request=1' },
      triggeredBy: 'HR_RTRFIX_STOP',
    });
    assert(res && res.ok === true, `phone-STOP send still succeeds (ok=${res && res.ok})`);
    assert(res && res.channel === 'email', `phone-STOP send routes to EMAIL (channel=${res && res.channel})`);
    assert(sentEmails.length === before + 1, `exactly one email actually sent (delta=${sentEmails.length - before})`);
    // The phone block is still logged for the audit trail.
    const blocked = await prisma.messageDelivery.findFirst({ where: { businessId, triggeredBy: 'HR_RTRFIX_STOP', status: 'BLOCKED_OPTOUT' } });
    assert(!!blocked, 'phone-STOP logged a BLOCKED_OPTOUT audit row (suppression recorded)');
    // The email delivery row is SENT.
    const emailDel = await prisma.messageDelivery.findFirst({ where: { businessId, triggeredBy: 'HR_RTRFIX_STOP', channel: 'EMAIL', status: 'SENT' } });
    assert(!!emailDel, 'phone-STOP still produced an EMAIL/SENT delivery (approver reached)');
    // The SMS/WA attempts must be recorded as PHONE_OPTED_OUT skips, not silent.
    assert(Array.isArray(res.attempts) && res.attempts.some((a) => a.skipped === 'PHONE_OPTED_OUT'), 'SMS/WhatsApp attempts marked PHONE_OPTED_OUT (not silently dropped)');

    // ── (B) Concurrent same-token dispatch → exactly one send ───────────────────
    log('(B) two concurrent same-token dispatches send exactly once (atomic dedupe):');
    const appr = await mkUserEmp(businessId, 'ConcApprover', null, `${PREFIX.toLowerCase()}-conc@t.test`);
    const token = `HR_RTRFIX_CONC_${Date.now()}`;
    const recipient = await notify._internals.recipientByUserId(businessId, appr.user.id);
    const variables = { NAME: 'Conc', MODULE: 'Leave', REQUESTER: 'Ic', BIZ: 'DriftHR', LINK: 'https://x/approvals?request=2' };
    const sendOnce = () => notify._internals.dispatchOne({ businessId, recipient, event: 'approval.pending', variables, dedupeToken: token });
    const [r1, r2] = await Promise.all([sendOnce(), sendOnce()]);
    const oks = [r1, r2].filter((r) => r && r.ok);
    const deduped = [r1, r2].filter((r) => r && r.deduped);
    assert(oks.length === 2, `both calls resolve ok (one sent, one deduped) (oks=${oks.length})`);
    assert(deduped.length === 1, `exactly one call was the dedupe short-circuit (deduped=${deduped.length})`);
    const concDels = await prisma.messageDelivery.findMany({ where: { businessId, triggeredBy: token } });
    assert(concDels.length === 1, `exactly ONE delivery row written for the token (got ${concDels.length})`);
    // A third sequential send with the SAME token is also deduped (claim persists).
    const r3 = await sendOnce();
    assert(r3 && r3.deduped === true, 'a later send with the same token is deduped (claim persists)');
    const concDels2 = await prisma.messageDelivery.findMany({ where: { businessId, triggeredBy: token } });
    assert(concDels2.length === 1, `still exactly one delivery after a 3rd send (got ${concDels2.length})`);

    log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ===\n`);
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('FATAL', e); await prisma.$disconnect(); process.exit(1); });
