// Template engine — pre-approved DLT/Twilio template registry + merge-tag
// rendering. All managed SMS sends through these (template-only architecture
// closes spam vectors at the input gate).
//
// Templates live in two places:
//   1. This file — the canonical source of truth (copy + variables + channels)
//   2. MessageTemplate table — DB row with provider IDs after DLT/Twilio approval
//
// Seed `seedTemplates()` upserts (1) into (2) so on every deploy the DB
// matches the code. DLT-approved provider IDs (msg91TemplateId, twilioContentSid)
// are filled in by the super-admin manually after approval — they are NOT
// overwritten by re-seeding.
'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// =============================================================================
// Template registry
// =============================================================================
//
// Each template has:
//   key         — stable identifier referenced in app code
//   displayName — shown in admin UI
//   category    — DLT/TRAI category
//   vertical    — which product line uses this
//   body        — text with {VAR} placeholders
//   variables   — list of variable names (validated at send time)
//   channels    — { sms, whatsapp, email } supported
//
// Body keeps "- Sitepresso" (or business name via merge tag) so the recipient
// can identify the sender even if the sender ID is generic.
const TEMPLATES = Object.freeze([
  {
    key: 'OTP_VERIFICATION',
    displayName: 'Verification code',
    category: 'AUTHENTICATION',
    vertical: 'ALL',
    body: 'Your Sitepresso verification code is {OTP}. Valid for {MIN} min. Do not share.',
    variables: ['OTP', 'MIN'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'BOOKING_CONFIRMED',
    displayName: 'Booking confirmation',
    category: 'TRANSACTIONAL',
    vertical: 'APPOINTMENT',
    body: 'Booked! Your appointment with {STAFF} on {DATE} at {TIME}. Manage: {LINK} - {BIZ}',
    variables: ['STAFF', 'DATE', 'TIME', 'LINK', 'BIZ'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'REMINDER_DAY_BEFORE',
    displayName: 'Day-before reminder',
    category: 'SERVICE',
    vertical: 'APPOINTMENT',
    body: 'Hi {NAME}, reminder: your visit to {BIZ} tomorrow at {TIME}. Reply STOP to opt out.',
    variables: ['NAME', 'BIZ', 'TIME'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'REMINDER_HOUR_OF',
    displayName: 'Hour-of reminder',
    category: 'SERVICE',
    vertical: 'APPOINTMENT',
    body: 'Your appointment at {BIZ} starts in 1 hour ({TIME}). See you soon!',
    variables: ['BIZ', 'TIME'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'BOOKING_CANCELLED',
    displayName: 'Booking cancelled',
    category: 'TRANSACTIONAL',
    vertical: 'APPOINTMENT',
    body: 'Your booking on {DATE} at {TIME} with {BIZ} has been cancelled. Rebook: {LINK}',
    variables: ['DATE', 'TIME', 'BIZ', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'ORDER_CONFIRMED',
    displayName: 'Order confirmation',
    category: 'TRANSACTIONAL',
    vertical: 'ECOMMERCE',
    body: 'Order #{ID} confirmed at {BIZ}. Total {AMT}. Track: {LINK}',
    variables: ['ID', 'BIZ', 'AMT', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'ORDER_OUT_FOR_DELIVERY',
    displayName: 'Out for delivery',
    category: 'SERVICE',
    vertical: 'ECOMMERCE',
    body: 'Order #{ID} from {BIZ} is out for delivery. ETA {TIME}.',
    variables: ['ID', 'BIZ', 'TIME'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'ORDER_DELIVERED',
    displayName: 'Order delivered',
    category: 'SERVICE',
    vertical: 'ECOMMERCE',
    body: 'Order #{ID} from {BIZ} delivered. Thanks for shopping with us!',
    variables: ['ID', 'BIZ'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'DELIVERY_ASSIGNED',
    displayName: 'Delivery rider assigned',
    category: 'SERVICE',
    vertical: 'ECOMMERCE',
    body: '{BIZ}: Your delivery #{ID} has been assigned to a rider. Track: {LINK}',
    variables: ['BIZ', 'ID', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'DELIVERY_OUT_FOR_DELIVERY',
    displayName: 'Delivery out for delivery',
    category: 'SERVICE',
    vertical: 'ECOMMERCE',
    body: '{BIZ}: Your delivery #{ID} is on the way. Track: {LINK}. OTP: {OTP}',
    variables: ['BIZ', 'ID', 'LINK', 'OTP'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'DELIVERY_ARRIVED',
    displayName: 'Delivery rider arrived',
    category: 'SERVICE',
    vertical: 'ECOMMERCE',
    body: '{BIZ}: Rider has arrived for delivery #{ID}. Share OTP {OTP} after receiving. Track: {LINK}',
    variables: ['BIZ', 'ID', 'OTP', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'DELIVERY_DELIVERED',
    displayName: 'Delivery completed',
    category: 'SERVICE',
    vertical: 'ECOMMERCE',
    body: '{BIZ}: Your delivery #{ID} has been delivered. Details: {LINK}',
    variables: ['BIZ', 'ID', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'DELIVERY_ATTEMPT_FAILED',
    displayName: 'Delivery attempt failed',
    category: 'SERVICE',
    vertical: 'ECOMMERCE',
    body: '{BIZ}: We could not complete delivery #{ID}. Reason: {REASON}. Track: {LINK}',
    variables: ['BIZ', 'ID', 'REASON', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'ORDER_SUBSTITUTION_PROPOSED',
    displayName: 'Substitution needs approval',
    category: 'TRANSACTIONAL',
    vertical: 'ECOMMERCE',
    body: '{BIZ}: {ITEM} was out of stock on order #{ID}. We picked {SUB} instead — approve or decline: {LINK}',
    variables: ['BIZ', 'ITEM', 'SUB', 'ID', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'CONTACT_FORM_RECEIVED',
    displayName: 'New enquiry (admin)',
    category: 'SERVICE',
    vertical: 'STATIC',
    body: 'New enquiry on {BIZ}: {NAME} ({CONTACT}). Reply at {LINK}',
    variables: ['BIZ', 'NAME', 'CONTACT', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  // ─── Sprint 1.2b — Promotional templates (PROMOTIONAL category in DLT)
  // These need explicit customer opt-in (CustomerMarketingOptOut filter at
  // dispatch time) and DLT approval as PROMOTIONAL (not TRANSACTIONAL).
  // Sender will get rate-limited harder by carriers + must respect 9 PM-9 AM
  // quiet hours in IN. Router enforces both checks before dispatch.
  {
    key: 'PROMO_DISCOUNT_OFFER',
    displayName: 'Discount / promo blast',
    category: 'PROMOTIONAL',
    vertical: 'ALL',
    body: '{BIZ}: {OFFER} Use code {CODE} before {EXPIRY}. Shop: {LINK} Reply STOP to opt out.',
    variables: ['BIZ', 'OFFER', 'CODE', 'EXPIRY', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'PROMO_NEW_PRODUCT',
    displayName: 'New product launch',
    category: 'PROMOTIONAL',
    vertical: 'ECOMMERCE',
    body: '{BIZ}: New arrival! {PRODUCT} now available. {LINK} Reply STOP to opt out.',
    variables: ['BIZ', 'PRODUCT', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'PROMO_BACK_TO_SCHOOL',
    displayName: 'Seasonal / event blast',
    category: 'PROMOTIONAL',
    vertical: 'ALL',
    body: '{BIZ}: {EVENT} — {OFFER}. Book/shop by {DATE}: {LINK} Reply STOP to opt out.',
    variables: ['BIZ', 'EVENT', 'OFFER', 'DATE', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'PROMO_ABANDONED_CART',
    displayName: 'Abandoned cart recovery',
    category: 'PROMOTIONAL',
    vertical: 'ECOMMERCE',
    body: '{BIZ}: You left {ITEMS} in your cart. Complete checkout: {LINK} Reply STOP to opt out.',
    variables: ['BIZ', 'ITEMS', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'PROMO_REENGAGEMENT',
    displayName: 'Win-back / re-engagement',
    category: 'PROMOTIONAL',
    vertical: 'ALL',
    body: '{BIZ}: We miss you! Book/shop again with {OFFER}: {LINK} Reply STOP to opt out.',
    variables: ['BIZ', 'OFFER', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
]);

// =============================================================================
// Pure rendering — no DB
// =============================================================================

// Render a template body with merge-tag substitution. Strict: throws if a
// required variable is missing. Unknown variables in `vars` are ignored.
//
// Example:
//   render({key: 'BOOKING_CONFIRMED', vars: { STAFF: 'Dr Singh', DATE: 'Apr 30', TIME: '10:30 AM', LINK: '...', BIZ: 'Bright Smile Dental' }})
//   → "Booked! Your appointment with Dr Singh on Apr 30 at 10:30 AM. Manage: ... - Bright Smile Dental"
function render({ key, vars = {} }) {
  const tpl = TEMPLATES.find((t) => t.key === key);
  if (!tpl) {
    const err = new Error(`Unknown template key: ${key}`);
    err.code = 'UNKNOWN_TEMPLATE';
    throw err;
  }
  const missing = tpl.variables.filter((v) => !(v in vars));
  if (missing.length) {
    const err = new Error(`Missing variables for ${key}: ${missing.join(', ')}`);
    err.code = 'MISSING_VARIABLES';
    err.missing = missing;
    throw err;
  }
  let body = tpl.body;
  for (const [name, value] of Object.entries(vars)) {
    // Replace ALL occurrences of {NAME} with the value. Variables are
    // uppercase-only by convention (matches DLT templates).
    body = body.split(`{${name}}`).join(String(value));
  }
  return body;
}

// Get a template's metadata by key (without rendering). Used by the smart
// router to validate channel support before sending.
function getTemplate(key) {
  return TEMPLATES.find((t) => t.key === key) || null;
}

// List templates filtered by vertical and/or category. Used by admin UI
// to show which templates are available to a given tenant.
function listTemplates({ vertical, category } = {}) {
  return TEMPLATES.filter((t) => {
    if (vertical && t.vertical !== 'ALL' && t.vertical !== vertical) return false;
    if (category && t.category !== category) return false;
    return true;
  });
}

// =============================================================================
// DB sync
// =============================================================================

// Upsert all TEMPLATES into MessageTemplate table. Idempotent. Preserves
// admin-set fields that aren't part of the registry: msg91TemplateId,
// twilioContentSid, approvalStatus, approvedAt — those reflect external
// DLT/Twilio approval state and shouldn't be reset on re-seed.
async function seedTemplates({ logger = console } = {}) {
  let created = 0;
  let updated = 0;

  for (let i = 0; i < TEMPLATES.length; i++) {
    const t = TEMPLATES[i];
    const existing = await prisma.messageTemplate.findUnique({
      where: { templateKey: t.key },
    });
    const data = {
      templateKey:     t.key,
      displayName:     t.displayName,
      category:        t.category,
      vertical:        t.vertical,
      body:            t.body,
      variables:       t.variables,
      smsEnabled:      t.channels.sms,
      whatsappEnabled: t.channels.whatsapp,
      emailEnabled:    t.channels.email,
      sortOrder:       i,
      isActive:        true,
    };
    if (existing) {
      await prisma.messageTemplate.update({
        where: { id: existing.id },
        // Preserve provider IDs + approval status — those come from DLT/Twilio
        data,
      });
      updated++;
    } else {
      await prisma.messageTemplate.create({
        data: { ...data, approvalStatus: 'DRAFT' },
      });
      created++;
    }
  }

  logger.log?.(`[templates] seedTemplates: created=${created} updated=${updated}`);
  return { created, updated };
}

module.exports = {
  TEMPLATES,
  render,
  getTemplate,
  listTemplates,
  seedTemplates,
};
