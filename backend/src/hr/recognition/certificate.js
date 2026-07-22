'use strict';

/**
 * certificate.js — Feature 35 award certificate (the F37 LMS certificate precedent).
 * REUSES F9 entirely — issueLetter renders on the tenant letterhead, mints the
 * ref-no, stores the IssuedLetter + EmployeeDocument and audits; we only pass the
 * award facts as template-declared MANUAL fields ({{manual.*}}) so the letters
 * merge-field catalog is untouched.
 *
 * THIN + FAIL-SOFT by design (spec §2): a missing template or a letters hiccup must
 * never block the award itself — the winner stays WON, and the nightly award-cycle
 * runner retries via awards.service.issueMissingCertificates.
 */

const prismaDefault = require('../../core/lib/prisma');
const letters = require('../letters/letters.service');
const { AWARD_CERT_CODE, seedRecognitionDefaults } = require('./seeds');

/** Resolve the tenant's award-certificate template id (seeding it on first miss). */
async function resolveAwardTemplateId(businessId) {
  let tpl = await prismaDefault.letterTemplate.findFirst({
    where: { businessId, code: AWARD_CERT_CODE, deletedAt: null, isActive: true },
    select: { id: true },
  });
  if (!tpl) {
    // Best-effort self-heal: the tenant predates R&R seeding.
    await seedRecognitionDefaults(businessId).catch(() => {});
    tpl = await prismaDefault.letterTemplate.findFirst({
      where: { businessId, code: AWARD_CERT_CODE, deletedAt: null, isActive: true },
      select: { id: true },
    });
  }
  return tpl ? tpl.id : null;
}

/**
 * Issue the certificate for one WON nomination. Idempotent: no-ops when the
 * nomination already carries certificateLetterId or is not WON. Returns
 * { issuedLetterId, referenceNo } | null (fail-soft — never throws to the caller's
 * award flow; callers may still catch for logging).
 */
async function issueAwardCertificate({ nomination, cycle }) {
  if (!nomination || nomination.status !== 'WON' || nomination.certificateLetterId) return null;
  if (!cycle || cycle.issueCertificate === false) return null;
  const businessId = nomination.businessId;

  const templateId = await resolveAwardTemplateId(businessId);
  if (!templateId) return null; // no template — award stands, certificate skipped

  const result = await letters.issueLetter(prismaDefault, {
    businessId,
    actorUserId: nomination.decidedByUserId || 'system',
    perms: {},
    templateId,
    employeeId: nomination.nomineeEmployeeId,
    mode: 'issue',
    overrides: {
      subject: `Award Certificate — ${cycle.name}`,
      issueDate: nomination.decidedAt || new Date(),
      manual: {
        awardName: cycle.name,
        periodLabel: cycle.periodLabel || '',
        citation: nomination.citation ? `Citation: ${nomination.citation}` : '',
      },
    },
  });

  // Conditional stamp — a concurrent issuer must not double-link.
  const stamped = await prismaDefault.awardNomination.updateMany({
    where: { id: nomination.id, certificateLetterId: null },
    data: { certificateLetterId: result.issuedLetterId },
  });
  if (stamped.count === 0) return null;
  return { issuedLetterId: result.issuedLetterId, referenceNo: result.referenceNo };
}

module.exports = { issueAwardCertificate, resolveAwardTemplateId };
