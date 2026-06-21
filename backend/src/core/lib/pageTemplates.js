// Page template registry — defines the schema each BusinessPage.templateKey
// expects in its content JSON. Used by the controller to validate writes
// AND by the storefront renderer to know which fields to display.
//
// Adding a new template:
//   1. Add an entry below with `key`, `label`, `parentNavs`, `fields`, `seoFallback`
//   2. (Phase 1) — that's it for the API. Storefront renderer (Phase 2)
//      will key off `templateKey` to pick the right React component.
//
// Field types supported in `fields`:
//   text       — single-line string
//   textarea   — multi-line string
//   image      — URL string (uploaded via existing image-upload flow)
//   richtext   — markdown / WYSIWYG (Phase 3 — for now, plain textarea)
//   list       — array of objects (e.g., a list of feature cards)
//
// Phase 1 ships 3 templates. Phase 5 (per ROADMAP) adds 2 more.

const TEMPLATES = {
  'info-page': {
    label: 'Info page',
    description: 'Generic page with hero image, title, and body text. Use for About, FAQ, Privacy summaries, etc.',
    parentNavs: ['about', 'info'],
    fields: [
      { key: 'heroImage', label: 'Hero image', type: 'image', required: false },
      { key: 'subtitle', label: 'Subtitle', type: 'text', required: false, max: 160 },
      { key: 'body', label: 'Body', type: 'textarea', required: true, max: 5000 },
    ],
  },
  'service-detail': {
    label: 'Service detail',
    description: 'Detailed page for one of your services. Hero, description, what to expect, booking CTA.',
    parentNavs: ['services'],
    fields: [
      { key: 'heroImage', label: 'Hero image', type: 'image', required: false },
      { key: 'description', label: 'Description', type: 'textarea', required: true, max: 1500 },
      { key: 'whatToExpect', label: 'What to expect', type: 'textarea', required: false, max: 1500 },
      { key: 'durationMinutes', label: 'Duration (minutes)', type: 'number', required: false, min: 5, max: 600 },
      { key: 'priceMinor', label: 'Price (minor units, e.g. cents)', type: 'number', required: false, min: 0 },
      { key: 'bookingServiceId', label: 'Linked booking service ID (optional)', type: 'text', required: false },
    ],
  },
  'team-bio': {
    label: 'Team bio',
    description: 'Bio page for one of your team members. Photo, role, bio, services they perform.',
    parentNavs: ['team'],
    fields: [
      { key: 'photo', label: 'Photo', type: 'image', required: false },
      { key: 'role', label: 'Role / title', type: 'text', required: false, max: 120 },
      { key: 'bio', label: 'Bio', type: 'textarea', required: true, max: 3000 },
      { key: 'services', label: 'Services performed', type: 'list', required: false }, // list of strings
      { key: 'workingHours', label: 'Working hours summary', type: 'text', required: false, max: 240 },
      { key: 'linkedStaffUserId', label: 'Linked staff User ID (optional)', type: 'text', required: false },
    ],
  },
  // Sprint 3.3 — Pages v2 block-based template. Used by the new admin
  // editor (5 block types, each toggleable). Content shape is an array
  // under `blocks`, validated per-type by validateBlockPageContent below.
  // Allowed in any nav section since pages can sit anywhere now.
  'block-page': {
    label: 'Block page',
    description: 'Compose with header / rich-text / image+text / feature-grid / CTA blocks. Toggle visibility per block.',
    parentNavs: ['services', 'team', 'about', 'products', 'info'],
    isBlocks: true,
  },
};

const TEMPLATE_KEYS = Object.keys(TEMPLATES);

// Allowed parentNav values across all templates.
const PARENT_NAVS = Array.from(
  new Set(TEMPLATE_KEYS.flatMap((k) => TEMPLATES[k].parentNavs))
).sort();

function getTemplate(key) {
  return TEMPLATES[key] || null;
}

