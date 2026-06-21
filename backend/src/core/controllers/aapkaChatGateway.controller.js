const {
  CHAT_ACTOR_ROLES,
  CHAT_CONTEXTS,
  HELP_ARTICLES,
  buildActionCatalog,
  buildBootstrapConfig,
  buildIntegrationConfig,
  normalizeActorRole,
  normalizeContext,
  normalizeKey,
} = require('../../../../packages/chat-v2-shared');
const support = require('./support.controller');
const { answerWithKnowledge } = require('../lib/aapkaChatAi');
const { ROLES } = require('../lib/roles');

function cleanText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function actorRoleFromUser(user, fallback) {
  if (!user) return fallback || CHAT_ACTOR_ROLES.VISITOR;
  if (user.role === ROLES.SUPER_ADMIN) return CHAT_ACTOR_ROLES.SUPER_ADMIN;
  if (user.role === ROLES.BUSINESS_ADMIN) return CHAT_ACTOR_ROLES.OWNER;
  if (user.role === ROLES.STAFF) return CHAT_ACTOR_ROLES.STAFF;
  return fallback || CHAT_ACTOR_ROLES.VISITOR;
}

function trainingArticles() {
  return Object.entries(HELP_ARTICLES || {}).map(([key, article]) => ({
    key,
    title: article.title,
    targetSection: article.targetSection || null,
    aliases: article.aliases || [],
    lines: article.lines || [],
  }));
}

function tenantSlugFrom(req) {
  const explicit = cleanText(req.body?.tenantSlug || req.query?.tenantSlug || req.params?.tenantSlug, 120);
  if (explicit) return normalizeKey(explicit, 'store');
  const installation = cleanText(req.body?.installation || req.body?.installationId || req.query?.installation || req.query?.installationId, 160);
  if (!installation) return 'store';
  const clean = normalizeKey(installation, 'store');
  if (clean.startsWith('storefront-')) return clean.slice('storefront-'.length) || 'store';
  if (clean.startsWith('sitepresso-')) {
    return clean
      .replace(/^sitepresso-/, '')
      .replace(/-(admin|admin-portal|storefront|support|customer)$/, '') || 'store';
  }
  return clean;
}

function integrationFor(req, overrides = {}) {
  const context = normalizeContext(
    overrides.context || req.query?.context || req.body?.context,
    CHAT_CONTEXTS.STOREFRONT,
  );
  const isAdmin = context === CHAT_CONTEXTS.ADMIN_PORTAL || context === CHAT_CONTEXTS.SUPER_ADMIN;
  const actorRole = normalizeActorRole(
    overrides.actorRole || req.query?.actorRole || req.body?.actorRole,
    actorRoleFromUser(req.user, isAdmin ? CHAT_ACTOR_ROLES.STAFF : CHAT_ACTOR_ROLES.VISITOR),
  );
  return buildIntegrationConfig({
    provider: 'sitepresso',
    projectKey: 'sitepresso',
    tenantSlug: tenantSlugFrom(req),
    context,
    actorRole,
    mode: isAdmin ? 'admin' : 'support',
    capabilities: isAdmin
      ? ['action_catalog', 'safe_drafts', 'diagnostics', 'support_ticket']
      : ['self_help', 'support_ticket'],
    actionBridge: {
      enabled: isAdmin,
      executionMode: 'browser_callback',
      endpoint: '/v1/actions',
    },
    supportBridge: {
      enabled: !isAdmin,
      executionMode: 'browser_callback',
      endpoint: '/v1/support',
    },
    training: {
      version: 'sitepresso-setup-v1',
      updatedAt: '2026-06-08',
      articles: trainingArticles(),
      actionPolicy: 'Preview first. Sitepresso executes mutations only after explicit approval and permission checks.',
    },
  });
}

function bootstrap(req, res) {
  const workspace = normalizeKey(req.query?.workspace || req.query?.workspaceId || 'sitepresso');
  const installation = normalizeKey(req.query?.installation || req.query?.installationId || 'web');
  const context = normalizeContext(req.query?.context, CHAT_CONTEXTS.STOREFRONT);
  const isAdmin = context === CHAT_CONTEXTS.ADMIN_PORTAL || context === CHAT_CONTEXTS.SUPER_ADMIN;
  const integration = integrationFor(req, { context });
  res.json(buildBootstrapConfig({
    workspace,
    workspaceName: 'Sitepresso',
    installation,
    brandColor: isAdmin ? '#16a34a' : '#1F8A4C',
    launcherPosition: 'right',
    welcomeMessage: isAdmin
      ? 'Ask me where to go, how to set something up, or ask me to draft a safe action.'
      : 'Ask about orders, delivery, pickup, refunds, products, or contact the store team.',
    features: {
      guidedFlowEnabled: false,
      allowFileTransfer: false,
    },
    integration,
  }));
}

function manifest(req, res) {
  const integration = integrationFor(req, {
    context: req.query?.context || CHAT_CONTEXTS.ADMIN_PORTAL,
  });
  res.json({
    product: 'AapkaChat',
    customer: 'Sitepresso',
    workspace: 'sitepresso',
    integration,
    catalog: buildActionCatalog({
      context: integration.context,
      actorRole: integration.actorRole,
    }),
  });
}

function register(req, res) {
  const integration = integrationFor(req, {
    context: req.body?.context || CHAT_CONTEXTS.ADMIN_PORTAL,
    actorRole: actorRoleFromUser(req.user, CHAT_ACTOR_ROLES.OWNER),
  });
  res.status(201).json({
    ok: true,
    workspace: normalizeKey(req.body?.workspace || 'sitepresso'),
    installation: normalizeKey(req.body?.installation || `sitepresso-${integration.tenantSlug}-${integration.mode}`),
    integration,
    message: 'Sitepresso installation registered with AapkaChat action and support metadata.',
  });
}

function withSupportParams(req, slug) {
  const original = req.params;
  req.params = {
    ...original,
    projectKey: 'shop',
    slug,
  };
  return () => { req.params = original; };
}

async function answerSelfHelp(req, res) {
  const restore = withSupportParams(req, tenantSlugFrom(req));
  try {
    return await support.answerPublicSelfHelp(req, res);
  } finally {
    restore();
  }
}

async function createSupportConversation(req, res) {
  const restore = withSupportParams(req, tenantSlugFrom(req));
  try {
    return await support.createPublicCustomerConversation(req, res);
  } finally {
    restore();
  }
}

async function answerKnowledge(req, res) {
  const integration = integrationFor(req, {
    context: req.body?.context || req.query?.context,
    actorRole: req.body?.actorRole || req.query?.actorRole,
  });
  const result = await answerWithKnowledge({
    query: cleanText(req.body?.query || req.body?.message || req.query?.query, 1000),
    context: integration.context,
    tenantSlug: integration.tenantSlug,
    integration,
  });
  res.json(result);
}

module.exports = {
  bootstrap,
  manifest,
  register,
  answerKnowledge,
  answerSelfHelp,
  createSupportConversation,
};
