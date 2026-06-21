// Marketing automation campaign registry. Six pre-built campaigns the
// tenant can toggle on/off and (optionally) customize subject/body/coupon.
//
// Each campaign has:
//   key                   — stable identifier ('BIRTHDAY' etc.)
//   displayName           — admin UI label
//   description           — admin UI subtitle, explains what this does
//   triggerType           — how the trigger detector finds candidates
//                           ('CUSTOMER_BIRTHDAY' | 'APPOINTMENT_COMPLETED' |
//                            'APPOINTMENT_NO_SHOW' | 'CUSTOMER_LAPSED' |
//                            'CUSTOMER_ANNIVERSARY' | 'APPOINTMENT_MILESTONE')
//   delayHours            — delay between trigger and scheduled send
//   frequencyCap          — { perWindowDays, maxSendsInWindow } for the
//                           same recipient + campaign combination
//   defaultSubject        — email subject line (variables in {})
//   defaultBody           — body with variables; renders to plain text + HTML
//   variables             — names that can appear in subject/body
//   defaultChannels       — { email, sms, whatsapp } — most start email-only
//   suggestedCoupon       — true if this campaign is coupon-friendly (UI suggests it)
'use strict';

const CAMPAIGNS = Object.freeze([
  {
    key: 'BIRTHDAY',
    displayName: 'Birthday wishes',
    description: 'Send a warm message when your customer turns a year older. Convert it to a coupon for repeat business.',
    triggerType: 'CUSTOMER_BIRTHDAY',
    delayHours: 0,
    frequencyCap: { perWindowDays: 365, maxSendsInWindow: 1 },
    defaultSubject: 'Happy birthday, {NAME}! 🎂',
    defaultBody: [
      'Hi {NAME},',
      '',
      'A little bird told us it\'s your birthday today — here\'s to a wonderful year ahead from everyone at {BIZ}!',
      '',
      'Treat yourself: book your next visit with us this month and we\'ll have something special waiting{COUPON_LINE}.',
      '',
      'Book here: {LINK}',
      '',
      '— The {BIZ} team',
    ].join('\n'),
    variables: ['NAME', 'BIZ', 'COUPON_LINE', 'LINK'],
    defaultChannels: { email: true, sms: false, whatsapp: false },
    suggestedCoupon: true,
  },
  {
    key: 'POST_VISIT',
    displayName: 'Post-visit thank-you',
    description: 'Send a thank-you 24 hours after each completed appointment. Optionally ask for a review.',
    triggerType: 'APPOINTMENT_COMPLETED',
    delayHours: 24,
    frequencyCap: { perWindowDays: 1, maxSendsInWindow: 1 }, // one per appointment
    defaultSubject: 'Thanks for visiting {BIZ}, {NAME}!',
    defaultBody: [
      'Hi {NAME},',
      '',
      'Thanks for choosing {BIZ} for your visit yesterday — we hope you had a great experience.',
      '',
      'How did we do? We\'d love to hear from you: {REVIEW_LINK}',
      '',
      'And if you\'d like to book your next visit, you can do that here: {LINK}',
      '',
      '— {STAFF}, {BIZ}',
    ].join('\n'),
    variables: ['NAME', 'BIZ', 'STAFF', 'REVIEW_LINK', 'LINK'],
    defaultChannels: { email: true, sms: false, whatsapp: false },
    suggestedCoupon: false,
  },
  {
    key: 'NO_SHOW_WINBACK',
    displayName: 'No-show win-back',
    description: 'Reach out 7 days after a no-show with a friendly note + small discount to bring them back.',
    triggerType: 'APPOINTMENT_NO_SHOW',
    delayHours: 24 * 7,
    frequencyCap: { perWindowDays: 180, maxSendsInWindow: 2 }, // max 2× / 6 months
    defaultSubject: 'We missed you, {NAME}',
    defaultBody: [
      'Hi {NAME},',
      '',
      'We had your spot reserved for {DATE_OF_VISIT} but we know life happens. No hard feelings!',
      '',
      'When you\'re ready, we\'d love to have you back. Use code {COUPON_CODE} for {COUPON_PERCENT}% off your next visit{COUPON_EXPIRY_LINE}.',
      '',
      'Book here: {LINK}',
      '',
      '— The {BIZ} team',
    ].join('\n'),
    variables: ['NAME', 'BIZ', 'DATE_OF_VISIT', 'COUPON_CODE', 'COUPON_PERCENT', 'COUPON_EXPIRY_LINE', 'LINK'],
    defaultChannels: { email: true, sms: false, whatsapp: false },
    suggestedCoupon: true,
  },
  {
    key: 'LAPSED_90D',
    displayName: 'Lapsed customer (90 days)',
    description: 'Gently reach out to customers who haven\'t booked in 90 days. Pulls them back before they forget.',
    triggerType: 'CUSTOMER_LAPSED',
    delayHours: 0,
    frequencyCap: { perWindowDays: 90, maxSendsInWindow: 1 },
    defaultSubject: 'It\'s been a while, {NAME}',
    defaultBody: [
      'Hi {NAME},',
      '',
      'It\'s been about 3 months since your last visit to {BIZ} — we hope everything\'s well!',
      '',
      'Things change quickly: we\'ve added new services and openings on weekends. If you\'d like to book your next visit, we\'re here.',
      '',
      'Book here: {LINK}',
      '',
      '— The {BIZ} team',
    ].join('\n'),
    variables: ['NAME', 'BIZ', 'LINK'],
    defaultChannels: { email: true, sms: false, whatsapp: false },
    suggestedCoupon: false,
  },
  {
    key: 'ANNIVERSARY',
    displayName: '1-year anniversary',
    description: 'Celebrate the year since their first visit with a thank-you note + special offer.',
    triggerType: 'CUSTOMER_ANNIVERSARY',
    delayHours: 0,
    frequencyCap: { perWindowDays: 365, maxSendsInWindow: 1 },
    defaultSubject: 'A year with us, {NAME}!',
    defaultBody: [
      'Hi {NAME},',
      '',
      'It\'s been a year since your first visit to {BIZ} — thank you for trusting us!',
      '',
      'To say thanks, here\'s {COUPON_PERCENT}% off your next visit with code {COUPON_CODE}{COUPON_EXPIRY_LINE}.',
      '',
      'Book here: {LINK}',
      '',
      '— The {BIZ} team',
    ].join('\n'),
    variables: ['NAME', 'BIZ', 'COUPON_CODE', 'COUPON_PERCENT', 'COUPON_EXPIRY_LINE', 'LINK'],
    defaultChannels: { email: true, sms: false, whatsapp: false },
    suggestedCoupon: true,
  },
  {
    key: 'ABANDONED_CART',
    displayName: 'Abandoned cart recovery',
    description: 'Email customers who added products to cart but didn\'t check out — bring them back.',
    triggerType: 'ABANDONED_CART',
    delayHours: 1, // gentle nudge after 1h
    frequencyCap: { perWindowDays: 14, maxSendsInWindow: 1 },
    defaultSubject: 'You left something behind, {NAME}',
    defaultBody: [
      'Hi {NAME},',
      '',
      'You added {ITEM_COUNT} items to your cart at {BIZ} but didn\'t finish checking out.',
      '',
      'Your cart is still saved — pick up where you left off:',
      '{LINK}',
      '',
      '— The {BIZ} team',
    ].join('\n'),
    variables: ['NAME', 'BIZ', 'ITEM_COUNT', 'LINK'],
    defaultChannels: { email: true, sms: false, whatsapp: false },
    suggestedCoupon: true,
  },
  {
    key: 'LOYALTY_MILESTONE',
    displayName: 'Loyalty milestones (5/10/25/50 visits)',
    description: 'Celebrate repeat customers when they hit visit milestones. Builds long-term loyalty.',
    triggerType: 'APPOINTMENT_MILESTONE',
    delayHours: 1, // small delay so the COMPLETED appointment finalises
    // Cap is computed at trigger time per-milestone — a customer can hit
    // 5/10/25/50 once each, never twice. The frequencyCap field is only
    // a defensive backstop here.
    frequencyCap: { perWindowDays: 365, maxSendsInWindow: 4 },
    defaultSubject: '🎉 {NAME}, that\'s {VISIT_COUNT} visits!',
    defaultBody: [
      'Hi {NAME},',
      '',
      'Today marks your {VISIT_COUNT}th visit to {BIZ} — we\'re so grateful for your loyalty.',
      '',
      'A small token of thanks: a free {GIFT_LABEL} on us at your next visit. Just mention this email.',
      '',
      'Book here: {LINK}',
      '',
      '— The {BIZ} team',
    ].join('\n'),
    variables: ['NAME', 'BIZ', 'VISIT_COUNT', 'GIFT_LABEL', 'LINK'],
    defaultChannels: { email: true, sms: false, whatsapp: false },
    suggestedCoupon: false,
    // Milestones we celebrate — easy to extend.
    milestones: [5, 10, 25, 50, 100],
  },
]);

