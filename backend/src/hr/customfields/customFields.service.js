'use strict';

/**
 * customFields.service.js — Phase 5b. Tenant-defined typed fields on the Employee
 * entity + their per-employee values. Pure validators/normalisers (no DB) plus a thin
 * Prisma CRUD layer, mirroring the Survey/SurveyQuestion/SurveyAnswer definition+value
 * precedent (engagement/surveys/survey.service.js): type-set guards as `new Set([...])`,
 * pure validators that return normalised values, HTTP shaping left to the controllers.
 *
 * A value lives in exactly ONE of four typed columns (textValue / numberValue /
 * dateValue / boolValue); the other three are NULL. SELECT stores the chosen option's
 * `value` in textValue. Clearing a field deletes its row (the read left-joins to null),
 * so the value table stays sparse. `key` + `fieldType` are IMMUTABLE after create — the
 * typed columns a value occupies depend on them.
 */

const TYPE_SET = new Set(['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN']);
const ESS_POLICY_SET = new Set(['HIDDEN', 'READ_ONLY', 'SELF_EDIT']);
const ENTITY_SET = new Set(['EMPLOYEE']);

// The four typed value columns, all-null (a "cleared" value).
const NULL_COLUMNS = { textValue: null, numberValue: null, dateValue: null, boolValue: null };

// ── error helper (status/code carried on the thrown Error; controllers map it) ──
function err(status, code, message, extra) {
  const e = new Error(message || code);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// ── key slug ─────────────────────────────────────────────────────────────────
// lowercase, trim, spaces/dashes → underscore, strip non [a-z0-9_], collapse repeats.
function slugifyKey(raw) {
  const s = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_') // spaces + dashes → underscore
    .replace(/[^a-z0-9_]+/g, '') // drop anything not a-z 0-9 _
    .replace(/_+/g, '_') // collapse repeats
    .replace(/^_+|_+$/g, ''); // trim edge underscores
  if (!s) throw err(422, 'INVALID_KEY', 'key must contain at least one alphanumeric character');
  return s;
}

// ── SELECT options: non-empty array of unique { value, label } (both non-empty) ──
function normaliseOptions(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw err(422, 'INVALID_OPTIONS', 'SELECT fields require a non-empty options array');
  }
  const seen = new Set();
  const out = [];
  for (const o of raw) {
    const value = o && o.value != null ? String(o.value).trim() : '';
    const label = o && o.label != null ? String(o.label).trim() : '';
    if (!value || !label) throw err(422, 'INVALID_OPTIONS', 'each option needs a non-empty { value, label }');
    if (seen.has(value)) throw err(422, 'INVALID_OPTIONS', `duplicate option value "${value}"`);
    seen.add(value);
    out.push({ value, label });
  }
  return out;
}

// ── definition create-input validation → a normalised create object ───────────
function validateDefinitionInput(body = {}) {
  const b = body || {};
  const fieldType = b.fieldType == null ? '' : String(b.fieldType).toUpperCase();
  if (!TYPE_SET.has(fieldType)) throw err(422, 'INVALID_TYPE', `Unknown fieldType "${b.fieldType}"`);

  const label = b.label == null ? '' : String(b.label).trim();
  if (!label) throw err(422, 'INVALID_LABEL', 'label is required');

  const essPolicy = b.essPolicy == null ? 'READ_ONLY' : String(b.essPolicy).toUpperCase();
  if (!ESS_POLICY_SET.has(essPolicy)) throw err(422, 'INVALID_ESS_POLICY', `Unknown essPolicy "${b.essPolicy}"`);

  const entityType = b.entityType == null ? 'EMPLOYEE' : String(b.entityType).toUpperCase();
  if (!ENTITY_SET.has(entityType)) throw err(422, 'INVALID_ENTITY', `Unknown entityType "${b.entityType}"`);

  // key: explicit key wins, else derive the slug from the label.
  const key = slugifyKey(b.key != null && String(b.key).trim() ? b.key : label);

  // SELECT carries options; every other type forces options = null.
  const options = fieldType === 'SELECT' ? normaliseOptions(b.options) : null;

  return {
    entityType,
    fieldType,
    key,
    label,
    description: b.description == null ? null : String(b.description),
    options,
    required: b.required === true,
    essVisible: b.essVisible === true,
    essPolicy,
    section: b.section == null || String(b.section).trim() === '' ? null : String(b.section).trim(),
    orderIndex: Number.isInteger(b.orderIndex) ? b.orderIndex : 0,
    isActive: b.isActive === false ? false : true,
  };
}

