const crypto = require('crypto');
const prisma = require('../lib/prisma');
const {
  CHAT_CHANNELS,
  CHAT_PROJECTS,
  DEFAULT_SELF_HELP,
  answerSelfHelp,
  normalizeChannel,
  normalizeProjectKey,
} = require('../../lib/chat-core');
const chatBus = require('../lib/supportEventBus');

const KIND_PLATFORM = 'PLATFORM_SUPPORT';
const KIND_CUSTOMER = 'WEBSITE_CUSTOMER';

const PROJECT_BY_KIND = {
  [KIND_PLATFORM]: CHAT_PROJECTS.SITEPRESSO,
  [KIND_CUSTOMER]: CHAT_PROJECTS.SHOP,
};

function cleanText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function requestProjectKey(req, fallback) {
  return normalizeProjectKey(req.params?.projectKey || req.body?.projectKey || req.query?.projectKey, fallback);
}

function requestChannel(req, fallback) {
  return normalizeChannel(req.params?.channel || req.body?.channel || req.query?.channel, fallback);
}

function requestSourceUrl(req) {
  const explicit = cleanText(req.body?.sourceUrl || req.query?.sourceUrl, 500);
  if (explicit) return explicit;
  return cleanText(req.get?.('referer'), 500) || null;
}

function mapMessage(message, publicView = false) {
  if (!message) return message;
  const base = {
    id: message.id,
    senderType: message.senderType,
    senderName: message.senderName,
    body: message.body,
    createdAt: message.createdAt,
  };
  if (publicView) return base;
  return {
    ...base,
    senderEmail: message.senderEmail,
    userId: message.userId,
    customerId: message.customerId,
    metadata: message.metadata,
  };
}

function publicConversation(conversation, options = {}) {
  if (!conversation) return null;
  const publicView = !!options.publicView;
  return {
    id: conversation.id,
    kind: conversation.kind,
    projectKey: conversation.projectKey || PROJECT_BY_KIND[conversation.kind] || CHAT_PROJECTS.SITEPRESSO,
    channel: conversation.channel || (conversation.kind === KIND_PLATFORM ? CHAT_CHANNELS.TENANT_SUPPORT : CHAT_CHANNELS.CUSTOMER_SUPPORT),
    sourceUrl: publicView ? undefined : conversation.sourceUrl,
    status: conversation.status,
    subject: conversation.subject,
    visitorName: conversation.visitorName,
    visitorEmail: publicView ? null : conversation.visitorEmail,
    lastMessageAt: conversation.lastMessageAt,
    createdAt: conversation.createdAt,
    business: conversation.business,
    customer: publicView ? undefined : conversation.customer,
    messages: (conversation.messages || []).map((message) => mapMessage(message, publicView)),
  };
}

function supportTopicsForBusiness(business) {
  const name = business?.name || 'the store';
  return DEFAULT_SELF_HELP.map((article) => {
    if (article.id !== 'orders') return article;
    return {
      ...article,
      answer: `You can track recent orders from My account > My orders. Open an order to see its current status, payment state, delivery or pickup method, and order items. If the status looks wrong, ${name} can review it from their admin inbox.`,
    };
  });
}

async function createMessage(tx, conversation, data) {
  const message = await tx.supportMessage.create({
    data: {
      conversationId: conversation.id,
      businessId: conversation.businessId,
      senderType: data.senderType,
      userId: data.userId || null,
      customerId: data.customerId || null,
      senderName: data.senderName || null,
      senderEmail: data.senderEmail || null,
      body: data.body,
      metadata: data.metadata || undefined,
    },
  });
  await tx.supportConversation.update({
    where: { id: conversation.id },
    data: {
      status: conversation.status === 'CLOSED' ? 'OPEN' : conversation.status,
      lastMessageAt: message.createdAt,
      ...(data.senderType === 'PLATFORM_ADMIN' ? { platformReadAt: message.createdAt } : {}),
      ...(data.senderType === 'TENANT_USER' ? { tenantReadAt: message.createdAt } : {}),
      ...(['CUSTOMER', 'VISITOR'].includes(data.senderType) ? { visitorReadAt: message.createdAt } : {}),
    },
  });
  setImmediate(() => {
    const publicPayload = {
      conversationId: conversation.id,
      message: mapMessage(message, true),
    };
    chatBus.publish(chatBus.roomConversation(conversation.id), 'message.created', publicPayload);
    if (conversation.kind === KIND_CUSTOMER) {
      chatBus.publish(chatBus.roomBusinessCustomer(conversation.businessId), 'message.created', {
        conversationId: conversation.id,
        message: mapMessage(message),
      });
    }
  });
  return message;
}

async function listPlatformForTenant(req, res) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const rows = await prisma.supportConversation.findMany({
    where: { businessId, kind: KIND_PLATFORM },
    orderBy: { lastMessageAt: 'desc' },
    include: { messages: { orderBy: { createdAt: 'asc' }, take: 100 } },
    take: 25,
  });
  res.json({ conversations: rows.map(publicConversation) });
}

