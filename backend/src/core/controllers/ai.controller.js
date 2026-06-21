// AI content generation controller — BUSINESS_ADMIN scope.
//
// POST /api/ai/generate-content — generate a product description, SEO meta, or
// blog outline for the caller's business. Tier-gated (Professional+) via
// assertBooleanFeature('ai_generation'); returns 503 when no ANTHROPIC_API_KEY
// is configured so the rest of the app keeps working without one.
'use strict';

const { z } = require('zod');
const prisma = require('../lib/prisma');
const { assertBooleanFeature } = require('../lib/entitlements');
const aiContent = require('../lib/aiContent');
const { resolveVertical } = require('../lib/vertical');

const bodySchema = z.object({
  type: z.enum(['product_description', 'seo_meta', 'blog_outline']),
  input: z.record(z.string(), z.unknown()).optional(),
});

// GET /api/ai/status — lightweight capability probe for the admin UI so it can
// show/hide the "Generate with AI" buttons without making a paid call.
async function status(req, res) {
  const businessId = req.user?.businessId || null;
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });

  let entitled = false;
  try {
    await assertBooleanFeature({ businessId, key: 'ai_generation', label: 'AI content generation' });
    entitled = true;
  } catch {
    entitled = false;
  }

  res.json({
    configured: aiContent.isConfigured(),
    entitled,
    available: aiContent.isConfigured() && entitled,
    provider: aiContent.PROVIDER,
    model: aiContent.MODEL,
    types: aiContent.supportedTypes(),
  });
}

async function generateContent(req, res) {
  const businessId = req.user?.businessId || null;
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });

  // Tier gate first — never spend an API call for a plan that isn't entitled.
  try {
    await assertBooleanFeature({ businessId, key: 'ai_generation', label: 'AI content generation' });
  } catch (err) {
    return res.status(err.status || 403).json({ message: err.message, code: err.code });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', issues: parsed.error.issues });
  }

  // Resolve business context (name + vertical) to ground the copy.
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true, vertical: true },
  });

  try {
    const out = await aiContent.generate({
      type: parsed.data.type,
      input: parsed.data.input || {},
      businessName: business?.name || null,
      vertical: business?.vertical ? resolveVertical(business.vertical) : null,
      locale: typeof req.body?.locale === 'string' ? req.body.locale : undefined,
    });
    return res.json({
      type: parsed.data.type,
      result: out.result,
      truncated: out.truncated,
      model: out.model,
    });
  } catch (err) {
    if (err.status && err.code) {
      return res.status(err.status).json({ message: err.message, code: err.code });
    }
    // eslint-disable-next-line no-console
    console.error('[ai.generateContent] failed', err?.message || err);
    return res.status(500).json({ message: 'Content generation failed.' });
  }
}

module.exports = { status, generateContent };
