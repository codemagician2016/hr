// Intake form helpers — pure logic for field validation + conditional
// show/hide. Used by both the admin form-builder API and the customer
// submission endpoint.
'use strict';

const FIELD_TYPES = Object.freeze([
  'text',
  'textarea',
  'email',
  'phone',
  'number',
  'select',
  'radio',
  'checkbox',
  'date',
  'file',
  'signature',
  'markdown', // read-only info text shown to customer
]);

const TYPES_NEEDING_OPTIONS = Object.freeze(new Set(['select', 'radio', 'checkbox']));

// Validate a single field definition. Returns null if valid, error string if not.
function validateFieldDef(field) {
  if (!field || typeof field !== 'object') return 'Field must be an object';
  if (!field.id || typeof field.id !== 'string') return 'Field id is required';
  if (!FIELD_TYPES.includes(field.type)) return `Field type "${field.type}" not supported`;
  if (field.type !== 'markdown' && (!field.label || typeof field.label !== 'string')) {
    return 'Field label is required for non-markdown types';
  }
  if (TYPES_NEEDING_OPTIONS.has(field.type)) {
    if (!Array.isArray(field.options) || field.options.length === 0) {
      return `${field.type} field must have options[]`;
    }
  }
  if (field.showIf) {
    const { fieldId, operator, value } = field.showIf;
    if (!fieldId || typeof fieldId !== 'string') return 'showIf.fieldId is required';
    if (!['equals', 'notEquals', 'contains', 'notEmpty'].includes(operator)) {
      return `showIf.operator "${operator}" not supported`;
    }
  }
  return null;
}

// Validate a complete fields[] array. Returns { ok, errors[] }.
function validateFieldsArray(fields) {
  if (!Array.isArray(fields)) return { ok: false, errors: ['fields must be an array'] };
  const errors = [];
  const seenIds = new Set();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const err = validateFieldDef(f);
    if (err) {
      errors.push(`Field ${i}: ${err}`);
      continue;
    }
    if (seenIds.has(f.id)) errors.push(`Field ${i}: duplicate id "${f.id}"`);
    seenIds.add(f.id);
  }
  return { ok: errors.length === 0, errors };
}

// Conditional logic engine. Evaluates whether a field should be visible
// given the current answers. Pure function — used by both server-side
// (server-side rendering) and client-side (live show/hide).
function shouldShow({ field, answers }) {
  if (!field?.showIf) return true;
  const { fieldId, operator, value } = field.showIf;
  const a = answers?.[fieldId];
  switch (operator) {
    case 'equals':    return a === value;
    case 'notEquals': return a !== value;
    case 'contains':  return Array.isArray(a) ? a.includes(value) : String(a || '').includes(String(value));
    case 'notEmpty':  return a != null && a !== '' && (!Array.isArray(a) || a.length > 0);
    default:          return true;
  }
}

// Validate a submission against the form definition. Returns
// { ok, errors[] }. Errors are field-level: [{ fieldId, message }].
function validateSubmission({ fields, answers }) {
  const errors = [];
  const ans = answers || {};
  for (const f of fields || []) {
    if (!shouldShow({ field: f, answers: ans })) continue; // hidden fields skip validation
    if (f.type === 'markdown') continue; // read-only, no answer required
    const value = ans[f.id];
    const isEmpty = value == null
      || value === ''
      || (Array.isArray(value) && value.length === 0);
    if (f.required && isEmpty) {
      errors.push({ fieldId: f.id, message: `${f.label} is required` });
      continue;
    }
    if (isEmpty) continue; // optional + empty → fine

    // Type-specific validation
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) {
      errors.push({ fieldId: f.id, message: `${f.label} must be a valid email` });
    } else if (f.type === 'number' && Number.isNaN(Number(value))) {
      errors.push({ fieldId: f.id, message: `${f.label} must be a number` });
    } else if (f.type === 'phone' && String(value).replace(/\D/g, '').length < 7) {
      errors.push({ fieldId: f.id, message: `${f.label} must be a valid phone` });
    } else if (f.type === 'select' || f.type === 'radio') {
      if (!Array.isArray(f.options) || !f.options.includes(value)) {
        errors.push({ fieldId: f.id, message: `${f.label} value not in allowed options` });
      }
    } else if (f.type === 'checkbox') {
      if (!Array.isArray(value)) {
        errors.push({ fieldId: f.id, message: `${f.label} must be an array` });
      } else {
        const opts = Array.isArray(f.options) ? f.options : [];
        for (const v of value) {
          if (!opts.includes(v)) {
            errors.push({ fieldId: f.id, message: `${f.label} contains invalid option "${v}"` });
            break;
          }
        }
      }
    } else if (f.type === 'date' && Number.isNaN(Date.parse(String(value)))) {
      errors.push({ fieldId: f.id, message: `${f.label} must be a valid date` });
    } else if (f.type === 'signature' && !String(value).startsWith('data:image/')) {
      errors.push({ fieldId: f.id, message: `${f.label} must be a captured signature` });
    } else if (f.type === 'file' && !Array.isArray(value) && typeof value !== 'string') {
      errors.push({ fieldId: f.id, message: `${f.label} upload missing` });
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  FIELD_TYPES,
  TYPES_NEEDING_OPTIONS,
  validateFieldDef,
  validateFieldsArray,
  shouldShow,
  validateSubmission,
};
