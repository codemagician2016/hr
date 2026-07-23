'use strict';

/**
 * careersPage.lib.js — Careers CMS pure helpers (NO DB, unit-testable).
 *
 * Three concerns live here so the admin controller, the public board projection
 * and the unit tests all share one implementation:
 *
 *  1. sanitizeHtml(html) — a server-side, regex-based ALLOWLIST sanitizer applied
 *     on WRITE to every rich-text field (aboutHtml / cultureHtml / customSections
 *     bodyHtml) so the UNAUTH public render is safe. Approach (v1):
 *       (a) Dangerous ELEMENTS are removed with their content:
 *           <script> <style> <iframe> <object> <embed> <noscript> <template>
 *           <svg> <math> <link> <meta> <base> <form>.
 *       (b) Every remaining tag is checked against an ALLOWLIST of safe tags;
 *           a tag not on the list is dropped (its text content is kept).
 *       (c) On an allowed tag, only allowlisted ATTRIBUTES survive; any `on*`
 *           handler is dropped, and href/src/style values carrying a
 *           javascript:/vbscript:/data: (non-image) scheme — after entity +
 *           whitespace de-obfuscation — are stripped.
 *     A dedicated library (sanitize-html / DOMPurify) is the production upgrade;
 *     the allowlist below is deliberately conservative for v1.
 *
 *  2. Input validation/normalisation for the PUT upsert (caps + shape).
 *
 *  3. The public projection: an UNPUBLISHED or absent page → null (the frontend
 *     falls back to today's hard-coded copy). Only isPublished pages ever expose
 *     content, and draft-only columns (isPublished, updatedByUserId, brandId, ids)
 *     are NEVER serialised onto the public endpoint.
 */

// ── length caps (defence-in-depth against unbounded @db.Text writes) ──────────
const CAP = {
  headline: 200,
  subheadline: 300,
  richText: 20000, // aboutHtml / cultureHtml
  sectionBody: 10000, // customSections[].bodyHtml
  sectionTitle: 200,
  heroImageUrl: 2000,
  brandId: 100,
  socialUrl: 500,
  perkLabel: 100,
  perkIcon: 50,
  maxSections: 20,
  maxPerks: 30,
};

// ── HTML sanitizer allowlist ──────────────────────────────────────────────────
const DANGEROUS_ELEMENTS = [
  'script', 'style', 'iframe', 'object', 'embed', 'noscript',
  'template', 'svg', 'math', 'link', 'meta', 'base', 'form',
];
const ALLOWED_TAGS = new Set([
  'a', 'p', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'mark',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'span', 'div', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'code', 'pre',
]);
// Attributes allowed per-tag; '*' applies to every allowed tag.
const ALLOWED_ATTRS = {
  '*': new Set(['class', 'id', 'title', 'style']),
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
};

// Decode HTML entities + strip whitespace/control chars so scheme obfuscation
// (e.g. `java&#115;cript:`, `java\tscript:`) can't sneak a dangerous URL past us.
function normalizeUrlValue(v) {
  let s = String(v || '');
  s = s.replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/&#(\d+);?/g, (_m, d) => String.fromCharCode(parseInt(d, 10)));
  s = s.replace(/[\u0000-\u0020\u00a0\u2000-\u200b\ufeff]+/g, ""); // strip control + odd whitespace
  return s.toLowerCase();
}

