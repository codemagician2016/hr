'use strict';

/**
 * certificate.js — LMS completion certificate issuance (Feature 37 §6.5).
 *
 * REUSES F9 entirely — NO new PDF renderer, NO new register. On the COMPLETED
 * transition we call letters.service.issueLetter() with the LMS_CERTIFICATE template;
 * F9 mints the ref-no (allocateCode scope LETTER), renders on the tenant letterhead (or
 * the pdfkit branded fallback when there's none), hashes the PDF, writes an
 * EmployeeDocument EMPLOYEE_VISIBLE (category TRAINING_CERTIFICATE), and audits — all
 * inherited. We persist the returned ids onto the Enrollment + a thin LearningCertificate
 * index row for fast lookups.
 */

const prisma = require('../../../core/lib/prisma');
const letters = require('../../letters/letters.service');

const DEFAULT_CERT_CODE = 'LMS-CERT-STD'; // the seeded market-agnostic LMS_CERTIFICATE template

/**
 * Resolve the certificate LetterTemplate id for a course: the course's pinned template,
 * else the tenant's default LMS_CERTIFICATE template (seeded code LMS-CERT-STD), else
 * any active LMS_CERTIFICATE template for the tenant.
 */
async function resolveCertificateTemplateId(businessId, course) {
  if (course && course.certificateTemplateId) {
    const pinned = await prisma.letterTemplate.findFirst({
      where: { id: course.certificateTemplateId, businessId, deletedAt: null },
      select: { id: true },
    });
    if (pinned) return pinned.id;
  }
  const byCode = await prisma.letterTemplate.findFirst({
    where: { businessId, code: DEFAULT_CERT_CODE, deletedAt: null },
    select: { id: true },
  });
  if (byCode) return byCode.id;
  const anyCert = await prisma.letterTemplate.findFirst({
    where: { businessId, category: 'LMS_CERTIFICATE', isActive: true, deletedAt: null },
    select: { id: true },
  });
  return anyCert ? anyCert.id : null;
}

/**
 * Issue the completion certificate for an enrollment. Idempotent: if the enrollment
 * already carries a certificateLetterId, returns the existing record (no double-mint).
 *
 * @param {Object} args
 * @param {string} args.businessId
 * @param {Object} args.enrollment  the COMPLETED enrollment row
 * @param {Object} args.course      the course (title/code/category/certificateTemplateId)
 * @param {number} [args.scorePct]  best graded score, for the cert facts
 * @param {string} [args.actorUserId='system']
 * @returns {{ issuedLetterId, referenceNo, employeeDocumentId } | null}
 */
async function issueForEnrollment({ businessId, enrollment, course, scorePct = null, actorUserId = 'system' }) {
  if (!enrollment || enrollment.certificateLetterId) {
    // already issued (or nothing to do) — return the existing index row if present.
    const existing = await prisma.learningCertificate.findUnique({
      where: { enrollmentId: enrollment ? enrollment.id : '' },
    }).catch(() => null);
    return existing
      ? { issuedLetterId: existing.issuedLetterId, referenceNo: existing.referenceNo, employeeDocumentId: existing.employeeDocumentId }
      : null;
  }

  const templateId = await resolveCertificateTemplateId(businessId, course);
  if (!templateId) return null; // no template available — caller skips cert (course still COMPLETED)

  const completedOn = enrollment.completedAt || new Date();
  const result = await letters.issueLetter(prisma, {
    businessId,
    actorUserId,
    perms: {},
    templateId,
    employeeId: enrollment.employeeId,
    mode: 'issue',
    overrides: {
      subject: `Certificate of Completion — ${course.title}`,
      issueDate: completedOn,
      // course.* merge facts (threaded through mergeFields.js course namespace)
      course: {
        title: course.title,
        code: course.code,
        category: course.category,
        completedOn,
        scorePct,
        cycle: enrollment.cycleKey || null,
      },
    },
  });

  // Persist the ids onto the enrollment + the thin index row (idempotent upsert).
  await prisma.enrollment.update({
    where: { id: enrollment.id },
    data: { certificateLetterId: result.issuedLetterId },
  });
  await prisma.learningCertificate.upsert({
    where: { enrollmentId: enrollment.id },
    create: {
      businessId,
      enrollmentId: enrollment.id,
      employeeId: enrollment.employeeId,
      courseId: enrollment.courseId,
      issuedLetterId: result.issuedLetterId,
      employeeDocumentId: result.employeeDocumentId || null,
      referenceNo: result.referenceNo,
      cycleKey: enrollment.cycleKey || null,
    },
    update: {
      issuedLetterId: result.issuedLetterId,
      employeeDocumentId: result.employeeDocumentId || null,
      referenceNo: result.referenceNo,
    },
  });

  return {
    issuedLetterId: result.issuedLetterId,
    referenceNo: result.referenceNo,
    employeeDocumentId: result.employeeDocumentId || null,
  };
}

/** Reissue a certificate via F9's reissueLetter (e.g. employee retook the course). */
async function reissueForEnrollment({ businessId, enrollment, actorUserId = 'system', reason }) {
  if (!enrollment || !enrollment.certificateLetterId) return null;
  const result = await letters.reissueLetter(prisma, {
    businessId,
    actorUserId,
    perms: {},
    sourceId: enrollment.certificateLetterId,
    reason: reason || 'LMS certificate reissue',
  });
  await prisma.enrollment.update({
    where: { id: enrollment.id },
    data: { certificateLetterId: result.issuedLetterId },
  });
  await prisma.learningCertificate.update({
    where: { enrollmentId: enrollment.id },
    data: {
      issuedLetterId: result.issuedLetterId,
      employeeDocumentId: result.employeeDocumentId || null,
      referenceNo: result.referenceNo,
    },
  }).catch(() => null);
  return result;
}

module.exports = { issueForEnrollment, reissueForEnrollment, resolveCertificateTemplateId, DEFAULT_CERT_CODE };
