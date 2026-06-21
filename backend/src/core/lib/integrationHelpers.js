// Helpers shared by the booking flow and any future caller that needs
// to mint a meeting URL on behalf of a connected provider.
//
// - getValidAccessToken(integration): returns a usable access token,
//   refreshing it from the refresh token when expired and updating the
//   row. Throws if no refresh token is available (admin reconnect needed).
// - findActiveIntegration(businessId): picks the highest-preference
//   ACTIVE integration for the business (or null if none).
// - maybeCreateMeetingForBooking({...}): convenience wrapper used by
//   booking.controller — looks up the integration, refreshes the
//   token if needed, calls provider.createMeeting, returns the URL or
//   null on any failure (so booking never fails because the video
//   provider hiccuped — fallback is the manual paste flow).

const prisma = require('./prisma');
const { encrypt, decrypt } = require('./crypto');
const { getProvider } = require('./videoProviders');

const PROVIDER_PREFERENCE = ['google_meet', 'zoom', 'ms_teams'];
const REFRESH_BUFFER_MS = 60 * 1000;

async function getValidAccessToken(integration) {
  const now = Date.now();
  if (
    integration.accessTokenEncrypted &&
    integration.accessTokenExpiry &&
    new Date(integration.accessTokenExpiry).getTime() - now > REFRESH_BUFFER_MS
  ) {
    return decrypt(integration.accessTokenEncrypted);
  }
  if (!integration.refreshTokenEncrypted) {
    throw new Error(`No refresh token for ${integration.provider} — admin needs to reconnect.`);
  }
  const refreshToken = decrypt(integration.refreshTokenEncrypted);
  const provider = getProvider(integration.provider);

  try {
    const refreshed = await provider.refreshAccessToken({ refreshToken });
    const { accessToken, expiresAt } = refreshed;
    // Zoom rotates the refresh token on every refresh — `refreshed.refreshToken`
    // (when present) is the NEW one and the old one is dead. Google
    // returns no refresh_token field on refresh, so we keep the existing
    // one. Treat both providers uniformly: persist whichever refresh
    // token is current.
    const newRefreshTokenEncrypted = refreshed.refreshToken
      ? encrypt(refreshed.refreshToken)
      : integration.refreshTokenEncrypted;
    await prisma.businessIntegration.update({
      where: { id: integration.id },
      data: {
        accessTokenEncrypted: encrypt(accessToken),
        accessTokenExpiry: expiresAt,
        refreshTokenEncrypted: newRefreshTokenEncrypted,
        lastError: null,
        status: 'ACTIVE',
      },
    }).catch(() => { /* non-critical write; better to use the token than fail */ });
    return accessToken;
  } catch (err) {
    // Mark the integration EXPIRED so the admin UI can surface it.
    await prisma.businessIntegration.update({
      where: { id: integration.id },
      data: { status: 'EXPIRED', lastError: err.message },
    }).catch(() => { /* non-critical */ });
    throw err;
  }
}

async function findActiveIntegration(businessId) {
  const rows = await prisma.businessIntegration.findMany({
    where: { businessId, status: 'ACTIVE' },
  });
  for (const key of PROVIDER_PREFERENCE) {
    const found = rows.find((r) => r.provider === key);
    if (found) return found;
  }
  return null;
}

async function maybeCreateMeetingForBooking({ businessId, appointment }) {
  const integration = await findActiveIntegration(businessId);
  if (!integration) return null;

  try {
    const accessToken = await getValidAccessToken(integration);
    const provider = getProvider(integration.provider);
    const result = await provider.createMeeting({ accessToken, appointment });
    // Stamp lastUsedAt for admin visibility / debugging.
    prisma.businessIntegration.update({
      where: { id: integration.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => { /* non-critical */ });
    return result.meetingUrl;
  } catch (err) {
    console.error(`[integration/${integration.provider}] createMeeting failed:`, err.message);
    return null;
  }
}

module.exports = {
  getValidAccessToken,
  findActiveIntegration,
  maybeCreateMeetingForBooking,
  PROVIDER_PREFERENCE,
};