const CAMPAIGNS_BY_KEY = Object.freeze(
  CAMPAIGNS.reduce((acc, c) => Object.assign(acc, { [c.key]: c }), {}),
);

// Render a campaign's subject + body with merge tags. Returns
// { subject, body }. Variables not provided render as empty string (not
// thrown, unlike Sprint 1.1's transactional templates) — marketing
// content is forgiving about missing optional fields like REVIEW_LINK.
function renderCampaign({ campaignKey, customSubject, customBody, vars = {} }) {
  const c = CAMPAIGNS_BY_KEY[campaignKey];
  if (!c) {
    const err = new Error(`Unknown campaign key: ${campaignKey}`);
    err.code = 'UNKNOWN_CAMPAIGN';
    throw err;
  }
  const subject = (customSubject ?? c.defaultSubject) || '';
  const body = (customBody ?? c.defaultBody) || '';
  const renderOne = (s) => {
    let out = s;
    // Replace each {VAR} with vars[VAR] (or empty string if missing).
    for (const v of c.variables) {
      out = out.split(`{${v}}`).join(String(vars[v] ?? ''));
    }
    // Strip any unused {VAR} placeholders.
    out = out.replace(/\{[A-Z_]+\}/g, '');
    // Tidy double spaces / orphan punctuation that result from missing optionals.
    out = out.replace(/[ \t]+/g, ' ').replace(/\n /g, '\n').replace(/ \n/g, '\n');
    return out;
  };
  return { subject: renderOne(subject), body: renderOne(body) };
}

function listCampaigns() {
  return CAMPAIGNS;
}

function getCampaign(key) {
  return CAMPAIGNS_BY_KEY[key] || null;
}

module.exports = {
  CAMPAIGNS,
  CAMPAIGNS_BY_KEY,
  renderCampaign,
  listCampaigns,
  getCampaign,
};
