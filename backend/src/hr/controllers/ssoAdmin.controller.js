'use strict';

// Tenant SSO + SCIM admin API — /api/hr/sso (protect + canManageSso; Owner and
// HR-Admin hold the key via the rbac.js presets).
//
//   GET    /connection        current connection (secrets NEVER echoed —
//                             hasClientSecret / hasSpPrivateKey booleans only)
//   PUT    /connection        upsert (ONE per tenant); clientSecret /
//                             spPrivateKey are WRITE-ONLY: provided → stored
//                             AES-256-GCM-encrypted; omitted → kept; null → cleared
//   POST   /connection/test   OIDC: live discovery fetch; SAML: cert parse sanity
//   DELETE /connection
//   GET    /scim-tokens       list (name/last4/lastUsedAt — never the hash)
//   POST   /scim-tokens       mint → returns the RAW token ONCE (stores sha256+last4)
//   DELETE /scim-tokens/:id   revoke (hard delete — the hash is worthless alone)

const crypto = require('crypto');
const prisma = require('../../core/lib/prisma');
const { encrypt } = require('../../core/lib/crypto');
const { writeAudit } = require('../../core/lib/audit');
const { hashKey } = require('../../core/lib/publicApi');
const { connectionConfigured } = require('../../core/lib/sso');
const { certToPem, spEntityId, acsUrl } = require('../../core/lib/sso/saml');
const { discoverIssuer } = require('../../core/lib/sso/oidc');
const { resolveApiBaseUrl } = require('../../core/utils/apiBaseUrl');

const PROTOCOLS = new Set(['SAML', 'OIDC']);
const TARGETS = new Set(['ESS', 'OPERATOR', 'BOTH']);

// The write-only projection: strip ciphertext, expose presence booleans + the
// derived SP endpoints the tenant pastes into their IdP.
function project(conn, slug) {
  if (!conn) return null;
  const {
    clientSecretEnc, spPrivateKeyEnc, ...rest
  } = conn;
  return {
    ...rest,
    hasClientSecret: Boolean(clientSecretEnc),
    hasSpPrivateKey: Boolean(spPrivateKeyEnc),
    configured: connectionConfigured(conn),
    // Copy-paste endpoints for the IdP side.
    endpoints: slug ? {
      status: `${resolveApiBaseUrl()}/sso/${slug}/status`,
      login: `${resolveApiBaseUrl()}/sso/${slug}/login`,
      oidcRedirectUri: `${resolveApiBaseUrl()}/sso/${slug}/callback`,
      samlMetadataUrl: spEntityId(slug),
      samlEntityId: spEntityId(slug),
      samlAcsUrl: acsUrl(slug),
      scimBaseUrl: `${resolveApiBaseUrl()}/scim/v2`,
    } : undefined,
  };
}

async function tenantSlug(businessId) {
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { slug: true } });
  return biz ? biz.slug : null;
}

// ── GET /connection ─────────────────────────────────────────────────
async function getConnection(req, res) {
  const businessId = req.user.businessId;
  const [conn, slug] = await Promise.all([
    prisma.ssoConnection.findUnique({ where: { businessId } }),
    tenantSlug(businessId),
  ]);
  res.json({ connection: project(conn, slug) });
}