// ── value coercion helpers ────────────────────────────────────────────────────
function isBlank(raw) {
  return raw == null || (typeof raw === 'string' && raw.trim() === '');
}

function coerceBool(raw) {
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0) return false;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return null;
}

/**
 * validateValue(def, raw) → { ok, columns, error }. `columns` is the four typed
 * columns to persist (the ones this type doesn't use are null). A null/undefined/''
 * raw clears the value (all-null columns) UNLESS the def is required (→ REQUIRED).
 */
function validateValue(def, raw) {
  // A blank raw is a clear request — rejected only when the field is required.
  if (isBlank(raw)) {
    if (def.required) return { ok: false, error: 'REQUIRED' };
    return { ok: true, columns: { ...NULL_COLUMNS } };
  }
  const columns = { ...NULL_COLUMNS };
  switch (def.fieldType) {
    case 'TEXT': {
      const s = String(raw).trim();
      if (!s) return def.required ? { ok: false, error: 'REQUIRED' } : { ok: true, columns };
      columns.textValue = s;
      return { ok: true, columns };
    }
    case 'NUMBER': {
      const n = Number(raw);
      if (Number.isNaN(n)) return { ok: false, error: 'NOT_A_NUMBER' };
      columns.numberValue = n;
      return { ok: true, columns };
    }
    case 'DATE': {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return { ok: false, error: 'INVALID_DATE' };
      columns.dateValue = d;
      return { ok: true, columns };
    }
    case 'BOOLEAN': {
      const bVal = coerceBool(raw);
      if (bVal === null) return { ok: false, error: 'NOT_A_BOOLEAN' };
      columns.boolValue = bVal;
      return { ok: true, columns };
    }
    case 'SELECT': {
      const v = String(raw).trim();
      const opts = Array.isArray(def.options) ? def.options : [];
      if (!opts.some((o) => o && String(o.value) === v)) return { ok: false, error: 'INVALID_OPTION' };
      columns.textValue = v;
      return { ok: true, columns };
    }
    default:
      return { ok: false, error: 'UNKNOWN_TYPE' };
  }
}

/** readValue(def, valueRow) → the scalar JS value for API responses (null if no row). */
function readValue(def, valueRow) {
  if (!valueRow) return null;
  switch (def.fieldType) {
    case 'TEXT':
    case 'SELECT':
      return valueRow.textValue == null ? null : valueRow.textValue;
    case 'NUMBER':
      return valueRow.numberValue == null ? null : valueRow.numberValue;
    case 'DATE':
      return valueRow.dateValue == null ? null : new Date(valueRow.dateValue).toISOString();
    case 'BOOLEAN':
      return valueRow.boolValue == null ? null : valueRow.boolValue;
    default:
      return null;
  }
}

/** The trimmed, public definition shape returned to admin + ESS. */
function publicDefinition(def) {
  return {
    id: def.id,
    key: def.key,
    label: def.label,
    description: def.description,
    fieldType: def.fieldType,
    options: def.options || null,
    required: def.required,
    essVisible: def.essVisible,
    essPolicy: def.essPolicy,
    section: def.section,
    orderIndex: def.orderIndex,
  };
}

const activeWhere = (businessId, entityType) => ({ businessId, entityType, isActive: true, deletedAt: null });

