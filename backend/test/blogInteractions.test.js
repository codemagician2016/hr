// Sprint 3.2b — blog comments + likes + settings.
//
// Mocks Prisma so we can verify the controller's policy + moderation +
// threading behaviour without a live DB. The `policyAllows` helper is
// exported for direct testing because it's the truth-table the entire
// access-control story rests on.

jest.mock('../src/core/lib/prisma', () => ({
  business: { findUnique: jest.fn() },
  blogPost: { findUnique: jest.fn() },
  blogComment: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  blogLike: {
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  blogSettings: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
}));

const prisma = require('../src/core/lib/prisma');
const i = require('../src/web/controllers/blogInteractions.controller');

function mockReq({ params = {}, body = {}, customer, headers = {}, cookies = {}, query = {}, user } = {}) {
  return {
    params,
    body,
    customer,
    user,
    headers,
    cookies,
    ip: '203.0.113.10',
    query,
  };
}

function mockRes() {
  const res = { statusCode: 200, body: null, cookies: [] };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.cookie = (name, value, opts) => { res.cookies.push({ name, value, opts }); return res; };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── policyAllows truth table ───────────────────────────────────────────────

describe('policyAllows', () => {
  test.each([
    ['NONE', 'GUEST', false],
    ['NONE', 'CUSTOMER', false],
    ['BOTH', 'GUEST', true],
    ['BOTH', 'CUSTOMER', true],
    ['GUEST_ONLY', 'GUEST', true],
    ['GUEST_ONLY', 'CUSTOMER', false],
    ['REGISTERED_ONLY', 'GUEST', false],
    ['REGISTERED_ONLY', 'CUSTOMER', true],
    ['BOGUS', 'GUEST', false],   // unknown policy fails closed
  ])('policy=%s actor=%s -> %s', (policy, actor, expected) => {
    expect(i.policyAllows(policy, actor)).toBe(expected);
  });
});

// ─── submitComment ──────────────────────────────────────────────────────────

describe('submitComment', () => {
  const BIZ = { id: 'biz-1', slug: 'acme', name: 'Acme' };
  const POST = { id: 'post-1', isPublished: true, businessId: 'biz-1' };

  beforeEach(() => {
    prisma.business.findUnique.mockResolvedValue(BIZ);
    prisma.blogPost.findUnique.mockResolvedValue(POST);
    prisma.blogSettings.findUnique.mockResolvedValue({
      businessId: 'biz-1',
      commentsEnabled: true,
      commentPolicy: 'BOTH',
      moderationMode: 'PRE_MODERATE',
      guestRequiresEmail: true,
    });
    prisma.blogComment.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'c-1', status: data.status, createdAt: new Date() })
    );
  });

  test('guest with name + email + body lands as PENDING when moderation is PRE_MODERATE', async () => {
    const req = mockReq({
      params: { slug: 'acme', postSlug: 'hello' },
      body: { authorName: 'Jamie', authorEmail: 'j@example.com', body: 'Nice post' },
    });
    const res = mockRes();
    await i.submitComment(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.awaitingModeration).toBe(true);
    expect(prisma.blogComment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        authorType: 'GUEST',
        authorName: 'Jamie',
        authorEmail: 'j@example.com',
        status: 'PENDING',
        customerId: null,
      }),
    }));
  });

  test('guest WITHOUT email is rejected when guestRequiresEmail is true', async () => {
    const req = mockReq({
      params: { slug: 'acme', postSlug: 'hello' },
      body: { authorName: 'Jamie', body: 'No email' },
    });
    const res = mockRes();
    await i.submitComment(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/email is required/i);
  });

  test('moderationMode=NONE auto-approves the comment', async () => {
    prisma.blogSettings.findUnique.mockResolvedValue({
      businessId: 'biz-1',
      commentsEnabled: true,
      commentPolicy: 'BOTH',
      moderationMode: 'NONE',
      guestRequiresEmail: true,
    });
    const req = mockReq({
      params: { slug: 'acme', postSlug: 'hello' },
      body: { authorName: 'Jamie', authorEmail: 'j@example.com', body: 'Auto' },
    });
    const res = mockRes();
    await i.submitComment(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.awaitingModeration).toBe(false);
    expect(prisma.blogComment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'APPROVED' }),
    }));
  });

  test('logged-in customer overrides any submitted name/email with their account', async () => {
    const req = mockReq({
      params: { slug: 'acme', postSlug: 'hello' },
      body: { body: 'Logged in', authorName: 'Spoof', authorEmail: 'spoof@x.com' },
      customer: { id: 'cust-1', name: 'Real Name', email: 'real@x.com' },
    });
    const res = mockRes();
    await i.submitComment(req, res);
    expect(res.statusCode).toBe(201);
    expect(prisma.blogComment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        authorType: 'CUSTOMER',
        authorName: 'Real Name',
        authorEmail: 'real@x.com',
        customerId: 'cust-1',
      }),
    }));
  });

  test('REGISTERED_ONLY policy rejects guests with requiresAuth=true', async () => {
    prisma.blogSettings.findUnique.mockResolvedValue({
      businessId: 'biz-1',
      commentsEnabled: true,
      commentPolicy: 'REGISTERED_ONLY',
      moderationMode: 'NONE',
      guestRequiresEmail: true,
    });
    const req = mockReq({
      params: { slug: 'acme', postSlug: 'hello' },
      body: { authorName: 'Jamie', authorEmail: 'j@x.com', body: 'Hi' },
    });
    const res = mockRes();
    await i.submitComment(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.requiresAuth).toBe(true);
  });

  test('commentsEnabled=false rejects all submissions', async () => {
    prisma.blogSettings.findUnique.mockResolvedValue({
      businessId: 'biz-1', commentsEnabled: false, commentPolicy: 'BOTH',
      moderationMode: 'NONE', guestRequiresEmail: false,
    });
    const req = mockReq({
      params: { slug: 'acme', postSlug: 'hello' },
      body: { authorName: 'X', authorEmail: 'x@x.com', body: 'hi' },
    });
    const res = mockRes();
    await i.submitComment(req, res);
    expect(res.statusCode).toBe(403);
  });

  test('reply-to-reply is rejected (one level deep enforced)', async () => {
    prisma.blogSettings.findUnique.mockResolvedValue({
      businessId: 'biz-1', commentsEnabled: true, commentPolicy: 'BOTH',
      moderationMode: 'NONE', guestRequiresEmail: true,
    });
    prisma.blogComment.findUnique.mockResolvedValue({
      id: 'parent-c', postId: 'post-1', parentId: 'grandparent-c', status: 'APPROVED',
    });
    const req = mockReq({
      params: { slug: 'acme', postSlug: 'hello' },
      body: { authorName: 'Jamie', authorEmail: 'j@x.com', body: 'reply', parentId: '00000000-0000-4000-8000-000000000001' },
    });
    const res = mockRes();
    await i.submitComment(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/replies to replies/i);
  });
});

