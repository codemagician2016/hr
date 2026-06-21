const assert = require('node:assert/strict');
const {
  LAYOUT_PRESETS,
  LAYOUT_PRESET_KEYS,
  VALID_LAYOUT_PRESETS,
  SECTION_KEYS,
  AVAILABLE_VARIANTS,
  DEFAULT_PRESET_KEY,
  resolvePreset,
  sanitizeSectionVariants,
} = require('../layout-presets.cjs');

assert.equal(LAYOUT_PRESETS.length, 100);
assert.equal(LAYOUT_PRESET_KEYS.length, 100);
assert.equal(DEFAULT_PRESET_KEY, 'classic');
assert.equal(LAYOUT_PRESETS[0].key, 'classic');
assert.equal(LAYOUT_PRESET_KEYS.at(-1), 'logistics-network');
assert.equal(resolvePreset({ designPreset: 'logistics-network' }).key, 'logistics-network');
assert.equal(VALID_LAYOUT_PRESETS.has('logistics-network'), true);
assert.equal(VALID_LAYOUT_PRESETS.has('not-a-real-preset'), false);

const restaurantPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'restaurant-menu');
assert.ok(restaurantPreset, 'restaurant-menu preset exists');
assert.deepEqual(restaurantPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(restaurantPreset.variants.hero, 'restaurant-cover');
assert.equal(restaurantPreset.variants.services, 'menu-board');
assert.equal(restaurantPreset.variants.pricing, 'dining-packages');
assert.equal(restaurantPreset.variants.gallery, 'dining-strip');
assert.equal(restaurantPreset.variants.testimonials, 'dining-reviews');
assert.equal(restaurantPreset.variants.contact, 'reservation-panel');

const medicalPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'medical-trust');
assert.ok(medicalPreset, 'medical-trust preset exists');
assert.deepEqual(medicalPreset.sectionOrder, ['services', 'team', 'testimonials', 'pricing', 'about', 'gallery', 'faq', 'contact']);
assert.equal(medicalPreset.variants.hero, 'clinic-intake');
assert.equal(medicalPreset.variants.services, 'care-pathways');
assert.equal(medicalPreset.variants.pricing, 'visit-options');
assert.equal(medicalPreset.variants.gallery, 'clinic-tour');
assert.equal(medicalPreset.variants.testimonials, 'patient-proof');
assert.equal(medicalPreset.variants.contact, 'appointment-panel');

const lawPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'law-prestige');
assert.ok(lawPreset, 'law-prestige preset exists');
assert.deepEqual(lawPreset.sectionOrder, ['services', 'testimonials', 'pricing', 'team', 'about', 'gallery', 'faq', 'contact']);
assert.equal(lawPreset.variants.hero, 'legal-brief');
assert.equal(lawPreset.variants.services, 'practice-dossier');
assert.equal(lawPreset.variants.pricing, 'engagement-scope');
assert.equal(lawPreset.variants.gallery, 'firm-library');
assert.equal(lawPreset.variants.testimonials, 'client-evidence');
assert.equal(lawPreset.variants.contact, 'confidential-intake');

const fitnessPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'fitness-energy');
assert.ok(fitnessPreset, 'fitness-energy preset exists');
assert.deepEqual(fitnessPreset.sectionOrder, ['services', 'pricing', 'testimonials', 'gallery', 'team', 'about', 'faq', 'contact']);
assert.equal(fitnessPreset.variants.hero, 'training-sprint');
assert.equal(fitnessPreset.variants.services, 'program-stack');
assert.equal(fitnessPreset.variants.pricing, 'coaching-plans');
assert.equal(fitnessPreset.variants.gallery, 'training-floor');
assert.equal(fitnessPreset.variants.testimonials, 'progress-proof');
assert.equal(fitnessPreset.variants.contact, 'goal-check');

const barberPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'barber-shop');
assert.ok(barberPreset, 'barber-shop preset exists');
assert.deepEqual(barberPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'team', 'about', 'faq', 'contact']);
assert.equal(barberPreset.variants.hero, 'barber-chair');
assert.equal(barberPreset.variants.services, 'grooming-menu');
assert.equal(barberPreset.variants.pricing, 'grooming-packages');
assert.equal(barberPreset.variants.gallery, 'barber-lookbook');
assert.equal(barberPreset.variants.testimonials, 'chair-proof');
assert.equal(barberPreset.variants.contact, 'chair-booking');

const dentalPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'dental-clinic');
assert.ok(dentalPreset, 'dental-clinic preset exists');
assert.deepEqual(dentalPreset.sectionOrder, ['services', 'team', 'pricing', 'testimonials', 'gallery', 'about', 'faq', 'contact']);
assert.equal(dentalPreset.variants.hero, 'dental-visit');
assert.equal(dentalPreset.variants.services, 'treatment-grid');
assert.equal(dentalPreset.variants.pricing, 'treatment-fees');
assert.equal(dentalPreset.variants.gallery, 'dental-suite');
assert.equal(dentalPreset.variants.testimonials, 'patient-reassurance');
assert.equal(dentalPreset.variants.contact, 'appointment-request');

const schoolPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'school-prospectus');
assert.ok(schoolPreset, 'school-prospectus preset exists');
assert.deepEqual(schoolPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'team', 'pricing', 'about', 'faq', 'contact']);
assert.equal(schoolPreset.variants.hero, 'school-open-day');
assert.equal(schoolPreset.variants.services, 'learning-pathways');
assert.equal(schoolPreset.variants.pricing, 'enrolment-options');
assert.equal(schoolPreset.variants.gallery, 'campus-tour');
assert.equal(schoolPreset.variants.testimonials, 'family-outcomes');
assert.equal(schoolPreset.variants.contact, 'admissions-enquiry');

const realEstatePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'real-estate-showcase');
assert.ok(realEstatePreset, 'real-estate-showcase preset exists');
assert.deepEqual(realEstatePreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'team', 'about', 'faq', 'contact']);
assert.equal(realEstatePreset.variants.hero, 'property-showcase');
assert.equal(realEstatePreset.variants.services, 'property-pathways');
assert.equal(realEstatePreset.variants.pricing, 'property-options');
assert.equal(realEstatePreset.variants.gallery, 'property-tour');
assert.equal(realEstatePreset.variants.testimonials, 'seller-buyer-proof');
assert.equal(realEstatePreset.variants.contact, 'appraisal-request');

const tradesPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'trades-quote');
assert.ok(tradesPreset, 'trades-quote preset exists');
assert.deepEqual(tradesPreset.sectionOrder, ['services', 'testimonials', 'gallery', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(tradesPreset.variants.hero, 'trade-dispatch');
assert.equal(tradesPreset.variants.services, 'trade-quote-board');
assert.equal(tradesPreset.variants.pricing, 'service-plans');
assert.equal(tradesPreset.variants.gallery, 'before-after');
assert.equal(tradesPreset.variants.testimonials, 'local-job-proof');
assert.equal(tradesPreset.variants.contact, 'quote-dispatch');

const fashionPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'fashion-drop');
assert.ok(fashionPreset, 'fashion-drop preset exists');
assert.deepEqual(fashionPreset.sectionOrder, ['services', 'gallery', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(fashionPreset.variants.hero, 'retail-drop');
assert.equal(fashionPreset.variants.services, 'collection-shelf');
assert.equal(fashionPreset.variants.pricing, 'collection-offers');
assert.equal(fashionPreset.variants.gallery, 'commerce-lookbook');
assert.equal(fashionPreset.variants.testimonials, 'buyer-notes');
assert.equal(fashionPreset.variants.contact, 'shop-support');

const photographerPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'photographer-gallery');
assert.ok(photographerPreset, 'photographer-gallery preset exists');
assert.deepEqual(photographerPreset.sectionOrder, ['gallery', 'services', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(photographerPreset.variants.hero, 'portfolio-wall');
assert.equal(photographerPreset.variants.services, 'case-study-grid');
assert.equal(photographerPreset.variants.pricing, 'creative-packages');
assert.equal(photographerPreset.variants.gallery, 'portfolio-wall');
assert.equal(photographerPreset.variants.testimonials, 'project-proof');
assert.equal(photographerPreset.variants.contact, 'project-brief');

const accountingPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'accounting-trust');
assert.ok(accountingPreset, 'accounting-trust preset exists');
assert.deepEqual(accountingPreset.sectionOrder, ['services', 'pricing', 'testimonials', 'team', 'about', 'gallery', 'faq', 'contact']);
assert.equal(accountingPreset.variants.hero, 'finance-ledger');
assert.equal(accountingPreset.variants.services, 'ledger-services');
assert.equal(accountingPreset.variants.pricing, 'advisory-retainers');
assert.equal(accountingPreset.variants.gallery, 'document-stack');
assert.equal(accountingPreset.variants.testimonials, 'finance-confidence');
assert.equal(accountingPreset.variants.contact, 'document-intake');

const spaPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'spa-retreat');
assert.ok(spaPreset, 'spa-retreat preset exists');
assert.deepEqual(spaPreset.sectionOrder, ['gallery', 'services', 'pricing', 'testimonials', 'team', 'about', 'faq', 'contact']);
assert.equal(spaPreset.variants.hero, 'spa-ritual');
assert.equal(spaPreset.variants.services, 'treatment-grid');
assert.equal(spaPreset.variants.pricing, 'treatment-fees');
assert.equal(spaPreset.variants.gallery, 'calm-space');
assert.equal(spaPreset.variants.testimonials, 'guest-calm-proof');
assert.equal(spaPreset.variants.contact, 'ritual-booking');

const hotelPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'hotel-resort');
assert.ok(hotelPreset, 'hotel-resort preset exists');
assert.deepEqual(hotelPreset.sectionOrder, ['services', 'gallery', 'pricing', 'testimonials', 'team', 'about', 'faq', 'contact']);
assert.equal(hotelPreset.variants.hero, 'hotel-stay');
assert.equal(hotelPreset.variants.services, 'stay-amenities');
assert.equal(hotelPreset.variants.pricing, 'room-offers');
assert.equal(hotelPreset.variants.gallery, 'stay-gallery');
assert.equal(hotelPreset.variants.testimonials, 'stay-reviews');
assert.equal(hotelPreset.variants.contact, 'stay-enquiry');

const industrialPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'industrial-capability');
assert.ok(industrialPreset, 'industrial-capability preset exists');
assert.deepEqual(industrialPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(industrialPreset.variants.hero, 'industrial-capability');
assert.equal(industrialPreset.variants.services, 'capability-matrix');
assert.equal(industrialPreset.variants.pricing, 'capacity-options');
assert.equal(industrialPreset.variants.gallery, 'factory-floor');
assert.equal(industrialPreset.variants.testimonials, 'operations-proof');
assert.equal(industrialPreset.variants.contact, 'sales-brief');

const tutorPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'tutor-conversion');
assert.ok(tutorPreset, 'tutor-conversion preset exists');
assert.deepEqual(tutorPreset.sectionOrder, ['services', 'pricing', 'testimonials', 'gallery', 'team', 'about', 'faq', 'contact']);
assert.equal(tutorPreset.variants.hero, 'tutor-plan');
assert.equal(tutorPreset.variants.services, 'subject-pathways');
assert.equal(tutorPreset.variants.pricing, 'tutoring-packages');
assert.equal(tutorPreset.variants.gallery, 'learning-space');
assert.equal(tutorPreset.variants.testimonials, 'learning-outcomes');
assert.equal(tutorPreset.variants.contact, 'assessment-enquiry');

const coursePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'course-launch');
assert.ok(coursePreset, 'course-launch preset exists');
assert.deepEqual(coursePreset.sectionOrder, ['services', 'pricing', 'testimonials', 'team', 'gallery', 'about', 'faq', 'contact']);
assert.equal(coursePreset.variants.hero, 'course-launchpad');
assert.equal(coursePreset.variants.services, 'module-stack');
assert.equal(coursePreset.variants.pricing, 'cohort-options');
assert.equal(coursePreset.variants.gallery, 'course-assets');
assert.equal(coursePreset.variants.testimonials, 'cohort-proof');
assert.equal(coursePreset.variants.contact, 'cohort-enquiry');

const recruitmentPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'recruitment-board');
assert.ok(recruitmentPreset, 'recruitment-board preset exists');
assert.deepEqual(recruitmentPreset.sectionOrder, ['services', 'testimonials', 'pricing', 'gallery', 'team', 'about', 'faq', 'contact']);
assert.equal(recruitmentPreset.variants.hero, 'recruitment-desk');
assert.equal(recruitmentPreset.variants.services, 'hiring-board');
assert.equal(recruitmentPreset.variants.pricing, 'hiring-retainers');
assert.equal(recruitmentPreset.variants.gallery, 'pipeline-board');
assert.equal(recruitmentPreset.variants.testimonials, 'hiring-proof');
assert.equal(recruitmentPreset.variants.contact, 'hiring-brief');

const logisticsPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'logistics-network');
assert.ok(logisticsPreset, 'logistics-network preset exists');
assert.deepEqual(logisticsPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(logisticsPreset.variants.hero, 'logistics-network');
assert.equal(logisticsPreset.variants.services, 'lane-network');
assert.equal(logisticsPreset.variants.pricing, 'freight-options');
assert.equal(logisticsPreset.variants.gallery, 'network-map');
assert.equal(logisticsPreset.variants.testimonials, 'delivery-proof');
assert.equal(logisticsPreset.variants.contact, 'freight-quote');

const financeAdvisorPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'finance-advisor');
assert.ok(financeAdvisorPreset, 'finance-advisor preset exists');
assert.deepEqual(financeAdvisorPreset.sectionOrder, ['services', 'pricing', 'testimonials', 'team', 'about', 'gallery', 'faq', 'contact']);
assert.equal(financeAdvisorPreset.variants.hero, 'advisor-plan');
assert.equal(financeAdvisorPreset.variants.services, 'planning-pathways');
assert.equal(financeAdvisorPreset.variants.pricing, 'planning-retainers');
assert.equal(financeAdvisorPreset.variants.gallery, 'planning-desk');
assert.equal(financeAdvisorPreset.variants.testimonials, 'advisor-confidence');
assert.equal(financeAdvisorPreset.variants.contact, 'planning-intake');

const immigrationPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'immigration-pathway');
assert.ok(immigrationPreset, 'immigration-pathway preset exists');
assert.deepEqual(immigrationPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'team', 'about', 'faq', 'contact']);
assert.equal(immigrationPreset.variants.hero, 'visa-pathway');
assert.equal(immigrationPreset.variants.services, 'visa-stages');
assert.equal(immigrationPreset.variants.pricing, 'visa-options');
assert.equal(immigrationPreset.variants.gallery, 'visa-documents');
assert.equal(immigrationPreset.variants.testimonials, 'visa-confidence');
assert.equal(immigrationPreset.variants.contact, 'visa-assessment');

const consultantDiagnosticPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'consultant-diagnostic');
assert.ok(consultantDiagnosticPreset, 'consultant-diagnostic preset exists');
assert.deepEqual(consultantDiagnosticPreset.sectionOrder, ['services', 'testimonials', 'pricing', 'gallery', 'team', 'about', 'faq', 'contact']);
assert.equal(consultantDiagnosticPreset.variants.hero, 'diagnostic-room');
assert.equal(consultantDiagnosticPreset.variants.services, 'diagnostic-offers');
assert.equal(consultantDiagnosticPreset.variants.pricing, 'diagnostic-packages');
assert.equal(consultantDiagnosticPreset.variants.gallery, 'diagnostic-workshop');
assert.equal(consultantDiagnosticPreset.variants.testimonials, 'diagnostic-proof');
assert.equal(consultantDiagnosticPreset.variants.contact, 'diagnostic-brief');

const notaryPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'notary-simple');
assert.ok(notaryPreset, 'notary-simple preset exists');
assert.deepEqual(notaryPreset.sectionOrder, ['services', 'pricing', 'testimonials', 'gallery', 'about', 'team', 'faq', 'contact']);
assert.equal(notaryPreset.variants.hero, 'notary-counter');
assert.equal(notaryPreset.variants.services, 'document-tasks');
assert.equal(notaryPreset.variants.pricing, 'notary-fees');
assert.equal(notaryPreset.variants.gallery, 'notary-documents');
assert.equal(notaryPreset.variants.testimonials, 'document-proof');
assert.equal(notaryPreset.variants.contact, 'document-appointment');

const corporateBoardroomPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'corporate-boardroom');
assert.ok(corporateBoardroomPreset, 'corporate-boardroom preset exists');
assert.deepEqual(corporateBoardroomPreset.sectionOrder, ['services', 'testimonials', 'pricing', 'gallery', 'team', 'about', 'faq', 'contact']);
assert.equal(corporateBoardroomPreset.variants.hero, 'boardroom-brief');
assert.equal(corporateBoardroomPreset.variants.services, 'boardroom-services');
assert.equal(corporateBoardroomPreset.variants.pricing, 'executive-retainers');
assert.equal(corporateBoardroomPreset.variants.gallery, 'boardroom-table');
assert.equal(corporateBoardroomPreset.variants.testimonials, 'executive-proof');
assert.equal(corporateBoardroomPreset.variants.contact, 'boardroom-intake');

const architectPortfolioPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'architect-portfolio');
assert.ok(architectPortfolioPreset, 'architect-portfolio preset exists');
assert.deepEqual(architectPortfolioPreset.sectionOrder, ['gallery', 'services', 'testimonials', 'pricing', 'team', 'about', 'faq', 'contact']);
assert.equal(architectPortfolioPreset.variants.hero, 'architecture-studio');
assert.equal(architectPortfolioPreset.variants.services, 'studio-commissions');
assert.equal(architectPortfolioPreset.variants.pricing, 'commission-options');
assert.equal(architectPortfolioPreset.variants.gallery, 'architecture-projects');
assert.equal(architectPortfolioPreset.variants.testimonials, 'commission-proof');
assert.equal(architectPortfolioPreset.variants.contact, 'commission-brief');

const builderProjectsPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'builder-projects');
assert.ok(builderProjectsPreset, 'builder-projects preset exists');
assert.deepEqual(builderProjectsPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(builderProjectsPreset.variants.hero, 'builder-site');
assert.equal(builderProjectsPreset.variants.services, 'build-capabilities');
assert.equal(builderProjectsPreset.variants.pricing, 'build-packages');
assert.equal(builderProjectsPreset.variants.gallery, 'site-progress');
assert.equal(builderProjectsPreset.variants.testimonials, 'build-proof');
assert.equal(builderProjectsPreset.variants.contact, 'project-quote');

const interiorLookbookPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'interior-lookbook');
assert.ok(interiorLookbookPreset, 'interior-lookbook preset exists');
assert.deepEqual(interiorLookbookPreset.sectionOrder, ['gallery', 'services', 'pricing', 'testimonials', 'team', 'about', 'faq', 'contact']);
assert.equal(interiorLookbookPreset.variants.hero, 'interior-lookbook');
assert.equal(interiorLookbookPreset.variants.services, 'room-schemes');
assert.equal(interiorLookbookPreset.variants.pricing, 'design-packages');
assert.equal(interiorLookbookPreset.variants.gallery, 'interior-rooms');
assert.equal(interiorLookbookPreset.variants.testimonials, 'room-proof');
assert.equal(interiorLookbookPreset.variants.contact, 'room-brief');

const landscapingPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'landscaping-before-after');
assert.ok(landscapingPreset, 'landscaping-before-after preset exists');
assert.deepEqual(landscapingPreset.sectionOrder, ['gallery', 'services', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(landscapingPreset.variants.hero, 'landscape-plan');
assert.equal(landscapingPreset.variants.services, 'outdoor-projects');
assert.equal(landscapingPreset.variants.pricing, 'landscape-packages');
assert.equal(landscapingPreset.variants.gallery, 'outdoor-before-after');
assert.equal(landscapingPreset.variants.testimonials, 'yard-proof');
assert.equal(landscapingPreset.variants.contact, 'landscape-quote');

const cleaningPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'cleaning-service');
assert.ok(cleaningPreset, 'cleaning-service preset exists');
assert.deepEqual(cleaningPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(cleaningPreset.variants.hero, 'cleaning-route');
assert.equal(cleaningPreset.variants.services, 'cleaning-plans');
assert.equal(cleaningPreset.variants.pricing, 'cleaning-packages');
assert.equal(cleaningPreset.variants.gallery, 'cleaning-results');
assert.equal(cleaningPreset.variants.testimonials, 'clean-proof');
assert.equal(cleaningPreset.variants.contact, 'cleaning-quote');

const maintenancePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'home-maintenance');
assert.ok(maintenancePreset, 'home-maintenance preset exists');
assert.deepEqual(maintenancePreset.sectionOrder, ['services', 'testimonials', 'pricing', 'gallery', 'about', 'team', 'faq', 'contact']);
assert.equal(maintenancePreset.variants.hero, 'maintenance-log');
assert.equal(maintenancePreset.variants.services, 'repair-checklist');
assert.equal(maintenancePreset.variants.pricing, 'maintenance-plans');
assert.equal(maintenancePreset.variants.gallery, 'repair-log');
assert.equal(maintenancePreset.variants.testimonials, 'home-proof');
assert.equal(maintenancePreset.variants.contact, 'maintenance-request');

const writerEditorialPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'writer-editorial');
assert.ok(writerEditorialPreset, 'writer-editorial preset exists');
assert.deepEqual(writerEditorialPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(writerEditorialPreset.variants.hero, 'editorial-desk');
assert.equal(writerEditorialPreset.variants.services, 'editorial-services');
assert.equal(writerEditorialPreset.variants.pricing, 'editorial-packages');
assert.equal(writerEditorialPreset.variants.gallery, 'editorial-clips');
assert.equal(writerEditorialPreset.variants.testimonials, 'publication-proof');
assert.equal(writerEditorialPreset.variants.contact, 'editorial-brief');

const developerSystemsPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'developer-systems');
assert.ok(developerSystemsPreset, 'developer-systems preset exists');
assert.deepEqual(developerSystemsPreset.sectionOrder, ['services', 'testimonials', 'gallery', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(developerSystemsPreset.variants.hero, 'industrial-capability');
assert.equal(developerSystemsPreset.variants.services, 'capability-matrix');
assert.equal(developerSystemsPreset.variants.pricing, 'engagement-scope');
assert.equal(developerSystemsPreset.variants.gallery, 'pipeline-board');
assert.equal(developerSystemsPreset.variants.testimonials, 'operations-proof');
assert.equal(developerSystemsPreset.variants.contact, 'technical-brief');

const designerCaseStudyPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'designer-case-study');
assert.ok(designerCaseStudyPreset, 'designer-case-study preset exists');
assert.deepEqual(designerCaseStudyPreset.sectionOrder, ['gallery', 'services', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(designerCaseStudyPreset.variants.hero, 'design-casefile');
assert.equal(designerCaseStudyPreset.variants.services, 'design-process');
assert.equal(designerCaseStudyPreset.variants.pricing, 'design-engagements');
assert.equal(designerCaseStudyPreset.variants.gallery, 'case-study-wall');
assert.equal(designerCaseStudyPreset.variants.testimonials, 'design-proof');
assert.equal(designerCaseStudyPreset.variants.contact, 'design-brief');

const creatorChannelPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'creator-channel');
assert.ok(creatorChannelPreset, 'creator-channel preset exists');
assert.deepEqual(creatorChannelPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(creatorChannelPreset.variants.hero, 'creator-studio');
assert.equal(creatorChannelPreset.variants.services, 'creator-offers');
assert.equal(creatorChannelPreset.variants.pricing, 'creator-packages');
assert.equal(creatorChannelPreset.variants.gallery, 'channel-assets');
assert.equal(creatorChannelPreset.variants.testimonials, 'audience-proof');
assert.equal(creatorChannelPreset.variants.contact, 'collaboration-brief');

const podcastStudioPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'podcast-studio');
assert.ok(podcastStudioPreset, 'podcast-studio preset exists');
assert.deepEqual(podcastStudioPreset.sectionOrder, ['gallery', 'services', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(podcastStudioPreset.variants.hero, 'podcast-studio');
assert.equal(podcastStudioPreset.variants.services, 'show-production');
assert.equal(podcastStudioPreset.variants.pricing, 'production-packages');
assert.equal(podcastStudioPreset.variants.gallery, 'episode-library');
assert.equal(podcastStudioPreset.variants.testimonials, 'listener-proof');
assert.equal(podcastStudioPreset.variants.contact, 'episode-brief');

const speakerStagePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'speaker-stage');
assert.ok(speakerStagePreset, 'speaker-stage preset exists');
assert.deepEqual(speakerStagePreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(speakerStagePreset.variants.hero, 'speaker-stage');
assert.equal(speakerStagePreset.variants.services, 'talk-topics');
assert.equal(speakerStagePreset.variants.pricing, 'speaking-packages');
assert.equal(speakerStagePreset.variants.gallery, 'stage-reel');
assert.equal(speakerStagePreset.variants.testimonials, 'stage-proof');
assert.equal(speakerStagePreset.variants.contact, 'speaking-brief');

const coachAuthorityPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'coach-authority');
assert.ok(coachAuthorityPreset, 'coach-authority preset exists');
assert.deepEqual(coachAuthorityPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(coachAuthorityPreset.variants.hero, 'speaker-stage');
assert.equal(coachAuthorityPreset.variants.services, 'talk-topics');
assert.equal(coachAuthorityPreset.variants.pricing, 'speaking-packages');
assert.equal(coachAuthorityPreset.variants.gallery, 'stage-reel');
assert.equal(coachAuthorityPreset.variants.testimonials, 'stage-proof');
assert.equal(coachAuthorityPreset.variants.contact, 'speaking-brief');

const artistCollectionPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'artist-collection');
assert.ok(artistCollectionPreset, 'artist-collection preset exists');
assert.deepEqual(artistCollectionPreset.sectionOrder, ['gallery', 'services', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(artistCollectionPreset.variants.hero, 'artist-collection');
assert.equal(artistCollectionPreset.variants.services, 'collection-works');
assert.equal(artistCollectionPreset.variants.pricing, 'art-offers');
assert.equal(artistCollectionPreset.variants.gallery, 'art-collection');
assert.equal(artistCollectionPreset.variants.testimonials, 'collector-proof');
assert.equal(artistCollectionPreset.variants.contact, 'collector-enquiry');

const agencyCasebookPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'agency-casebook');
assert.ok(agencyCasebookPreset, 'agency-casebook preset exists');
assert.deepEqual(agencyCasebookPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(agencyCasebookPreset.variants.hero, 'agency-casebook');
assert.equal(agencyCasebookPreset.variants.services, 'agency-method');
assert.equal(agencyCasebookPreset.variants.pricing, 'agency-retainers');
assert.equal(agencyCasebookPreset.variants.gallery, 'agency-casebook');
assert.equal(agencyCasebookPreset.variants.testimonials, 'casebook-proof');
assert.equal(agencyCasebookPreset.variants.contact, 'agency-brief');

const groceryMarketPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'grocery-market');
assert.ok(groceryMarketPreset, 'grocery-market preset exists');
assert.deepEqual(groceryMarketPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(groceryMarketPreset.variants.hero, 'market-stall');
assert.equal(groceryMarketPreset.variants.services, 'market-groups');
assert.equal(groceryMarketPreset.variants.pricing, 'market-boxes');
assert.equal(groceryMarketPreset.variants.gallery, 'market-shelves');
assert.equal(groceryMarketPreset.variants.testimonials, 'fresh-proof');
assert.equal(groceryMarketPreset.variants.contact, 'market-order');

const electronicsCatalogPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'electronics-catalog');
assert.ok(electronicsCatalogPreset, 'electronics-catalog preset exists');
assert.deepEqual(electronicsCatalogPreset.sectionOrder, ['services', 'gallery', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(electronicsCatalogPreset.variants.hero, 'spec-catalog');
assert.equal(electronicsCatalogPreset.variants.services, 'spec-categories');
assert.equal(electronicsCatalogPreset.variants.pricing, 'product-bundles');
assert.equal(electronicsCatalogPreset.variants.gallery, 'product-specs');
assert.equal(electronicsCatalogPreset.variants.testimonials, 'buyer-support-proof');
assert.equal(electronicsCatalogPreset.variants.contact, 'product-advice');

const furnitureShowroomPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'furniture-showroom');
assert.ok(furnitureShowroomPreset, 'furniture-showroom preset exists');
assert.deepEqual(furnitureShowroomPreset.sectionOrder, ['gallery', 'services', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(furnitureShowroomPreset.variants.hero, 'showroom-floor');
assert.equal(furnitureShowroomPreset.variants.services, 'room-collections');
assert.equal(furnitureShowroomPreset.variants.pricing, 'showroom-packages');
assert.equal(furnitureShowroomPreset.variants.gallery, 'showroom-rooms');
assert.equal(furnitureShowroomPreset.variants.testimonials, 'showroom-proof');
assert.equal(furnitureShowroomPreset.variants.contact, 'showroom-visit');

const beautyBrandStorePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'beauty-brand-store');
assert.ok(beautyBrandStorePreset, 'beauty-brand-store preset exists');
assert.deepEqual(beautyBrandStorePreset.sectionOrder, ['services', 'gallery', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(beautyBrandStorePreset.variants.hero, 'beauty-routine');
assert.equal(beautyBrandStorePreset.variants.services, 'routine-sets');
assert.equal(beautyBrandStorePreset.variants.pricing, 'routine-kits');
assert.equal(beautyBrandStorePreset.variants.gallery, 'routine-shelf');
assert.equal(beautyBrandStorePreset.variants.testimonials, 'routine-proof');
assert.equal(beautyBrandStorePreset.variants.contact, 'routine-advice');

const subscriptionBoxPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'subscription-box');
assert.ok(subscriptionBoxPreset, 'subscription-box preset exists');
assert.deepEqual(subscriptionBoxPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(subscriptionBoxPreset.variants.hero, 'subscription-unbox');
assert.equal(subscriptionBoxPreset.variants.services, 'box-plans');
assert.equal(subscriptionBoxPreset.variants.pricing, 'box-subscriptions');
assert.equal(subscriptionBoxPreset.variants.gallery, 'box-unboxing');
assert.equal(subscriptionBoxPreset.variants.testimonials, 'subscriber-proof');
assert.equal(subscriptionBoxPreset.variants.contact, 'subscription-help');

const wholesaleCatalogPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'wholesale-catalog');
assert.ok(wholesaleCatalogPreset, 'wholesale-catalog preset exists');
assert.deepEqual(wholesaleCatalogPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(wholesaleCatalogPreset.variants.hero, 'wholesale-desk');
assert.equal(wholesaleCatalogPreset.variants.services, 'trade-ranges');
assert.equal(wholesaleCatalogPreset.variants.pricing, 'trade-terms');
assert.equal(wholesaleCatalogPreset.variants.gallery, 'trade-catalog');
assert.equal(wholesaleCatalogPreset.variants.testimonials, 'trade-proof');
assert.equal(wholesaleCatalogPreset.variants.contact, 'trade-account');

const handmadeBoutiquePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'handmade-boutique');
assert.ok(handmadeBoutiquePreset, 'handmade-boutique preset exists');
assert.deepEqual(handmadeBoutiquePreset.sectionOrder, ['gallery', 'services', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(handmadeBoutiquePreset.variants.hero, 'maker-boutique');
assert.equal(handmadeBoutiquePreset.variants.services, 'maker-ranges');
assert.equal(handmadeBoutiquePreset.variants.pricing, 'maker-offers');
assert.equal(handmadeBoutiquePreset.variants.gallery, 'maker-studio');
assert.equal(handmadeBoutiquePreset.variants.testimonials, 'maker-proof');
assert.equal(handmadeBoutiquePreset.variants.contact, 'custom-order');

const weddingVenuePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'wedding-venue');
assert.ok(weddingVenuePreset, 'wedding-venue preset exists');
assert.deepEqual(weddingVenuePreset.sectionOrder, ['gallery', 'services', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(weddingVenuePreset.variants.hero, 'venue-celebration');
assert.equal(weddingVenuePreset.variants.services, 'venue-packages');
assert.equal(weddingVenuePreset.variants.pricing, 'venue-packages');
assert.equal(weddingVenuePreset.variants.gallery, 'venue-spaces');
assert.equal(weddingVenuePreset.variants.testimonials, 'celebration-proof');
assert.equal(weddingVenuePreset.variants.contact, 'venue-date-check');

const eventPlannerPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'event-planner');
assert.ok(eventPlannerPreset, 'event-planner preset exists');
assert.deepEqual(eventPlannerPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(eventPlannerPreset.variants.hero, 'event-command');
assert.equal(eventPlannerPreset.variants.services, 'event-blueprint');
assert.equal(eventPlannerPreset.variants.pricing, 'event-packages');
assert.equal(eventPlannerPreset.variants.gallery, 'event-production');
assert.equal(eventPlannerPreset.variants.testimonials, 'event-proof');
assert.equal(eventPlannerPreset.variants.contact, 'event-brief');

const travelExperiencesPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'travel-experiences');
assert.ok(travelExperiencesPreset, 'travel-experiences preset exists');
assert.deepEqual(travelExperiencesPreset.sectionOrder, ['gallery', 'services', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(travelExperiencesPreset.variants.hero, 'journey-map');
assert.equal(travelExperiencesPreset.variants.services, 'itinerary-paths');
assert.equal(travelExperiencesPreset.variants.pricing, 'trip-options');
assert.equal(travelExperiencesPreset.variants.gallery, 'travel-scenes');
assert.equal(travelExperiencesPreset.variants.testimonials, 'traveller-proof');
assert.equal(travelExperiencesPreset.variants.contact, 'trip-enquiry');

const nonprofitCausePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'nonprofit-cause');
assert.ok(nonprofitCausePreset, 'nonprofit-cause preset exists');
assert.deepEqual(nonprofitCausePreset.sectionOrder, ['services', 'gallery', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(nonprofitCausePreset.variants.hero, 'cause-impact');
assert.equal(nonprofitCausePreset.variants.services, 'impact-programs');
assert.equal(nonprofitCausePreset.variants.pricing, 'donation-paths');
assert.equal(nonprofitCausePreset.variants.gallery, 'cause-stories');
assert.equal(nonprofitCausePreset.variants.testimonials, 'impact-proof');
assert.equal(nonprofitCausePreset.variants.contact, 'supporter-action');

const communityHubPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'community-hub');
assert.ok(communityHubPreset, 'community-hub preset exists');
assert.deepEqual(communityHubPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(communityHubPreset.variants.hero, 'community-welcome');
assert.equal(communityHubPreset.variants.services, 'community-programs');
assert.equal(communityHubPreset.variants.pricing, 'membership-options');
assert.equal(communityHubPreset.variants.gallery, 'community-moments');
assert.equal(communityHubPreset.variants.testimonials, 'member-proof');
assert.equal(communityHubPreset.variants.contact, 'participation-enquiry');

const churchMinistryPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'church-ministry');
assert.ok(churchMinistryPreset, 'church-ministry preset exists');
assert.deepEqual(churchMinistryPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(churchMinistryPreset.variants.hero, 'ministry-gathering');
assert.equal(churchMinistryPreset.variants.services, 'ministry-pathways');
assert.equal(churchMinistryPreset.variants.pricing, 'ministry-giving');
assert.equal(churchMinistryPreset.variants.gallery, 'ministry-life');
assert.equal(churchMinistryPreset.variants.testimonials, 'ministry-proof');
assert.equal(churchMinistryPreset.variants.contact, 'visit-ministry');

const chefTastingRoomPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'chef-tasting-room');
assert.ok(chefTastingRoomPreset, 'chef-tasting-room preset exists');
assert.deepEqual(chefTastingRoomPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'team', 'about', 'faq', 'contact']);
assert.equal(chefTastingRoomPreset.variants.hero, 'chef-table');
assert.equal(chefTastingRoomPreset.variants.services, 'tasting-menu');
assert.equal(chefTastingRoomPreset.variants.pricing, 'tasting-offers');
assert.equal(chefTastingRoomPreset.variants.gallery, 'chef-pass');
assert.equal(chefTastingRoomPreset.variants.testimonials, 'chef-proof');
assert.equal(chefTastingRoomPreset.variants.contact, 'tasting-reservation');

const cafeCounterPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'cafe-counter');
assert.ok(cafeCounterPreset, 'cafe-counter preset exists');
assert.deepEqual(cafeCounterPreset.sectionOrder, ['services', 'gallery', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(cafeCounterPreset.variants.hero, 'cafe-counter-hero');
assert.equal(cafeCounterPreset.variants.services, 'cafe-shelf');
assert.equal(cafeCounterPreset.variants.pricing, 'cafe-specials');
assert.equal(cafeCounterPreset.variants.gallery, 'cafe-display');
assert.equal(cafeCounterPreset.variants.testimonials, 'cafe-regulars');
assert.equal(cafeCounterPreset.variants.contact, 'cafe-order');

const barNightlifePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'bar-nightlife');
assert.ok(barNightlifePreset, 'bar-nightlife preset exists');
assert.deepEqual(barNightlifePreset.sectionOrder, ['services', 'gallery', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(barNightlifePreset.variants.hero, 'nightlife-stage');
assert.equal(barNightlifePreset.variants.services, 'bar-programs');
assert.equal(barNightlifePreset.variants.pricing, 'bar-packages');
assert.equal(barNightlifePreset.variants.gallery, 'nightlife-room');
assert.equal(barNightlifePreset.variants.testimonials, 'nightlife-proof');
assert.equal(barNightlifePreset.variants.contact, 'bar-booking');

const foodTruckPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'food-truck');
assert.ok(foodTruckPreset, 'food-truck preset exists');
assert.deepEqual(foodTruckPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(foodTruckPreset.variants.hero, 'truck-route');
assert.equal(foodTruckPreset.variants.services, 'truck-menu');
assert.equal(foodTruckPreset.variants.pricing, 'truck-catering');
assert.equal(foodTruckPreset.variants.gallery, 'truck-route-gallery');
assert.equal(foodTruckPreset.variants.testimonials, 'street-food-proof');
assert.equal(foodTruckPreset.variants.contact, 'truck-location');

const privateDiningPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'private-dining');
assert.ok(privateDiningPreset, 'private-dining preset exists');
assert.deepEqual(privateDiningPreset.sectionOrder, ['gallery', 'services', 'pricing', 'testimonials', 'team', 'about', 'faq', 'contact']);
assert.equal(privateDiningPreset.variants.hero, 'private-room');
assert.equal(privateDiningPreset.variants.services, 'private-dining-packages');
assert.equal(privateDiningPreset.variants.pricing, 'private-room-offers');
assert.equal(privateDiningPreset.variants.gallery, 'private-room-gallery');
assert.equal(privateDiningPreset.variants.testimonials, 'private-event-proof');
assert.equal(privateDiningPreset.variants.contact, 'private-dining-enquiry');

const bakeryDisplayPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'bakery-display');
assert.ok(bakeryDisplayPreset, 'bakery-display preset exists');
assert.deepEqual(bakeryDisplayPreset.sectionOrder, ['services', 'gallery', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(bakeryDisplayPreset.variants.hero, 'bakery-window');
assert.equal(bakeryDisplayPreset.variants.services, 'bakery-trays');
assert.equal(bakeryDisplayPreset.variants.pricing, 'bakery-offers');
assert.equal(bakeryDisplayPreset.variants.gallery, 'bakery-case');
assert.equal(bakeryDisplayPreset.variants.testimonials, 'bakery-proof');
assert.equal(bakeryDisplayPreset.variants.contact, 'bakery-order');

const cateringEventsPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'catering-events');
assert.ok(cateringEventsPreset, 'catering-events preset exists');
assert.deepEqual(cateringEventsPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(cateringEventsPreset.variants.hero, 'catering-brief');
assert.equal(cateringEventsPreset.variants.services, 'catering-packages');
assert.equal(cateringEventsPreset.variants.pricing, 'catering-menus');
assert.equal(cateringEventsPreset.variants.gallery, 'catering-spread');
assert.equal(cateringEventsPreset.variants.testimonials, 'catering-proof');
assert.equal(cateringEventsPreset.variants.contact, 'catering-quote');

const wineCellarPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'wine-cellar');
assert.ok(wineCellarPreset, 'wine-cellar preset exists');
assert.deepEqual(wineCellarPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(wineCellarPreset.variants.hero, 'cellar-door');
assert.equal(wineCellarPreset.variants.services, 'cellar-tastings');
assert.equal(wineCellarPreset.variants.pricing, 'cellar-memberships');
assert.equal(wineCellarPreset.variants.gallery, 'cellar-gallery');
assert.equal(wineCellarPreset.variants.testimonials, 'cellar-proof');
assert.equal(wineCellarPreset.variants.contact, 'cellar-booking');

const therapyCalmPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'therapy-calm');
assert.ok(therapyCalmPreset, 'therapy-calm preset exists');
assert.deepEqual(therapyCalmPreset.sectionOrder, ['services', 'pricing', 'testimonials', 'gallery', 'about', 'team', 'faq', 'contact']);
assert.equal(therapyCalmPreset.variants.hero, 'therapy-room');
assert.equal(therapyCalmPreset.variants.services, 'therapy-pathways');
assert.equal(therapyCalmPreset.variants.pricing, 'therapy-fees');
assert.equal(therapyCalmPreset.variants.gallery, 'calm-space');
assert.equal(therapyCalmPreset.variants.testimonials, 'therapy-proof');
assert.equal(therapyCalmPreset.variants.contact, 'therapy-enquiry');

const specialistPracticePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'specialist-practice');
assert.ok(specialistPracticePreset, 'specialist-practice preset exists');
assert.deepEqual(specialistPracticePreset.sectionOrder, ['services', 'team', 'pricing', 'testimonials', 'gallery', 'about', 'faq', 'contact']);
assert.equal(specialistPracticePreset.variants.hero, 'specialist-desk');
assert.equal(specialistPracticePreset.variants.services, 'specialist-care');
assert.equal(specialistPracticePreset.variants.pricing, 'specialist-options');
assert.equal(specialistPracticePreset.variants.gallery, 'specialist-suite');
assert.equal(specialistPracticePreset.variants.testimonials, 'specialist-proof');
assert.equal(specialistPracticePreset.variants.contact, 'specialist-referral');

const diagnosticLabPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'diagnostic-lab');
assert.ok(diagnosticLabPreset, 'diagnostic-lab preset exists');
assert.deepEqual(diagnosticLabPreset.sectionOrder, ['services', 'pricing', 'testimonials', 'gallery', 'about', 'team', 'faq', 'contact']);
assert.equal(diagnosticLabPreset.variants.hero, 'specialist-desk');
assert.equal(diagnosticLabPreset.variants.services, 'specialist-care');
assert.equal(diagnosticLabPreset.variants.pricing, 'specialist-options');
assert.equal(diagnosticLabPreset.variants.gallery, 'specialist-suite');
assert.equal(diagnosticLabPreset.variants.testimonials, 'specialist-proof');
assert.equal(diagnosticLabPreset.variants.contact, 'specialist-referral');

const veterinaryCarePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'veterinary-care');
assert.ok(veterinaryCarePreset, 'veterinary-care preset exists');
assert.deepEqual(veterinaryCarePreset.sectionOrder, ['services', 'team', 'pricing', 'testimonials', 'gallery', 'about', 'faq', 'contact']);
assert.equal(veterinaryCarePreset.variants.hero, 'vet-visit');
assert.equal(veterinaryCarePreset.variants.services, 'pet-care-pathways');
assert.equal(veterinaryCarePreset.variants.pricing, 'pet-care-plans');
assert.equal(veterinaryCarePreset.variants.gallery, 'pet-clinic-tour');
assert.equal(veterinaryCarePreset.variants.testimonials, 'pet-family-proof');
assert.equal(veterinaryCarePreset.variants.contact, 'pet-visit-request');

const skincareClinicPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'skincare-clinic');
assert.ok(skincareClinicPreset, 'skincare-clinic preset exists');
assert.deepEqual(skincareClinicPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'team', 'about', 'faq', 'contact']);
assert.equal(skincareClinicPreset.variants.hero, 'beauty-routine');
assert.equal(skincareClinicPreset.variants.services, 'routine-sets');
assert.equal(skincareClinicPreset.variants.pricing, 'routine-kits');
assert.equal(skincareClinicPreset.variants.gallery, 'routine-shelf');
assert.equal(skincareClinicPreset.variants.testimonials, 'routine-proof');
assert.equal(skincareClinicPreset.variants.contact, 'routine-advice');

const yogaStudioPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'yoga-studio');
assert.ok(yogaStudioPreset, 'yoga-studio preset exists');
assert.deepEqual(yogaStudioPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'team', 'about', 'faq', 'contact']);
assert.equal(yogaStudioPreset.variants.hero, 'coach-authority');
assert.equal(yogaStudioPreset.variants.services, 'coaching-paths');
assert.equal(yogaStudioPreset.variants.pricing, 'coaching-programs');
assert.equal(yogaStudioPreset.variants.gallery, 'coaching-board');
assert.equal(yogaStudioPreset.variants.testimonials, 'coaching-proof');
assert.equal(yogaStudioPreset.variants.contact, 'coaching-fit');

const wellnessCoachPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'wellness-coach');
assert.ok(wellnessCoachPreset, 'wellness-coach preset exists');
assert.deepEqual(wellnessCoachPreset.sectionOrder, ['services', 'pricing', 'testimonials', 'gallery', 'about', 'team', 'faq', 'contact']);
assert.equal(wellnessCoachPreset.variants.hero, 'coach-authority');
assert.equal(wellnessCoachPreset.variants.services, 'coaching-paths');
assert.equal(wellnessCoachPreset.variants.pricing, 'coaching-programs');
assert.equal(wellnessCoachPreset.variants.gallery, 'coaching-board');
assert.equal(wellnessCoachPreset.variants.testimonials, 'coaching-proof');
assert.equal(wellnessCoachPreset.variants.contact, 'coaching-fit');

const fitnessProgramPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'fitness-program');
assert.ok(fitnessProgramPreset, 'fitness-program preset exists');
assert.deepEqual(fitnessProgramPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'team', 'about', 'faq', 'contact']);
assert.equal(fitnessProgramPreset.variants.hero, 'training-sprint');
assert.equal(fitnessProgramPreset.variants.services, 'program-stack');
assert.equal(fitnessProgramPreset.variants.pricing, 'coaching-plans');
assert.equal(fitnessProgramPreset.variants.gallery, 'training-floor');
assert.equal(fitnessProgramPreset.variants.testimonials, 'progress-proof');
assert.equal(fitnessProgramPreset.variants.contact, 'goal-check');

const maternityCarePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'maternity-care');
assert.ok(maternityCarePreset, 'maternity-care preset exists');
assert.deepEqual(maternityCarePreset.sectionOrder, ['services', 'team', 'pricing', 'testimonials', 'gallery', 'about', 'faq', 'contact']);
assert.equal(maternityCarePreset.variants.hero, 'clinic-intake');
assert.equal(maternityCarePreset.variants.services, 'care-pathways');
assert.equal(maternityCarePreset.variants.pricing, 'visit-options');
assert.equal(maternityCarePreset.variants.gallery, 'clinic-tour');
assert.equal(maternityCarePreset.variants.testimonials, 'patient-proof');
assert.equal(maternityCarePreset.variants.contact, 'appointment-panel');

const cohortAcademyPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'cohort-academy');
assert.ok(cohortAcademyPreset, 'cohort-academy preset exists');
assert.deepEqual(cohortAcademyPreset.sectionOrder, ['services', 'pricing', 'testimonials', 'team', 'gallery', 'about', 'faq', 'contact']);
assert.equal(cohortAcademyPreset.variants.hero, 'course-launchpad');
assert.equal(cohortAcademyPreset.variants.services, 'module-stack');
assert.equal(cohortAcademyPreset.variants.pricing, 'cohort-options');
assert.equal(cohortAcademyPreset.variants.gallery, 'course-assets');
assert.equal(cohortAcademyPreset.variants.testimonials, 'cohort-proof');
assert.equal(cohortAcademyPreset.variants.contact, 'cohort-enquiry');

const preschoolWarmPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'preschool-warm');
assert.ok(preschoolWarmPreset, 'preschool-warm preset exists');
assert.deepEqual(preschoolWarmPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'team', 'pricing', 'about', 'faq', 'contact']);
assert.equal(preschoolWarmPreset.variants.hero, 'school-open-day');
assert.equal(preschoolWarmPreset.variants.services, 'learning-pathways');
assert.equal(preschoolWarmPreset.variants.pricing, 'enrolment-options');
assert.equal(preschoolWarmPreset.variants.gallery, 'campus-tour');
assert.equal(preschoolWarmPreset.variants.testimonials, 'family-outcomes');
assert.equal(preschoolWarmPreset.variants.contact, 'admissions-enquiry');

const languageInstitutePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'language-institute');
assert.ok(languageInstitutePreset, 'language-institute preset exists');
assert.deepEqual(languageInstitutePreset.sectionOrder, ['services', 'pricing', 'testimonials', 'gallery', 'team', 'about', 'faq', 'contact']);
assert.equal(languageInstitutePreset.variants.hero, 'tutor-plan');
assert.equal(languageInstitutePreset.variants.services, 'subject-pathways');
assert.equal(languageInstitutePreset.variants.pricing, 'tutoring-packages');
assert.equal(languageInstitutePreset.variants.gallery, 'learning-space');
assert.equal(languageInstitutePreset.variants.testimonials, 'learning-outcomes');
assert.equal(languageInstitutePreset.variants.contact, 'assessment-enquiry');

const classicPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'classic');
assert.ok(classicPreset, 'classic preset exists');
assert.deepEqual(classicPreset.sectionOrder, ['services', 'testimonials', 'pricing', 'gallery', 'about', 'team', 'faq', 'contact']);
assert.equal(classicPreset.variants.hero, 'service-front');
assert.equal(classicPreset.variants.services, 'service-pathways');
assert.equal(classicPreset.variants.pricing, 'service-options');
assert.equal(classicPreset.variants.gallery, 'service-gallery');
assert.equal(classicPreset.variants.testimonials, 'service-proof');
assert.equal(classicPreset.variants.contact, 'service-enquiry');

const magazinePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'magazine');
assert.ok(magazinePreset, 'magazine preset exists');
assert.deepEqual(magazinePreset.sectionOrder, ['gallery', 'services', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(magazinePreset.variants.hero, 'editorial-desk');
assert.equal(magazinePreset.variants.services, 'editorial-services');
assert.equal(magazinePreset.variants.pricing, 'editorial-packages');
assert.equal(magazinePreset.variants.gallery, 'editorial-clips');
assert.equal(magazinePreset.variants.testimonials, 'publication-proof');
assert.equal(magazinePreset.variants.contact, 'editorial-brief');

const minimalMonoPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'minimal-mono');
assert.ok(minimalMonoPreset, 'minimal-mono preset exists');
assert.deepEqual(minimalMonoPreset.sectionOrder, ['services', 'pricing', 'testimonials', 'about', 'team', 'gallery', 'faq', 'contact']);
assert.equal(minimalMonoPreset.variants.hero, 'service-front');
assert.equal(minimalMonoPreset.variants.services, 'service-pathways');
assert.equal(minimalMonoPreset.variants.pricing, 'service-options');
assert.equal(minimalMonoPreset.variants.gallery, 'service-gallery');
assert.equal(minimalMonoPreset.variants.testimonials, 'service-proof');
assert.equal(minimalMonoPreset.variants.contact, 'service-enquiry');

const boldSplitPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'bold-split');
assert.ok(boldSplitPreset, 'bold-split preset exists');
assert.deepEqual(boldSplitPreset.sectionOrder, ['services', 'testimonials', 'pricing', 'gallery', 'about', 'team', 'faq', 'contact']);
assert.equal(boldSplitPreset.variants.hero, 'agency-casebook');
assert.equal(boldSplitPreset.variants.services, 'agency-method');
assert.equal(boldSplitPreset.variants.pricing, 'agency-retainers');
assert.equal(boldSplitPreset.variants.gallery, 'agency-casebook');
assert.equal(boldSplitPreset.variants.testimonials, 'casebook-proof');
assert.equal(boldSplitPreset.variants.contact, 'agency-brief');

const wellnessWarmPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'wellness-warm');
assert.ok(wellnessWarmPreset, 'wellness-warm preset exists');
assert.deepEqual(wellnessWarmPreset.sectionOrder, ['services', 'pricing', 'gallery', 'testimonials', 'team', 'about', 'faq', 'contact']);
assert.equal(wellnessWarmPreset.variants.hero, 'spa-ritual');
assert.equal(wellnessWarmPreset.variants.services, 'ritual-menu');
assert.equal(wellnessWarmPreset.variants.pricing, 'treatment-rituals');
assert.equal(wellnessWarmPreset.variants.gallery, 'ritual-atmosphere');
assert.equal(wellnessWarmPreset.variants.testimonials, 'guest-calm-proof');
assert.equal(wellnessWarmPreset.variants.contact, 'ritual-booking');

const techGridPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'tech-grid');
assert.ok(techGridPreset, 'tech-grid preset exists');
assert.deepEqual(techGridPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(techGridPreset.variants.hero, 'developer-console');
assert.equal(techGridPreset.variants.services, 'system-builds');
assert.equal(techGridPreset.variants.pricing, 'technical-retainers');
assert.equal(techGridPreset.variants.gallery, 'system-screens');
assert.equal(techGridPreset.variants.testimonials, 'technical-proof');
assert.equal(techGridPreset.variants.contact, 'technical-brief');

const luxurySerifPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'luxury-serif');
assert.ok(luxurySerifPreset, 'luxury-serif preset exists');
assert.deepEqual(luxurySerifPreset.sectionOrder, ['gallery', 'services', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(luxurySerifPreset.variants.hero, 'artist-collection');
assert.equal(luxurySerifPreset.variants.services, 'collection-works');
assert.equal(luxurySerifPreset.variants.pricing, 'art-offers');
assert.equal(luxurySerifPreset.variants.gallery, 'art-collection');
assert.equal(luxurySerifPreset.variants.testimonials, 'collector-proof');
assert.equal(luxurySerifPreset.variants.contact, 'collector-enquiry');

const studioPortfolioPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'studio-portfolio');
assert.ok(studioPortfolioPreset, 'studio-portfolio preset exists');
assert.deepEqual(studioPortfolioPreset.sectionOrder, ['gallery', 'services', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(studioPortfolioPreset.variants.hero, 'portfolio-wall');
assert.equal(studioPortfolioPreset.variants.services, 'case-study-grid');
assert.equal(studioPortfolioPreset.variants.pricing, 'creative-packages');
assert.equal(studioPortfolioPreset.variants.gallery, 'portfolio-wall');
assert.equal(studioPortfolioPreset.variants.testimonials, 'project-proof');
assert.equal(studioPortfolioPreset.variants.contact, 'project-brief');

const consultancyPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'consultancy');
assert.ok(consultancyPreset, 'consultancy preset exists');
assert.deepEqual(consultancyPreset.sectionOrder, ['services', 'testimonials', 'pricing', 'gallery', 'team', 'about', 'faq', 'contact']);
assert.equal(consultancyPreset.variants.hero, 'diagnostic-room');
assert.equal(consultancyPreset.variants.services, 'diagnostic-offers');
assert.equal(consultancyPreset.variants.pricing, 'diagnostic-packages');
assert.equal(consultancyPreset.variants.gallery, 'diagnostic-workshop');
assert.equal(consultancyPreset.variants.testimonials, 'diagnostic-proof');
assert.equal(consultancyPreset.variants.contact, 'diagnostic-brief');

const agencyBoldPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'agency-bold');
assert.ok(agencyBoldPreset, 'agency-bold preset exists');
assert.deepEqual(agencyBoldPreset.sectionOrder, ['services', 'testimonials', 'pricing', 'gallery', 'team', 'about', 'faq', 'contact']);
assert.equal(agencyBoldPreset.variants.hero, 'agency-casebook');
assert.equal(agencyBoldPreset.variants.services, 'agency-method');
assert.equal(agencyBoldPreset.variants.pricing, 'agency-retainers');
assert.equal(agencyBoldPreset.variants.gallery, 'agency-casebook');
assert.equal(agencyBoldPreset.variants.testimonials, 'casebook-proof');
assert.equal(agencyBoldPreset.variants.contact, 'agency-brief');

const salonSoftPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'salon-soft');
assert.ok(salonSoftPreset, 'salon-soft preset exists');
assert.deepEqual(salonSoftPreset.sectionOrder, ['services', 'gallery', 'pricing', 'team', 'testimonials', 'about', 'faq', 'contact']);
assert.equal(salonSoftPreset.variants.hero, 'beauty-routine');
assert.equal(salonSoftPreset.variants.services, 'routine-sets');
assert.equal(salonSoftPreset.variants.pricing, 'routine-kits');
assert.equal(salonSoftPreset.variants.gallery, 'routine-shelf');
assert.equal(salonSoftPreset.variants.testimonials, 'routine-proof');
assert.equal(salonSoftPreset.variants.contact, 'routine-advice');

const creativeMosaicPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'creative-mosaic');
assert.ok(creativeMosaicPreset, 'creative-mosaic preset exists');
assert.deepEqual(creativeMosaicPreset.sectionOrder, ['gallery', 'services', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(creativeMosaicPreset.variants.hero, 'design-casefile');
assert.equal(creativeMosaicPreset.variants.services, 'design-process');
assert.equal(creativeMosaicPreset.variants.pricing, 'design-engagements');
assert.equal(creativeMosaicPreset.variants.gallery, 'case-study-wall');
assert.equal(creativeMosaicPreset.variants.testimonials, 'design-proof');
assert.equal(creativeMosaicPreset.variants.contact, 'design-brief');

const healthcarePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'healthcare');
assert.ok(healthcarePreset, 'healthcare preset exists');
assert.deepEqual(healthcarePreset.sectionOrder, ['services', 'about', 'team', 'testimonials', 'pricing', 'gallery', 'faq', 'contact']);
assert.equal(healthcarePreset.variants.hero, 'specialist-desk');
assert.equal(healthcarePreset.variants.services, 'specialist-care');
assert.equal(healthcarePreset.variants.pricing, 'specialist-options');
assert.equal(healthcarePreset.variants.gallery, 'specialist-suite');
assert.equal(healthcarePreset.variants.testimonials, 'patient-reassurance');
assert.equal(healthcarePreset.variants.contact, 'appointment-request');

const academyPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'academy');
assert.ok(academyPreset, 'academy preset exists');
assert.deepEqual(academyPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'team', 'pricing', 'about', 'faq', 'contact']);
assert.equal(academyPreset.variants.hero, 'school-open-day');
assert.equal(academyPreset.variants.services, 'learning-pathways');
assert.equal(academyPreset.variants.pricing, 'enrolment-options');
assert.equal(academyPreset.variants.gallery, 'campus-tour');
assert.equal(academyPreset.variants.testimonials, 'family-outcomes');
assert.equal(academyPreset.variants.contact, 'admissions-enquiry');

const commercePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'commerce');
assert.ok(commercePreset, 'commerce preset exists');
assert.deepEqual(commercePreset.sectionOrder, ['services', 'gallery', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(commercePreset.variants.hero, 'retail-drop');
assert.equal(commercePreset.variants.services, 'collection-shelf');
assert.equal(commercePreset.variants.pricing, 'collection-offers');
assert.equal(commercePreset.variants.gallery, 'commerce-lookbook');
assert.equal(commercePreset.variants.testimonials, 'buyer-notes');
assert.equal(commercePreset.variants.contact, 'shop-support');

const startupPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'startup');
assert.ok(startupPreset, 'startup preset exists');
assert.deepEqual(startupPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(startupPreset.variants.hero, 'developer-console');
assert.equal(startupPreset.variants.services, 'system-builds');
assert.equal(startupPreset.variants.pricing, 'technical-retainers');
assert.equal(startupPreset.variants.gallery, 'system-screens');
assert.equal(startupPreset.variants.testimonials, 'technical-proof');
assert.equal(startupPreset.variants.contact, 'technical-brief');

const personalBrandPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'personal-brand');
assert.ok(personalBrandPreset, 'personal-brand preset exists');
assert.deepEqual(personalBrandPreset.sectionOrder, ['services', 'testimonials', 'pricing', 'gallery', 'about', 'team', 'faq', 'contact']);
assert.equal(personalBrandPreset.variants.hero, 'coach-authority');
assert.equal(personalBrandPreset.variants.services, 'coaching-paths');
assert.equal(personalBrandPreset.variants.pricing, 'coaching-programs');
assert.equal(personalBrandPreset.variants.gallery, 'coaching-board');
assert.equal(personalBrandPreset.variants.testimonials, 'coaching-proof');
assert.equal(personalBrandPreset.variants.contact, 'coaching-fit');

const editorialFeaturePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'editorial-feature');
assert.ok(editorialFeaturePreset, 'editorial-feature preset exists');
assert.deepEqual(editorialFeaturePreset.sectionOrder, ['gallery', 'services', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(editorialFeaturePreset.variants.hero, 'editorial-desk');
assert.equal(editorialFeaturePreset.variants.services, 'editorial-services');
assert.equal(editorialFeaturePreset.variants.pricing, 'editorial-packages');
assert.equal(editorialFeaturePreset.variants.gallery, 'editorial-clips');
assert.equal(editorialFeaturePreset.variants.testimonials, 'publication-proof');
assert.equal(editorialFeaturePreset.variants.contact, 'editorial-brief');

const bentoModernPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'bento-modern');
assert.ok(bentoModernPreset, 'bento-modern preset exists');
assert.deepEqual(bentoModernPreset.sectionOrder, ['services', 'testimonials', 'pricing', 'gallery', 'about', 'team', 'faq', 'contact']);
assert.equal(bentoModernPreset.variants.hero, 'service-front');
assert.equal(bentoModernPreset.variants.services, 'service-pathways');
assert.equal(bentoModernPreset.variants.pricing, 'service-options');
assert.equal(bentoModernPreset.variants.gallery, 'service-gallery');
assert.equal(bentoModernPreset.variants.testimonials, 'service-proof');
assert.equal(bentoModernPreset.variants.contact, 'service-enquiry');

const boutiqueCardPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'boutique-card');
assert.ok(boutiqueCardPreset, 'boutique-card preset exists');
assert.deepEqual(boutiqueCardPreset.sectionOrder, ['gallery', 'services', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(boutiqueCardPreset.variants.hero, 'maker-boutique');
assert.equal(boutiqueCardPreset.variants.services, 'maker-ranges');
assert.equal(boutiqueCardPreset.variants.pricing, 'maker-offers');
assert.equal(boutiqueCardPreset.variants.gallery, 'maker-studio');
assert.equal(boutiqueCardPreset.variants.testimonials, 'maker-proof');
assert.equal(boutiqueCardPreset.variants.contact, 'custom-order');

const saasLaunchPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'saas-launch');
assert.ok(saasLaunchPreset, 'saas-launch preset exists');
assert.deepEqual(saasLaunchPreset.sectionOrder, ['services', 'gallery', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(saasLaunchPreset.variants.hero, 'developer-console');
assert.equal(saasLaunchPreset.variants.services, 'system-builds');
assert.equal(saasLaunchPreset.variants.pricing, 'technical-retainers');
assert.equal(saasLaunchPreset.variants.gallery, 'system-screens');
assert.equal(saasLaunchPreset.variants.testimonials, 'technical-proof');
assert.equal(saasLaunchPreset.variants.contact, 'technical-brief');

const studioFeaturePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'studio-feature');
assert.ok(studioFeaturePreset, 'studio-feature preset exists');
assert.deepEqual(studioFeaturePreset.sectionOrder, ['gallery', 'services', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(studioFeaturePreset.variants.hero, 'design-casefile');
assert.equal(studioFeaturePreset.variants.services, 'design-process');
assert.equal(studioFeaturePreset.variants.pricing, 'design-engagements');
assert.equal(studioFeaturePreset.variants.gallery, 'case-study-wall');
assert.equal(studioFeaturePreset.variants.testimonials, 'design-proof');
assert.equal(studioFeaturePreset.variants.contact, 'design-brief');

const retailBentoPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'retail-bento');
assert.ok(retailBentoPreset, 'retail-bento preset exists');
assert.deepEqual(retailBentoPreset.sectionOrder, ['services', 'gallery', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(retailBentoPreset.variants.hero, 'retail-drop');
assert.equal(retailBentoPreset.variants.services, 'collection-shelf');
assert.equal(retailBentoPreset.variants.pricing, 'collection-offers');
assert.equal(retailBentoPreset.variants.gallery, 'commerce-lookbook');
assert.equal(retailBentoPreset.variants.testimonials, 'buyer-notes');
assert.equal(retailBentoPreset.variants.contact, 'shop-support');

const clinicTimelinePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'clinic-timeline');
assert.ok(clinicTimelinePreset, 'clinic-timeline preset exists');
assert.deepEqual(clinicTimelinePreset.sectionOrder, ['about', 'services', 'team', 'testimonials', 'pricing', 'gallery', 'faq', 'contact']);
assert.equal(clinicTimelinePreset.variants.hero, 'clinic-intake');
assert.equal(clinicTimelinePreset.variants.services, 'care-pathways');
assert.equal(clinicTimelinePreset.variants.pricing, 'treatment-fees');
assert.equal(clinicTimelinePreset.variants.gallery, 'dental-suite');
assert.equal(clinicTimelinePreset.variants.testimonials, 'family-outcomes');
assert.equal(clinicTimelinePreset.variants.contact, 'appointment-request');

const editorialMonoPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'editorial-mono');
assert.ok(editorialMonoPreset, 'editorial-mono preset exists');
assert.deepEqual(editorialMonoPreset.sectionOrder, ['gallery', 'services', 'testimonials', 'pricing', 'about', 'team', 'faq', 'contact']);
assert.equal(editorialMonoPreset.variants.hero, 'editorial-desk');
assert.equal(editorialMonoPreset.variants.services, 'editorial-services');
assert.equal(editorialMonoPreset.variants.pricing, 'editorial-packages');
assert.equal(editorialMonoPreset.variants.gallery, 'editorial-clips');
assert.equal(editorialMonoPreset.variants.testimonials, 'publication-proof');
assert.equal(editorialMonoPreset.variants.contact, 'editorial-brief');

const agencyFeaturePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'agency-feature');
assert.ok(agencyFeaturePreset, 'agency-feature preset exists');
assert.deepEqual(agencyFeaturePreset.sectionOrder, ['services', 'testimonials', 'pricing', 'gallery', 'team', 'about', 'faq', 'contact']);
assert.equal(agencyFeaturePreset.variants.hero, 'agency-casebook');
assert.equal(agencyFeaturePreset.variants.services, 'agency-method');
assert.equal(agencyFeaturePreset.variants.pricing, 'agency-retainers');
assert.equal(agencyFeaturePreset.variants.gallery, 'agency-casebook');
assert.equal(agencyFeaturePreset.variants.testimonials, 'casebook-proof');
assert.equal(agencyFeaturePreset.variants.contact, 'agency-brief');

const boutiqueBentoPreset = LAYOUT_PRESETS.find((preset) => preset.key === 'boutique-bento');
assert.ok(boutiqueBentoPreset, 'boutique-bento preset exists');
assert.deepEqual(boutiqueBentoPreset.sectionOrder, ['gallery', 'services', 'pricing', 'testimonials', 'about', 'team', 'faq', 'contact']);
assert.equal(boutiqueBentoPreset.variants.hero, 'beauty-routine');
assert.equal(boutiqueBentoPreset.variants.services, 'routine-sets');
assert.equal(boutiqueBentoPreset.variants.pricing, 'routine-kits');
assert.equal(boutiqueBentoPreset.variants.gallery, 'routine-shelf');
assert.equal(boutiqueBentoPreset.variants.testimonials, 'routine-proof');
assert.equal(boutiqueBentoPreset.variants.contact, 'routine-advice');

const trainingEnterprisePreset = LAYOUT_PRESETS.find((preset) => preset.key === 'training-enterprise');
assert.ok(trainingEnterprisePreset, 'training-enterprise preset exists');
assert.deepEqual(trainingEnterprisePreset.sectionOrder, ['services', 'pricing', 'testimonials', 'team', 'gallery', 'about', 'faq', 'contact']);
assert.equal(trainingEnterprisePreset.variants.hero, 'course-launchpad');
assert.equal(trainingEnterprisePreset.variants.services, 'module-stack');
assert.equal(trainingEnterprisePreset.variants.pricing, 'cohort-options');
assert.equal(trainingEnterprisePreset.variants.gallery, 'course-assets');
assert.equal(trainingEnterprisePreset.variants.testimonials, 'cohort-proof');
assert.equal(trainingEnterprisePreset.variants.contact, 'cohort-enquiry');

for (const preset of LAYOUT_PRESETS) {
  for (const [section, variant] of Object.entries(preset.variants)) {
    assert.ok(SECTION_KEYS.has(section), `Unknown section ${section} in ${preset.key}`);
    assert.ok((AVAILABLE_VARIANTS[section] || []).includes(variant), `Unknown variant ${section}.${variant} in ${preset.key}`);
  }
}

assert.deepEqual(
  sanitizeSectionVariants({ hero: 'card-stack', notASection: 'x', services: '', about: 42 }),
  { hero: 'card-stack' },
);

console.log('layout preset tests passed');