async function createPlatformForTenant(req, res) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const body = cleanText(req.body?.body);
  if (!body) return res.status(400).json({ message: 'Message is required' });
  const subject = cleanText(req.body?.subject, 160) || 'Support request';
  const conversation = await prisma.$transaction(async (tx) => {
    const created = await tx.supportConversation.create({
      data: {
        businessId,
        kind: KIND_PLATFORM,
        projectKey: CHAT_PROJECTS.SITEPRESSO,
        channel: CHAT_CHANNELS.TENANT_SUPPORT,
        subject,
        status: 'OPEN',
        tenantReadAt: new Date(),
      },
    });
    await createMessage(tx, created, {
      senderType: 'TENANT_USER',
      userId: req.user.id,
      senderName: req.user.name,
      senderEmail: req.user.email,
      body,
    });
    return tx.supportConversation.findUnique({
      where: { id: created.id },
      include: { messages: { orderBy: { createdAt: 'asc' } }, business: { select: { id: true, name: true, slug: true } } },
    });
  });
  res.status(201).json({ conversation: publicConversation(conversation) });
}

async function replyPlatformForTenant(req, res) {
  const businessId = req.user?.businessId;
  const body = cleanText(req.body?.body);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  if (!body) return res.status(400).json({ message: 'Message is required' });
  const existing = await prisma.supportConversation.findFirst({
    where: { id: req.params.id, businessId, kind: KIND_PLATFORM },
  });
  if (!existing) return res.status(404).json({ message: 'Conversation not found' });
  const message = await prisma.$transaction((tx) => createMessage(tx, existing, {
    senderType: 'TENANT_USER',
    userId: req.user.id,
    senderName: req.user.name,
    senderEmail: req.user.email,
    body,
  }));
  res.status(201).json({ message });
}

async function listPlatformForSuperadmin(req, res) {
  const rows = await prisma.supportConversation.findMany({
    where: { kind: KIND_PLATFORM },
    orderBy: { lastMessageAt: 'desc' },
    include: {
      business: { select: { id: true, name: true, slug: true, email: true } },
      messages: { orderBy: { createdAt: 'asc' }, take: 100 },
    },
    take: 100,
  });
  res.json({ conversations: rows.map(publicConversation) });
}

async function replyPlatformForSuperadmin(req, res) {
  const body = cleanText(req.body?.body);
  if (!body) return res.status(400).json({ message: 'Message is required' });
  const existing = await prisma.supportConversation.findFirst({
    where: { id: req.params.id, kind: KIND_PLATFORM },
  });
  if (!existing) return res.status(404).json({ message: 'Conversation not found' });
  const message = await prisma.$transaction((tx) => createMessage(tx, existing, {
    senderType: 'PLATFORM_ADMIN',
    userId: req.user.id,
    senderName: req.user.name || 'Sitepresso support',
    senderEmail: req.user.email,
    body,
  }));
  res.status(201).json({ message });
}

async function listCustomerForTenant(req, res) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const rows = await prisma.supportConversation.findMany({
    where: { businessId, kind: KIND_CUSTOMER },
    orderBy: { lastMessageAt: 'desc' },
    include: {
      customer: { select: { id: true, name: true, email: true, phone: true } },
      messages: { orderBy: { createdAt: 'asc' }, take: 100 },
    },
    take: 100,
  });
  res.json({ conversations: rows.map(publicConversation) });
}

async function replyCustomerForTenant(req, res) {
  const businessId = req.user?.businessId;
  const body = cleanText(req.body?.body);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  if (!body) return res.status(400).json({ message: 'Message is required' });
  const existing = await prisma.supportConversation.findFirst({
    where: { id: req.params.id, businessId, kind: KIND_CUSTOMER },
  });
  if (!existing) return res.status(404).json({ message: 'Conversation not found' });
  const message = await prisma.$transaction((tx) => createMessage(tx, existing, {
    senderType: 'TENANT_USER',
    userId: req.user.id,
    senderName: req.user.name,
    senderEmail: req.user.email,
    body,
  }));
  res.status(201).json({ message });
}

async function closeCustomerForTenant(req, res) {
  const businessId = req.user?.businessId;
  const updated = await prisma.supportConversation.updateMany({
    where: { id: req.params.id, businessId, kind: KIND_CUSTOMER },
    data: { status: 'CLOSED', closedAt: new Date() },
  });
  if (!updated.count) return res.status(404).json({ message: 'Conversation not found' });
  res.json({ ok: true });
}

