'use strict';

/*
 * careersPage.unit.test.js — Careers CMS PURE logic. Plain-node, NO DB:
 *   node backend/src/hr/talent/recruitment/__tests__/careersPage.unit.test.js
 *
 * Covers: the write-time HTML sanitizer (strips script, iframe, on* handlers,
 * javascript: URLs; keeps safe tags/attrs), the public projection (draft → null,
 * published →
 * fields, no draft leak), customSections ordering/validation, brand projection,
 * and the full sanitizeCareersInput caps/allowlist.
 */

const assert = require('assert');
const lib = require('../careersPage.lib');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

/* ── sanitizeHtml: dangerous elements stripped WITH content ── */
{
  ok('script block removed with content', lib.sanitizeHtml('<p>hi</p><script>alert(1)</script>') === '<p>hi</p>');
  ok('iframe removed', !/iframe/i.test(lib.sanitizeHtml('<iframe src="evil"></iframe><p>ok</p>')));
  ok('style block removed', !/expression/i.test(lib.sanitizeHtml('<style>a{background:expression(1)}</style><p>x</p>')));
  ok('object/embed removed', lib.sanitizeHtml('<object data="x"></object><embed src="y">text').replace(/\s+/g, '') === 'text');
  ok('html comment removed', lib.sanitizeHtml('<p>a</p><!-- <script>x</script> -->') === '<p>a</p>');
}

/* ── sanitizeHtml: event handlers + javascript: URLs neutralised ── */
{
  const a = lib.sanitizeHtml('<a href="javascript:alert(1)">x</a>');
  ok('javascript: href dropped', !/javascript:/i.test(a) && /<a[^>]*>x<\/a>/.test(a));
  const img = lib.sanitizeHtml('<img src="javascript:alert(1)" onerror="steal()">');
  ok('img javascript src dropped', !/javascript:/i.test(img));
  ok('onerror handler dropped', !/onerror/i.test(img));
  ok('onclick dropped but tag kept', lib.sanitizeHtml('<p onclick="x()">t</p>') === '<p>t</p>');
  // entity-obfuscated scheme still caught (java&#115;cript: → javascript:)
  ok('entity-obfuscated javascript: href stripped', !/href=/i.test(lib.sanitizeHtml('<a href="java&#115;cript:alert(1)">x</a>')));
}

/* ── sanitizeHtml: safe content preserved ── */
{
  const safe = '<p>Join <strong>us</strong></p><ul><li>Perk</li></ul><a href="https://x.com" target="_blank" rel="noopener">apply</a>';
  const out = lib.sanitizeHtml(safe);
  ok('keeps p/strong/ul/li', /<p>Join <strong>us<\/strong><\/p><ul><li>Perk<\/li><\/ul>/.test(out));
  ok('keeps safe https href', /href="https:\/\/x\.com"/.test(out));
  ok('keeps target + rel', /target="_blank"/.test(out) && /rel="noopener"/.test(out));
  ok('allows data:image/ in img', /src="data:image\/png;base64,AAAA"/.test(lib.sanitizeHtml('<img src="data:image/png;base64,AAAA">')));
  ok('drops non-image data: in img', !/data:text/i.test(lib.sanitizeHtml('<img src="data:text/html,<b>x">')));
}

/* ── sanitizeHtml: non-allowlisted tag dropped, inner text kept ── */
{
  ok('marquee tag dropped, text kept', lib.sanitizeHtml('<marquee>run</marquee>') === 'run');
  ok('svg element removed with content', lib.sanitizeHtml('<svg><script>x</script></svg>y') === 'y');
  ok('null passes through as null', lib.sanitizeHtml(null) === null);
}

/* ── projectPublicPage: draft → null, published → fields, no leak ── */
{
  ok('null row → null', lib.projectPublicPage(null) === null);
  ok('draft (isPublished false) → null', lib.projectPublicPage({ isPublished: false, headline: 'secret' }) === null);
  const row = {
    isPublished: true,
    headline: 'We are hiring',
    subheadline: 'Join the team',
    aboutHtml: '<p>about</p>',
    cultureHtml: '<p>culture</p>',
    heroImageUrl: 'https://x/hero.png',
    brandId: 'brand-123',
    updatedByUserId: 'user-9',
    customSectionsJson: [{ title: 'B', bodyHtml: '<p>b</p>', order: 2 }, { title: 'A', bodyHtml: '<p>a</p>', order: 1 }],
    socialLinksJson: { linkedin: 'https://linkedin.com/x' },
    perksJson: [{ icon: 'gift', label: 'Bonus' }],
  };
  const pub = lib.projectPublicPage(row);
  ok('published headline present', pub.headline === 'We are hiring');
  ok('published aboutHtml present', pub.aboutHtml === '<p>about</p>');
  ok('social links surfaced', pub.socialLinks.linkedin === 'https://linkedin.com/x');
  ok('perks surfaced', pub.perks[0].label === 'Bonus');
  // NO draft-only columns leak onto the public projection.
  ok('no brandId leak', !('brandId' in pub));
  ok('no isPublished leak', !('isPublished' in pub));
  ok('no updatedByUserId leak', !('updatedByUserId' in pub));
}

