// AI content generation — Claude-powered marketing copy for tenants.
//
// Generates product descriptions, SEO meta (title/description), and blog
// outlines on demand. Talks to Claude through one of two providers, chosen by
// the AI_PROVIDER env var:
//   • "bedrock"  (default) — Amazon Bedrock via @anthropic-ai/bedrock-sdk.
//                Credentials come from the standard AWS chain (instance role on
//                the box, env vars / profile locally). Region from BEDROCK_REGION
//                or AWS_REGION. No API key needed — auth is AWS IAM.
//   • "anthropic"          — first-party Claude API via @anthropic-ai/sdk,
//                authed with ANTHROPIC_API_KEY.
// When the chosen provider isn't configured, the endpoint reports "not
// configured" (503) instead of failing hard, so the rest of the app is fine.
//
// Bedrock model IDs are NOT the first-party strings — they're inference-profile
// IDs (verified live in ap-south-1, 2026-06-04). The newest models are only
// reachable via "global.anthropic.*" profiles, and each requires model access
// to be GRANTED in the Bedrock console (an ungranted model 403s). On this
// account Opus 4.8 / 4.7 are NOT granted; Opus 4.6, Sonnet 4.6 and Haiku 4.5
// are. Default below is Sonnet 4.6 (global.anthropic.claude-sonnet-4-6) —
// granted and a strong balance of quality and cost. Override with
// AI_CONTENT_MODEL (e.g. global.anthropic.claude-haiku-4-5-20251001-v1:0 to cut
// cost on high volume).
//
// Design notes:
//   • One frozen system prompt (cacheable prefix) + per-request volatile input
//     in the user turn — correct prompt-caching hygiene. Caching only engages
//     once the system prefix exceeds the model's minimum cacheable size
//     (~4096 tokens); below that it silently no-ops (no error), so the
//     cache_control marker is forward-safe rather than a guarantee. (Verified
//     accepted by Bedrock with cache_creation_input_tokens: 0 below the min.)
//   • Structured output via output_config.format (a JSON Schema) — verified
//     working on Bedrock. The model is constrained to emit valid JSON matching
//     the schema (no markdown fences, no prose to parse, no leaked reasoning),
//     so thinking is disabled for speed + cost.
'use strict';

const PROVIDER = (process.env.AI_PROVIDER || 'bedrock').toLowerCase();

// Per-provider default model — Sonnet 4.6 (operator's choice). On Bedrock this
// is the granted, working "global.anthropic.claude-sonnet-4-6" inference
// profile; on the first-party API it's "claude-sonnet-4-6". Override via
// AI_CONTENT_MODEL.
const DEFAULT_MODEL = PROVIDER === 'anthropic'
  ? 'claude-sonnet-4-6'
  : 'global.anthropic.claude-sonnet-4-6';
const MODEL = process.env.AI_CONTENT_MODEL || DEFAULT_MODEL;

const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';

// Optional credential override for Bedrock. The box loads .env (incl.
// AWS_ACCESS_KEY_ID for SES) into process.env, and the AWS credential chain
// prefers those env keys — which auth as an IAM user NOT granted Bedrock. Set
// BEDROCK_CREDENTIALS=instance on the box so the Bedrock client uses the EC2
// instance role (sp-ec2-ssm, which holds the SitepressoBedrockInvoke policy)
// via IMDS, bypassing the env keys. Leave unset locally to use the default
// chain (shared profile / env / role).
const BEDROCK_CREDENTIALS = (process.env.BEDROCK_CREDENTIALS || '').toLowerCase();

// Generous-enough ceiling for short marketing copy (longest output is a blog
// outline). Well under the streaming threshold, so a plain (non-streamed)
// request is fine and simpler.
const MAX_TOKENS = 2048;

