const PROD_PLATFORM_DOMAIN = 'sitepresso.com';

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function normalizePlatformDomain(value) {
  const host = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/:\d+$/, '');
  if (!host) return '';
  return host.replace(/^(app|admin|www)\./, '');
}

function isProdBuyTransferPaused(env = process.env) {
  if (truthy(env.DOMAIN_RESELLER_PROD_BUY_TRANSFER_ENABLED)) return false;
  const platformDomain = normalizePlatformDomain(env.PLATFORM_DOMAIN || env.NEXT_PUBLIC_PLATFORM_DOMAIN);
  return platformDomain === PROD_PLATFORM_DOMAIN;
}

function assertProdBuyTransferEnabled(env = process.env) {
  if (!isProdBuyTransferPaused(env)) return;
  const err = new Error('Domain buying and transfers are temporarily unavailable on production. Connect an existing domain instead.');
  err.status = 503;
  err.code = 'DOMAIN_BUY_TRANSFER_PAUSED';
  throw err;
}

module.exports = {
  assertProdBuyTransferEnabled,
  isProdBuyTransferPaused,
  normalizePlatformDomain,
};
