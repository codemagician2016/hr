// Single helper for resolving the locale to send a notification in.
// Email + SMS templates are translated; we need to pick the right one.
//
// Cascade (first non-empty wins):
//   1. customer.preferredLanguage   — appointment customer's saved preference
//   2. user.preferredLanguage       — staff user's saved preference (for
//                                      notifications addressed TO the staff
//                                      member, e.g. "you have a new booking")
//   3. cookieLocale                 — the language the visitor is currently
//                                      browsing in (web flows only — cron
//                                      jobs and schedulers don't see cookies)
//   4. business.defaultLanguage     — the tenant's "house language", set in
//                                      Settings. Acts as the floor for
//                                      anonymous / cookie-less recipients.
//   5. null                         — let the translator fall through to
//                                      DEFAULT_LOCALE (English).
//
// Pass undefined for inputs that don't apply to the call site (e.g. omit
// `user` for a customer-only flow, or `cookieLocale` for a background job).
'use strict';

function resolveRecipientLocale({ customer, user, business, cookieLocale } = {}) {
  return (
    (customer && customer.preferredLanguage) ||
    (user && user.preferredLanguage) ||
    cookieLocale ||
    (business && business.defaultLanguage) ||
    null
  );
}

module.exports = { resolveRecipientLocale };
