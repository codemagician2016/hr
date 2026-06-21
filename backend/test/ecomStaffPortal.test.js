const {
  isEcommerceBusiness,
  staffPortalPathForBusiness,
  staffPortalUrlForBusiness,
} = require('../src/core/lib/ecomStaffPortal');
const { ECOM_SYSTEM_ROLES } = require('../src/core/lib/ecomPermissionCatalog');

describe('ecom staff portal routing', () => {
  test('routes ecommerce staff to the shop manager portal', () => {
    const business = { slug: 'ramu-general-store', vertical: 'ECOMMERCE' };
    expect(isEcommerceBusiness(business)).toBe(true);
    expect(staffPortalPathForBusiness(business)).toBe('/ramu-general-store/staff/manager');
    expect(staffPortalUrlForBusiness(business, 'https://aapkatech.com/')).toBe(
      'https://aapkatech.com/ramu-general-store/staff/manager'
    );
  });

  test('keeps appointment and static staff on the generic staff portal', () => {
    expect(staffPortalPathForBusiness({ slug: 'nail-studio', vertical: 'APPOINTMENT' }))
      .toBe('/nail-studio/staff');
    expect(staffPortalPathForBusiness({ slug: 'taxfixy', vertical: 'STATIC' }))
      .toBe('/taxfixy/staff');
  });

  test('inventory preset is inventory-only, not rider/order/customer access', () => {
    expect(ECOM_SYSTEM_ROLES.Inventory).toEqual(expect.arrayContaining([
      'inventory.view',
      'inventory.adjust',
      'inventory.transfer',
      'inventory.grn',
    ]));
    expect(ECOM_SYSTEM_ROLES.Inventory).not.toEqual(expect.arrayContaining([
      'orders.view',
      'orders.edit',
      'catalogue.view',
      'customers.view',
    ]));
  });
});