// ── PUT /connection (upsert; secrets write-only) ────────────────────
async function putConnection(req, res) {
  const businessId = req.user.businessId;
  const b = req.body || {};

  const protocol = String(b.protocol || '').toUpperCase();
  if (!PROTOCOLS.has(protocol)) {
    return res.status(400).json({ message: 'protocol must be SAML or OIDC' });
  }
  const loginTarget = b.loginTarget === undefined ? undefined : String(b.loginTarget).toUpperCase();
  if (loginTarget !== undefined && !TARGETS.has(loginTarget)) {
    return res.status(400).json({ message: 'loginTarget must be ESS, OPERATOR or BOTH' });
  }
  if (protocol === 'OIDC' && !(b.issuerUrl && b.clientId)) {
    return res.status(400).json({ message: 'OIDC requires issuerUrl and clientId' });
  }
  if (protocol === 'SAML') {
    if (!(b.idpSsoUrl && b.idpCertPem)) {
      return res.status(400).json({ message: 'SAML requires idpSsoUrl and idpCertPem' });
    }
    try {
      // Parse sanity BEFORE persisting — a broken cert bricks every login.
      new crypto.X509Certificate(certToPem(b.idpCertPem)); // eslint-disable-line no-new
    } catch (e) {
      return res.status(422).json({ message: `idpCertPem is not a valid X.509 certificate: ${e.message}` });
    }
  }
  if (b.jitDefaultDepartmentId) {
    const dept = await prisma.department.findFirst({
      where: { id: String(b.jitDefaultDepartmentId), businessId },
      select: { id: true },
    });
    if (!dept) return res.status(400).json({ message: 'jitDefaultDepartmentId does not exist in this tenant' });
  }

  const common = {
    protocol,
    isActive: b.isActive === undefined ? true : b.isActive === true,
    displayName: b.displayName !== undefined ? (b.displayName || null) : undefined,
    loginTarget,
    issuerUrl: b.issuerUrl !== undefined ? (b.issuerUrl || null) : undefined,
    clientId: b.clientId !== undefined ? (b.clientId || null) : undefined,
    scopes: b.scopes !== undefined ? (String(b.scopes || '').trim() || 'openid email profile') : undefined,
    idpEntityId: b.idpEntityId !== undefined ? (b.idpEntityId || null) : undefined,
    idpSsoUrl: b.idpSsoUrl !== undefined ? (b.idpSsoUrl || null) : undefined,
    idpCertPem: b.idpCertPem !== undefined ? (b.idpCertPem || null) : undefined,
    wantAssertionsSigned: b.wantAssertionsSigned === undefined ? undefined : b.wantAssertionsSigned !== false,
    jitProvision: b.jitProvision === undefined ? undefined : b.jitProvision === true,
    jitDefaultDepartmentId: b.jitDefaultDepartmentId !== undefined ? (b.jitDefaultDepartmentId || null) : undefined,
    attributeMapJson: b.attributeMapJson !== undefined ? (b.attributeMapJson || null) : undefined,
  };
  // Secrets: undefined → keep; null/'' → clear; a string → encrypt-at-rest.
  if (b.clientSecret !== undefined) {
    common.clientSecretEnc = b.clientSecret ? encrypt(String(b.clientSecret)) : null;
  }
  if (b.spPrivateKey !== undefined) {
    common.spPrivateKeyEnc = b.spPrivateKey ? encrypt(String(b.spPrivateKey)) : null;
  }
  // Drop undefineds so upsert-update leaves omitted columns untouched.
  const update = Object.fromEntries(Object.entries(common).filter(([, v]) => v !== undefined));

  const conn = await prisma.ssoConnection.upsert({
    where: { businessId },
    update,
    create: {
      businessId,
      protocol,
      isActive: update.isActive !== undefined ? update.isActive : true,
      displayName: update.displayName || null,
      loginTarget: loginTarget || 'ESS',
      issuerUrl: update.issuerUrl || null,
      clientId: update.clientId || null,
      clientSecretEnc: update.clientSecretEnc || null,
      scopes: update.scopes || 'openid email profile',
      idpEntityId: update.idpEntityId || null,
      idpSsoUrl: update.idpSsoUrl || null,
      idpCertPem: update.idpCertPem || null,
      spPrivateKeyEnc: update.spPrivateKeyEnc || null,
      wantAssertionsSigned: update.wantAssertionsSigned !== undefined ? update.wantAssertionsSigned : true,
      jitProvision: update.jitProvision === true,
      jitDefaultDepartmentId: update.jitDefaultDepartmentId || null,
      attributeMapJson: update.attributeMapJson || null,
    },
  });

  await writeAudit({
    businessId,
    actorId: req.user.id,
    action: 'sso.connection.upsert',
    entityType: 'SsoConnection',
    entityId: conn.id,
    meta: {
      protocol: conn.protocol,
      isActive: conn.isActive,
      loginTarget: conn.loginTarget,
      jitProvision: conn.jitProvision,
      secretRotated: b.clientSecret !== undefined || b.spPrivateKey !== undefined,
    },
  });

  res.json({ connection: project(conn, await tenantSlug(businessId)) });
}