// ── definition CRUD ───────────────────────────────────────────────────────────
async function listDefinitions(prisma, businessId, { entityType = 'EMPLOYEE', includeInactive = false } = {}) {
  const where = { businessId, entityType, deletedAt: null };
  if (!includeInactive) where.isActive = true;
  return prisma.customFieldDefinition.findMany({
    where,
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
  });
}

async function createDefinition(prisma, businessId, body) {
  const norm = validateDefinitionInput(body);
  try {
    return await prisma.customFieldDefinition.create({ data: { businessId, ...norm } });
  } catch (e) {
    // @@unique([businessId, entityType, key]) — a duplicate key for this tenant.
    if (e && e.code === 'P2002') throw err(409, 'DUPLICATE_KEY', `A custom field with key "${norm.key}" already exists`);
    throw e;
  }
}

async function updateDefinition(prisma, businessId, id, body = {}) {
  const existing = await prisma.customFieldDefinition.findFirst({ where: { id, businessId } });
  if (!existing) throw err(404, 'NOT_FOUND', 'Custom field definition not found');
  const b = body || {};

  // key + fieldType are IMMUTABLE after create (the value columns depend on them).
  if (b.fieldType != null && String(b.fieldType).toUpperCase() !== existing.fieldType) {
    throw err(422, 'IMMUTABLE_FIELD_TYPE', 'fieldType cannot be changed after creation');
  }
  if (b.key != null && slugifyKey(b.key) !== existing.key) {
    throw err(422, 'IMMUTABLE_KEY', 'key cannot be changed after creation');
  }

  const data = { version: { increment: 1 } };
  if (b.label !== undefined) {
    const label = b.label == null ? '' : String(b.label).trim();
    if (!label) throw err(422, 'INVALID_LABEL', 'label cannot be empty');
    data.label = label;
  }
  if (b.description !== undefined) data.description = b.description == null ? null : String(b.description);
  if (b.required !== undefined) data.required = b.required === true;
  if (b.essVisible !== undefined) data.essVisible = b.essVisible === true;
  if (b.essPolicy !== undefined) {
    const p = String(b.essPolicy).toUpperCase();
    if (!ESS_POLICY_SET.has(p)) throw err(422, 'INVALID_ESS_POLICY', `Unknown essPolicy "${b.essPolicy}"`);
    data.essPolicy = p;
  }
  if (b.section !== undefined) {
    data.section = b.section == null || String(b.section).trim() === '' ? null : String(b.section).trim();
  }
  if (b.orderIndex !== undefined && Number.isInteger(b.orderIndex)) data.orderIndex = b.orderIndex;
  if (b.isActive !== undefined) {
    data.isActive = b.isActive === true;
    // Re-activating an archived def also clears the soft-delete stamp.
    if (b.isActive === true) data.deletedAt = null;
  }
  // options are editable ONLY on a SELECT def; forced null on every other type.
  if (b.options !== undefined) {
    data.options = existing.fieldType === 'SELECT' ? normaliseOptions(b.options) : null;
  }

  return prisma.customFieldDefinition.update({ where: { id: existing.id }, data });
}

// Soft archive — hide the def but keep its historical values intact.
async function archiveDefinition(prisma, businessId, id) {
  const existing = await prisma.customFieldDefinition.findFirst({ where: { id, businessId } });
  if (!existing) throw err(404, 'NOT_FOUND', 'Custom field definition not found');
  return prisma.customFieldDefinition.update({
    where: { id: existing.id },
    data: { isActive: false, deletedAt: new Date(), version: { increment: 1 } },
  });
}

// ── per-employee values ───────────────────────────────────────────────────────
/**
 * getEmployeeCustomFields → [{ definition, value }] for all ACTIVE defs (optionally
 * essVisible-only), left-joined to this employee's value rows (value is null when unset).
 */
