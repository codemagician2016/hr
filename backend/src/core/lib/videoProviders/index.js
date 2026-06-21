// Video provider registry. Each provider module under this folder
// implements the same surface so the rest of the codebase only needs
// to know "give me the provider keyed under 'google_meet'" and call
// the provider-agnostic methods on it.
//
// Provider interface (all methods are optional in Phase A — they
// throw NotImplemented until the provider's body lands):
//
//   provider.key                                              // 'google_meet' | 'zoom' | 'ms_teams'
//   provider.displayName                                      // "Google Meet"
//   provider.brandColor                                       // for the admin UI card accent
//   provider.isConfigured()                                   // env-vars present?
//   provider.getConnectUrl({ businessId, redirectUri, state }) // → URL string
//   provider.handleCallback({ code, redirectUri })            // → { externalAccountId, externalAccountEmail, refreshToken, accessToken, expiresAt, scopes }
//   provider.refreshAccessToken({ refreshToken })             // → { accessToken, expiresAt }
//   provider.createMeeting({ accessToken, appointment })      // → { meetingUrl, externalEventId? }
//   provider.revoke({ refreshToken })                         // → void (best-effort)

const googleMeet = require('./googleMeet');
const zoom = require('./zoom');
const msTeams = require('./msTeams');

const REGISTRY = {
  google_meet: googleMeet,
  zoom: zoom,
  ms_teams: msTeams,
};

const KNOWN_KEYS = Object.keys(REGISTRY);

function getProvider(key) {
  const provider = REGISTRY[key];
  if (!provider) throw new Error(`Unknown video provider: ${key}`);
  return provider;
}

function listProviders() {
  return KNOWN_KEYS.map((key) => ({
    key,
    displayName: REGISTRY[key].displayName,
    brandColor: REGISTRY[key].brandColor,
    isConfigured: REGISTRY[key].isConfigured(),
  }));
}

class NotImplemented extends Error {
  constructor(provider, method) {
    super(`${provider}.${method}() not implemented yet — Phase B/C/D pending`);
    this.code = 'PROVIDER_NOT_IMPLEMENTED';
  }
}

module.exports = {
  getProvider,
  listProviders,
  KNOWN_KEYS,
  NotImplemented,
};