/* ── customSections ordering + validation ── */
{
  const sections = lib.projectPublicPage({
    isPublished: true,
    customSectionsJson: [
      { title: 'third', bodyHtml: 'c', order: 3 },
      { title: 'first', bodyHtml: 'a', order: 1 },
      { title: 'second', bodyHtml: 'b', order: 2 },
    ],
  }).customSections;
  ok('sections sorted by order asc', sections.map((s) => s.title).join(',') === 'first,second,third');

  // stable on tie (input index breaks ties)
  const tie = lib.normalizeCustomSections([
    { title: 'x', order: 1 }, { title: 'y', order: 1 }, { title: 'z', order: 1 },
  ]);
  ok('tie order is stable (input order)', tie.map((s) => s.title).join(',') === 'x,y,z');

  // cap the number of sections
  const many = Array.from({ length: 50 }, (_, i) => ({ title: `t${i}`, order: i }));
  ok('sections capped at CAP.maxSections', lib.normalizeCustomSections(many).length === lib.CAP.maxSections);

  // sanitize:true strips script from section body
  const dirty = lib.normalizeCustomSections([{ title: 't', bodyHtml: '<p>ok</p><script>bad()</script>', order: 0 }], { sanitize: true });
  ok('section bodyHtml sanitised on write', dirty[0].bodyHtml === '<p>ok</p>');
  // read-side normalise does NOT re-sanitise (already clean at rest) but is safe shape
  ok('non-array sections → []', lib.normalizeCustomSections('nope').length === 0);
}

/* ── projectPublicBrand: null → null; maps emailFooter → footerText ── */
{
  ok('null brand → null', lib.projectPublicBrand(null) === null);
  const b = lib.projectPublicBrand({ logoUrl: 'l', primaryColor: '#111', accentColor: '#222', emailFooter: 'foot', supportEmail: 'nope@x' });
  ok('brand logo mapped', b.logoUrl === 'l');
  ok('brand primary/accent mapped', b.primaryColor === '#111' && b.accentColor === '#222');
  ok('emailFooter → footerText', b.footerText === 'foot');
  ok('brand does not leak supportEmail', !('supportEmail' in b));
}

/* ── sanitizeCareersInput: caps + allowlist + sanitise ── */
{
  const data = lib.sanitizeCareersInput({
    headline: '  Hello  ',
    aboutHtml: '<p>hi</p><script>x</script>',
    heroImageUrl: 'javascript:alert(1)',
    customSections: [{ title: 'A', bodyHtml: '<p>a</p><iframe></iframe>', order: 5 }],
    socialLinks: { linkedin: 'https://linkedin.com/c', twitter: 'javascript:x', bogusKey: 'https://y', website: 'http://co.example' },
    perks: [{ icon: 'star', label: 'Free lunch' }, { label: '' }, { icon: 'x' }],
  });
  ok('headline trimmed', data.headline === 'Hello');
  ok('aboutHtml sanitised', data.aboutHtml === '<p>hi</p>');
  ok('dangerous hero url rejected → null', data.heroImageUrl === null);
  ok('section body sanitised', data.customSectionsJson[0].bodyHtml === '<p>a</p>');
  ok('valid https social kept', data.socialLinksJson.linkedin === 'https://linkedin.com/c');
  ok('valid http social kept', data.socialLinksJson.website === 'http://co.example');
  ok('javascript social dropped', !('twitter' in data.socialLinksJson));
  ok('unknown social key dropped', !('bogusKey' in data.socialLinksJson));
  ok('perk with label kept', data.perksJson.some((p) => p.label === 'Free lunch'));
  ok('perk without label dropped', data.perksJson.length === 1);
  ok('input never sets isPublished', !('isPublished' in data));

  // length caps
  const long = lib.sanitizeCareersInput({ headline: 'a'.repeat(500) });
  ok('headline capped', long.headline.length === lib.CAP.headline);
}

/* ── emptyCareersPage default shape ── */
{
  const e = lib.emptyCareersPage();
  ok('empty page not published', e.isPublished === false);
  ok('empty customSections is []', Array.isArray(e.customSections) && e.customSections.length === 0);
  ok('empty socialLinks is {}', e.socialLinks && typeof e.socialLinks === 'object' && !Array.isArray(e.socialLinks));
}

console.log(`careersPage.unit: ${passed} checks passed`);
