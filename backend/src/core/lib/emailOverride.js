// Single source of truth for email routing.
//
// Rule:
//   - DEPLOY_ENV=production         → mail goes to the real recipient
//   - anything else (staging, dev)  → mail goes to STAGING_INBOX
//
// To change the staging inbox: edit `STAGING_INBOX` below OR set the
// STAGING_EMAIL_OVERRIDE env var. Code wins if both are set.
//
// Why ONE env var (DEPLOY_ENV) instead of "is NODE_ENV production AND
// FORCE_EMAIL_OVERRIDE is not true AND EMAIL_OVERRIDE is set"?
//   - The old rule depended on three conditions. Forget any one of
//     them on a prod deploy and customer mail starts going to the
//     wrong place. New rule is binary: DEPLOY_ENV says prod, or it
//     doesn't.
//   - NODE_ENV is overloaded by Node itself + every framework. Both
//     staging and prod typically run NODE_ENV=production for the
//     framework optimisations. So NODE_ENV is a bad signal for
//     "should I send real mail."
//   - Adding more environments later (preview, e2e, demo-tenant)
//     just means DEPLOY_ENV gets new values and they all default
//     to override. Production is the explicit opt-in to real mail —
//     the safe default.
//
// Safe-by-default: if DEPLOY_ENV is unset (e.g. dev box), the override
// applies. Real customer mail only goes out when DEPLOY_ENV is the
// literal string 'production'.

const STAGING_INBOX = 'codemagician2016@gmail.com';

function isProductionDeploy() {
  return String(process.env.DEPLOY_ENV || '').toLowerCase() === 'production';
}

function getStagingInbox() {
  return process.env.STAGING_EMAIL_OVERRIDE || STAGING_INBOX;
}

// Returns { requestedRecipient, actualRecipient, overrideApplied }.
// `actualRecipient` is who the email actually gets sent to.
// `requestedRecipient` is who the caller asked us to send it to.
// `overrideApplied` is true when those differ — used by the email
// utility to optionally prefix the subject line / log a warning.
function resolveRecipient(to) {
  if (isProductionDeploy()) {
    return { requestedRecipient: to, actualRecipient: to, overrideApplied: false };
  }
  const inbox = getStagingInbox();
  return {
    requestedRecipient: to,
    actualRecipient: inbox,
    overrideApplied: inbox !== to,
  };
}

module.exports = { resolveRecipient, isProductionDeploy, getStagingInbox };
