// Zod schemas for the customer address book endpoints. Mounted on
// /api/customer/addresses (requireCustomer guard). Country is ISO 3166-1
// alpha-2, stored uppercase to match the Order.shippingAddress format.

const { z } = require('zod');

const addressBaseShape = z.object({
  label: z.string().trim().max(40).optional().nullable(),
  fullName: z.string().trim().min(1, 'Recipient name is required').max(120),
  phone: z.string().trim().max(40).optional().nullable(),
  line1: z.string().trim().min(1, 'Address line 1 is required').max(200),
  line2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().min(1, 'City is required').max(120),
  state: z.string().trim().max(120).optional().nullable(),
  postalCode: z.string().trim().min(1, 'Postal code is required').max(40),
  country: z.string().trim().toUpperCase().length(2, 'Country must be a 2-letter ISO code'),
  isDefault: z.boolean().optional(),
});

const createAddressSchema = addressBaseShape;
const updateAddressSchema = addressBaseShape.partial();

module.exports = { createAddressSchema, updateAddressSchema };
