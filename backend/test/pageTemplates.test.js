// Tests for the page template registry. Pure-function logic; no DB or
// network involved.

const tpl = require('../src/core/lib/pageTemplates');

describe('TEMPLATES registry', () => {
  test('exposes 3 starter templates', () => {
    expect(tpl.TEMPLATE_KEYS).toEqual(expect.arrayContaining(['info-page', 'service-detail', 'team-bio']));
  });
  test('every template has key, label, parentNavs, and either fields or isBlocks', () => {
    for (const key of tpl.TEMPLATE_KEYS) {
      const t = tpl.getTemplate(key);
      expect(t).toBeTruthy();
      expect(typeof t.label).toBe('string');
      expect(Array.isArray(t.parentNavs)).toBe(true);
      expect(t.parentNavs.length).toBeGreaterThan(0);
      if (t.isBlocks) {
        // Block-based template — no fields registry, validated by
        // validateBlockPageContent instead.
        expect(t.fields).toBeUndefined();
        continue;
      }
      expect(Array.isArray(t.fields)).toBe(true);
      expect(t.fields.length).toBeGreaterThan(0);
      for (const field of t.fields) {
        expect(typeof field.key).toBe('string');
        expect(typeof field.label).toBe('string');
        expect(typeof field.type).toBe('string');
      }
    }
  });
  test('PARENT_NAVS is the union of all template parentNavs', () => {
    expect(tpl.PARENT_NAVS).toEqual(expect.arrayContaining(['services', 'team', 'about', 'info']));
  });
});

describe('getTemplate', () => {
  test('returns null for unknown key', () => {
    expect(tpl.getTemplate('does-not-exist')).toBeNull();
  });
  test('returns template object for known key', () => {
    expect(tpl.getTemplate('info-page')).toMatchObject({ label: 'Info page' });
  });
});

describe('validateContent', () => {
  test('rejects unknown templateKey', () => {
    const r = tpl.validateContent('nope', { body: 'x' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/Unknown templateKey/);
  });

  test('rejects non-object content', () => {
    expect(tpl.validateContent('info-page', 'string').ok).toBe(false);
    expect(tpl.validateContent('info-page', null).ok).toBe(false);
    expect(tpl.validateContent('info-page', []).ok).toBe(false);
  });

  test('passes when required fields are present', () => {
    const r = tpl.validateContent('info-page', { body: 'Some body text' });
    expect(r.ok).toBe(true);
  });

  test('rejects missing required field', () => {
    const r = tpl.validateContent('info-page', {});
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("'body' is required"))).toBe(true);
  });

  test('rejects empty string for required field', () => {
    const r = tpl.validateContent('info-page', { body: '' });
    expect(r.ok).toBe(false);
  });

  test('rejects field exceeding max length', () => {
    const huge = 'x'.repeat(6000);
    const r = tpl.validateContent('info-page', { body: huge });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('exceeds max length'))).toBe(true);
  });

  test('rejects unknown field', () => {
    const r = tpl.validateContent('info-page', { body: 'ok', randomKey: 'x' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('Unknown field'))).toBe(true);
  });

  test('image URL accepts http://, https://, /absolute', () => {
    expect(tpl.validateContent('info-page', { body: 'b', heroImage: 'https://x.com/i.jpg' }).ok).toBe(true);
    expect(tpl.validateContent('info-page', { body: 'b', heroImage: '/uploads/i.jpg' }).ok).toBe(true);
  });

  test('image rejects bare strings', () => {
    const r = tpl.validateContent('info-page', { body: 'b', heroImage: 'not a url' });
    expect(r.ok).toBe(false);
  });

  test('number field validates min/max', () => {
    const ok = tpl.validateContent('service-detail', { description: 'x', durationMinutes: 30 });
    expect(ok.ok).toBe(true);
    const tooLow = tpl.validateContent('service-detail', { description: 'x', durationMinutes: 1 });
    expect(tooLow.ok).toBe(false);
    const tooHigh = tpl.validateContent('service-detail', { description: 'x', durationMinutes: 9999 });
    expect(tooHigh.ok).toBe(false);
    const wrongType = tpl.validateContent('service-detail', { description: 'x', durationMinutes: 'thirty' });
    expect(wrongType.ok).toBe(false);
  });

  test('list field accepts arrays', () => {
    const r = tpl.validateContent('team-bio', { bio: 'b', services: ['Haircut', 'Beard trim'] });
    expect(r.ok).toBe(true);
  });

  test('list field rejects non-arrays', () => {
    const r = tpl.validateContent('team-bio', { bio: 'b', services: 'Haircut, Beard' });
    expect(r.ok).toBe(false);
  });
});

describe('validateSlug', () => {
  test('accepts simple slugs', () => {
    expect(tpl.validateSlug('haircut')).toBe(true);
    expect(tpl.validateSlug('about-us')).toBe(true);
    expect(tpl.validateSlug('jane-doe-bio')).toBe(true);
    expect(tpl.validateSlug('a')).toBe(true);
    expect(tpl.validateSlug('a1')).toBe(true);
  });

  test('rejects uppercase / underscores / spaces', () => {
    expect(tpl.validateSlug('Haircut')).toBe(false);
    expect(tpl.validateSlug('about_us')).toBe(false);
    expect(tpl.validateSlug('about us')).toBe(false);
  });

  test('rejects leading / trailing / double dashes', () => {
    expect(tpl.validateSlug('-haircut')).toBe(false);
    expect(tpl.validateSlug('haircut-')).toBe(false);
    expect(tpl.validateSlug('hair--cut')).toBe(false);
  });

  test('rejects too long (>80 chars)', () => {
    expect(tpl.validateSlug('a'.repeat(81))).toBe(false);
  });

  test('rejects non-strings', () => {
    expect(tpl.validateSlug(123)).toBe(false);
    expect(tpl.validateSlug(null)).toBe(false);
    expect(tpl.validateSlug(undefined)).toBe(false);
  });
});

describe('validateParentNav', () => {
  test('accepts valid parentNavs', () => {
    expect(tpl.validateParentNav('services')).toBe(true);
    expect(tpl.validateParentNav('team')).toBe(true);
    expect(tpl.validateParentNav('about')).toBe(true);
    expect(tpl.validateParentNav('info')).toBe(true);
  });
  test('rejects unknown parentNavs', () => {
    expect(tpl.validateParentNav('random')).toBe(false);
    expect(tpl.validateParentNav('')).toBe(false);
    expect(tpl.validateParentNav(null)).toBe(false);
  });
});
