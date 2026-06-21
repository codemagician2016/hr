// ============================================================================
// Best-effort Cloudflare DNS writer. Used to auto-publish a domain's mail DNS
// (MX/SPF/DKIM) when that domain's zone happens to live in our Cloudflare
// account. When it does not (most BYOD domains on external registrars), we
// can't write it — callers fall back to handing the records to the customer
// as setup instructions. Reads the same env as the custom-hostname flow.
// ============================================================================

function cfToken() {
  return String(process.env.CLOUDFLARE_DNS_TOKEN || process.env.CLOUDFLARE_CUSTOM_HOSTNAME_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '').trim();
}

function isConfigured() {
  return Boolean(cfToken());
}

async function cf(path, options = {}) {
  const token = cfToken();
  if (!token) {
    const err = new Error('Cloudflare DNS token not configured');
    err.code = 'CF_NOT_CONFIGURED';
    throw err;
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const msg = Array.isArray(json.errors) ? json.errors.map((e) => e.message).filter(Boolean).join('; ') : '';
    const err = new Error(msg || `Cloudflare API failed (${res.status})`);
    err.status = res.status;
    err.cloudflare = json;
    throw err;
  }
  return json.result;
}

// Resolve the registrable apex (naive: last two labels — fine for the common
// case; Cloudflare zone lookup by name confirms it exists in the account).
function apexOf(domain) {
  const parts = String(domain || '').toLowerCase().replace(/\.$/, '').split('.');
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

async function findZoneId(domain) {
  for (const name of [String(domain || '').toLowerCase(), apexOf(domain)]) {
    if (!name) continue;
    const zones = await cf(`/zones?name=${encodeURIComponent(name)}`);
    if (Array.isArray(zones) && zones[0]?.id) return { zoneId: zones[0].id, zoneName: zones[0].name };
  }
  return null;
}

// Create-or-update one DNS record (matched by type+name; MX also matched by content).
async function upsertRecord(zoneId, record) {
  const params = new URLSearchParams({ type: record.type, name: record.name });
  const existing = await cf(`/zones/${zoneId}/dns_records?${params.toString()}`);
  const match = (existing || []).find((r) => (record.type === 'MX' ? r.content === record.content : true));
  const body = {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: 1,
    ...(record.type === 'MX' ? { priority: record.priority ?? 10 } : {}),
  };
  if (match) {
    return cf(`/zones/${zoneId}/dns_records/${match.id}`, { method: 'PUT', body: JSON.stringify(body) });
  }
  return cf(`/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify(body) });
}

// Try to write all records into the domain's Cloudflare zone.
// Returns { managed: true, zoneName } on success, or { managed: false, reason }.
async function writeRecords(domain, records) {
  if (!isConfigured()) return { managed: false, reason: 'cloudflare-not-configured' };
  let zone;
  try {
    zone = await findZoneId(domain);
  } catch (err) {
    return { managed: false, reason: `zone-lookup-failed: ${err.message}` };
  }
  if (!zone) return { managed: false, reason: 'zone-not-in-account' };
  try {
    for (const record of records) await upsertRecord(zone.zoneId, record);
    return { managed: true, zoneName: zone.zoneName };
  } catch (err) {
    return { managed: false, reason: `write-failed: ${err.message}` };
  }
}

module.exports = { isConfigured, findZoneId, writeRecords };
