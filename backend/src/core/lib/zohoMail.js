// ============================================================================
// Zoho Mail adapter — provisions reseller mailboxes in Sitepresso's Zoho
// organization. We create the account + set a password, then hand the
// credentials to the customer (they sign in at Zoho directly). All calls are
// env-gated: when credentials are absent, isConfigured() is false and the
// provisioning service records the mailbox as PENDING instead of failing.
//
// Required env (set on the box once the Zoho API app exists):
//   ZOHO_MAIL_CLIENT_ID, ZOHO_MAIL_CLIENT_SECRET, ZOHO_MAIL_REFRESH_TOKEN
//   ZOHO_MAIL_ZOID            — Zoho organization id (numeric)
//   ZOHO_MAIL_REGION          — data-center TLD: 'in' (default), 'com', 'eu', 'au'…
// OAuth scope needed on the app: ZohoMail.organization.accounts.CREATE,
//   ZohoMail.organization.domains.ALL
// ============================================================================

function zohoConfig(env = process.env) {
  const region = String(env.ZOHO_MAIL_REGION || 'in').trim().toLowerCase() || 'in';
  const clientId = String(env.ZOHO_MAIL_CLIENT_ID || '').trim();
  const clientSecret = String(env.ZOHO_MAIL_CLIENT_SECRET || '').trim();
  const refreshToken = String(env.ZOHO_MAIL_REFRESH_TOKEN || '').trim();
  const zoid = String(env.ZOHO_MAIL_ZOID || env.ZOHO_MAIL_ORG_ID || '').trim();
  return {
    region,
    clientId,
    clientSecret,
    refreshToken,
    zoid,
    accountsHost: `https://accounts.zoho.${region}`,
    mailHost: `https://mail.zoho.${region}`,
    hasCredentials: Boolean(clientId && clientSecret && refreshToken && zoid),
  };
}

function isConfigured(env = process.env) {
  return zohoConfig(env).hasCredentials;
}

// Mail DNS the customer's domain needs to point at Zoho. dkim is optional —
// it is only known after the domain is added to the org (getDomain returns it).
function mailDnsRecords(domain, { region = 'in', dkim = null } = {}) {
  const z = `zoho.${region}`;
  const records = [
    { type: 'MX', name: domain, content: `mx.${z}`, priority: 10 },
    { type: 'MX', name: domain, content: `mx2.${z}`, priority: 20 },
    { type: 'MX', name: domain, content: `mx3.${z}`, priority: 50 },
    { type: 'TXT', name: domain, content: `v=spf1 include:${z} ~all` },
  ];
  if (dkim && dkim.selector && dkim.value) {
    records.push({ type: 'TXT', name: `${dkim.selector}._domainkey.${domain}`, content: dkim.value });
  }
  return records;
}

let cachedToken = null; // { token, expiresAt }

async function getAccessToken(env = process.env) {
  const cfg = zohoConfig(env);
  if (!cfg.hasCredentials) {
    const err = new Error('Zoho Mail is not configured');
    err.code = 'ZOHO_NOT_CONFIGURED';
    throw err;
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token;
  const params = new URLSearchParams({
    refresh_token: cfg.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
  });
  const res = await fetch(`${cfg.accountsHost}/oauth/v2/token?${params.toString()}`, { method: 'POST' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const err = new Error(json.error || `Zoho OAuth failed (${res.status})`);
    err.zoho = json;
    throw err;
  }
  cachedToken = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in || 3600) * 1000) };
  return cachedToken.token;
}

async function zohoApi(path, { method = 'GET', body } = {}, env = process.env) {
  const cfg = zohoConfig(env);
  const token = await getAccessToken(env);
  const res = await fetch(`${cfg.mailHost}${path}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  // Zoho wraps results in { status: { code, description }, data }
  const code = json?.status?.code;
  if (!res.ok || (code && code !== 200 && code !== 201)) {
    const err = new Error(json?.status?.description || json?.data?.errorCode || `Zoho API failed (${res.status})`);
    err.status = res.status;
    err.zoho = json;
    throw err;
  }
  return json.data ?? json;
}

// Add the domain to the org (idempotent-ish: a duplicate is treated as ok).
async function addDomain(domain, env = process.env) {
  const cfg = zohoConfig(env);
  try {
    return await zohoApi(`/api/organization/${cfg.zoid}/domains`, { method: 'POST', body: { domainName: domain } }, env);
  } catch (err) {
    if (/exist|already/i.test(err.message || '')) return { domainName: domain, alreadyAdded: true };
    throw err;
  }
}

// Fetch domain details (verification + DKIM selector/value) when available.
async function getDomain(domain, env = process.env) {
  const cfg = zohoConfig(env);
  try {
    const data = await zohoApi(`/api/organization/${cfg.zoid}/domains/${encodeURIComponent(domain)}`, {}, env);
    const dkimSelector = data?.dkimSelector || data?.dkim?.selector || null;
    const dkimValue = data?.dkimValue || data?.dkim?.publicKey || data?.dkim?.value || null;
    return { raw: data, dkim: dkimSelector && dkimValue ? { selector: dkimSelector, value: dkimValue } : null };
  } catch {
    return { raw: null, dkim: null };
  }
}

// Create a mailbox user in the org. Returns the Zoho account id when present.
async function createAccount({ emailAddress, password, displayName }, env = process.env) {
  const cfg = zohoConfig(env);
  const data = await zohoApi(`/api/organization/${cfg.zoid}/accounts`, {
    method: 'POST',
    body: {
      primaryEmailAddress: emailAddress,
      password,
      displayName: displayName || emailAddress.split('@')[0],
      role: 'member',
    },
  }, env);
  return {
    zohoAccountId: String(data?.zuid || data?.accountId || data?.zoid || '') || null,
    raw: data,
  };
}

module.exports = {
  zohoConfig,
  isConfigured,
  getAccessToken,
  addDomain,
  getDomain,
  createAccount,
  mailDnsRecords,
};
