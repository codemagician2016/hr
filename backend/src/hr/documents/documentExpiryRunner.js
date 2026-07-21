'use strict';

/**
 * documentExpiryRunner.js — Program P1.7: nightly document-expiry reminders.
 *
 * EmployeeDocument.expiresAt has existed since Feature 4 (visa/permit/licence)
 * with list-time `expiringSoon` annotations — but nothing PROACTIVE. This
 * runner (03:30 nightly) notifies for documents expiring in exactly N days
 * (N ∈ REMIND_AT = 30, 7, 1 — exact-day match + one run per day = naturally
 * deduped, the probation-sweep idiom) and on the expiry day itself:
 *   - the employee (their passport/visa/etc. is lapsing), and
 *   - HR (fallback: the notification goes to the tenant admin user's email)
 * via 'document.expiring' → HR_DOCUMENT_EXPIRING_SOON.
 *
 * Per-row failures are counted, never thrown. Company-level BusinessDocument
 * rows (agreements/licences) notify HR only.
 */

const prisma = require('../../core/lib/prisma');
const { notifyHrEvent } = require('../integrations/notifications');

const REMIND_AT = [30, 7, 1, 0]; // days before expiry (0 = expires today)

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

function addDays(base, days) {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function adminEmail(businessId) {
  const owner = await prisma.user.findFirst({
    where: { businessId, role: 'BUSINESS_ADMIN', isActive: true },
    select: { email: true },
    orderBy: { createdAt: 'asc' },
  });
  return owner ? owner.email : null;
}

async function runDocumentExpirySweep({ asOf = new Date() } = {}) {
  const summary = { scanned: 0, reminded: 0, errors: 0, tenants: new Set() };
  const targetDates = REMIND_AT.map((n) => dayKey(addDays(asOf, n)));
  const from = new Date(`${targetDates[targetDates.length - 1]}T00:00:00Z`);
  const to = new Date(`${targetDates[0]}T23:59:59Z`);

  // Employee documents with an expiry landing on one of the reminder days.
  const docs = await prisma.employeeDocument.findMany({
    where: { expiresAt: { gte: from, lte: to }, deletedAt: null },
    select: {
      id: true, businessId: true, category: true, name: true, expiresAt: true,
      employee: { select: { id: true, firstName: true, lastName: true, workEmail: true, personalEmail: true, deletedAt: true } },
    },
  });
  const hrEmailByTenant = new Map();
  for (const doc of docs) {
    const expKey = dayKey(doc.expiresAt);
    if (!targetDates.includes(expKey)) continue;
    if (!doc.employee || doc.employee.deletedAt) continue;
    summary.scanned += 1;
    summary.tenants.add(doc.businessId);
    try {
      const name = [doc.employee.firstName, doc.employee.lastName].filter(Boolean).join(' ');
      const days = Math.round((new Date(expKey) - new Date(dayKey(asOf))) / 86400000);
      const vars = {
        employeeName: name || 'An employee',
        docName: doc.name || doc.category,
        expiryDate: expKey,
        days: String(days),
      };
      const empEmail = doc.employee.workEmail || doc.employee.personalEmail || null;
      if (empEmail) {
        await notifyHrEvent({
          businessId: doc.businessId,
          event: 'document.expiring',
          recipientEmail: empEmail,
          variables: vars,
          triggeredBy: `HR_DOC_EXPIRY:${doc.id}:${expKey}`,
        });
        summary.reminded += 1;
      }
      if (!hrEmailByTenant.has(doc.businessId)) hrEmailByTenant.set(doc.businessId, await adminEmail(doc.businessId));
      const hr = hrEmailByTenant.get(doc.businessId);
      if (hr && hr !== empEmail) {
        await notifyHrEvent({
          businessId: doc.businessId,
          event: 'document.expiring',
          recipientEmail: hr,
          variables: vars,
          triggeredBy: `HR_DOC_EXPIRY_HR:${doc.id}:${expKey}`,
        });
        summary.reminded += 1;
      }
    } catch (e) {
      summary.errors += 1;
      console.error(`[docExpiry] doc ${doc.id} failed: ${e.message}`);
    }
  }

  // Company documents (licences/agreements) → HR only.
  const bizDocs = await prisma.businessDocument.findMany({
    where: { expiresAt: { gte: from, lte: to }, deletedAt: null },
    select: { id: true, businessId: true, name: true, category: true, expiresAt: true },
  }).catch(() => []);
  for (const doc of bizDocs) {
    const expKey = dayKey(doc.expiresAt);
    if (!targetDates.includes(expKey)) continue;
    summary.scanned += 1;
    summary.tenants.add(doc.businessId);
    try {
      if (!hrEmailByTenant.has(doc.businessId)) hrEmailByTenant.set(doc.businessId, await adminEmail(doc.businessId));
      const hr = hrEmailByTenant.get(doc.businessId);
      if (!hr) continue;
      const days = Math.round((new Date(expKey) - new Date(dayKey(asOf))) / 86400000);
      await notifyHrEvent({
        businessId: doc.businessId,
        event: 'document.expiring',
        recipientEmail: hr,
        variables: {
          employeeName: 'Company document',
          docName: doc.name || doc.category,
          expiryDate: expKey,
          days: String(days),
        },
        triggeredBy: `HR_DOC_EXPIRY_BIZ:${doc.id}:${expKey}`,
      });
      summary.reminded += 1;
    } catch (e) {
      summary.errors += 1;
      console.error(`[docExpiry] business doc ${doc.id} failed: ${e.message}`);
    }
  }

  return { scanned: summary.scanned, reminded: summary.reminded, errors: summary.errors, tenants: summary.tenants.size };
}

module.exports = { runDocumentExpirySweep, REMIND_AT };
