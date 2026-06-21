const { getProvider, listProviders, KNOWN_KEYS } = require('../src/core/lib/videoProviders');

describe('videoProviders registry', () => {
  test('registers exactly the three expected providers', () => {
    expect(KNOWN_KEYS.sort()).toEqual(['google_meet', 'ms_teams', 'zoom']);
  });

  test('every provider has the required surface', () => {
    for (const key of KNOWN_KEYS) {
      const p = getProvider(key);
      expect(p.key).toBe(key);
      expect(typeof p.displayName).toBe('string');
      expect(p.displayName.length).toBeGreaterThan(0);
      expect(typeof p.brandColor).toBe('string');
      expect(typeof p.isConfigured).toBe('function');
      expect(typeof p.getConnectUrl).toBe('function');
      expect(typeof p.handleCallback).toBe('function');
      expect(typeof p.refreshAccessToken).toBe('function');
      expect(typeof p.createMeeting).toBe('function');
      expect(typeof p.revoke).toBe('function');
    }
  });

  test('getProvider throws for unknown key', () => {
    expect(() => getProvider('skype')).toThrow(/Unknown video provider/);
  });

  // All three providers are fully implemented as of Phase D (2026-04-27).
  // Each has its own dedicated test file (googleMeet.test.js, zoom.test.js,
  // msTeams.test.js) covering the OAuth + meeting-creation flows.

  test('listProviders returns one entry per known key with isConfigured', () => {
    const list = listProviders();
    expect(list.map((p) => p.key).sort()).toEqual(KNOWN_KEYS.slice().sort());
    for (const entry of list) {
      expect(typeof entry.isConfigured).toBe('boolean');
    }
  });
});
