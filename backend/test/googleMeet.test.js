// Tests for the Google Meet provider — mock global fetch since the
// provider talks directly to Google's HTTP endpoints.

const provider = require('../src/core/lib/videoProviders/googleMeet');

const ORIGINAL_ENV = { ...process.env };

function jwtFor(payload) {
  // Minimal unsigned JWT — provider only reads the payload, not the sig.
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  global.fetch = jest.fn();
});

afterAll(() => {
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('googleMeet provider', () => {
  describe('isConfigured', () => {
    test('true when both env vars set', () => {
      expect(provider.isConfigured()).toBe(true);
    });
    test('false when client ID missing', () => {
      delete process.env.GOOGLE_CLIENT_ID;
      expect(provider.isConfigured()).toBe(false);
    });
    test('false when client secret missing', () => {
      delete process.env.GOOGLE_CLIENT_SECRET;
      expect(provider.isConfigured()).toBe(false);
    });
  });

  describe('getConnectUrl', () => {
    test('builds the consent URL with the right params', () => {
      const url = provider.getConnectUrl({
        redirectUri: 'https://api.example.com/callback',
        state: 'state-token-abc',
      });
      const u = new URL(url);
      expect(u.host).toBe('accounts.google.com');
      expect(u.pathname).toBe('/o/oauth2/v2/auth');
      expect(u.searchParams.get('client_id')).toBe('test-client-id');
      expect(u.searchParams.get('redirect_uri')).toBe('https://api.example.com/callback');
      expect(u.searchParams.get('response_type')).toBe('code');
      expect(u.searchParams.get('access_type')).toBe('offline');
      expect(u.searchParams.get('prompt')).toBe('consent');
      expect(u.searchParams.get('state')).toBe('state-token-abc');
      expect(u.searchParams.get('scope')).toContain('calendar.events');
      expect(u.searchParams.get('scope')).toContain('email');
    });
    test('throws when GOOGLE_CLIENT_ID is unset', () => {
      delete process.env.GOOGLE_CLIENT_ID;
      expect(() => provider.getConnectUrl({ redirectUri: 'x', state: 'y' })).toThrow(/GOOGLE_CLIENT_ID/);
    });
  });

  describe('handleCallback', () => {
    test('exchanges code for tokens and decodes id_token', async () => {
      const idToken = jwtFor({ sub: 'google-uid-1', email: 'shopkeeper@example.com' });
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          id_token: idToken,
          scope: 'calendar.events openid email',
        }),
      });
      const result = await provider.handleCallback({
        code: 'auth-code-1',
        redirectUri: 'https://api.example.com/cb',
      });
      expect(result.externalAccountId).toBe('google-uid-1');
      expect(result.externalAccountEmail).toBe('shopkeeper@example.com');
      expect(result.refreshToken).toBe('refresh-1');
      expect(result.accessToken).toBe('access-1');
      expect(result.expiresAt).toBeInstanceOf(Date);
      // Should be ~1 hour from now (minus 60s buffer).
      const delta = result.expiresAt.getTime() - Date.now();
      expect(delta).toBeGreaterThan(3000_000); // > 50 min
      expect(delta).toBeLessThan(3700_000);    // < 62 min
      expect(result.scopes).toContain('calendar.events');
    });

    test('throws when Google returns a non-200', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant', error_description: 'code expired' }),
      });
      await expect(
        provider.handleCallback({ code: 'bad', redirectUri: 'https://x' })
      ).rejects.toThrow(/code expired/);
    });

    test('survives a missing id_token (rare but legal)', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
          // no id_token
        }),
      });
      const result = await provider.handleCallback({ code: 'c', redirectUri: 'x' });
      expect(result.externalAccountId).toBe(null);
      expect(result.externalAccountEmail).toBe(null);
    });
  });

  describe('refreshAccessToken', () => {
    test('renews the access token', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'access-2', expires_in: 3600 }),
      });
      const result = await provider.refreshAccessToken({ refreshToken: 'refresh-1' });
      expect(result.accessToken).toBe('access-2');
      expect(result.expiresAt).toBeInstanceOf(Date);
    });
    test('throws when no refresh token is given', async () => {
      await expect(provider.refreshAccessToken({})).rejects.toThrow(/refresh/);
    });
  });

  describe('createMeeting', () => {
    test('inserts a calendar event with conferenceData and returns hangoutLink', async () => {
      let capturedBody = null;
      let capturedUrl = null;
      let capturedHeaders = null;
      global.fetch.mockImplementationOnce(async (url, opts) => {
        capturedUrl = url;
        capturedHeaders = opts.headers;
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            id: 'event-id-1',
            hangoutLink: 'https://meet.google.com/abc-defg-hij',
            conferenceData: { conferenceId: 'abc-defg-hij' },
          }),
        };
      });
      const result = await provider.createMeeting({
        accessToken: 'access-1',
        appointment: {
          id: 'appt-1',
          summary: 'Haircut — Ravi',
          date: '2026-05-01',
          startTime: '10:00',
          endTime: '10:30',
          timezone: 'Asia/Kolkata',
          attendees: [{ email: 'customer@example.com', displayName: 'Ravi' }],
        },
      });
      expect(result.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
      expect(result.externalEventId).toBe('event-id-1');
      // Verify the request shape:
      expect(capturedUrl).toContain('conferenceDataVersion=1');
      expect(capturedUrl).toContain('sendUpdates=none');
      expect(capturedHeaders.Authorization).toBe('Bearer access-1');
      expect(capturedBody.summary).toBe('Haircut — Ravi');
      expect(capturedBody.start.dateTime).toBe('2026-05-01T10:00:00');
      expect(capturedBody.start.timeZone).toBe('Asia/Kolkata');
      expect(capturedBody.end.dateTime).toBe('2026-05-01T10:30:00');
      expect(capturedBody.conferenceData.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet');
      expect(capturedBody.conferenceData.createRequest.requestId).toContain('appt-1');
      expect(capturedBody.attendees).toHaveLength(1);
    });

    test('throws on Calendar API error', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'Invalid Credentials' } }),
      });
      await expect(
        provider.createMeeting({
          accessToken: 'expired',
          appointment: { id: 'a', date: '2026-05-01', startTime: '10:00', endTime: '10:30' },
        })
      ).rejects.toThrow(/Invalid Credentials/);
    });

    test('throws when Calendar succeeds but no hangoutLink (Meet creation silently failed)', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'event-id-1' /* no hangoutLink */ }),
      });
      await expect(
        provider.createMeeting({
          accessToken: 'a',
          appointment: { id: 'a', date: '2026-05-01', startTime: '10:00', endTime: '10:30' },
        })
      ).rejects.toThrow(/no hangoutLink/);
    });

    test('refuses without an appointment date', async () => {
      await expect(
        provider.createMeeting({ accessToken: 'a', appointment: {} })
      ).rejects.toThrow(/date \/ startTime \/ endTime/);
    });
  });

  describe('revoke', () => {
    test('best-effort POST to revoke endpoint', async () => {
      global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
      await provider.revoke({ refreshToken: 'refresh-1' });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('oauth2.googleapis.com/revoke?token=refresh-1'),
        expect.objectContaining({ method: 'POST' })
      );
    });
    test('swallows network errors silently', async () => {
      global.fetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      await expect(provider.revoke({ refreshToken: 'refresh-1' })).resolves.toBeUndefined();
    });
    test('does nothing when no refresh token given', async () => {
      await provider.revoke({});
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