// Block-page block schema. Each block: { id, type, enabled, props }.
// `props` is type-specific; we validate the known types and reject
// unknown ones so future block types must be added here before they
// reach the DB.
const BLOCK_TYPES = ['header', 'richtext', 'imagetext', 'features', 'steps', 'gallery', 'linklist', 'faq', 'cta'];

const PAGE_LAYOUT_PRESETS = ['service-premium', 'editorial', 'visual-story', 'resource-hub', 'document'];

const PLACEMENTS = ['TOP', 'DROPDOWN', 'FOOTER', 'HIDDEN'];

function validateBlockProps(type, props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    return [`Block '${type}' props must be an object`];
  }
  const errs = [];
  const str = (k, max = 1000, required = false) => {
    const v = props[k];
    if (required && (v === undefined || v === '')) errs.push(`Block '${type}' missing required prop '${k}'`);
    else if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > max)) {
      errs.push(`Block '${type}'.${k} must be a string ≤ ${max} chars`);
    }
  };
  const bool = (k) => {
    const v = props[k];
    if (v !== undefined && typeof v !== 'boolean') errs.push(`Block '${type}'.${k} must be boolean`);
  };
  switch (type) {
    case 'header':
      str('title', 240, true);
      str('subtitle', 480);
      str('eyebrow', 120);
      str('primaryCtaText', 80);
      str('primaryCtaLink', 2000);
      str('secondaryCtaText', 80);
      str('secondaryCtaLink', 2000);
      str('bannerImageUrl', 2000);
      bool('showBreadcrumb');
      bool('fullWidthBanner');
      break;
    case 'richtext':
      str('heading', 240);
      str('body', 20000, true);
      bool('twoColumns');
      break;
    case 'imagetext':
      str('imageUrl', 2000);
      str('eyebrow', 120);
      str('title', 240);
      str('body', 4000);
      str('caption', 1200);
      str('buttonText', 80);
      str('buttonLink', 2000);
      if (props.position !== undefined && !['left', 'right'].includes(props.position)) {
        errs.push(`Block 'imagetext'.position must be "left" or "right"`);
      }
      break;
    case 'features': {
      str('eyebrow', 120);
      str('heading', 240);
      str('intro', 600);
      if (props.columns !== undefined && ![2, 3, 4].includes(props.columns)) {
        errs.push(`Block 'features'.columns must be 2, 3 or 4`);
      }
      if (props.items === undefined) break;
      if (!Array.isArray(props.items)) {
        errs.push(`Block 'features'.items must be an array`);
        break;
      }
      props.items.forEach((it, i) => {
        if (!it || typeof it !== 'object') {
          errs.push(`Feature item ${i + 1} must be an object`);
          return;
        }
        if (it.title !== undefined && (typeof it.title !== 'string' || it.title.length > 240))
          errs.push(`Feature ${i + 1}.title must be a string ≤ 240 chars`);
        if (it.desc !== undefined && (typeof it.desc !== 'string' || it.desc.length > 480))
          errs.push(`Feature ${i + 1}.desc must be a string ≤ 480 chars`);
      });
      break;
    }
    case 'steps': {
      str('eyebrow', 120);
      str('heading', 240);
      str('intro', 600);
      if (props.items === undefined) break;
      if (!Array.isArray(props.items)) {
        errs.push(`Block 'steps'.items must be an array`);
        break;
      }
      if (props.items.length > 12) errs.push(`Block 'steps'.items may have at most 12 entries`);
      props.items.forEach((it, i) => {
        if (!it || typeof it !== 'object') {
          errs.push(`Step item ${i + 1} must be an object`);
          return;
        }
        if (it.title !== undefined && (typeof it.title !== 'string' || it.title.length > 240))
          errs.push(`Step ${i + 1}.title must be a string ≤ 240 chars`);
        if (it.desc !== undefined && (typeof it.desc !== 'string' || it.desc.length > 600))
          errs.push(`Step ${i + 1}.desc must be a string ≤ 600 chars`);
      });
      break;
    }
    case 'gallery': {
      str('eyebrow', 120);
      str('heading', 240);
      str('intro', 600);
      if (props.style !== undefined && !['grid', 'mosaic', 'strip'].includes(props.style)) {
        errs.push(`Block 'gallery'.style must be "grid", "mosaic" or "strip"`);
      }
      if (props.items === undefined) break;
      if (!Array.isArray(props.items)) {
        errs.push(`Block 'gallery'.items must be an array`);
        break;
      }
      if (props.items.length > 12) errs.push(`Block 'gallery'.items may have at most 12 entries`);
      props.items.forEach((it, i) => {
        if (!it || typeof it !== 'object') {
          errs.push(`Gallery item ${i + 1} must be an object`);
          return;
        }
        if (it.imageUrl !== undefined && (typeof it.imageUrl !== 'string' || it.imageUrl.length > 2000))
          errs.push(`Gallery ${i + 1}.imageUrl must be a string ≤ 2000 chars`);
        if (it.title !== undefined && (typeof it.title !== 'string' || it.title.length > 160))
          errs.push(`Gallery ${i + 1}.title must be a string ≤ 160 chars`);
        if (it.caption !== undefined && (typeof it.caption !== 'string' || it.caption.length > 360))
          errs.push(`Gallery ${i + 1}.caption must be a string ≤ 360 chars`);
      });
      break;
    }
    case 'linklist': {
      str('eyebrow', 120);
      str('heading', 240);
      str('intro', 600);
      if (props.links === undefined) break;
      if (!Array.isArray(props.links)) {
        errs.push(`Block 'linklist'.links must be an array`);
        break;
      }
      if (props.links.length > 16) errs.push(`Block 'linklist'.links may have at most 16 entries`);
      props.links.forEach((it, i) => {
        if (!it || typeof it !== 'object') {
          errs.push(`Link item ${i + 1} must be an object`);
          return;
        }
        if (it.label !== undefined && (typeof it.label !== 'string' || it.label.length > 120))
          errs.push(`Link ${i + 1}.label must be a string ≤ 120 chars`);
        if (it.href !== undefined && (typeof it.href !== 'string' || it.href.length > 2000))
          errs.push(`Link ${i + 1}.href must be a string ≤ 2000 chars`);
        if (it.desc !== undefined && (typeof it.desc !== 'string' || it.desc.length > 360))
          errs.push(`Link ${i + 1}.desc must be a string ≤ 360 chars`);
      });
      break;
    }
    case 'faq': {
      str('eyebrow', 120);
      str('heading', 240);
      str('intro', 600);
      if (props.items === undefined) break;
      if (!Array.isArray(props.items)) {
        errs.push(`Block 'faq'.items must be an array`);
        break;
      }
      if (props.items.length > 20) errs.push(`Block 'faq'.items may have at most 20 entries`);
      props.items.forEach((it, i) => {
        if (!it || typeof it !== 'object') {
          errs.push(`FAQ item ${i + 1} must be an object`);
          return;
        }
        if (it.q !== undefined && (typeof it.q !== 'string' || it.q.length > 240))
          errs.push(`FAQ ${i + 1}.q must be a string ≤ 240 chars`);
        if (it.a !== undefined && (typeof it.a !== 'string' || it.a.length > 1200))
          errs.push(`FAQ ${i + 1}.a must be a string ≤ 1200 chars`);
      });
      break;
    }
    case 'cta':
      str('eyebrow', 120);
      str('heading', 240, true);
      str('body', 600);
      str('buttonText', 80);
      str('buttonLink', 2000);
      str('secondaryButtonText', 80);
      str('secondaryButtonLink', 2000);
      str('imageUrl', 2000);
      if (props.style !== undefined && !['primary', 'outline', 'secondary'].includes(props.style)) {
        errs.push(`Block 'cta'.style must be "primary", "outline" or "secondary"`);
      }
      if (props.background !== undefined && !['solid', 'card', 'image'].includes(props.background)) {
        errs.push(`Block 'cta'.background must be "solid", "card" or "image"`);
      }
      break;
    default:
      // unreachable — caller already gated on BLOCK_TYPES
      break;
  }
  return errs;
}

