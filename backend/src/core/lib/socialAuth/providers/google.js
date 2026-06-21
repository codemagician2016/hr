'use strict';

// Google identity provider.
//
// Implements the provider contract consumed by socialAuth/index.js:
//   name          : stable provider key stored in CustomerIdentity.provider
//   isConfigured(): whether the server has the credentials to verify tokens
//   verify(token) : resolve a Google ID token (the GSI `credential`) into a
//                   normalised identity, or throw on any failure.
//
// To add Apple / Microsoft / etc. later: drop a sibling file exporting the
// same shape and register it in ../index.js — nothing else changes.

const { OAuth2Client } = require('google-auth-library');

const NAME = 'google';

// Lazily constructed so a missing GOOGLE_CLIENT_ID at require-time doesn't
// crash boot — isConfigured() gates real use and the route returns a clear
// 503 instead of a misleading "invalid credential" 401.
let client = null;
function getClient() {
  if (!client) client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || undefined);
  return client;
}

function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID.trim());
}

async function verify(credential) {
  if (!isConfigured()) {
    const err = new Error('Google sign-in is not configured on the server');
    err.code = 'PROVIDER_NOT_CONFIGURED';
    throw err;
  }
  if (!credential) {
    const err = new Error('Missing Google credential');
    err.code = 'BAD_CREDENTIAL';
    throw err;
  }

  let payload;
  try {
    const ticket = await getClient().verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (e) {
    const err = new Error('Invalid Google credential');
    err.code = 'BAD_CREDENTIAL';
    err.cause = e;
    throw err;
  }

  if (!payload || !payload.sub) {
    const err = new Error('Google token had no subject');
    err.code = 'BAD_CREDENTIAL';
    throw err;
  }
  if (!payload.email) {
    const err = new Error('Could not get an email from the Google account');
    err.code = 'NO_EMAIL';
    throw err;
  }

  return {
    provider: NAME,
    subject: String(payload.sub),
    email: String(payload.email).toLowerCase().trim(),
    emailVerified: payload.email_verified !== false,
    name: payload.name || (payload.email ? payload.email.split('@')[0] : 'Customer'),
  };
}

module.exports = { name: NAME, isConfigured, verify };
