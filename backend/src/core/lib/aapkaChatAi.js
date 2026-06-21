const {
  buildGroundedAnswer,
  buildKnowledgeBundle,
  buildKnowledgePrompt,
  retrieveKnowledge,
} = require('../../../../packages/chat-v2-shared');

function envFirst(names = []) {
  for (const name of names) {
    const value = process.env[name];
    if (String(value || '').trim()) return String(value).trim();
  }
  return '';
}

function aiConfig() {
  return {
    disabled: process.env.AAPKACHAT_AI_DISABLE === '1',
    provider: process.env.AAPKACHAT_AI_PROVIDER || 'gemini',
    apiKey: envFirst(['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_API_KEY']),
    model: process.env.AAPKACHAT_GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    fetch: globalThis.fetch,
  };
}

function parseGeminiText(payload = {}) {
  const parts = payload.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => part.text || '').join('').trim();
}

async function callGemini(prompt, config) {
  if (!config?.apiKey || !config.fetch || config.disabled) return null;
  const model = encodeURIComponent(config.model || 'gemini-2.5-flash');
  const response = await config.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 700,
      },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `Gemini request failed with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return parseGeminiText(data);
}

async function answerWithKnowledge(input = {}) {
  const query = String(input.query || input.message || '').trim();
  const bundle = buildKnowledgeBundle(input.training || input.integration?.training || input.bundle || {});
  const articles = retrieveKnowledge(query, bundle, { limit: input.limit || 4 });
  const fallback = buildGroundedAnswer({
    query,
    articles,
    context: input.context,
    tenantName: input.tenantName || input.tenantSlug,
  });
  if (!fallback.resolved) return fallback;

  const config = aiConfig();
  if (config.provider !== 'gemini' || !config.apiKey || config.disabled) {
    return {
      ...fallback,
      ai: { provider: 'deterministic', model: null, used: false },
    };
  }

  try {
    const prompt = buildKnowledgePrompt({
      query,
      articles,
      context: input.context,
      tenantName: input.tenantName || input.tenantSlug,
    });
    const answer = await callGemini(prompt, config);
    if (!answer) {
      return {
        ...fallback,
        ai: { provider: 'deterministic', model: null, used: false },
      };
    }
    return {
      ...fallback,
      answer,
      provider: 'gemini',
      ai: { provider: 'gemini', model: config.model, used: true },
    };
  } catch (error) {
    return {
      ...fallback,
      ai: {
        provider: 'gemini',
        model: config.model,
        used: false,
        error: error.message || String(error),
      },
    };
  }
}

module.exports = {
  aiConfig,
  callGemini,
  answerWithKnowledge,
};