function isConfigured() {
  if (PROVIDER === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
  // Bedrock: assume IAM creds come from the AWS chain (instance role / env /
  // profile). We can't probe the chain cheaply/synchronously, so treat a
  // resolvable region as "configured"; a missing/again-denied credential
  // surfaces as a clean 401/403 at call time.
  return Boolean(BEDROCK_REGION);
}

let _client = null;
function getClient() {
  if (!isConfigured()) return null;
  if (_client) return _client;
  if (PROVIDER === 'anthropic') {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  } else {
    const { AnthropicBedrock } = require('@anthropic-ai/bedrock-sdk');
    const opts = { awsRegion: BEDROCK_REGION };
    if (BEDROCK_CREDENTIALS === 'instance') {
      // Force EC2 instance-role creds via IMDS, ignoring the .env AWS keys.
      const { fromInstanceMetadata } = require('@aws-sdk/credential-providers');
      const provider = fromInstanceMetadata();
      opts.providerChainResolver = () => Promise.resolve(provider);
    }
    _client = new AnthropicBedrock(opts);
  }
  return _client;
}

function aiError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// Trim + clamp a free-text field so a tenant can't blow up token cost (and to
// keep the prompt prefix-stable in shape). Returns '' for non-strings.
function clampText(value, max = 1500) {
  if (value == null) return '';
  return String(value).trim().slice(0, max);
}

// Clamp a list of short strings (keywords, features).
function clampList(value, maxItems = 12, maxLen = 80) {
  if (!Array.isArray(value)) {
    // Allow a comma-separated string too.
    if (typeof value === 'string' && value.trim()) {
      value = value.split(',');
    } else {
      return [];
    }
  }
  return value
    .map((v) => clampText(v, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

// ── Frozen system prompt (cacheable prefix) ──────────────────────────────────
// Stable across every request. Volatile per-request content (business name,
// product details, topic) goes in the user turn, never here.
const SYSTEM_PROMPT = `You are the in-house marketing copywriter for businesses using Sitepresso, a website builder. You write short, high-converting marketing copy for small-business storefronts: product descriptions, SEO metadata, and blog outlines.

House rules — follow these for every task:
- Write in clear, natural, benefit-led prose. No buzzword soup, no "unlock", no "elevate", no "in today's fast-paced world", no emoji unless the requested tone explicitly calls for it.
- Match the requested tone exactly. Tones: "professional" (confident, precise), "friendly" (warm, conversational), "luxury" (refined, understated, aspirational), "playful" (lively, lightly humorous), "minimal" (spare, plain, no adjectives stacked).
- Honour the business name and any audience/region the user gives. Reflect the product category in your word choices.
- NEVER invent specific facts the user did not provide: no prices, no dimensions, no materials, no ingredients, no certifications, no shipping promises, no review counts, no awards. Write around what you are given. If a detail would normally appear but wasn't supplied, keep the copy general rather than fabricating it.
- Write in the language/locale the user specifies; default to English (US) when none is given.
- Output ONLY the JSON the schema requires. Do not add commentary, markdown, or explanations.

SEO rules (for the seo_meta task):
- metaTitle: <= 60 characters, lead with the primary keyword or product name, append a short brand/value cue. No clickbait, no ALL CAPS.
- metaDescription: 140-155 characters, one or two sentences, include a soft call to action, naturally include the primary keyword once. Never keyword-stuff.

Product description rules (for the product_description task):
- title: a clean, scannable product title (you may lightly refine the given name; do not add specs you weren't given).
- shortDescription: a single sentence (~120 characters) for listing cards.
- description: 2 to 4 short plain-text paragraphs of body copy. Lead with the benefit, then supporting detail. Plain text only — no markdown.
- bullets: 3 to 5 concise, benefit-led feature lines (not full sentences, no trailing punctuation), each grounded in a detail the user provided.

Blog outline rules (for the blog_outline task):
- title: a compelling, specific post title (not generic).
- metaDescription: a 140-155 character SEO description for the post.
- sections: 4 to 7 sections, each with a clear heading and 2 to 4 bullet points describing what that section will cover. This is an outline, not the finished article — points are talking points, not paragraphs.`;

// ── Per-type configuration: JSON Schema + user-prompt builder ────────────────
// Each schema is a strict JSON Schema (additionalProperties:false everywhere,
// no min/max constraints — structured outputs reject those). Length/shape
// guidance lives in the prompt instead.

const TYPES = {
  product_description: {
    label: 'product description',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Polished product title' },
        shortDescription: { type: 'string', description: 'One-sentence summary (~120 chars) for listing cards' },
        description: { type: 'string', description: '2-4 short plain-text paragraphs of body copy' },
        bullets: {
          type: 'array',
          description: '3-5 benefit-led feature lines',
          items: { type: 'string' },
        },
      },
      required: ['title', 'shortDescription', 'description', 'bullets'],
    },
    buildPrompt({ input, businessName, vertical, locale }) {
      const name = clampText(input.name || input.title, 200);
      if (!name) throw aiError('A product name is required.', 400, 'missing_input');
      const lines = [
        'Write a product description.',
        `Business: ${businessName || 'a small business'}${vertical ? ` (${vertical.toLowerCase()})` : ''}.`,
        `Product name: ${name}.`,
      ];
      if (input.category) lines.push(`Category: ${clampText(input.category, 120)}.`);
      const keywords = clampList(input.keywords);
      if (keywords.length) lines.push(`Keywords to weave in naturally: ${keywords.join(', ')}.`);
      const features = clampList(input.features, 12, 160);
      if (features.length) lines.push(`Known features/details (use only these — invent nothing): ${features.join('; ')}.`);
      if (input.audience) lines.push(`Target audience: ${clampText(input.audience, 200)}.`);
      lines.push(`Tone: ${normalizeTone(input.tone)}.`);
      if (locale) lines.push(`Language/locale: ${clampText(locale, 20)}.`);
      return lines.join('\n');
    },
  },

  seo_meta: {
    label: 'SEO metadata',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        metaTitle: { type: 'string', description: 'SEO title tag, <= 60 characters' },
        metaDescription: { type: 'string', description: 'Meta description, 140-155 characters' },
      },
      required: ['metaTitle', 'metaDescription'],
    },
    buildPrompt({ input, businessName, vertical, locale }) {
      const subject = clampText(input.title || input.name || input.pageName, 200);
      if (!subject) throw aiError('A page title or name is required.', 400, 'missing_input');
      const lines = [
        'Write SEO metadata (title tag + meta description) for this page.',
        `Business: ${businessName || 'a small business'}${vertical ? ` (${vertical.toLowerCase()})` : ''}.`,
        `Page / subject: ${subject}.`,
      ];
      if (input.context) lines.push(`What the page is about: ${clampText(input.context, 1500)}.`);
      const keywords = clampList(input.keywords);
      if (keywords.length) lines.push(`Primary keywords: ${keywords.join(', ')}.`);
      if (locale) lines.push(`Language/locale: ${clampText(locale, 20)}.`);
      return lines.join('\n');
    },
  },

  blog_outline: {
    label: 'blog outline',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Compelling, specific post title' },
        metaDescription: { type: 'string', description: 'SEO description for the post, 140-155 characters' },
        sections: {
          type: 'array',
          description: '4-7 outline sections',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              heading: { type: 'string', description: 'Section heading' },
              points: {
                type: 'array',
                description: '2-4 talking points for this section',
                items: { type: 'string' },
              },
            },
            required: ['heading', 'points'],
          },
        },
      },
      required: ['title', 'metaDescription', 'sections'],
    },
    buildPrompt({ input, businessName, vertical, locale }) {
      const topic = clampText(input.topic || input.title, 300);
      if (!topic) throw aiError('A blog topic is required.', 400, 'missing_input');
      const lines = [
        'Write a blog post outline.',
        `Business: ${businessName || 'a small business'}${vertical ? ` (${vertical.toLowerCase()})` : ''}.`,
        `Topic: ${topic}.`,
      ];
      const keywords = clampList(input.keywords);
      if (keywords.length) lines.push(`Target keywords: ${keywords.join(', ')}.`);
      if (input.audience) lines.push(`Target audience: ${clampText(input.audience, 200)}.`);
      lines.push(`Tone: ${normalizeTone(input.tone)}.`);
      if (locale) lines.push(`Language/locale: ${clampText(locale, 20)}.`);
      return lines.join('\n');
    },
  },
};