async function createPublicCustomerConversation(req, res) {
  const business = await prisma.business.findUnique({
    where: { slug: String(req.params.slug || '').toLowerCase() },
    select: { id: true, name: true, slug: true, isActive: true },
  });
  if (!business || !business.isActive) return res.status(404).json({ message: 'Business not found' });
  const body = cleanText(req.body?.body);
  if (!body) return res.status(400).json({ message: 'Message is required' });
  const visitorName = cleanText(req.body?.visitorName, 120) || 'Website visitor';
  const visitorEmail = cleanText(req.body?.visitorEmail, 200).toLowerCase() || null;
  const visitorPhone = cleanText(req.body?.visitorPhone, 40) || null;
  const visitorToken = crypto.randomBytes(24).toString('hex');
  const conversation = await prisma.$transaction(async (tx) => {
    const created = await tx.supportConversation.create({
      data: {
        businessId: business.id,
        kind: KIND_CUSTOMER,
        projectKey: requestProjectKey(req, CHAT_PROJECTS.SHOP),
        channel: requestChannel(req, CHAT_CHANNELS.CUSTOMER_SUPPORT),
        sourceUrl: requestSourceUrl(req),
        subject: cleanText(req.body?.subject, 160) || 'Website chat',
        visitorName,
        visitorEmail,
        visitorPhone,
        visitorToken,
        status: 'OPEN',
        visitorReadAt: new Date(),
      },
    });
    await createMessage(tx, created, {
      senderType: req.customer ? 'CUSTOMER' : 'VISITOR',
      customerId: req.customer?.id || null,
      senderName: req.customer?.name || visitorName,
      senderEmail: req.customer?.email || visitorEmail,
      body,
    });
    return tx.supportConversation.findUnique({
      where: { id: created.id },
      include: { messages: { orderBy: { createdAt: 'asc' } }, business: { select: { id: true, name: true, slug: true } } },
    });
  });
  res.status(201).json({ conversation: publicConversation(conversation, { publicView: true }), visitorToken });
}

async function getPublicSelfHelp(req, res) {
  const slug = String(req.params.slug || '').toLowerCase();
  const business = await prisma.business.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true, isActive: true },
  });
  if (!business || !business.isActive) return res.status(404).json({ message: 'Business not found' });
  const topics = supportTopicsForBusiness(business);
  res.json({
    projectKey: requestProjectKey(req, CHAT_PROJECTS.SHOP),
    channel: requestChannel(req, CHAT_CHANNELS.CUSTOMER_SUPPORT),
    business,
    topics: topics.map(({ keywords, ...topic }) => topic),
  });
}

async function answerPublicSelfHelp(req, res) {
  const slug = String(req.params.slug || '').toLowerCase();
  const business = await prisma.business.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true, isActive: true },
  });
  if (!business || !business.isActive) return res.status(404).json({ message: 'Business not found' });
  const query = cleanText(req.body?.query || req.query?.query, 600);
  const result = answerSelfHelp(query, supportTopicsForBusiness(business));
  res.json({
    projectKey: requestProjectKey(req, CHAT_PROJECTS.SHOP),
    channel: requestChannel(req, CHAT_CHANNELS.CUSTOMER_SUPPORT),
    query,
    resolved: result.resolved,
    answer: result.answer,
    suggestions: (result.suggestions || []).map(({ keywords, score, ...topic }) => topic),
    canEscalate: true,
  });
}

async function getPublicCustomerConversation(req, res) {
  const token = cleanText(req.query?.token || req.body?.visitorToken, 200);
  const conversation = await prisma.supportConversation.findFirst({
    where: { id: req.params.id, kind: KIND_CUSTOMER, visitorToken: token || '__none__' },
    include: { messages: { orderBy: { createdAt: 'asc' } }, business: { select: { id: true, name: true, slug: true } } },
  });
  if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
  res.json({ conversation: publicConversation(conversation, { publicView: true }) });
}

async function streamPublicCustomerConversation(req, res) {
  const token = cleanText(req.query?.token || req.body?.visitorToken, 200);
  const conversation = await prisma.supportConversation.findFirst({
    where: { id: req.params.id, kind: KIND_CUSTOMER, visitorToken: token || '__none__' },
    select: { id: true },
  });
  if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ conversationId: conversation.id })}\n\n`);

  const unsubscribe = chatBus.subscribe(chatBus.roomConversation(conversation.id), ({ event, payload }) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function replyPublicCustomerConversation(req, res) {
  const token = cleanText(req.body?.visitorToken || req.query?.token, 200);
  const body = cleanText(req.body?.body);
  if (!body) return res.status(400).json({ message: 'Message is required' });
  const existing = await prisma.supportConversation.findFirst({
    where: { id: req.params.id, kind: KIND_CUSTOMER, visitorToken: token || '__none__' },
  });
  if (!existing) return res.status(404).json({ message: 'Conversation not found' });
  const message = await prisma.$transaction((tx) => createMessage(tx, existing, {
    senderType: req.customer ? 'CUSTOMER' : 'VISITOR',
    customerId: req.customer?.id || null,
    senderName: req.customer?.name || existing.visitorName || 'Website visitor',
    senderEmail: req.customer?.email || existing.visitorEmail || null,
    body,
  }));
  res.status(201).json({ message: mapMessage(message, true) });
}

module.exports = {
  listPlatformForTenant,
  createPlatformForTenant,
  replyPlatformForTenant,
  listPlatformForSuperadmin,
  replyPlatformForSuperadmin,
  listCustomerForTenant,
  replyCustomerForTenant,
  closeCustomerForTenant,
  getPublicSelfHelp,
  answerPublicSelfHelp,
  createPublicCustomerConversation,
  getPublicCustomerConversation,
  streamPublicCustomerConversation,
  replyPublicCustomerConversation,
};
