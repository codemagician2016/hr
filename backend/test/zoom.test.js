// Tests for the Zoom provider — same shape as googleMeet.test.js,
// mocking global fetch to exercise the OAuth + meeting-creation flows.

const provider = require('../src/core/lib/videoProviders/zoom');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.ZOOM_CLIENT_ID = 'test-zoom-id';
  process.env.ZOOM_CLIENT_SECRET = 'test-zoom-secret';
  global.fetch = jest.fn();
});

afterAll(() => {
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('zoom provider', () => {
  describe('isConfigured', () => {
    test('true when both env vars set', () => {
      expect(provider.isConfigured()).toBe(true);
    });
    test('false when client ID missing', () => {
      delete process.env.ZOOM_CLIENT_ID;
      expect(provider.isConfigured()).toBe(false);
    });
    test('false when client secret missing', () => {
      delete process.env.ZOOM_CLIENT_SECRET;
      expect(provider.isConfigured()).toBe(false);
    });
  });

  describe('getConnectUrl', () => {
    test('builds the Zoom authorize URL with the right params', () => {
      const url = provider.getConnectUrl({
        redirectUri: 'https://api.example.com/callback',
        state: 'state-abc',
      });
      const u = new URL(url);
      expect(u.host).toBe('zoom.us');
      expect(u.pathname).toBe('/oauth/authorize');
      expect(u.searchParams.get('response_type')).toBe('code');
      expect(u.searchParams.get('client_id')).toBe('test-zoom-id');
      expect(u.searchParams.get('redirect_uri')).toBe('https://api.example.com/callback');
      expect(u.searchParams.get('state')).toBe('state-abc');
      expect(u.searchParams.get('scope')).toContain('meeting:write');
      expect(u.searchParams.get('scope')).toContain('user:read');
    });
    test('throws when env vars missing', () => {
      delete process.env.ZOOM_CLIENT_ID;
      expect(() => provider.getConnectUrl({ redirectUri: 'x', state: 'y' })).toThrow(/ZOOM_CLIENT_ID/);
    });
  });

  describe('handleCallback', () => {
    test('exchanges code for tokens with Basic-auth header, then fetches user email', async () => {
      let tokenCallHeaders = null;
      let tokenCallBody = null;
      let userCallHeaders = null;

      // 1st fetch — token exchange
      global.fetch.mockImplementationOnce(async (url, opts) => {
        tokenCallHeaders = opts.headers;
        tokenCallBody = opts.body;
        expect(url).toBe('https://zoom.us/oauth/token');
        return {
          ok: true,
          json: async () => ({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            scope: 'meeting:write user:read',
          }),
        };
      });
      // 2nd fetch — /users/me
      global.fetch.mockImplementationOnce(async (url, opts) => {
        userCallHeaders = opts.headers;
        expect(url).toBe('https://api.zoom.us/v2/users/me');
        return {
          ok: true,
          json: async () => ({ id: 'zoom-uid-1', email: 'shop@example.com' }),
        };
      });

      const result = await provider.handleCallback({
        code: 'auth-code-1',
        redirectUri: 'https://api.example.com/cb',
      });

      // Token call uses Basic auth (NOT body-based client creds)
      expect(tokenCallHeaders.Authorization).toMatch(/^Basic /);
      const decoded = Buffer.from(tokenCallHeaders.Authorization.replace('Basic ', ''), 'base64').toString();
      expect(decoded).toBe('test-zoom-id:test-zoom-secret');
      // Token call body has the right grant + redirect
      expect(tokenCallBody).toContain('grant_type=authorization_code');
      expect(tokenCallBody).toContain('code=auth-code-1');

      // User call uses Bearer with the new access token
      expect(userCallHeaders.Authorization).toBe('Bearer access-1');

      expect(result.externalAccountId).toBe('zoom-uid-1');
      expect(result.externalAccountEmail).toBe('shop@example.com');
      expect(result.refreshToken).toBe('refresh-1');
      expect(result.accessToken).toBe('access-1');
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    test('survives /users/me failure — returns tokens with null email', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
      });
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });
      const result = await provider.handleCallback({ code: 'c', redirectUri: 'x' });
      expect(result.accessToken).toBe('a');
      expect(result.externalAccountEmail).toBe(null);
      expect(result.externalAccountId).toBe(null);
    });

    test('throws when token exchange fails', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ reason: 'Invalid authorization code' }),
      });
      await expect(
        provider.handleCallback({ code: 'bad', redirectUri: 'x' })
      ).rejects.toThrow(/Invalid authorization code/);
    });
  });

  describe('refreshAccessToken', () => {
    test('returns new access AND refresh tokens (Zoom rotates refresh on every refresh)', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          expires_in: 3600,
        }),
      });
      const result = await provider.refreshAccessToken({ refreshToken: 'refresh-1' });
      expect(result.accessToken).toBe('access-2');
      expect(result.refreshToken).toBe('refresh-2');
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    test('throws when no refresh token given', async () => {
      await expect(provider.refreshAccessToken({})).rejects.toThrow(/refresh/);
    });
  });

  describe('createMeeting', () => {
    test('creates a scheduled meeting with the right body', async () => {
      let capturedBody = null;
      let capturedHeaders = null;
      global.fetch.mockImplementationOnce(async (url, opts) => {
        expect(url).toBe('https://api.zoom.us/v2/users/me/meetings');
        capturedHeaders = opts.headers;
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            id: 99887766,
            join_url: 'https://zoom.us/j/99887766?pwd=abc',
          }),
        };
      });
      const result = await provider.createMeeting({
        accessToken: 'access-1',
        appointment: {
          id: 'appt-1',
          summary: 'Consult — Ravi',
          date: '2026-05-01',
          startTime: '14:00',
          endTime: '14:45',
          timezone: 'Asia/Kolkata',
        },
      });
      expect(result.meetingUrl).toBe('https://zoom.us/j/99887766?pwd=abc');
      expect(result.externalEventId).toBe('99887766');
      expect(capturedHeaders.Authorization).toBe('Bearer access-1');
      expect(capturedBody.topic).toBe('Consult — Ravi');
      expect(capturedBody.type).toBe(2); // scheduled
      expect(capturedBody.start_time).toBe('2026-05-01T14:00:00');
      expect(capturedBody.duration).toBe(45);
      expect(capturedBody.timezone).toBe('Asia/Kolkata');
    });

    test('throws on Zoom error', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ message: 'Invalid access token' }),
      });
      await expect(
        provider.createMeeting({
          accessToken: 'expired',
          appointment: { id: 'a', date: '2026-05-01', startTime: '10:00', endTime: '10:30' },
        })
      ).rejects.toThrow(/Invalid access token/);
    });

    test('throws when Zoom returns 200 but no join_url', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 1 /* missing join_url */ }),
      });
      await expect(
        provider.createMeeting({
          accessToken: 'a',
          appointment: { id: 'a', date: '2026-05-01', startTime: '10:00', endTime: '10:30' },
        })
      ).rejects.toThrow(/no join_url/);
    });

    test('refuses without an appointment date', async () => {
      await expect(
        provider.createMeeting({ accessToken: 'a', appointment: {} })
      ).rejects.toThrow(/date \/ startTime \/ endTime/);
    });

    test('floors duration at 1 minute when end <= start (defensive)', async () => {
      let capturedBody = null;
      global.fetch.mockImplementationOnce(async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ id: 1, join_url: 'https://zoom.us/j/1' }) };
      });
      await provider.createMeeting({
        accessToken: 'a',
        appointment: { id: 'a', date: '2026-05-01', startTime: '10:00', endTime: '10:00' },
      });
      expect(capturedBody.duration).toBe(1);
    });
  });

  describe('revoke', () => {
    test('best-effort POST with Basic-auth header', async () => {
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      await provider.revoke({ refreshToken: 'refresh-1' });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('zoom.us/oauth/revoke?token=refresh-1'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Basic /) }),
        })
      );
    });
    test('swallows errors', async () => {
      global.fetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      await expect(provider.revoke({ refreshToken: 'r' })).resolves.toBeUndefined();
    });
    test('does nothing without a refresh token', async () => {
      await provider.revoke({});
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