const VALID_TONES = new Set(['professional', 'friendly', 'luxury', 'playful', 'minimal']);
function normalizeTone(tone) {
  const t = String(tone || '').trim().toLowerCase();
  return VALID_TONES.has(t) ? t : 'professional';
}

function supportedTypes() {
  return Object.keys(TYPES);
}

// Generate content. Returns { result, usage, model, truncated }.
// Throws an error with `.status`/`.code` on configuration / validation /
// upstream failures so the controller can map it to an HTTP response.
async function generate({ type, input = {}, businessName, vertical, locale }) {
  const client = getClient();
  if (!client) {
    throw aiError('AI content generation is not configured on this server.', 503, 'ai_not_configured');
  }
  const cfg = TYPES[type];
  if (!cfg) {
    throw aiError(`Unknown generation type "${type}".`, 400, 'unknown_type');
  }

  const userPrompt = cfg.buildPrompt({ input, businessName, vertical, locale });

  let resp;
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Short copy — no extended reasoning needed; disabling it cuts latency
      // and cost. Structured output guarantees the response is clean JSON, so
      // there's no risk of reasoning leaking into the visible answer.
      thinking: { type: 'disabled' },
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      output_config: { format: { type: 'json_schema', schema: cfg.schema } },
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    // Map upstream failures to clean, actionable errors.
    const s = err?.status;
    if (s === 401) {
      throw aiError('The AI provider rejected the credentials (bad API key / AWS auth).', 503, 'ai_auth_failed');
    }
    if (s === 403 || s === 404) {
      // Bedrock: the model isn't granted for this account, or the inference
      // profile ID is wrong for this region.
      throw aiError(
        `The configured AI model ("${MODEL}") is not available to this account/region. Grant model access in the Bedrock console or set AI_CONTENT_MODEL to a granted model.`,
        503,
        'ai_model_unavailable',
      );
    }
    if (s === 429) {
      throw aiError('The AI provider is rate-limiting requests. Please retry shortly.', 429, 'ai_rate_limited');
    }
    throw aiError('The AI provider is temporarily unavailable. Please retry.', 502, 'ai_upstream_error');
  }

  if (resp.stop_reason === 'refusal') {
    throw aiError('The request was declined by the content-safety system. Try rephrasing.', 422, 'ai_refusal');
  }

  const text = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw aiError('The AI returned malformed output. Please retry.', 502, 'ai_bad_output');
  }

  return {
    result,
    usage: resp.usage || null,
    model: resp.model || MODEL,
    truncated: resp.stop_reason === 'max_tokens',
  };
}

module.exports = {
  isConfigured,
  generate,
  supportedTypes,
  MODEL,
  PROVIDER,
};
