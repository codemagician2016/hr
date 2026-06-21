import { describe, expect, test } from 'vitest';
import {
  COMMON_BODY_FIELDS,
  DOCUMENT_BODY_PLUGINS,
  getBodyFieldsForPlugin,
  getDocumentPluginForTheme,
  getDocumentTypesForTheme,
  getLetterheadGroupsForPlugin,
  normalizeDocumentThemeKey,
} from '../lib/documentPlugins.js';

function ids(items) {
  return items.map((item) => item.id);
}

function flattenedLetterheadFieldIds(pluginId) {
  return getLetterheadGroupsForPlugin(pluginId).flatMap((group) => ids(group.fields));
}

describe('document plugin registry', () => {
  test('normalizes source theme keys consistently', () => {
    expect(normalizeDocumentThemeKey('Doctor Clinic')).toBe('doctor_clinic');
    expect(normalizeDocumentThemeKey('fitness-trainer')).toBe('fitness_trainer');
    expect(normalizeDocumentThemeKey('  Law & Firm  ')).toBe('law_firm');
  });

  test('maps doctor themes to medical body fields only', () => {
    const plugin = getDocumentPluginForTheme('doctor_clinic');
    expect(plugin.id).toBe('doctor_medical');
    expect(ids(getDocumentTypesForTheme('doctor_clinic'))).toEqual([
      'prescription',
      'medical_certificate',
      'follow_up_note',
    ]);

    const fieldIds = ids(getBodyFieldsForPlugin(plugin.id));
    expect(fieldIds).toContain('client_name');
    expect(fieldIds).toContain('rx_section');
    expect(fieldIds).toContain('diagnosis_notes');
    expect(fieldIds).not.toContain('case_number');
    expect(fieldIds).not.toContain('pet_name');
  });

  test('maps legal themes to legal body fields only', () => {
    const plugin = getDocumentPluginForTheme('family-lawyer');
    expect(plugin.id).toBe('lawyer_legal');
    expect(ids(getDocumentTypesForTheme('law_firm'))).toContain('legal_notice');
    expect(ids(getDocumentTypesForTheme('law_firm'))).toContain('engagement_letter');

    const fieldIds = ids(getBodyFieldsForPlugin(plugin.id));
    expect(fieldIds).toContain('case_number');
    expect(fieldIds).toContain('matter_type');
    expect(fieldIds).not.toContain('rx_section');
    expect(fieldIds).not.toContain('session_type');
  });

  test('maps veterinary themes to pet fields and its own Rx section', () => {
    const plugin = getDocumentPluginForTheme('pet-hospital');
    expect(plugin.id).toBe('veterinary');

    const fieldIds = ids(getBodyFieldsForPlugin(plugin.id));
    expect(fieldIds).toContain('pet_name');
    expect(fieldIds).toContain('owner_name');
    expect(fieldIds).toContain('rx_section');
    expect(fieldIds).not.toContain('patient_age');
    expect(fieldIds).not.toContain('case_number');
  });

  test('maps wellness themes to session fields', () => {
    const plugin = getDocumentPluginForTheme('gym');
    expect(plugin.id).toBe('wellness_fitness');

    const fieldIds = ids(getBodyFieldsForPlugin(plugin.id));
    expect(fieldIds).toContain('session_type');
    expect(fieldIds).toContain('health_disclaimer');
    expect(fieldIds).not.toContain('diagnosis_notes');
    expect(fieldIds).not.toContain('meeting_link');
  });

  test('falls back unknown themes to the general business plugin', () => {
    const plugin = getDocumentPluginForTheme('unknown-theme');
    expect(plugin.id).toBe('business_consultant');

    const fieldIds = ids(getBodyFieldsForPlugin(plugin.id));
    expect(fieldIds).toContain('service_type');
    expect(fieldIds).toContain('meeting_type');
  });

  test('maps accounting and tax themes to business documents, not legal case documents', () => {
    const plugin = getDocumentPluginForTheme('ca-tax-consultant');
    expect(plugin.id).toBe('business_consultant');

    const fieldIds = ids(getBodyFieldsForPlugin(plugin.id));
    expect(fieldIds).toContain('agenda');
    expect(fieldIds).not.toContain('case_number');
    expect(fieldIds).not.toContain('court_date');
  });

  test('keeps common booking fields separate from profession fields', () => {
    const commonIds = ids(COMMON_BODY_FIELDS);
    expect(commonIds).toContain('booking_reference');
    expect(commonIds).toContain('appointment_date');

    const doctorOnlyIds = ids(getBodyFieldsForPlugin('doctor_medical', { includeCommon: false }));
    expect(doctorOnlyIds).toContain('diagnosis_notes');
    expect(doctorOnlyIds).not.toContain('booking_reference');
  });

  test('filters professional letterhead IDs by plugin', () => {
    expect(flattenedLetterheadFieldIds('doctor_medical')).toContain('registration_number');
    expect(flattenedLetterheadFieldIds('doctor_medical')).not.toContain('license_number');

    expect(flattenedLetterheadFieldIds('lawyer_legal')).toContain('registration_number');
    expect(flattenedLetterheadFieldIds('lawyer_legal')).not.toContain('license_number');

    expect(flattenedLetterheadFieldIds('business_consultant')).toContain('license_number');
    expect(flattenedLetterheadFieldIds('business_consultant')).not.toContain('registration_number');
  });

  test('keeps registry IDs unique', () => {
    expect(new Set(ids(DOCUMENT_BODY_PLUGINS)).size).toBe(DOCUMENT_BODY_PLUGINS.length);

    for (const plugin of DOCUMENT_BODY_PLUGINS) {
      expect(new Set(ids(plugin.documentTypes)).size).toBe(plugin.documentTypes.length);
      expect(new Set(ids(plugin.fields)).size).toBe(plugin.fields.length);
    }
  });

  test('does not assign one theme key to multiple plugins', () => {
    const seen = new Map();

    for (const plugin of DOCUMENT_BODY_PLUGINS) {
      for (const themeKey of plugin.themeKeys) {
        expect(seen.get(themeKey)).toBeUndefined();
        seen.set(themeKey, plugin.id);
      }
    }
  });
});
