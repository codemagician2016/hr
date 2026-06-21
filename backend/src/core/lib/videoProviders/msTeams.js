// Microsoft Teams provider — Phase D implementation.
//
// OAuth flow (Microsoft Entra ID multi-tenant app):
//   1. getConnectUrl() builds the consent URL on the `/common/` endpoint
//      (the multi-tenant flavour), with scopes `OnlineMeetings.ReadWrite`
//      + `User.Read` + `offline_access`. `offline_access` is required —
//      without it Microsoft does NOT return a refresh_token.
//   2. handleCallback() POSTs to the v2.0 token endpoint with
//      client_id + client_secret in the body (Microsoft accepts both
//      body-based and Basic-auth; body keeps it consistent with Google).
//      No id_token decode — we follow up with GET /v1.0/me to grab the
//      connected user's email for admin-UI display.
//   3. refreshAccessToken() uses the same token endpoint with
//      `grant_type=refresh_token`. Microsoft sometimes rotates refresh
//      tokens (depends on conditional-access policies on the user's
//      tenant), so we surface the new one when present and let
//      integrationHelpers persist it — same path Zoom uses.
//   4. createMeeting() POSTs to /v1.0/me/onlineMeetings with
//      subject + startDateTime + endDateTime. Reads joinWebUrl off the
//      response. Standalone online meeting — NOT a calendar event —
//      so it doesn't clutter the user's Outlook calendar with extras.
//   5. revoke() — Microsoft doesn't expose a per-token revoke endpoint
//      via standard OAuth. The disconnect controller deletes the row
//      locally; the user can manually revoke our app's access at
//      https://myaccount.microsoft.com/permissions if they want
//      tenant-wide cleanup.
//
// Env vars required:
//   MS_CLIENT_ID
//   MS_CLIENT_SECRET
//
// Verification note:
//   Microsoft's review path goes through Publisher Verification (1-3
//   weeks). Pre-review the app works for any account that explicitly
//   accepts the consent screen.

const { NotImplemented } = require('./_notImplemented');

// v2.0 endpoint accepts short scope names; offline_access is mandatory
// for refresh_token issuance.
const SCOPES = ['OnlineMeetings.ReadWrite', 'User.Read', 'offline_access'];

const AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const ME_URL = 'https://graph.microsoft.com/v1.0/me';
const CREATE_MEETING_URL = 'https://graph.microsoft.com/v1.0/me/onlineMeetings';

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Microsoft ${url}: ${msg}`);
  }
  return data;
}

// Microsoft requires RFC3339 with explicit `Z` (UTC) or offset on
// startDateTime / endDateTime. We don't have an arbitrary timezone
// library at hand on the backend, so we always normalise to UTC by
// using Intl.DateTimeFormat to compute the offset for the appointment's
// IANA zone, then append it. Falls back to "Z" when the zone is UTC or
// the lookup fails.
function toRfc3339WithOffset(dateYmd, hhmm, timezone) {
  const tz = timezone || 'UTC';
  // Compute the UTC offset for `dateYmd hhmm` in that zone.
  // Trick: format the same instant in that zone and compare.
  try {
    const isoLocal = `${dateYmd}T${hhmm}:00`;
    if (tz === 'UTC') return `${isoLocal}Z`;
    // Use formatToParts to extract the offset for this date in this zone.
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    });
    const parts = fmt.formatToParts(new Date(`${isoLocal}Z`));
    const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value || '';
    // longOffset gives strings like "GMT+05:30" or "GMT-04:00"
    const m = offsetPart.match(/GMT([+-]\d{2}:?\d{2})?/);
    if (!m || !m[1]) return `${isoLocal}Z`;
    const offset = m[1].includes(':') ? m[1] : `${m[1].slice(0, 3)}:${m[1].slice(3)}`;
    return `${isoLocal}${offset}`;
  } catch {
    return `${dateYmd}T${hhmm}:00Z`;
  }
}

module.exports = {
  key: 'ms_teams',
  displayName: 'Microsoft Teams',
  brandColor: '#6264A7',
  description: 'Auto-create a Microsoft Teams meeting link on every virtual appointment.',
  oauthInstructions: 'Connect a Microsoft 365 / Outlook account. Personal Microsoft accounts also work. Microsoft review takes 1-3 weeks via Publisher Verification.',

  isConfigured() {
    return !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
  },

  getConnectUrl({ redirectUri, state }) {
    if (!process.env.MS_CLIENT_ID) throw new Error('MS_CLIENT_ID not set');
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', process.env.MS_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', SCOPES.join(' '));
    url.searchParams.set('state', state);
    // prompt=consent forces the consent dialog every time so refresh
    // tokens always issue (mirrors what we do for Google).
    url.searchParams.set('prompt', 'consent');
    return url.toString();
  },

  async handleCallback({ code, redirectUri }) {
    if (!process.env.MS_CLIENT_ID || !process.env.MS_CLIENT_SECRET) {
      throw new Error('MS_CLIENT_ID / MS_CLIENT_SECRET not set');
    }
    const data = await postForm(TOKEN_URL, {
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
    });
    const expiresInSec = Number(data.expires_in) || 3600;

    // Pull user info for the admin display label. Failure is non-fatal.
    let externalAccountId = null;
    let externalAccountEmail = null;
    try {
      const userRes = await fetch(ME_URL, {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (userRes.ok) {
        const user = await userRes.json().catch(() => ({}));
        externalAccountId = user.id || null;
        // `mail` is null for some account types (e.g. personal accounts
        // without a primary email). userPrincipalName is always set and
        // looks like an email — good fallback.
        externalAccountEmail = user.mail || user.userPrincipalName || null;
      }
    } catch { /* swallow — display label is optional */ }

    return {
      externalAccountId,
      externalAccountEmail,
      refreshToken: data.refresh_token || null,
      accessToken: data.access_token || null,
      expiresAt: new Date(Date.now() + (expiresInSec - 60) * 1000),
      scopes: data.scope || SCOPES.join(' '),
    };
  },

  async refreshAccessToken({ refreshToken }) {
    if (!refreshToken) throw new Error('No refresh token to refresh with');
    if (!process.env.MS_CLIENT_ID || !process.env.MS_CLIENT_SECRET) {
      throw new Error('MS_CLIENT_ID / MS_CLIENT_SECRET not set');
    }
    const data = await postForm(TOKEN_URL, {
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: SCOPES.join(' '),
    });
    const expiresInSec = Number(data.expires_in) || 3600;
    return {
      accessToken: data.access_token,
      // Microsoft sometimes rotates refresh tokens. Surface the new one
      // when present so integrationHelpers can persist it.
      refreshToken: data.refresh_token || null,
      expiresAt: new Date(Date.now() + (expiresInSec - 60) * 1000),
    };
  },

  async createMeeting({ accessToken, appointment }) {
    if (!accessToken) throw new Error('Missing access token');
    if (!appointment?.date || !appointment?.startTime || !appointment?.endTime) {
      throw new Error('Appointment missing date / startTime / endTime');
    }
    const startDateTime = toRfc3339WithOffset(appointment.date, appointment.startTime, appointment.timezone);
    const endDateTime = toRfc3339WithOffset(appointment.date, appointment.endTime, appointment.timezone);

    const body = {
      subject: appointment.summary || 'Appointment',
      startDateTime,
      endDateTime,
    };

    const res = await fetch(CREATE_MEETING_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Microsoft Graph onlineMeetings: ${data?.error?.message || `HTTP ${res.status}`}`);
    }
    if (!data.joinWebUrl) {
      throw new Error('Graph returned 200 but no joinWebUrl — meeting creation failed silently');
    }
    return {
      meetingUrl: data.joinWebUrl,
      externalEventId: data.id || null,
    };
  },

  async revoke(/* { refreshToken } */) {
    // Microsoft doesn't expose a per-token revoke endpoint over OAuth.
    // The local row is deleted by the disconnect controller; users who
    // want to wipe consent tenant-wide can do so at
    // https://myaccount.microsoft.com/permissions . No-op here.
  },
};