function validateBlockPageContent(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return ['content must be a JSON object with a `blocks` array'];
  }
  if (content.layout !== undefined) {
    if (!content.layout || typeof content.layout !== 'object' || Array.isArray(content.layout)) {
      return ['content.layout must be an object when provided'];
    }
    if (content.layout.preset !== undefined && !PAGE_LAYOUT_PRESETS.includes(content.layout.preset)) {
      return [`content.layout.preset must be one of: ${PAGE_LAYOUT_PRESETS.join(', ')}`];
    }
  }
  const blocks = content.blocks;
  if (!Array.isArray(blocks)) return ['content.blocks must be an array'];
  if (blocks.length > 50) return ['content.blocks may have at most 50 entries'];
  const errors = [];
  const seenIds = new Set();
  blocks.forEach((b, i) => {
    if (!b || typeof b !== 'object') { errors.push(`Block ${i + 1} must be an object`); return; }
    if (typeof b.id !== 'string' || b.id.length < 1 || b.id.length > 80) {
      errors.push(`Block ${i + 1}.id must be a 1-80 char string`);
    } else if (seenIds.has(b.id)) {
      errors.push(`Block ${i + 1}.id "${b.id}" is duplicated`);
    } else {
      seenIds.add(b.id);
    }
    if (!BLOCK_TYPES.includes(b.type)) {
      errors.push(`Block ${i + 1}.type must be one of: ${BLOCK_TYPES.join(', ')}`);
      return;
    }
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') {
      errors.push(`Block ${i + 1}.enabled must be boolean`);
    }
    errors.push(...validateBlockProps(b.type, b.props || {}));
  });
  return errors;
}

