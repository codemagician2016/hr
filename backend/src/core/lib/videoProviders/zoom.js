// Zoom provider — Phase C implementation.
//
// OAuth flow (Zoom Marketplace OAuth App):
//   1. getConnectUrl() builds the authorize URL with `meeting:write` and
//      `user:read` scopes.
//   2. handleCallback() POSTs to https://zoom.us/oauth/token with
//      Basic-auth header (base64 of `clientId:clientSecret`) — this
//      differs from Google, which sends client creds in the body.
//   3. Zoom doesn't issue an id_token; we follow up with a GET to
//      https://api.zoom.us/v2/users/me to fetch the connected user's
//      email so the admin UI can show "Connected as foo@bar.com".
//   4. refreshAccessToken() uses the same token endpoint with
//      `grant_type=refresh_token`. Important: Zoom rotates the refresh
//      token on every refresh — the response carries a NEW one and the
//      old one is invalidated. Callers must persist it.
//   5. createMeeting() POSTs to /v2/users/me/meetings with a `type=2`
//      (scheduled) meeting. Zoom returns `join_url` which is what
//      customers click. Free accounts hit a 40-min cap on 3+ participant
//      meetings — surfaced by Zoom's UI, not us.
//   6. revoke() POSTs to https://zoom.us/oauth/revoke (best-effort).
//
// Env vars required:
//   ZOOM_CLIENT_ID
//   ZOOM_CLIENT_SECRET
//
// Marketplace review note:
//   Once the OAuth App is submitted to Zoom Marketplace it goes through
//   ~2-3 weeks of review. Pre-review the app works for the developer's
//   own account and any explicitly-added "test users" — plenty for
//   early-customer phase.

const { NotImplemented } = require('./_notImplemented');

const SCOPES = ['meeting:write', 'user:read'];
const AUTHORIZE_URL = 'https://zoom.us/oauth/authorize';
const TOKEN_URL = 'https://zoom.us/oauth/token';
const REVOKE_URL = 'https://zoom.us/oauth/revoke';
const USERS_ME_URL = 'https://api.zoom.us/v2/users/me';
const CREATE_MEETING_URL = 'https://api.zoom.us/v2/users/me/meetings';

function basicAuthHeader() {
  const id = process.env.ZOOM_CLIENT_ID;
  const secret = process.env.ZOOM_CLIENT_SECRET;
  if (!id || !secret) throw new Error('ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET not set');
  const token = Buffer.from(`${id}:${secret}`).toString('base64');
  return `Basic ${token}`;
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.reason || data.error || data.message || `HTTP ${res.status}`;
    throw new Error(`Zoom ${url}: ${msg}`);
  }
  return data;
}

// Compute duration in whole minutes from "HH:MM" - "HH:MM". If end is
// before start (shouldn't happen in real bookings) we floor at 1 to
// avoid Zoom's 400 on duration<1.
function minutesBetween(startTime, endTime) {
  const [sh, sm] = String(startTime).split(':').map(Number);
  const [eh, em] = String(endTime).split(':').map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  return Math.max(1, diff);
}

module.exports = {
  key: 'zoom',
  displayName: 'Zoom',
  brandColor: '#2D8CFF',
  description: 'Auto-create a Zoom meeting link on every virtual appointment. Works with free and paid Zoom accounts.',
  oauthInstructions: 'Connect a Zoom account. Free accounts work for 1-on-1 meetings of any length, or group meetings up to 40 minutes. Submitted to Zoom Marketplace for review (2-3 weeks); usable in pre-review mode by the OAuth app owner + explicitly added test users.',

  isConfigured() {
    return !!(process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);
  },

  getConnectUrl({ redirectUri, state }) {
    if (!process.env.ZOOM_CLIENT_ID) throw new Error('ZOOM_CLIENT_ID not set');
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', process.env.ZOOM_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    // Zoom expects scopes space-separated in a single param.
    url.searchParams.set('scope', SCOPES.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  },

  async handleCallback({ code, redirectUri }) {
    const data = await postForm(TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    const expiresInSec = Number(data.expires_in) || 3600;
    // Pull the connected user's email so admin UI can show it. Failure
    // here isn't fatal — the integration still works without it.
    let externalAccountId = null;
    let externalAccountEmail = null;
    try {
      const userRes = await fetch(USERS_ME_URL, {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (userRes.ok) {
        const user = await userRes.json().catch(() => ({}));
        externalAccountId = user.id || null;
        externalAccountEmail = user.email || null;
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
    const data = await postForm(TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const expiresInSec = Number(data.expires_in) || 3600;
    return {
      accessToken: data.access_token,
      // Zoom rotates the refresh token on every refresh. Surface the new
      // one so the caller can persist it; the old one is dead the moment
      // this response is issued.
      refreshToken: data.refresh_token || null,
      expiresAt: new Date(Date.now() + (expiresInSec - 60) * 1000),
    };
  },

  async createMeeting({ accessToken, appointment }) {
    if (!accessToken) throw new Error('Missing access token');
    if (!appointment?.date || !appointment?.startTime || !appointment?.endTime) {
      throw new Error('Appointment missing date / startTime / endTime');
    }
    // Zoom wants an RFC3339 start_time in the host's timezone — when
    // `timezone` is specified separately, Zoom interprets `start_time`
    // as local-time-in-that-zone instead of UTC.
    const startDateTime = `${appointment.date}T${appointment.startTime}:00`;
    const duration = minutesBetween(appointment.startTime, appointment.endTime);
    const tz = appointment.timezone || 'UTC';

    const body = {
      topic: appointment.summary || 'Appointment',
      type: 2, // scheduled
      start_time: startDateTime,
      duration,
      timezone: tz,
      // settings.waiting_room defaults to true for many free accounts
      // (Zoom's security defaults). We leave it unspecified so the
      // host's account-level default applies.
      settings: {
        host_video: true,
        participant_video: true,
        join_before_host: false,
        // password defaults to true on most plans; let Zoom decide.
      },
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
      throw new Error(`Zoom create meeting: ${data.message || `HTTP ${res.status}`}`);
    }
    if (!data.join_url) {
      throw new Error('Zoom returned 200 but no join_url — meeting creation failed silently');
    }
    return {
      meetingUrl: data.join_url,
      externalEventId: data.id ? String(data.id) : null,
    };
  },

  async revoke({ refreshToken }) {
    if (!refreshToken) return;
    try {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`, {
        method: 'POST',
        headers: { Authorization: basicAuthHeader() },
      });
    } catch { /* swallow */ }
  },
};