// ── POST /connection/test ───────────────────────────────────────────
async function testConnection(req, res) {
  const businessId = req.user.businessId;
  const conn = await prisma.ssoConnection.findUnique({ where: { businessId } });
  if (!conn) return res.status(404).json({ ok: false, message: 'No SSO connection is configured yet' });

  if (conn.protocol === 'OIDC') {
    try {
      const issuer = await discoverIssuer(conn.issuerUrl, { force: true });
      return res.json({
        ok: true,
        protocol: 'OIDC',
        issuer: issuer.metadata.issuer,
        authorizationEndpoint: issuer.metadata.authorization_endpoint,
        tokenEndpoint: issuer.metadata.token_endpoint,
      });
    } catch (e) {
      return res.status(422).json({ ok: false, protocol: 'OIDC', message: e.message });
    }
  }
  // SAML — parse the IdP cert and report validity window.
  try {
    const cert = new crypto.X509Certificate(certToPem(conn.idpCertPem));
    return res.json({
      ok: true,
      protocol: 'SAML',
      certSubject: cert.subject,
      certIssuer: cert.issuer,
      certValidTo: cert.validTo,
      idpSsoUrl: conn.idpSsoUrl,
    });
  } catch (e) {
    return res.status(422).json({ ok: false, protocol: 'SAML', message: `IdP certificate is not parseable: ${e.message}` });
  }
}

// ── DELETE /connection ──────────────────────────────────────────────
async function deleteConnection(req, res) {
  const businessId = req.user.businessId;
  const conn = await prisma.ssoConnection.findUnique({ where: { businessId } });
  if (!conn) return res.status(404).json({ message: 'No SSO connection to delete' });
  await prisma.ssoConnection.delete({ where: { businessId } });
  await writeAudit({
    businessId,
    actorId: req.user.id,
    action: 'sso.connection.delete',
    entityType: 'SsoConnection',
    entityId: conn.id,
    meta: { protocol: conn.protocol },
  });
  res.json({ deleted: true });
}

// ── SCIM tokens ─────────────────────────────────────────────────────
const TOKEN_SELECT = {
  id: true, name: true, last4: true, isActive: true, lastUsedAt: true, createdByUserId: true, createdAt: true,
};

async function listScimTokens(req, res) {
  const tokens = await prisma.scimToken.findMany({
    where: { businessId: req.user.businessId },
    select: TOKEN_SELECT,
    orderBy: { createdAt: 'desc' },
  });
  res.json({ tokens });
}

async function createScimToken(req, res) {
  const businessId = req.user.businessId;
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ message: 'name is required' });

  const raw = `scim_${crypto.randomBytes(32).toString('hex')}`;
  const token = await prisma.scimToken.create({
    data: {
      businessId,
      name,
      tokenHash: hashKey(raw),
      last4: raw.slice(-4),
      createdByUserId: req.user.id,
    },
    select: TOKEN_SELECT,
  });
  await writeAudit({
    businessId,
    actorId: req.user.id,
    action: 'sso.scimToken.create',
    entityType: 'ScimToken',
    entityId: token.id,
    meta: { name, last4: token.last4 },
  });
  // The RAW token is returned exactly ONCE — only the sha256 is stored.
  res.status(201).json({ token: { ...token, raw } });
}

async function deleteScimToken(req, res) {
  const businessId = req.user.businessId;
  const token = await prisma.scimToken.findFirst({
    where: { id: req.params.id, businessId },
    select: { id: true, name: true, last4: true },
  });
  if (!token) return res.status(404).json({ message: 'Token not found' });
  await prisma.scimToken.delete({ where: { id: token.id } });
  await writeAudit({
    businessId,
    actorId: req.user.id,
    action: 'sso.scimToken.delete',
    entityType: 'ScimToken',
    entityId: token.id,
    meta: { name: token.name, last4: token.last4 },
  });
  res.json({ deleted: true });
}

module.exports = {
  getConnection,
  putConnection,
  testConnection,
  deleteConnection,
  listScimTokens,
  createScimToken,
  deleteScimToken,
  _internals: { project },
};