// ─── toggleLike ─────────────────────────────────────────────────────────────

describe('toggleLike', () => {
  const BIZ = { id: 'biz-1', slug: 'acme' };
  const POST = { id: 'post-1', isPublished: true };

  beforeEach(() => {
    prisma.business.findUnique.mockResolvedValue(BIZ);
    prisma.blogPost.findUnique.mockResolvedValue(POST);
    prisma.blogSettings.findUnique.mockResolvedValue({
      businessId: 'biz-1', likesEnabled: true, likePolicy: 'BOTH',
      moderationMode: 'NONE', commentsEnabled: true,
    });
    prisma.blogLike.count.mockResolvedValue(1);
  });

  test('logged-in customer with no existing like creates a like keyed by customerId', async () => {
    prisma.blogLike.findUnique.mockResolvedValue(null);
    const req = mockReq({
      params: { slug: 'acme', postSlug: 'hello' },
      customer: { id: 'cust-1', name: 'X', email: 'x@x.com' },
    });
    const res = mockRes();
    await i.toggleLike(req, res);
    const call = prisma.blogLike.create.mock.calls[0][0];
    expect(call.data.customerId).toBe('cust-1');
    expect(call.data.sessionId).toBeUndefined();
  });

  test('logged-in customer with existing like deletes it (toggle off)', async () => {
    prisma.blogLike.findUnique
      .mockResolvedValueOnce({ id: 'lk-1' }) // initial check finds it
      .mockResolvedValueOnce(null); // post-delete read returns nothing
    const req = mockReq({
      params: { slug: 'acme', postSlug: 'hello' },
      customer: { id: 'cust-1' },
    });
    const res = mockRes();
    await i.toggleLike(req, res);
    expect(prisma.blogLike.delete).toHaveBeenCalledWith({ where: { id: 'lk-1' } });
    expect(res.body.liked).toBe(false);
  });

  test('guest like creates a session cookie + uses sessionId', async () => {
    prisma.blogLike.findUnique.mockResolvedValue(null);
    const req = mockReq({ params: { slug: 'acme', postSlug: 'hello' } });
    const res = mockRes();
    await i.toggleLike(req, res);
    expect(res.cookies.length).toBeGreaterThan(0);
    expect(res.cookies[0].name).toBe('sp_blog_session');
    const call = prisma.blogLike.create.mock.calls[0][0];
    expect(call.data.sessionId).toEqual(expect.any(String));
    expect(call.data.customerId).toBeUndefined();
  });

  test('likesEnabled=false rejects', async () => {
    prisma.blogSettings.findUnique.mockResolvedValue({
      businessId: 'biz-1', likesEnabled: false, likePolicy: 'BOTH',
    });
    const req = mockReq({
      params: { slug: 'acme', postSlug: 'hello' },
      customer: { id: 'cust-1' },
    });
    const res = mockRes();
    await i.toggleLike(req, res);
    expect(res.statusCode).toBe(403);
  });
});