async function getEmployeeCustomFields(prisma, businessId, employeeId, { essVisibleOnly = false } = {}) {
  const where = activeWhere(businessId, 'EMPLOYEE');
  if (essVisibleOnly) where.essVisible = true;
  const defs = await prisma.customFieldDefinition.findMany({
    where,
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
  });
  if (defs.length === 0) return [];
  const rows = await prisma.customFieldValue.findMany({
    where: { businessId, employeeId, definitionId: { in: defs.map((d) => d.id) } },
  });
  const byDef = new Map(rows.map((r) => [r.definitionId, r]));
  return defs.map((def) => ({
    definition: publicDefinition(def),
    value: readValue(def, byDef.get(def.id) || null),
  }));
}

/**
 * setEmployeeCustomFields(prisma, businessId, employeeId, valuesByKey, opts) —
 * validate each supplied key against its ACTIVE def, then upsert/clear the value rows
 * in ONE transaction. Unknown keys → 422 UNKNOWN_FIELD; when essSelfEditOnly, any key
 * whose essPolicy !== 'SELF_EDIT' → 403. Required is enforced only for keys PRESENT in
 * the payload (an unrelated missing required field never blocks the write). Returns the
 * refreshed getEmployeeCustomFields.
 */
async function setEmployeeCustomFields(prisma, businessId, employeeId, valuesByKey, { actorUserId = null, essSelfEditOnly = false } = {}) {
  const input = valuesByKey && typeof valuesByKey === 'object' ? valuesByKey : {};
  const keys = Object.keys(input);

  const defs = keys.length
    ? await prisma.customFieldDefinition.findMany({
        where: { ...activeWhere(businessId, 'EMPLOYEE'), key: { in: keys } },
      })
    : [];
  const byKey = new Map(defs.map((d) => [d.key, d]));

  // Validate everything BEFORE opening the tx so a bad key never half-applies a batch.
  const ops = [];
  for (const key of keys) {
    const def = byKey.get(key);
    if (!def) throw err(422, 'UNKNOWN_FIELD', `Unknown custom field "${key}"`, { field: key });
    if (essSelfEditOnly && def.essPolicy !== 'SELF_EDIT') {
      throw err(403, 'FIELD_NOT_SELF_EDITABLE', `Custom field "${key}" is not self-editable`, { field: key });
    }
    const v = validateValue(def, input[key]);
    if (!v.ok) {
      const code = v.error === 'REQUIRED' ? 'REQUIRED' : 'INVALID_VALUE';
      throw err(422, code, `Invalid value for "${key}": ${v.error}`, { field: key, reason: v.error });
    }
    ops.push({ def, columns: v.columns });
  }

  if (ops.length) {
    await prisma.$transaction(async (tx) => {
      for (const { def, columns } of ops) {
        const allNull = columns.textValue == null && columns.numberValue == null && columns.dateValue == null && columns.boolValue == null;
        if (allNull) {
          // Clear → drop the row (keeps the value table sparse; reads left-join to null).
          await tx.customFieldValue.deleteMany({ where: { businessId, employeeId, definitionId: def.id } });
        } else {
          await tx.customFieldValue.upsert({
            where: { definitionId_employeeId: { definitionId: def.id, employeeId } },
            create: { businessId, definitionId: def.id, employeeId, updatedById: actorUserId, ...columns },
            update: { updatedById: actorUserId, ...columns },
          });
        }
      }
    });
  }

  return getEmployeeCustomFields(prisma, businessId, employeeId, { essVisibleOnly: essSelfEditOnly });
}

module.exports = {
  TYPE_SET,
  ESS_POLICY_SET,
  slugifyKey,
  normaliseOptions,
  validateDefinitionInput,
  validateValue,
  readValue,
  publicDefinition,
  listDefinitions,
  createDefinition,
  updateDefinition,
  archiveDefinition,
  getEmployeeCustomFields,
  setEmployeeCustomFields,
};