function isDangerousUrl(v) {
  const s = normalizeUrlValue(v);
  if (/^(javascript|vbscript|livescript|mocha):/.test(s)) return true;
  // allow data:image/... (inline images) but nothing else on the data: scheme.
  if (/^data:/.test(s) && !/^data:image\//.test(s)) return true;
  return false;
}

function isDangerousStyle(v) {
  const s = normalizeUrlValue(v);
  return /(expression\(|javascript:|vbscript:|url\(\s*['"]?\s*(javascript|data|vbscript):)/.test(s);
}

// Parse an opening-tag attribute string → a clean, allowlisted attribute string.
function sanitizeAttributes(tag, attrStr) {
  if (!attrStr) return '';
  const allowedForTag = ALLOWED_ATTRS[tag] || null;
  const globalAllowed = ALLOWED_ATTRS['*'];
  const kept = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const rawName = m[1];
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    // drop every event handler + a couple of known-dangerous attrs outright.
    if (name.startsWith('on') || name === 'formaction' || name === 'xlink:href' || name === 'srcdoc') continue;
    const isAllowed = globalAllowed.has(name) || (allowedForTag && allowedForTag.has(name));
    if (!isAllowed) continue;
    let val = m[3];
    if (val == null) { kept.push(name); continue; } // boolean attr
    val = val.replace(/^['"]|['"]$/g, ''); // unwrap quotes
    if ((name === 'href' || name === 'src') && isDangerousUrl(val)) continue;
    if (name === 'style' && isDangerousStyle(val)) continue;
    // re-emit with a double-quoted, entity-escaped value.
    const safeVal = val.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    kept.push(`${name}="${safeVal}"`);
  }
  return kept.length ? ' ' + kept.join(' ') : '';
}

function sanitizeHtml(html) {
  if (html == null) return null;
  let out = String(html);

  // (a) remove dangerous elements WITH their content (open→close), plus any
  // stray/unclosed opening or closing tag of the same name.
  for (const tag of DANGEROUS_ELEMENTS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '');
  }
  // strip HTML comments (can hide conditional-comment script on IE).
  out = out.replace(/<!--[\s\S]*?-->/g, '');

  // (b)+(c) walk every remaining tag; drop non-allowlisted tags, and rebuild
  // allowlisted ones with only safe attributes.
  out = out.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (_full, slash, name, attrs) => {
      const tag = name.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return ''; // drop tag, keep inner text
      if (slash === '/') return `</${tag}>`;
      return `<${tag}${sanitizeAttributes(tag, attrs)}>`;
    });

  return out;
}

// ── input validation / normalisation for the PUT upsert ───────────────────────
function clampStr(v, cap) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > cap ? s.slice(0, cap) : s;
}

// A social link must be an http(s) URL (we never render javascript:/data:).
function cleanSocialUrl(v) {
  const s = clampStr(v, CAP.socialUrl);
  if (!s) return null;
  if (isDangerousUrl(s)) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

const SOCIAL_KEYS = ['linkedin', 'twitter', 'x', 'facebook', 'instagram', 'youtube', 'github', 'glassdoor', 'website'];

function normalizeSocialLinks(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const out = {};
  for (const k of SOCIAL_KEYS) {
    if (json[k] == null) continue;
    const url = cleanSocialUrl(json[k]);
    if (url) out[k] = url;
  }
  return out;
}

// Normalise + sanitise custom sections, sorted by `order` (stable on ties).
function normalizeCustomSections(json, { sanitize = false } = {}) {
  if (!Array.isArray(json)) return [];
  const items = json.slice(0, CAP.maxSections).map((raw, idx) => {
    const r = raw && typeof raw === 'object' ? raw : {};
    const order = Number.isFinite(Number(r.order)) ? Number(r.order) : idx;
    let bodyHtml = clampStr(r.bodyHtml, CAP.sectionBody);
    if (sanitize) bodyHtml = sanitizeHtml(bodyHtml);
    return { title: clampStr(r.title, CAP.sectionTitle), bodyHtml, order, _idx: idx };
  });
  items.sort((a, b) => (a.order - b.order) || (a._idx - b._idx));
  return items.map(({ title, bodyHtml, order }) => ({ title, bodyHtml, order }));
}

function normalizePerks(json) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const raw of json.slice(0, CAP.maxPerks)) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const label = clampStr(r.label, CAP.perkLabel);
    if (!label) continue;
    const icon = clampStr(r.icon, CAP.perkIcon);
    out.push(icon ? { icon, label } : { label });
  }
  return out;
}

// Turn a raw PUT body → the exact Prisma column payload (sanitised + capped).
// Never sets isPublished (that is toggled only via publish/unpublish).
function sanitizeCareersInput(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    headline: clampStr(b.headline, CAP.headline),
    subheadline: clampStr(b.subheadline, CAP.subheadline),
    aboutHtml: sanitizeHtml(clampStr(b.aboutHtml, CAP.richText)),
    cultureHtml: sanitizeHtml(clampStr(b.cultureHtml, CAP.richText)),
    heroImageUrl: (() => {
      const s = clampStr(b.heroImageUrl, CAP.heroImageUrl);
      return s && !isDangerousUrl(s) ? s : null;
    })(),
    brandId: clampStr(b.brandId, CAP.brandId),
    customSectionsJson: normalizeCustomSections(b.customSections ?? b.customSectionsJson, { sanitize: true }),
    socialLinksJson: normalizeSocialLinks(b.socialLinks ?? b.socialLinksJson),
    perksJson: normalizePerks(b.perks ?? b.perksJson),
  };
}

