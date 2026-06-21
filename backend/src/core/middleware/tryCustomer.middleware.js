// Soft customer-auth: if a valid customer token is present, set req.customer;
// otherwise continue as a guest.
const { authenticateCustomer } = require('./auth.middleware');

async function tryCustomer(req, res, next) {
  try {
    req.customer = await authenticateCustomer(req, res);
    req.authType = 'customer';
  } catch {
    // Guests and stale customer sessions should not block public storefront UX.
  }
  next();
}

module.exports = { tryCustomer };
