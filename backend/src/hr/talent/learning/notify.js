'use strict';

/**
 * notify.js — thin LMS notification helpers over the EXISTING notifyHrEvent registry
 * (Feature 37). NO new transport: the email/SMS/WhatsApp cascade + DLT/Twilio routing
 * is inherited. Each helper resolves the learner's contact off the Employee row and
 * fires a best-effort templated message; failures never throw (learning writes proceed).
 */

const { notifyHrEvent } = require('../../integrations/notifications');

function nameOf(emp) {
  if (!emp) return 'there';
  return [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim() || emp.code || 'there';
}
function contactOf(emp) {
  return {
    recipientEmail: (emp && (emp.workEmail || emp.personalEmail)) || null,
    recipientPhone: (emp && emp.phone) || null,
    recipientCountry: (emp && emp.countryCode) || null,
  };
}
function fmtDate(d) {
  if (!d) return 'soon';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return 'soon';
  return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
}

async function fire(businessId, event, emp, variables) {
  try {
    await notifyHrEvent({ businessId, event, ...contactOf(emp), variables });
  } catch (_) { /* best-effort */ }
}

async function assigned({ businessId, employee, course, enrollment, bizName }) {
  return fire(businessId, 'learning.assigned', employee, {
    NAME: nameOf(employee), COURSE: course.title, DUE: fmtDate(enrollment.dueAt),
    LINK: '/learning', BIZ: bizName || 'HR',
  });
}
async function dueSoon({ businessId, employee, course, enrollment, bizName }) {
  return fire(businessId, 'learning.due-soon', employee, {
    NAME: nameOf(employee), COURSE: course.title, DUE: fmtDate(enrollment.dueAt),
    LINK: '/learning', BIZ: bizName || 'HR',
  });
}
async function overdue({ businessId, employee, course, enrollment, bizName }) {
  return fire(businessId, 'learning.overdue', employee, {
    NAME: nameOf(employee), COURSE: course.title, DUE: fmtDate(enrollment.dueAt),
    LINK: '/learning', BIZ: bizName || 'HR',
  });
}
async function completed({ businessId, employee, course, bizName }) {
  return fire(businessId, 'learning.completed', employee, {
    NAME: nameOf(employee), COURSE: course.title, BIZ: bizName || 'HR',
  });
}
async function certReady({ businessId, employee, course, referenceNo, bizName }) {
  return fire(businessId, 'learning.cert-ready', employee, {
    NAME: nameOf(employee), COURSE: course.title, REF: referenceNo || '', LINK: '/learning', BIZ: bizName || 'HR',
  });
}

module.exports = { assigned, dueSoon, overdue, completed, certReady, _internals: { nameOf, contactOf, fmtDate } };