// ── public projections (draft → null; only isPublished exposes content) ───────
// Returns the leak-safe public page object, or null for an absent/unpublished
// page. Stored rich-text is already sanitised at write time; we only shape +
// order here and NEVER emit draft-only columns.
function projectPublicPage(row) {
  if (!row || !row.isPublished) return null;
  return {
    headline: row.headline || null,
    subheadline: row.subheadline || null,
    aboutHtml: row.aboutHtml || null,
    cultureHtml: row.cultureHtml || null,
    heroImageUrl: row.heroImageUrl || null,
    customSections: normalizeCustomSections(row.customSectionsJson),
    socialLinks: (row.socialLinksJson && typeof row.socialLinksJson === 'object' && !Array.isArray(row.socialLinksJson)) ? row.socialLinksJson : {},
    perks: Array.isArray(row.perksJson) ? row.perksJson : [],
  };
}

// The tenant's active brand → the leak-safe brand block (logo/colors/footer).
function projectPublicBrand(brand) {
  if (!brand) return null;
  return {
    logoUrl: brand.logoUrl || null,
    primaryColor: brand.primaryColor || null,
    accentColor: brand.accentColor || null,
    footerText: brand.emailFooter || null,
  };
}

// The admin-facing default when a tenant has no CareersPage row yet.
function emptyCareersPage() {
  return {
    headline: null, subheadline: null, aboutHtml: null, cultureHtml: null,
    heroImageUrl: null, brandId: null,
    customSections: [], socialLinks: {}, perks: [],
    isPublished: false, updatedAt: null,
  };
}

// Shape a stored row for the ADMIN GET (includes draft fields — operator only).
function shapeAdminPage(row) {
  if (!row) return emptyCareersPage();
  return {
    headline: row.headline || null,
    subheadline: row.subheadline || null,
    aboutHtml: row.aboutHtml || null,
    cultureHtml: row.cultureHtml || null,
    heroImageUrl: row.heroImageUrl || null,
    brandId: row.brandId || null,
    customSections: normalizeCustomSections(row.customSectionsJson),
    socialLinks: (row.socialLinksJson && typeof row.socialLinksJson === 'object' && !Array.isArray(row.socialLinksJson)) ? row.socialLinksJson : {},
    perks: Array.isArray(row.perksJson) ? row.perksJson : [],
    isPublished: !!row.isPublished,
    updatedAt: row.updatedAt || null,
  };
}

module.exports = {
  CAP,
  sanitizeHtml,
  isDangerousUrl,
  normalizeSocialLinks,
  normalizeCustomSections,
  normalizePerks,
  sanitizeCareersInput,
  projectPublicPage,
  projectPublicBrand,
  emptyCareersPage,
  shapeAdminPage,
};
