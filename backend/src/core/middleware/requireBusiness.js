// Cleanup #7 — tenant guard middleware. Replaces the
//   if (!req.user.businessId) return res.status(400).json({ message: '...' });
// boilerplate at the top of ~68 controller endpoints. Apply once at the
// route layer and the controller body can assume req.user.businessId is
// populated.
//
// Why 400 (not 403)? Historical: this state happens when a SUPER_ADMIN
// or freshly-created BUSINESS_ADMIN user hasn't completed onboarding
// yet, NOT when a logged-in user tries to access another tenant's data.
// 400 ("set up your business first") matches the existing message tone.
//
// Use:
//   router.get('/foo', protect, requireRole('BUSINESS_ADMIN'), requireBusiness, fooHandler);
//
// `protect` populates req.user; this middleware runs after it. SUPER_ADMIN
// callers without a businessId still trip this — they shouldn't be hitting
// tenant-scoped endpoints in the first place, but if they need to, they
// should pass an explicit ?businessId= and a different gate.

function requireBusiness(req, res, next) {
  if (!req.user?.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  return next();
}

module.exports = { requireBusiness };