function validatePlacement(placement) {
  if (placement === undefined || placement === null) return true;
  return PLACEMENTS.includes(placement);
}

// Validate that `content` matches the schema for the given template.
// Returns { ok: true } or { ok: false, errors: [...] }.
function validateContent(templateKey, content) {
  const tpl = getTemplate(templateKey);
  if (!tpl) {
    return { ok: false, errors: [`Unknown templateKey: ${templateKey}`] };
  }
  // Block-page uses a separate validator (array of blocks vs key-value fields).
  if (tpl.isBlocks) {
    const errs = validateBlockPageContent(content);
    return errs.length > 0 ? { ok: false, errors: errs } : { ok: true };
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return { ok: false, errors: ['content must be a JSON object'] };
  }
  const errors = [];
  for (const field of tpl.fields) {
    const value = content[field.key];
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`Field '${field.key}' is required`);
      continue;
    }
    if (value === undefined || value === null) continue;
    switch (field.type) {
      case 'text':
      case 'textarea':
      case 'richtext':
        if (typeof value !== 'string') errors.push(`Field '${field.key}' must be a string`);
        else if (field.max && value.length > field.max) errors.push(`Field '${field.key}' exceeds max length ${field.max}`);
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`Field '${field.key}' must be a number`);
        else {
          if (field.min !== undefined && value < field.min) errors.push(`Field '${field.key}' is below min ${field.min}`);
          if (field.max !== undefined && value > field.max) errors.push(`Field '${field.key}' exceeds max ${field.max}`);
        }
        break;
      case 'image':
        if (typeof value !== 'string') errors.push(`Field '${field.key}' must be a string URL`);
        else if (!/^https?:\/\//.test(value) && !value.startsWith('/')) {
          errors.push(`Field '${field.key}' must be a URL or absolute path`);
        }
        break;
      case 'list':
        if (!Array.isArray(value)) errors.push(`Field '${field.key}' must be an array`);
        break;
      default:
        // Unknown field type — let it through but flag for visibility
        break;
    }
  }
  // Reject unknown keys to keep content clean
  const knownKeys = new Set(tpl.fields.map((f) => f.key));
  for (const key of Object.keys(content)) {
    if (!knownKeys.has(key)) errors.push(`Unknown field '${key}' for template ${templateKey}`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

// Slug validation: lowercase letters, numbers, dashes; 1-80 chars; no
// leading/trailing dash; no double-dash.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,78}[a-z0-9]$|^[a-z0-9]$/;

function validateSlug(slug) {
  if (typeof slug !== 'string') return false;
  return SLUG_RE.test(slug);
}

function validateParentNav(parentNav) {
  return PARENT_NAVS.includes(parentNav);
}

function validateCustomParentNav(parentNav) {
  return validateSlug(parentNav);
}

// Sprint 3.3b — Quick-add preset pages. Each preset is a one-tap page
// the admin can add to their site without writing copy from scratch.
// They become real BusinessPage rows on the block-page template; the
// admin then customises the placeholder copy. `defaultPlacement` and
// `defaultParentNav` give the create flow sensible defaults — admins
// can change either after creation.
//
// Presets are vertical-aware: a STATIC tenant doesn't see "What to
// expect at your first appointment". When `vertical` is omitted the
// preset is universal.
//
// Adding a preset:
//   1. Append below with id / title / description / iconKey / blocks
//   2. `blocks` is a FUNCTION that returns a fresh block array with
//      unique ids — clonePresetBlocks() is the safe way to get one.

let _presetIdCounter = 0;
function _bid(prefix) {
  _presetIdCounter += 1;
  return `${prefix}-preset-${Date.now().toString(36)}-${_presetIdCounter}`;
}

const PRESETS = [
  {
    id: 'faq',
    title: 'FAQ',
    slug: 'faq',
    description: 'Answer the questions every visitor asks before they book.',
    iconKey: 'help',
    defaultPlacement: 'DROPDOWN',
    defaultParentNav: 'about',
    blocks: () => [
      { id: _bid('header'),   type: 'header',   enabled: true, props: { title: 'Frequently Asked Questions', subtitle: 'Everything you need to know before you book.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'How do I book an appointment?', body: 'Tap the "Book a Session" button at the top of any page, pick a service, then choose a time that works for you. A confirmation lands in your inbox right away.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'What does a first session look like?', body: 'Replace this paragraph with a short description of what new clients can expect on their first visit — duration, format, and what to bring.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'How do I cancel or reschedule?', body: 'You can cancel or reschedule from your booking confirmation up to 24 hours before your appointment. Inside that window, please call us directly so we can make space for someone on the waitlist.' } },
      { id: _bid('cta'),      type: 'cta',      enabled: true, props: { heading: 'Still have questions?', buttonText: 'Get in touch', buttonLink: '/#contact', style: 'primary', background: 'solid' } },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy Policy',
    slug: 'privacy',
    description: 'A starter privacy policy you can customise to your business.',
    iconKey: 'lock',
    defaultPlacement: 'FOOTER',
    defaultParentNav: 'info',
    blocks: () => [
      { id: _bid('header'),   type: 'header',   enabled: true, props: { title: 'Privacy Policy', subtitle: 'Last updated [DATE]. Replace this with the date you publish.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'What we collect', body: 'When you book an appointment we collect your name, email, and phone number, plus any notes you add to your booking. If you log in, we also store your password as a secure hash.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'How we use it', body: 'We use your details to confirm appointments, send reminders, and respond to enquiries. We never sell your data, and we only share it with third-party services (e.g. payment providers, email tools) that strictly need it to deliver our service to you.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Your rights', body: 'You can request a copy of your data, ask us to correct it, or have it deleted at any time. Email us at [your email address] and we\'ll respond within 30 days.' } },
    ],
  },
  {
    id: 'terms',
    title: 'Terms of Service',
    slug: 'terms',
    description: 'Plain-English starter terms covering bookings, payment and cancellation.',
    iconKey: 'doc',
    defaultPlacement: 'FOOTER',
    defaultParentNav: 'info',
    blocks: () => [
      { id: _bid('header'),   type: 'header',   enabled: true, props: { title: 'Terms of Service', subtitle: 'Last updated [DATE].' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Booking and payment', body: 'When you confirm a booking, you\'re agreeing to attend the session at the time you picked. Payment is due [at the time of booking / after the session — pick one]. We accept the payment methods listed at checkout.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Cancellations and refunds', body: 'Cancel at least 24 hours in advance for a full refund. Late cancellations and no-shows are charged the full session fee. If you need to reschedule for medical or emergency reasons, contact us — we\'ll always work with you.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Limitation of liability', body: 'Our service is provided as-is. We do our best to deliver every session as booked, but we\'re not liable for indirect losses arising from missed appointments or scheduling errors. Replace with bespoke wording if your jurisdiction requires it.' } },
    ],
  },
  {
    id: 'cancellation',
    title: 'Cancellation Policy',
    slug: 'cancellation-policy',
    description: 'A short, friendly explanation of your cancellation rules.',
    iconKey: 'clock',
    defaultPlacement: 'FOOTER',
    defaultParentNav: 'info',
    vertical: ['APPOINTMENT'],
    blocks: () => [
      { id: _bid('header'),   type: 'header',   enabled: true, props: { title: 'Cancellation Policy', subtitle: 'Plans change — here\'s how to handle it.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Standard window', body: 'Please give us at least 24 hours\' notice if you need to cancel or reschedule. That gives someone on the waitlist a chance to take your slot.' } },
      { id: _bid('features'), type: 'features', enabled: true, props: {
        columns: 3,
        items: [
          { title: 'More than 24h before', desc: 'Cancel for free, no questions asked.' },
          { title: 'Less than 24h before', desc: 'Full session fee applies.' },
          { title: 'No-show', desc: 'Full session fee applies.' },
        ],
      } },
      { id: _bid('cta'),      type: 'cta',      enabled: true, props: { heading: 'Need to change a booking?', buttonText: 'Manage my bookings', buttonLink: '/dashboard', style: 'outline', background: 'card' } },
    ],
  },
  {
    id: 'what-to-expect',
    title: 'What to Expect',
    slug: 'what-to-expect',
    description: 'A first-visit guide that puts new clients at ease.',
    iconKey: 'info',
    defaultPlacement: 'DROPDOWN',
    defaultParentNav: 'about',
    vertical: ['APPOINTMENT'],
    blocks: () => [
      { id: _bid('header'),   type: 'header',   enabled: true, props: { title: 'What to Expect on Your First Visit', subtitle: 'A quick walk-through so you know exactly what to expect.' } },
      { id: _bid('features'), type: 'features', enabled: true, props: {
        columns: 3,
        items: [
          { title: 'Before you arrive', desc: 'Fill in the short intake form we email after booking — it saves time at the door.' },
          { title: 'When you arrive', desc: 'Check in at reception. We\'ll show you to a comfortable space and offer water, tea, or coffee.' },
          { title: 'During the session', desc: 'Your practitioner will walk you through the plan, answer any questions, then begin.' },
        ],
      } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'How long does it take?', body: 'A typical first session runs [60 minutes — replace with your duration]. We block extra time at the start so you never feel rushed.' } },
      { id: _bid('cta'),      type: 'cta',      enabled: true, props: { heading: 'Ready to book your first session?', buttonText: 'Book now', buttonLink: '/book', style: 'primary', background: 'solid' } },
    ],
  },
  {
    id: 'insurance',
    title: 'Insurance & Pricing',
    slug: 'insurance-pricing',
    description: 'List the insurers you accept and your standard fees.',
    iconKey: 'shield',
    defaultPlacement: 'DROPDOWN',
    defaultParentNav: 'about',
    vertical: ['APPOINTMENT'],
    blocks: () => [
      { id: _bid('header'),   type: 'header',   enabled: true, props: { title: 'Insurance & Pricing', subtitle: 'Plain answers to the most common money questions.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Insurers we accept', body: 'Replace this with the list of insurers you bill directly. If you don\'t bill any insurer, swap this for: "We offer paid invoices that you can claim back from your insurer — most plans cover our services."' } },
      { id: _bid('features'), type: 'features', enabled: true, props: {
        columns: 3,
        items: [
          { title: 'Initial session', desc: '60 minutes · [$ amount]' },
          { title: 'Follow-up', desc: '50 minutes · [$ amount]' },
          { title: 'Sliding scale', desc: 'We reserve a few slots each week for clients facing financial hardship — ask us.' },
        ],
      } },
      { id: _bid('cta'),      type: 'cta',      enabled: true, props: { heading: 'Questions about a specific insurer?', buttonText: 'Send us a message', buttonLink: '/#contact', style: 'outline', background: 'card' } },
    ],
  },
  {
    id: 'online-sessions',
    title: 'Online Sessions',
    slug: 'online-sessions',
    description: 'How your virtual appointments work.',
    iconKey: 'monitor',
    defaultPlacement: 'DROPDOWN',
    defaultParentNav: 'services',
    vertical: ['APPOINTMENT'],
    blocks: () => [
      { id: _bid('header'),   type: 'header',   enabled: true, props: { title: 'Online Sessions', subtitle: 'Same care, from anywhere with a stable internet connection.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'How it works', body: 'When you book an online session, you\'ll receive a private video link in your confirmation email. Click the link a few minutes before your time, and your practitioner will join you on the call.' } },
      { id: _bid('features'), type: 'features', enabled: true, props: {
        columns: 3,
        items: [
          { title: 'Private', desc: 'End-to-end encrypted video — no recordings unless you ask for one.' },
          { title: 'Flexible', desc: 'Take a session from your home, office, or anywhere with a quiet space.' },
          { title: 'Easy', desc: 'No app to install. Works in any modern browser, on phone or laptop.' },
        ],
      } },
      { id: _bid('cta'),      type: 'cta',      enabled: true, props: { heading: 'Book your first online session', buttonText: 'See available times', buttonLink: '/book', style: 'primary', background: 'solid' } },
    ],
  },
];

const ECOMMERCE_PRESETS = [
  {
    id: 'ecom-faq',
    title: 'FAQ',
    slug: 'faq',
    description: 'Common delivery, pickup, payment, and order questions for shoppers.',
    iconKey: 'help',
    defaultPlacement: 'FOOTER',
    defaultParentNav: 'info',
    vertical: ['ECOMMERCE'],
    blocks: () => [
      { id: _bid('header'),   type: 'header',   enabled: true, props: { title: 'Frequently Asked Questions', subtitle: 'Answers about shopping, delivery, pickup, and payments.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'How do I place an order?', body: 'Browse products, add items to your cart, choose delivery or pickup when available, then complete checkout with one of the enabled payment methods.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Can I choose a delivery slot?', body: 'If delivery slots are enabled for your area, you can select an available time window during checkout.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'What if an item is unavailable?', body: 'We will contact you about substitutions or remove the unavailable item from your order before dispatch, depending on your store policy.' } },
    ],
  },
  {
    id: 'ecom-privacy',
    title: 'Privacy Policy',
    slug: 'privacy',
    description: 'Starter privacy policy for shopper accounts, orders, and delivery data.',
    iconKey: 'lock',
    defaultPlacement: 'FOOTER',
    defaultParentNav: 'info',
    vertical: ['ECOMMERCE'],
    blocks: () => [
      { id: _bid('header'),   type: 'header',   enabled: true, props: { title: 'Privacy Policy', subtitle: 'Last updated [DATE]. Replace this before publishing.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Information we collect', body: 'We collect details needed to process orders, including name, email, phone number, delivery address, order items, payment status, and support messages.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'How we use information', body: 'We use shopper information to process orders, send order updates, manage delivery or pickup, prevent fraud, and respond to customer support requests.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Your rights', body: 'You can request access, correction, or deletion of your personal data by contacting us at [your support email].' } },
    ],
  },
  {
    id: 'ecom-terms',
    title: 'Terms of Service',
    slug: 'terms',
    description: 'Plain-English starter terms for online grocery orders.',
    iconKey: 'doc',
    defaultPlacement: 'FOOTER',
    defaultParentNav: 'info',
    vertical: ['ECOMMERCE'],
    blocks: () => [
      { id: _bid('header'),   type: 'header',   enabled: true, props: { title: 'Terms of Service', subtitle: 'Last updated [DATE].' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Orders and availability', body: 'Products, prices, and availability may vary by location. An order is accepted when we confirm it, and substitutions may apply if a product becomes unavailable.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Payment', body: 'Available payment methods are shown at checkout. Depending on store settings, orders may be prepaid online, cash on delivery, or both.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Delivery and pickup', body: 'Delivery and pickup times are estimates. We do our best to meet selected slots, but delays can occur due to traffic, weather, or operational constraints.' } },
    ],
  },
  {
    id: 'ecom-shipping',
    title: 'Delivery Policy',
    slug: 'delivery-policy',
    description: 'Explain delivery areas, slots, fees, and missed deliveries.',
    iconKey: 'truck',
    defaultPlacement: 'FOOTER',
    defaultParentNav: 'info',
    vertical: ['ECOMMERCE'],
    blocks: () => [
      { id: _bid('header'),   type: 'header',   enabled: true, props: { title: 'Delivery Policy', subtitle: 'Delivery areas, slots, and fees.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Delivery areas', body: 'We deliver to the service areas shown at checkout. Availability may depend on your selected store or fulfilment location.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Delivery fees and slots', body: 'Delivery fees and available slots are shown before you place your order. Please ensure someone is available to receive the order during the selected window.' } },
    ],
  },
  {
    id: 'ecom-returns',
    title: 'Returns & Refunds',
    slug: 'returns-refunds',
    description: 'Starter policy for damaged, missing, or unsuitable grocery items.',
    iconKey: 'rotate',
    defaultPlacement: 'FOOTER',
    defaultParentNav: 'info',
    vertical: ['ECOMMERCE'],
    blocks: () => [
      { id: _bid('header'),   type: 'header',   enabled: true, props: { title: 'Returns & Refunds', subtitle: 'How we handle damaged, missing, or incorrect items.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Report an issue', body: 'If an item is damaged, missing, or incorrect, contact us within [time window] with your order number and photos where possible.' } },
      { id: _bid('richtext'), type: 'richtext', enabled: true, props: { heading: 'Refunds', body: 'Approved refunds are processed to the original payment method where possible, or as store credit depending on the payment method and store policy.' } },
    ],
  },
];

function getPreset(id) {
  return [...PRESETS, ...ECOMMERCE_PRESETS].find((p) => p.id === id) || null;
}

function listPresetsForVertical(vertical) {
  if (vertical === 'ECOMMERCE') return ECOMMERCE_PRESETS;
  return PRESETS.filter((p) => !p.vertical || p.vertical.includes(vertical));
}

function clonePresetBlocks(presetId) {
  const p = getPreset(presetId);
  if (!p) return null;
  // Each preset's blocks() factory generates fresh ids on each call so
  // re-cloning the same preset doesn't collide.
  return p.blocks();
}

module.exports = {
  TEMPLATES,
  TEMPLATE_KEYS,
  PARENT_NAVS,
  PLACEMENTS,
  PAGE_LAYOUT_PRESETS,
  BLOCK_TYPES,
  PRESETS,
  ECOMMERCE_PRESETS,
  getTemplate,
  validateContent,
  validateBlockPageContent,
  validateSlug,
  validateParentNav,
  validateCustomParentNav,
  validatePlacement,
  getPreset,
  listPresetsForVertical,
  clonePresetBlocks,
};
