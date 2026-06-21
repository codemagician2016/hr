const prisma = require('./prisma');
const {
  createPaddleCustomerAddress,
  createPaddleCustomerBusiness,
} = require('./paddle');
const { normalizeCountryCode } = require('./subscriptionBilling');

function clean(value) {
  const out = String(value || '').trim();
  return out || null;
}

function billingContactEmail(business, user = null) {
  return clean(business?.billingEmail) || clean(business?.email) || clean(user?.email);
}

function billingContactName(business, user = null) {
  return clean(business?.billingContactName)
    || clean(user?.name)
    || clean(business?.name)
    || 'Sitepresso customer';
}

function billingCompanyName(business) {
  return clean(business?.billingBusinessName) || clean(business?.name);
}

function hasAddressInput(business) {
  return Boolean(
    normalizeCountryCode(business?.billingCountry || business?.country)
    || clean(business?.billingAddressLine1)
    || clean(business?.billingCity)
    || clean(business?.billingPostalCode)
  );
}

function hasBusinessInput(business) {
  return String(business?.billingPurchaserType || '').toUpperCase() === 'BUSINESS'
    || Boolean(clean(business?.billingBusinessName) || clean(business?.billingTaxId));
}

async function ensurePaddleBillingProfile({
  business,
  paddleCustomerId,
  user = null,
  tx = prisma,
} = {}) {
  if (!business || !paddleCustomerId) {
    return { addressId: null, businessId: null };
  }

  let addressId = clean(business.paddleBillingAddressId);
  let businessId = clean(business.paddleBillingBusinessId);
  const patch = {};

  if (!addressId && hasAddressInput(business)) {
    const countryCode = normalizeCountryCode(business.billingCountry || business.country);
    if (countryCode) {
      const address = await createPaddleCustomerAddress(paddleCustomerId, {
        description: business.name ? `${business.name} billing address` : 'Billing address',
        first_line: clean(business.billingAddressLine1),
        second_line: clean(business.billingAddressLine2),
        city: clean(business.billingCity),
        region: clean(business.billingState),
        postal_code: clean(business.billingPostalCode),
        country_code: countryCode,
        custom_data: {
          businessId: business.id,
          businessSlug: business.slug || null,
        },
      });
      addressId = address?.id || null;
      if (addressId) patch.paddleBillingAddressId = addressId;
    }
  }

  if (!businessId && hasBusinessInput(business)) {
    const email = billingContactEmail(business, user);
    const contactName = billingContactName(business, user);
    const payload = {
      name: billingCompanyName(business),
      company_number: clean(business.billingCompanyNumber),
      tax_identifier: clean(business.billingTaxId),
      custom_data: {
        businessId: business.id,
        businessSlug: business.slug || null,
      },
    };
    if (email) {
      payload.contacts = [{ name: contactName, email }];
    }
    const paddleBusiness = await createPaddleCustomerBusiness(paddleCustomerId, payload);
    businessId = paddleBusiness?.id || null;
    if (businessId) patch.paddleBillingBusinessId = businessId;
  }

  if (Object.keys(patch).length > 0 && tx.business?.update) {
    await tx.business.update({
      where: { id: business.id },
      data: patch,
    }).catch(() => null);
  }

  return { addressId, businessId };
}

module.exports = {
  ensurePaddleBillingProfile,
};
