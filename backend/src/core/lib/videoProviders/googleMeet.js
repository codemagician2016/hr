// Google Meet provider — Phase B implementation.
//
// OAuth flow:
//   1. getConnectUrl() builds the consent URL with `calendar.events`
//      (the verified scope that gates Meet creation), `openid` + `email`
//      + `profile` for the connected-account display name.
//   2. handleCallback() POSTs to oauth2.googleapis.com/token to exchange
//      `code` → refresh_token + access_token + id_token.
//      We decode id_token (a JWT) to get the connected user's email so
//      the admin UI can show "Connected as foo@bar.com".
//   3. refreshAccessToken() POSTs to the same endpoint with
//      `grant_type=refresh_token` to renew the access token.
//   4. createMeeting() POSTs to the Calendar API events.insert endpoint
//      with conferenceData.createRequest. Calendar issues a Meet link
//      and returns it as `hangoutLink`.
//   5. revoke() POSTs to oauth2.googleapis.com/revoke (best-effort).
//
// Env vars required:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//
// Verification note:
//   `calendar.events` is a "restricted" scope so the OAuth consent screen
//   needs Google verification (~4-6 weeks). In Testing-mode the app
//   works for up to 100 explicitly-listed admins, which is plenty for
//   the early-customer phase.

const { NotImplemented } = require('./_notImplemented');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'openid',
  'email',
  'profile',
];

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CALENDAR_EVENT_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function decodeJwtPayload(jwt) {
  try {
    const part = jwt.split('.')[1];
    const decoded = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Google ${url}: ${msg}`);
  }
  return data;
}

module.exports = {
  key: 'google_meet',
  displayName: 'Google Meet',
  brandColor: '#00897B',
  description: 'Auto-create a Google Meet link on every virtual appointment. Customers see the link in their booking emails and dashboard.',
  oauthInstructions: 'Connect a Google Workspace account. Free Google accounts work too — Meet is included in every account at no extra cost. Verification by Google takes 4-6 weeks; works for up to 100 admins in "Testing mode" before then.',

  isConfigured() {
    return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  },

  getConnectUrl({ redirectUri, state }) {
    if (!process.env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID not set');
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES.join(' '));
    // access_type=offline + prompt=consent forces Google to issue a
    // refresh_token even when the same user has already consented.
    // Without prompt=consent, returning users get only an access_token.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', state);
    return url.toString();
  },

  async handleCallback({ code, redirectUri }) {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set');
    }
    const data = await postForm(TOKEN_URL, {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const idPayload = data.id_token ? decodeJwtPayload(data.id_token) : {};
    const expiresInSec = Number(data.expires_in) || 3600;
    return {
      externalAccountId: idPayload.sub || null,
      externalAccountEmail: idPayload.email || null,
      refreshToken: data.refresh_token || null,
      accessToken: data.access_token || null,
      // Subtract 60s buffer so callers refresh slightly before Google
      // would actually reject the token.
      expiresAt: new Date(Date.now() + (expiresInSec - 60) * 1000),
      scopes: data.scope || SCOPES.join(' '),
    };
  },

  async refreshAccessToken({ refreshToken }) {
    if (!refreshToken) throw new Error('No refresh token to refresh with');
    const data = await postForm(TOKEN_URL, {
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    });
    const expiresInSec = Number(data.expires_in) || 3600;
    return {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + (expiresInSec - 60) * 1000),
    };
  },

  async createMeeting({ accessToken, appointment }) {
    if (!accessToken) throw new Error('Missing access token');
    if (!appointment?.date || !appointment?.startTime || !appointment?.endTime) {
      throw new Error('Appointment missing date / startTime / endTime');
    }
    // Calendar wants RFC3339 timestamps. We pass `date` (YYYY-MM-DD) +
    // `startTime` / `endTime` (HH:MM) + the business's IANA timezone, so
    // the event lands at the correct local time even when our backend
    // server runs in a different zone.
    const startDateTime = `${appointment.date}T${appointment.startTime}:00`;
    const endDateTime = `${appointment.date}T${appointment.endTime}:00`;
    const tz = appointment.timezone || 'UTC';
    // requestId must be unique per createRequest; appointmentId+timestamp
    // makes it stable for retries within the same booking attempt and
    // unique across different bookings.
    const requestId = `sitepresso-${appointment.id || 'noId'}-${Date.now()}`;

    const body = {
      summary: appointment.summary || 'Appointment',
      description: appointment.description || undefined,
      start: { dateTime: startDateTime, timeZone: tz },
      end: { dateTime: endDateTime, timeZone: tz },
      conferenceData: {
        createRequest: {
          requestId,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
      // sendUpdates=none on the URL prevents Calendar from emailing
      // attendees a Calendar invite (we send our own booking emails).
      ...(appointment.attendees ? { attendees: appointment.attendees } : {}),
    };

    const url = `${CALENDAR_EVENT_URL}?conferenceDataVersion=1&sendUpdates=none`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Calendar events.insert: ${data?.error?.message || `HTTP ${res.status}`}`);
    }
    if (!data.hangoutLink) {
      throw new Error('Calendar event created but no hangoutLink in response — Meet creation failed silently');
    }
    return {
      meetingUrl: data.hangoutLink,
      externalEventId: data.id || null,
    };
  },

  async revoke({ refreshToken }) {
    if (!refreshToken) return;
    // Best-effort — don't throw on failure. The DB row gets deleted by
    // the disconnect controller regardless.
    try {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' });
    } catch { /* swallow */ }
  },
};
