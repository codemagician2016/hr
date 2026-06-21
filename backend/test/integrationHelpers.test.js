// Tests for the shared helpers that connect the booking flow to the
// video-provider abstraction. Mocks Prisma + the provider so the helper
// logic (refresh-then-cache, preference order, swallow-on-failure) can
// be exercised in isolation.

jest.mock('../src/core/lib/prisma', () => ({
  businessIntegration: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
}));

jest.mock('../src/core/lib/videoProviders', () => {
  const actual = jest.requireActual('../src/core/lib/videoProviders');
  return {
    ...actual,
    getProvider: jest.fn(),
  };
});

const prisma = require('../src/core/lib/prisma');
const { getProvider } = require('../src/core/lib/videoProviders');
const { encrypt } = require('../src/core/lib/crypto');

const ORIGINAL_SECRET = process.env.JWT_SECRET;

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
});
afterAll(() => {
  process.env.JWT_SECRET = ORIGINAL_SECRET;
});
beforeEach(() => {
  jest.clearAllMocks();
});

describe('getValidAccessToken', () => {
  const { getValidAccessToken } = require('../src/core/lib/integrationHelpers');

  test('returns the cached access token when not yet expired', async () => {
    const integration = {
      id: 'int-1',
      provider: 'google_meet',
      accessTokenEncrypted: encrypt('cached-access-token'),
      accessTokenExpiry: new Date(Date.now() + 30 * 60 * 1000), // 30 min from now
      refreshTokenEncrypted: encrypt('refresh-1'),
    };
    const token = await getValidAccessToken(integration);
    expect(token).toBe('cached-access-token');
    // No provider call since we used the cached one.
    expect(getProvider).not.toHaveBeenCalled();
  });

  test('refreshes and caches when access token is near expiry', async () => {
    const integration = {
      id: 'int-1',
      provider: 'google_meet',
      accessTokenEncrypted: encrypt('old-access-token'),
      accessTokenExpiry: new Date(Date.now() - 1000), // already expired
      refreshTokenEncrypted: encrypt('refresh-1'),
    };
    const refreshAccessToken = jest.fn().mockResolvedValue({
      accessToken: 'fresh-access-token',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    getProvider.mockReturnValue({ refreshAccessToken });
    prisma.businessIntegration.update.mockResolvedValue({});

    const token = await getValidAccessToken(integration);
    expect(token).toBe('fresh-access-token');
    expect(refreshAccessToken).toHaveBeenCalledWith({ refreshToken: 'refresh-1' });
    // Side-effect: persisted the new token + ACTIVE status.
    expect(prisma.businessIntegration.update).toHaveBeenCalledWith({
      where: { id: 'int-1' },
      data: expect.objectContaining({
        accessTokenExpiry: expect.any(Date),
        status: 'ACTIVE',
        lastError: null,
      }),
    });
  });

  test('persists rotated refresh token when provider returns one (Zoom semantics)', async () => {
    const integration = {
      id: 'int-1',
      provider: 'zoom',
      accessTokenEncrypted: encrypt('old-access'),
      accessTokenExpiry: new Date(Date.now() - 1000), // expired → triggers refresh
      refreshTokenEncrypted: encrypt('refresh-1'),
    };
    const refreshAccessToken = jest.fn().mockResolvedValue({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh', // Zoom rotates
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    getProvider.mockReturnValue({ refreshAccessToken });
    prisma.businessIntegration.update.mockResolvedValue({});

    const token = await getValidAccessToken(integration);
    expect(token).toBe('fresh-access');
    // Critical: the new refresh token must have been persisted, otherwise
    // the next refresh fails (Zoom invalidates the previous one).
    const updateCall = prisma.businessIntegration.update.mock.calls[0][0];
    expect(updateCall.data.refreshTokenEncrypted).toBeDefined();
    // Encrypted blob differs each call (random IV), so we can't compare
    // strings — but it shouldn't equal the old encrypted blob.
    expect(updateCall.data.refreshTokenEncrypted).not.toBe(integration.refreshTokenEncrypted);
  });

  test('keeps existing refresh token when provider does NOT return a new one (Google semantics)', async () => {
    const integration = {
      id: 'int-1',
      provider: 'google_meet',
      accessTokenEncrypted: encrypt('old-access'),
      accessTokenExpiry: new Date(Date.now() - 1000),
      refreshTokenEncrypted: encrypt('refresh-google'),
    };
    const refreshAccessToken = jest.fn().mockResolvedValue({
      accessToken: 'fresh-access',
      // NOTE: no refreshToken in response — Google doesn't rotate.
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    getProvider.mockReturnValue({ refreshAccessToken });
    prisma.businessIntegration.update.mockResolvedValue({});

    await getValidAccessToken(integration);
    const updateCall = prisma.businessIntegration.update.mock.calls[0][0];
    // Should re-use the original encrypted blob unchanged.
    expect(updateCall.data.refreshTokenEncrypted).toBe(integration.refreshTokenEncrypted);
  });

  test('marks integration EXPIRED when refresh fails', async () => {
    const integration = {
      id: 'int-1',
      provider: 'google_meet',
      accessTokenEncrypted: null,
      accessTokenExpiry: null,
      refreshTokenEncrypted: encrypt('revoked-refresh-token'),
    };
    const refreshAccessToken = jest.fn().mockRejectedValue(new Error('invalid_grant'));
    getProvider.mockReturnValue({ refreshAccessToken });
    prisma.businessIntegration.update.mockResolvedValue({});

    await expect(getValidAccessToken(integration)).rejects.toThrow(/invalid_grant/);
    expect(prisma.businessIntegration.update).toHaveBeenCalledWith({
      where: { id: 'int-1' },
      data: expect.objectContaining({ status: 'EXPIRED' }),
    });
  });

  test('throws when no refresh token is on file', async () => {
    const integration = {
      id: 'int-1',
      provider: 'google_meet',
      accessTokenEncrypted: null,
      accessTokenExpiry: null,
      refreshTokenEncrypted: null,
    };
    await expect(getValidAccessToken(integration)).rejects.toThrow(/reconnect/);
    expect(getProvider).not.toHaveBeenCalled();
  });
});

describe('findActiveIntegration', () => {
  const { findActiveIntegration } = require('../src/core/lib/integrationHelpers');

  test('returns null when business has no integrations', async () => {
    prisma.businessIntegration.findMany.mockResolvedValue([]);
    expect(await findActiveIntegration('biz-1')).toBe(null);
  });

  test('prefers google_meet when multiple active', async () => {
    prisma.businessIntegration.findMany.mockResolvedValue([
      { id: 'z', provider: 'zoom' },
      { id: 'g', provider: 'google_meet' },
      { id: 't', provider: 'ms_teams' },
    ]);
    const result = await findActiveIntegration('biz-1');
    expect(result.provider).toBe('google_meet');
  });

  test('falls through to zoom when google_meet absent', async () => {
    prisma.businessIntegration.findMany.mockResolvedValue([
      { id: 't', provider: 'ms_teams' },
      { id: 'z', provider: 'zoom' },
    ]);
    const result = await findActiveIntegration('biz-1');
    expect(result.provider).toBe('zoom');
  });

  test('only returns ACTIVE rows (status filter is at the query level)', async () => {
    // The where:{status:'ACTIVE'} is enforced in the helper; we trust
    // the test's mock to honour it. This test ensures we passed the
    // filter through.
    prisma.businessIntegration.findMany.mockResolvedValue([]);
    await findActiveIntegration('biz-1');
    expect(prisma.businessIntegration.findMany).toHaveBeenCalledWith({
      where: { businessId: 'biz-1', status: 'ACTIVE' },
    });
  });
});

describe('maybeCreateMeetingForBooking', () => {
  const { maybeCreateMeetingForBooking } = require('../src/core/lib/integrationHelpers');

  test('returns null when no integration is connected', async () => {
    prisma.businessIntegration.findMany.mockResolvedValue([]);
    const result = await maybeCreateMeetingForBooking({
      businessId: 'biz-1',
      appointment: { id: 'a', date: '2026-05-01', startTime: '10:00', endTime: '10:30' },
    });
    expect(result).toBe(null);
  });

  test('creates a meeting and returns the URL when integration is active', async () => {
    prisma.businessIntegration.findMany.mockResolvedValue([
      {
        id: 'int-1',
        provider: 'google_meet',
        accessTokenEncrypted: encrypt('access-1'),
        accessTokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
        refreshTokenEncrypted: encrypt('refresh-1'),
      },
    ]);
    const createMeeting = jest.fn().mockResolvedValue({ meetingUrl: 'https://meet.google.com/xyz' });
    getProvider.mockReturnValue({ createMeeting });
    prisma.businessIntegration.update.mockResolvedValue({});

    const result = await maybeCreateMeetingForBooking({
      businessId: 'biz-1',
      appointment: {
        id: 'appt-1',
        summary: 'Service A',
        date: '2026-05-01',
        startTime: '10:00',
        endTime: '10:30',
        timezone: 'UTC',
      },
    });
    expect(result).toBe('https://meet.google.com/xyz');
    expect(createMeeting).toHaveBeenCalledWith({
      accessToken: 'access-1',
      appointment: expect.objectContaining({ id: 'appt-1' }),
    });
  });

  test('returns null (does not throw) when provider createMeeting fails', async () => {
    prisma.businessIntegration.findMany.mockResolvedValue([
      {
        id: 'int-1',
        provider: 'google_meet',
        accessTokenEncrypted: encrypt('access-1'),
        accessTokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
        refreshTokenEncrypted: encrypt('refresh-1'),
      },
    ]);
    const createMeeting = jest.fn().mockRejectedValue(new Error('Quota exceeded'));
    getProvider.mockReturnValue({ createMeeting });
    // Suppress the console.error so test output stays clean.
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await maybeCreateMeetingForBooking({
      businessId: 'biz-1',
      appointment: { id: 'appt-1', date: '2026-05-01', startTime: '10:00', endTime: '10:30' },
    });
    expect(result).toBe(null); // never blocks the booking
    errSpy.mockRestore();
  });
});
