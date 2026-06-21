import { resolveAllVariants, VARIANT_LABELS } from './layoutPresets';

const TEXT_ONLY_HERO_VARIANTS = new Set([
  'minimal-centered',
  'gradient-mesh',
  'stat-band',
  'editorial-split',
]);

const PANORAMIC_HERO_VARIANTS = new Set([
  'card-stack',
]);

const WIDE_HERO_VARIANTS = new Set([
  'v1',
]);

const SQUARE_HERO_VARIANTS = new Set([
  'portfolio-wall',
  'design-casefile',
  'creator-studio',
  'artist-collection',
  'agency-casebook',
]);

const SPLIT_IMAGE_HERO_VARIANTS = new Set([
  'split-image',
]);

const FRAME_SPECS = {
  none: {
    key: 'none',
    usesImage: false,
    label: 'Text-only hero',
    frameName: 'No image slot',
    aspect: null,
    aspectCss: null,
    recommendedSize: 'No hero image used',
    hint: 'This layout does not display a hero image on the live website.',
    helper: 'Change the hero layout if you want a photo-led first screen.',
    previewMaxWidth: null,
    stockWidth: 1600,
    stockHeight: 900,
  },
  wide: {
    key: 'wide',
    usesImage: true,
    label: 'Wide hero banner',
    frameName: 'Full-width landscape frame',
    aspect: 16 / 7,
    aspectCss: '16 / 7',
    recommendedSize: '1920x840px',
    hint: 'Best for wide landscape photos with the subject kept near the centre.',
    helper: 'The live site crops this as a wide cover, especially on desktop.',
    previewMaxWidth: null,
    stockWidth: 1600,
    stockHeight: 700,
  },
  panoramic: {
    key: 'panoramic',
    usesImage: true,
    label: 'Panoramic hero image',
    frameName: 'Short wide image strip',
    aspect: 16 / 6,
    aspectCss: '16 / 6',
    recommendedSize: '1920x720px',
    hint: 'Best for wide images where important detail is not near the top or bottom edge.',
    helper: 'This layout uses the image as a shallow cap above the hero copy.',
    previewMaxWidth: null,
    stockWidth: 1600,
    stockHeight: 600,
  },
  split: {
    key: 'split',
    usesImage: true,
    label: 'Split hero image',
    frameName: 'Tall split-screen frame',
    aspect: 4 / 5,
    aspectCss: '4 / 5',
    recommendedSize: '1200x1500px',
    hint: 'Best for vertical or lightly cropped photos with the main subject centred.',
    helper: 'The live site places this beside the headline, so a normal banner will look over-cropped.',
    previewMaxWidth: 220,
    stockWidth: 1200,
    stockHeight: 1500,
  },
  tall: {
    key: 'tall',
    usesImage: true,
    label: 'Tall hero card',
    frameName: 'Portrait-style website card',
    aspect: 3 / 4,
    aspectCss: '3 / 4',
    recommendedSize: '1200x1600px',
    hint: 'Best for portrait-style images. Keep faces, products, and text in the middle safe area.',
    helper: 'This matches the tall card shown in the live preview and storefront.',
    previewMaxWidth: 220,
    stockWidth: 1200,
    stockHeight: 1600,
  },
  square: {
    key: 'square',
    usesImage: true,
    label: 'Mosaic hero image',
    frameName: 'Square/near-square feature frame',
    aspect: 1,
    aspectCss: '1 / 1',
    recommendedSize: '1400x1400px',
    hint: 'Best for square images or photos that still make sense when cropped from all sides.',
    helper: 'This layout places the image inside a grid, so the crop is closer to a square tile than a banner.',
    previewMaxWidth: 240,
    stockWidth: 1400,
    stockHeight: 1400,
  },
};

function parseSectionVariants(sectionVariants) {
  if (!sectionVariants) return null;
  if (typeof sectionVariants === 'object') return sectionVariants;
  try {
    const parsed = JSON.parse(sectionVariants);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveHeroVariantForGuidance({ designPreset, sectionVariants, heroVariant } = {}) {
  if (heroVariant) return heroVariant;
  const variants = resolveAllVariants({
    designPreset: designPreset || null,
    sectionVariants: parseSectionVariants(sectionVariants),
  });
  return variants.hero || 'v1';
}

function frameKeyForHeroVariant(heroVariant) {
  if (TEXT_ONLY_HERO_VARIANTS.has(heroVariant)) return 'none';
  if (PANORAMIC_HERO_VARIANTS.has(heroVariant)) return 'panoramic';
  if (WIDE_HERO_VARIANTS.has(heroVariant)) return 'wide';
  if (SQUARE_HERO_VARIANTS.has(heroVariant)) return 'square';
  if (SPLIT_IMAGE_HERO_VARIANTS.has(heroVariant)) return 'split';
  return 'tall';
}

function stockImagesForSpec(spec) {
  if (!spec.usesImage) return [];
  const seeds = [
    'sitepresso-hero-workspace',
    'sitepresso-hero-service',
    'sitepresso-hero-team',
    'sitepresso-hero-interior',
    'sitepresso-hero-product',
    'sitepresso-hero-detail',
  ];
  return seeds.map((seed) => `https://picsum.photos/seed/${seed}/${spec.stockWidth}/${spec.stockHeight}`);
}

export function getHeroImageGuidance(options = {}) {
  const heroVariant = resolveHeroVariantForGuidance(options);
  const frameKey = frameKeyForHeroVariant(heroVariant);
  const spec = FRAME_SPECS[frameKey] || FRAME_SPECS.tall;
  const variantLabel = VARIANT_LABELS.hero?.[heroVariant] || heroVariant || 'Hero';

  return {
    ...spec,
    heroVariant,
    variantLabel,
    fieldLabel: spec.usesImage ? 'Hero image' : 'Hero image',
    uploadHint: spec.usesImage
      ? `JPG or PNG - max 15MB - Recommended: ${spec.recommendedSize} - ${spec.frameName}`
      : spec.hint,
    stockImages: stockImagesForSpec(spec),
  };
}

