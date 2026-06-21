// Tests for the MS Teams provider — same shape as googleMeet/zoom tests,
// mocking global fetch.

const provider = require('../src/core/lib/videoProviders/msTeams');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.MS_CLIENT_ID = 'test-ms-id';
  process.env.MS_CLIENT_SECRET = 'test-ms-secret';
  global.fetch = jest.fn();
});

afterAll(() => {
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('msTeams provider', () => {
  describe('isConfigured', () => {
    test('true when both env vars set', () => {
      expect(provider.isConfigured()).toBe(true);
    });
    test('false when client ID missing', () => {
      delete process.env.MS_CLIENT_ID;
      expect(provider.isConfigured()).toBe(false);
    });
    test('false when client secret missing', () => {
      delete process.env.MS_CLIENT_SECRET;
      expect(provider.isConfigured()).toBe(false);
    });
  });

  describe('getConnectUrl', () => {
    test('builds the Microsoft consent URL on the multi-tenant /common/ endpoint', () => {
      const url = provider.getConnectUrl({
        redirectUri: 'https://api.example.com/callback',
        state: 'state-123',
      });
      const u = new URL(url);
      expect(u.host).toBe('login.microsoftonline.com');
      expect(u.pathname).toBe('/common/oauth2/v2.0/authorize');
      expect(u.searchParams.get('client_id')).toBe('test-ms-id');
      expect(u.searchParams.get('response_type')).toBe('code');
      expect(u.searchParams.get('redirect_uri')).toBe('https://api.example.com/callback');
      expect(u.searchParams.get('state')).toBe('state-123');
      expect(u.searchParams.get('prompt')).toBe('consent');
      const scope = u.searchParams.get('scope');
      expect(scope).toContain('OnlineMeetings.ReadWrite');
      expect(scope).toContain('User.Read');
      // offline_access is mandatory — without it Microsoft returns no
      // refresh_token and the integration becomes a one-shot.
      expect(scope).toContain('offline_access');
    });
    test('throws when client ID missing', () => {
      delete process.env.MS_CLIENT_ID;
      expect(() => provider.getConnectUrl({ redirectUri: 'x', state: 'y' })).toThrow(/MS_CLIENT_ID/);
    });
  });

  describe('handleCallback', () => {
    test('exchanges code for tokens, then GETs /me for the user email', async () => {
      let tokenBody = null;
      let meHeaders = null;

      global.fetch.mockImplementationOnce(async (url, opts) => {
        expect(url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
        tokenBody = opts.body;
        return {
          ok: true,
          json: async () => ({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            scope: 'OnlineMeetings.ReadWrite User.Read offline_access',
          }),
        };
      });
      global.fetch.mockImplementationOnce(async (url, opts) => {
        expect(url).toBe('https://graph.microsoft.com/v1.0/me');
        meHeaders = opts.headers;
        return {
          ok: true,
          json: async () => ({
            id: 'aad-uid-1',
            mail: 'shop@contoso.com',
            userPrincipalName: 'shop@contoso.com',
          }),
        };
      });

      const result = await provider.handleCallback({
        code: 'auth-code-1',
        redirectUri: 'https://api.example.com/cb',
      });
      // Token body has client_id + client_secret + grant + scope
      expect(tokenBody).toContain('grant_type=authorization_code');
      expect(tokenBody).toContain('code=auth-code-1');
      expect(tokenBody).toContain('client_id=test-ms-id');
      expect(tokenBody).toContain('client_secret=test-ms-secret');
      expect(tokenBody).toContain('offline_access');
      // User call uses Bearer
      expect(meHeaders.Authorization).toBe('Bearer access-1');
      // Result shape
      expect(result.externalAccountId).toBe('aad-uid-1');
      expect(result.externalAccountEmail).toBe('shop@contoso.com');
      expect(result.refreshToken).toBe('refresh-1');
      expect(result.accessToken).toBe('access-1');
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    test('falls back to userPrincipalName when /me returns mail=null (personal accounts)', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
      });
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'aad-uid-2',
          mail: null,
          userPrincipalName: 'someone@outlook.com',
        }),
      });
      const result = await provider.handleCallback({ code: 'c', redirectUri: 'x' });
      expect(result.externalAccountEmail).toBe('someone@outlook.com');
    });

    test('survives /me failure with null email', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
      });
      global.fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
      const result = await provider.handleCallback({ code: 'c', redirectUri: 'x' });
      expect(result.accessToken).toBe('a');
      expect(result.externalAccountEmail).toBe(null);
    });

    test('throws when token endpoint rejects the code', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant', error_description: 'AADSTS70008: refresh token expired' }),
      });
      await expect(
        provider.handleCallback({ code: 'bad', redirectUri: 'x' })
      ).rejects.toThrow(/AADSTS70008/);
    });
  });

  describe('refreshAccessToken', () => {
    test('renews the access token; surfaces a new refresh when present', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'access-2',
          refresh_token: 'refresh-2', // Microsoft sometimes rotates
          expires_in: 3600,
        }),
      });
      const result = await provider.refreshAccessToken({ refreshToken: 'refresh-1' });
      expect(result.accessToken).toBe('access-2');
      expect(result.refreshToken).toBe('refresh-2');
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    test('returns null refreshToken when Microsoft does not rotate (older flows)', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'access-2', expires_in: 3600 }),
      });
      const result = await provider.refreshAccessToken({ refreshToken: 'refresh-1' });
      expect(result.accessToken).toBe('access-2');
      expect(result.refreshToken).toBe(null);
    });

    test('throws when no refresh token given', async () => {
      await expect(provider.refreshAccessToken({})).rejects.toThrow(/refresh/);
    });
  });

  describe('createMeeting', () => {
    test('creates a Teams meeting with subject + startDateTime + endDateTime', async () => {
      let capturedBody = null;
      let capturedHeaders = null;
      global.fetch.mockImplementationOnce(async (url, opts) => {
        expect(url).toBe('https://graph.microsoft.com/v1.0/me/onlineMeetings');
        capturedHeaders = opts.headers;
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            id: 'meeting-id-1',
            joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/abc/0',
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
          timezone: 'UTC',
        },
      });
      expect(result.meetingUrl).toBe('https://teams.microsoft.com/l/meetup-join/abc/0');
      expect(result.externalEventId).toBe('meeting-id-1');
      expect(capturedHeaders.Authorization).toBe('Bearer access-1');
      expect(capturedBody.subject).toBe('Consult — Ravi');
      // UTC zone produces clean Z-suffix RFC3339
      expect(capturedBody.startDateTime).toBe('2026-05-01T14:00:00Z');
      expect(capturedBody.endDateTime).toBe('2026-05-01T14:45:00Z');
    });

    test('appends timezone offset for non-UTC zones', async () => {
      let capturedBody = null;
      global.fetch.mockImplementationOnce(async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ id: 'm', joinWebUrl: 'https://teams.example/x' }) };
      });
      await provider.createMeeting({
        accessToken: 'a',
        appointment: { id: 'a', date: '2026-05-01', startTime: '10:00', endTime: '10:30', timezone: 'Asia/Kolkata' },
      });
      // India is +05:30 — should appear in the offset suffix.
      expect(capturedBody.startDateTime).toMatch(/^2026-05-01T10:00:00\+05:30$/);
      expect(capturedBody.endDateTime).toMatch(/^2026-05-01T10:30:00\+05:30$/);
    });

    test('throws on Graph error', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'InvalidAuthenticationToken' } }),
      });
      await expect(
        provider.createMeeting({
          accessToken: 'expired',
          appointment: { id: 'a', date: '2026-05-01', startTime: '10:00', endTime: '10:30' },
        })
      ).rejects.toThrow(/InvalidAuthenticationToken/);
    });

    test('throws when Graph returns 200 but no joinWebUrl', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'x' /* missing joinWebUrl */ }),
      });
      await expect(
        provider.createMeeting({
          accessToken: 'a',
          appointment: { id: 'a', date: '2026-05-01', startTime: '10:00', endTime: '10:30' },
        })
      ).rejects.toThrow(/no joinWebUrl/);
    });

    test('refuses without an appointment date', async () => {
      await expect(
        provider.createMeeting({ accessToken: 'a', appointment: {} })
      ).rejects.toThrow(/date \/ startTime \/ endTime/);
    });
  });

  describe('revoke', () => {
    test('is a no-op (Microsoft has no per-token revoke OAuth endpoint)', async () => {
      await provider.revoke({ refreshToken: 'r' });
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
