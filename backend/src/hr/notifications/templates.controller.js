'use strict';

/**
 * hr/notifications/templates.controller.js — Program P1.6: tenant-editable
 * notification templates.
 *
 *   GET    /notifications/templates       HR-vertical registry ⋈ tenant overrides
 *   PUT    /notifications/templates/:key  upsert the tenant body override
 *   DELETE /notifications/templates/:key  reset to the stock body
 *   POST   /notifications/templates/:key/preview  render a body with sample vars
 *
 * The in-code registry (HR_TEMPLATES + core templates) remains the authority
 * for KEYS and VARIABLES; a tenant override replaces the rendered BODY only.
 * Save-time guard: every {TOKEN} in the override must be a variable the
 * template actually receives — an unknown token would go out literally.
 */

const prisma = require('../../core/lib/prisma');
const { listTemplates, resolveTemplate, substituteVars } = require('../../core/lib/notifications/templates');

const MAX_BODY = 2000;

function tokensOf(body) {
  const out = new Set();
  const re = /\{([A-Za-z0-9_]+)\}/g;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return [...out];
}

async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    // listTemplates('HR') also returns vertical:'ALL' core templates (OTP etc.)
    // — the HR console edits strictly HR-vertical ones.
    const registry = listTemplates({ vertical: 'HR' }).filter((t) => t.vertical === 'HR');
    const overrides = await prisma.tenantMessageTemplate.findMany({ where: { businessId } });
    const byKey = new Map(overrides.map((o) => [o.templateKey, o]));
    const items = registry.map((t) => {
      const o = byKey.get(t.key) || null;
      return {
        key: t.key,
        displayName: t.displayName,
        category: t.category,
        channels: t.channels,
        variables: t.variables,
        defaultBody: t.body,
        overrideBody: o && o.isActive ? o.body : null,
        overridden: !!(o && o.isActive),
        updatedAt: o ? o.updatedAt : null,
      };
    });
    res.json({ items });
  } catch (e) { next(e); }
}

function validateOverride(key, body) {
  const tpl = resolveTemplate(key);
  if (!tpl || tpl.vertical !== 'HR') return { error: 'Unknown notification template.' , status: 404 };
  if (!body || typeof body !== 'string' || !body.trim()) return { error: 'body is required.', status: 400 };
  if (body.length > MAX_BODY) return { error: `body too long (${MAX_BODY} max).`, status: 400 };
  const unknown = tokensOf(body).filter((t) => !tpl.variables.includes(t));
  if (unknown.length) {
    return {
      error: `Unknown token(s) ${unknown.map((t) => `{${t}}`).join(', ')} — this template provides: ${tpl.variables.map((v) => `{${v}}`).join(', ') || '(none)'}.`,
      status: 400,
    };
  }
  return { tpl };
}

async function upsert(req, res, next) {
  try {
    const { businessId, id: userId } = req.user;
    const key = req.params.key;
    const body = req.body && req.body.body;
    const v = validateOverride(key, body);
    if (v.error) return res.status(v.status).json({ message: v.error });
    const row = await prisma.tenantMessageTemplate.upsert({
      where: { businessId_templateKey: { businessId, templateKey: key } },
      create: { businessId, templateKey: key, body: body.trim(), isActive: true, updatedByUserId: userId || null },
      update: { body: body.trim(), isActive: true, updatedByUserId: userId || null },
    });
    res.json({ key, overrideBody: row.body, overridden: true });
  } catch (e) { next(e); }
}

async function reset(req, res, next) {
  try {
    const { businessId } = req.user;
    const key = req.params.key;
    await prisma.tenantMessageTemplate.deleteMany({ where: { businessId, templateKey: key } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// Render against sample variables — powers the editor's live preview. Body
// resolution mirrors the send path: an explicit draft body wins, else the
// tenant's ACTIVE stored override, else the stock registry body.
async function preview(req, res, next) {
  try {
    const { businessId } = req.user;
    const key = req.params.key;
    const tpl = resolveTemplate(key);
    if (!tpl || tpl.vertical !== 'HR') return res.status(404).json({ message: 'Unknown notification template.' });
    let body = req.body && typeof req.body.body === 'string' && req.body.body.trim() ? req.body.body : null;
    if (body == null) {
      const stored = await prisma.tenantMessageTemplate.findUnique({
        where: { businessId_templateKey: { businessId, templateKey: key } },
      });
      body = stored && stored.isActive ? stored.body : tpl.body;
    }
    const sample = {};
    for (const v of tpl.variables) sample[v] = (req.body && req.body.variables && req.body.variables[v]) || `[${v}]`;
    res.json({ key, rendered: substituteVars(body, sample), variables: tpl.variables });
  } catch (e) { next(e); }
}

module.exports = { list, upsert, reset, preview };