// ─── listPublicComments ─────────────────────────────────────────────────────

describe('listPublicComments', () => {
  beforeEach(() => {
    prisma.business.findUnique.mockResolvedValue({ id: 'biz-1', slug: 'acme' });
    prisma.blogPost.findUnique.mockResolvedValue({ id: 'post-1', isPublished: true });
  });

  test('groups replies under their parent and never leaks email', async () => {
    prisma.blogSettings.findUnique.mockResolvedValue({ commentsEnabled: true });
    // First findMany call = top-level, second = replies (per the new
    // pagination shape — top + replies fetched separately).
    prisma.blogComment.findMany
      .mockResolvedValueOnce([
        { id: 'c1', parentId: null, authorName: 'A', body: 'top1', createdAt: new Date('2026-04-01') },
        { id: 'c3', parentId: null, authorName: 'C', body: 'top2', createdAt: new Date('2026-04-03') },
      ])
      .mockResolvedValueOnce([
        { id: 'c2', parentId: 'c1', authorName: 'B', body: 'reply', createdAt: new Date('2026-04-02') },
      ]);
    prisma.blogComment.count.mockResolvedValue(2);
    const req = mockReq({ params: { slug: 'acme', postSlug: 'hello' } });
    const res = mockRes();
    await i.listPublicComments(req, res);
    expect(res.body.commentsEnabled).toBe(true);
    expect(res.body.comments).toHaveLength(2);
    expect(res.body.comments[0].id).toBe('c1');
    expect(res.body.comments[0].replies).toHaveLength(1);
    expect(res.body.comments[0].replies[0].id).toBe('c2');
    expect(res.body.totalTopLevel).toBe(2);
    expect(res.body.nextCursor).toBeNull();
    // Email field must not appear in any comment object
    const flat = JSON.stringify(res.body);
    expect(flat).not.toMatch(/@/);
  });

  test('returns empty list with commentsEnabled=false when feature is off', async () => {
    prisma.blogSettings.findUnique.mockResolvedValue({ commentsEnabled: false });
    const req = mockReq({ params: { slug: 'acme', postSlug: 'hello' } });
    const res = mockRes();
    await i.listPublicComments(req, res);
    expect(res.body).toEqual({ comments: [], commentsEnabled: false, nextCursor: null });
  });
});
