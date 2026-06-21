// Cleanup #7 — unit tests for requireBusiness middleware + findOwned
// helper. The middleware ships with full coverage because every
// tenant-scoped endpoint depends on it; a regression here would
// silently break authentication semantics across the API.

const { requireBusiness } = require('../src/core/middleware/requireBusiness');
const { findOwned } = require('../src/core/lib/findOwned');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

describe('requireBusiness middleware', () => {
  test('400s when req.user is missing entirely', () => {
    const req = {};
    const res = mockRes();
    const next = jest.fn();
    requireBusiness(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/set up your business/);
    expect(next).not.toHaveBeenCalled();
  });
  test('400s when req.user.businessId is missing', () => {
    const req = { user: { id: 'u1' } };
    const res = mockRes();
    const next = jest.fn();
    requireBusiness(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });
  test('400s when businessId is empty string', () => {
    const req = { user: { businessId: '' } };
    const res = mockRes();
    const next = jest.fn();
    requireBusiness(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });
  test('calls next() when businessId is set', () => {
    const req = { user: { businessId: 'biz1' } };
    const res = mockRes();
    const next = jest.fn();
    requireBusiness(req, res, next);
    expect(res.statusCode).toBe(200); // unchanged
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('findOwned helper', () => {
  function mockModel(returnValue) {
    return { findFirst: jest.fn(async () => returnValue) };
  }

  test('400s when id is missing from params', async () => {
    const req = { params: {}, user: { businessId: 'biz1' } };
    const res = mockRes();
    const result = await findOwned(mockModel(null), req, res, { resource: 'page' });
    expect(result).toBeNull();
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/id is required/);
  });

  test('400s when businessId is missing', async () => {
    const req = { params: { id: 'p1' }, user: {} };
    const res = mockRes();
    const result = await findOwned(mockModel(null), req, res);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/set up your business/);
  });

  test('404s + customised message when record not found', async () => {
    const req = { params: { id: 'p1' }, user: { businessId: 'biz1' } };
    const res = mockRes();
    const model = mockModel(null);
    const result = await findOwned(model, req, res, { resource: 'page' });
    expect(result).toBeNull();
    expect(res.statusCode).toBe(404);
    expect(res.body.message).toBe('Page not found');
  });

  test('returns the record when found', async () => {
    const req = { params: { id: 'p1' }, user: { businessId: 'biz1' } };
    const res = mockRes();
    const fake = { id: 'p1', name: 'Foo' };
    const model = mockModel(fake);
    const result = await findOwned(model, req, res);
    expect(result).toBe(fake);
    expect(res.statusCode).toBe(200); // unchanged
    expect(model.findFirst).toHaveBeenCalledWith({
      where: { id: 'p1', businessId: 'biz1' },
    });
  });

  test('forwards select arg to Prisma', async () => {
    const req = { params: { id: 'p1' }, user: { businessId: 'biz1' } };
    const res = mockRes();
    const fake = { id: 'p1' };
    const model = mockModel(fake);
    await findOwned(model, req, res, { select: { id: true } });
    expect(model.findFirst).toHaveBeenCalledWith({
      where: { id: 'p1', businessId: 'biz1' },
      select: { id: true },
    });
  });

  test('id can be overridden (e.g. from body)', async () => {
    const req = { params: { id: 'wrong' }, user: { businessId: 'biz1' }, body: { otherId: 'right' } };
    const res = mockRes();
    const model = mockModel({ id: 'right' });
    await findOwned(model, req, res, { id: req.body.otherId });
    expect(model.findFirst).toHaveBeenCalledWith({
      where: { id: 'right', businessId: 'biz1' },
    });
  });
});
