'use strict';

/**
 * meOnboarding.controller.js — new-hire SELF-SERVICE onboarding surface
 * (Feature 4 §4.2, §4.5, §6, slice 4b). Mounted at /api/hr/me/onboarding.
 *
 * SELF-ONLY by construction (§4.5): there is NO `:id` in any path. The subject
 * employee/journey is resolved ENTIRELY from the session (the customer/ESS
 * token) or, for a pre-join candidate with no portal account yet, from a hashed,
 * expiring magic-link token (?token= / X-Onboarding-Token header). A body
 * `employeeId` is structurally ignored — a caller cannot reach another person's
 * journey. Cross-tenant is blocked by the businessId on every where-clause.
 *
 * The collect endpoints (personal/statutory/bank/emergency) validate via the
 * pure `validators.js` (statutory by the entity's countryCode), STAGE the data
 * into the journey's `selfServiceJson` bucket (promoted to real rows at
 * provisioning, 4c), and mark the matching COLLECT_* LifecycleTask DONE. Invalid
 * statutory → 422 with per-field errors. `submit` is guarded: blocked (422)
 * until the required docs are uploaded + required SELF_ONBOARDING tasks DONE,
 * then advances the journey SELF_ONBOARDING → DOCS_ESIGN.
 */

const crypto = require('crypto');
const prisma = require('../../../core/lib/prisma');
const s3 = require('../../../core/lib/s3');
const { validateStatutory } = require('../validators');
const { advanceJourney } = require('../journeyEngine');

// ── token hashing (pre-join magic link) ──────────────────────────────────────
// The journey stores only the SHA-256 of the token (preJoinTokenHash); the raw
// token travels in the link and is never persisted. Hashing matches the platform
// convention (core/lib/publicApi.js, accountDeletion.js).
function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Default pre-join link lifetime (days) — the mint path ALWAYS sets an expiry
// (validation treats a NULL expiry as invalid, so a token without one is dead).
const PRE_JOIN_TOKEN_TTL_DAYS = 7;

/**
 * mintPreJoinToken({ joinDate } = {}) -> { rawToken, tokenHash, expiresAt }
 *
 * Mint a pre-join magic-link token. The caller persists { tokenHash, expiresAt }
 * onto the journey (preJoinTokenHash / preJoinTokenExpiresAt) and emails the
 * rawToken in the link (never stored). The expiry is ALWAYS set — joinDate + 7d
 * when a join date is known, else now + 7d — so a minted token is never
 * non-expiring (H). Exported so the offer-accept seed path reuses it.
 */
function mintPreJoinToken({ joinDate } = {}) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const base = joinDate ? new Date(joinDate) : new Date();
  const anchor = Number.isNaN(base.getTime()) ? new Date() : base;
  const expiresAt = new Date(anchor.getTime() + PRE_JOIN_TOKEN_TTL_DAYS * 86400000);
  return { rawToken, tokenHash: hashToken(rawToken), expiresAt };
}

// ── document upload guards (size cap + MIME allow-list + category enum) ───────
// Hard ceiling on the DECODED payload (DoS guard): reject before decoding/storing.
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB
// Onboarding docs are PDFs or scanned ID images only.
const ALLOWED_DOC_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);
// The DocumentCategory enum values (mirror prisma/schema.prisma — writing a value
// outside this set makes Prisma 500; we reject with a 422 instead).
const DOCUMENT_CATEGORIES = new Set([
  'ID_PROOF', 'ADDRESS_PROOF', 'PAN', 'AADHAAR', 'PASSPORT', 'VISA', 'WORK_PERMIT',
  'EDUCATION', 'EXPERIENCE', 'OFFER_LETTER', 'CONTRACT', 'PAYSLIP_COPY',
  'TAX_DECLARATION', 'FORM16', 'BANK_PROOF', 'MEDICAL', 'POLICY_ACK', 'OTHER',
]);

// Parse + validate a base64 data URL against the allow-list + size cap, WITHOUT
// trusting any client-supplied mimeType/sizeBytes. Returns { ok, mime, bytes } or
// { ok:false, status, message }. Applies to BOTH the S3 path and the data-URL
// fallback path (so the fallback can't bypass the allow-list, M).
function validateDocDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    return { ok: false, status: 400, message: 'A file (fileBase64 data URL) is required' };
  }
  const m = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(dataUrl);
  if (!m || !m[2]) {
    return { ok: false, status: 422, message: 'Only base64 data URLs are supported' };
  }
  const mime = m[1].toLowerCase();
  if (!ALLOWED_DOC_MIME.has(mime)) {
    return { ok: false, status: 422, message: `Unsupported document type: ${mime}. Allowed: PDF, PNG, JPG.` };
  }
  // Decoded size from the base64 length WITHOUT allocating the buffer: every 4
  // base64 chars decode to 3 bytes, minus padding. This lets us reject an
  // oversize payload BEFORE decoding/storing it (DoS guard, H).
  const b64 = m[3] || '';
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.floor((b64.length * 3) / 4) - padding;
  if (decodedBytes > MAX_DOC_BYTES) {
    return { ok: false, status: 413, message: `File exceeds the ${MAX_DOC_BYTES / (1024 * 1024)} MB upload limit` };
  }
  return { ok: true, mime, bytes: decodedBytes };
}

// ── self-employee bridge (mirror of payroll service resolveSelfEmployee) ──────
// A customer's portal identity links to an Employee via matching workEmail /
// personalEmail, or via the linked User. Tenant-scoped. Returns the employee row
// (id) or null. The entity (for the statutory country) is resolved separately
// from the current EmploymentRecord — Employee has no direct entityId column.
async function resolveSelfEmployee(businessId, customer) {
  if (!customer || !customer.email) return null;
  const byEmail = await prisma.employee.findFirst({
    where: {
      businessId,
      deletedAt: null,
      OR: [{ workEmail: customer.email }, { personalEmail: customer.email }],
    },
    select: { id: true },
  });
  if (byEmail) return byEmail;
  const byUser = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, user: { is: { email: customer.email } } },
    select: { id: true },
  });
  return byUser || null;
}

// ── entity countryCode (drives the statutory rule set) ───────────────────────
// Resolve the journey's market: prefer the journey.entityId; fall back to the
// employee's current employment entity; default IN. Pure read, businessId-scoped.
async function resolveCountryCode(businessId, { entityId, employeeId }) {
  let eid = entityId || null;
  if (!eid && employeeId) {
    const rec = await prisma.employmentRecord.findFirst({
      where: { businessId, employeeId, isCurrent: true },
      select: { entityId: true },
    });
    eid = rec ? rec.entityId : null;
  }
  if (!eid) return 'IN';
  const entity = await prisma.entity.findFirst({
    where: { id: eid, businessId },
    select: { countryCode: true },
  });
  return entity && entity.countryCode ? String(entity.countryCode).toUpperCase() : 'IN';
}

/**
 * resolveSubjectJourney(req) -> { journey, employeeId|null, viaToken } | { error }
 *
 * The single chokepoint that resolves the caller's OWN active onboarding journey.
 * Two paths, never the body:
 *   (a) session — req.customer → self Employee → the employee-anchored journey,
 *       OR (pre-provision) the journey whose subject offer/email is the caller's.
 *   (b) pre-join token — ?token= / X-Onboarding-Token → the one journey whose
 *       preJoinTokenHash matches and whose token has not expired.
 * Out-of-scope is impossible: we never accept an id/employeeId from the client.
 */
async function resolveSubjectJourney(req) {
  const rawToken = (req.query && req.query.token) || req.get('x-onboarding-token') || null;

  // Pre-join magic-link path (candidate has no portal account yet).
  if (rawToken) {
    const tokenHash = hashToken(rawToken);
    const journey = await prisma.lifecycleJourney.findFirst({
      where: { direction: 'ONBOARDING', deletedAt: null, preJoinTokenHash: tokenHash },
    });
    if (!journey) return { error: { status: 401, message: 'Invalid or expired onboarding link' } };
    // Expiry is MANDATORY: a NULL expiry is treated as INVALID (never a
    // non-expiring token), and a past expiry is rejected — both 401.
    if (!journey.preJoinTokenExpiresAt
      || new Date(journey.preJoinTokenExpiresAt).getTime() < Date.now()) {
      return { error: { status: 401, message: 'This onboarding link has expired' } };
    }
    // Tenant binding (L): the businessId is derived from THIS journey (resolved by
    // the token hash) — never from any client hint — and every downstream read/
    // write is businessId-scoped, so a cross-tenant journey is unreachable.
    return { journey, businessId: journey.businessId, employeeId: journey.employeeId || null, viaToken: true };
  }

  // Session path — requires an authenticated customer (ESS).
  const customer = req.customer;
  if (!customer || !customer.businessId) {
    return { error: { status: 401, message: 'Not authenticated' } };
  }
  const businessId = customer.businessId;
  const self = await resolveSelfEmployee(businessId, customer);

  if (self) {
    // Provisioned new hire — the journey is anchored to their Employee.
    const journey = await prisma.lifecycleJourney.findFirst({
      where: { businessId, direction: 'ONBOARDING', deletedAt: null, employeeId: self.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!journey) return { error: { status: 404, message: 'No onboarding in progress' } };
    return { journey, businessId, employeeId: self.id, viaToken: false };
  }

  // Pre-provision new hire who DOES have a portal session: match the journey via
  // the accepted offer's candidate email (still self-derived — from the session
  // email, never the body). businessId-scoped, so cross-tenant is impossible.
  const journey = await prisma.lifecycleJourney.findFirst({
    where: {
      businessId,
      direction: 'ONBOARDING',
      deletedAt: null,
      employeeId: null,
      offer: { application: { candidate: { email: customer.email } } },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!journey) return { error: { status: 404, message: 'No onboarding in progress' } };
  return { journey, businessId, employeeId: null, viaToken: false };
}

// ── completeness vector ──────────────────────────────────────────────────────
// The four self-service buckets + whether the e-sign/docs gates are satisfied.
// Recomputed from selfServiceJson + the journey's tasks on every write so the
// wizard always renders the truth.
const COLLECT_TASK_FOR_SECTION = {
  personal: 'COLLECT_PERSONAL',
  statutory: 'COLLECT_STATUTORY',
  bank: 'COLLECT_BANK',
  emergency: 'COLLECT_EMERGENCY',
};

function completenessVector(journey, tasks) {
  const ss = journey.selfServiceJson || {};
  const taskByKey = {};
  for (const t of tasks || []) if (t.taskKey) taskByKey[t.taskKey] = t;
  const sectionDone = (section) => {
    const key = COLLECT_TASK_FOR_SECTION[section];
    const t = key ? taskByKey[key] : null;
    // A section is complete when its staged bucket exists AND the bound task is
    // terminal-good (or there is no such task — non-templated tenants).
    const staged = !!ss[section];
    const taskGood = !t || ['DONE', 'SKIPPED', 'NOT_APPLICABLE'].includes(t.status);
    return staged && taskGood;
  };
  const docsTask = taskByKey.UPLOAD_DOCS;
  const docsDone = !docsTask || ['DONE', 'SKIPPED', 'NOT_APPLICABLE'].includes(docsTask.status);
  return {
    personal: sectionDone('personal'),
    statutory: sectionDone('statutory'),
    bank: sectionDone('bank'),
    emergency: sectionDone('emergency'),
    documents: docsDone,
    // submit-ready = all BLOCKING+MANDATORY SELF_ONBOARDING tasks terminal-good.
    submitReady: selfOnboardingGate(tasks).ok,
  };
}

// The SELF_ONBOARDING stage gate: every blocking+mandatory task at that stage
// must be terminal-good. Returns { ok, pending: [taskKey|title] } for the 422.
function selfOnboardingGate(tasks) {
  const blockers = (tasks || []).filter(
    (t) => t.stageKey === 'SELF_ONBOARDING' && t.isBlocking !== false && t.isMandatory !== false,
  );
  const pending = blockers
    .filter((t) => !['DONE', 'SKIPPED', 'NOT_APPLICABLE'].includes(t.status))
    .map((t) => t.taskKey || t.title);
  return { ok: pending.length === 0, pending };
}

// Load the journey's tasks (ordered) — small helper used by every write path.
function loadTasks(client, journeyId) {
  return client.lifecycleTask.findMany({
    where: { journeyId },
    orderBy: [{ stageKey: 'asc' }, { dueDate: 'asc' }],
  });
}

// Mark a journey's COLLECT_* task DONE (idempotent — already-done is a no-op).
async function markCollectTask(tx, journeyId, taskKey, completedByUserId) {
  const task = await tx.lifecycleTask.findFirst({ where: { journeyId, taskKey } });
  if (!task) return; // tenant template may not include this task — skip silently
  if (['DONE', 'SKIPPED', 'NOT_APPLICABLE'].includes(task.status)) return;
  await tx.lifecycleTask.update({
    where: { id: task.id },
    data: {
      status: 'DONE',
      completedAt: new Date(),
      completedByUserId: completedByUserId || null,
      version: { increment: 1 },
    },
  });
}

// Stage a section into selfServiceJson under `section`, merging with what's there.
async function stageSection(tx, journey, section, data) {
  const ss = journey.selfServiceJson && typeof journey.selfServiceJson === 'object'
    ? { ...journey.selfServiceJson } : {};
  ss[section] = { ...(ss[section] || {}), ...data };
  await tx.lifecycleJourney.update({
    where: { id: journey.id },
    data: { selfServiceJson: ss, version: { increment: 1 } },
  });
  return ss;
}

// ── GET /me/onboarding ───────────────────────────────────────────────────────
// The caller's own active journey + tasks + completeness vector. Self-only.
async function getMyOnboarding(req, res, next) {
  try {
    const resolved = await resolveSubjectJourney(req);
    if (resolved.error) return res.status(resolved.error.status).json({ message: resolved.error.message });
    const { journey } = resolved;
    const tasks = await loadTasks(prisma, journey.id);
    const countryCode = await resolveCountryCode(journey.businessId, {
      entityId: journey.entityId,
      employeeId: journey.employeeId,
    });
    // Never leak the token hash / internal columns to the client.
    const { preJoinTokenHash, preJoinTokenExpiresAt, ...safeJourney } = journey;
    return res.json({
      journey: safeJourney,
      tasks,
      countryCode,
      selfService: journey.selfServiceJson || {},
      completeness: completenessVector(journey, tasks),
    });
  } catch (e) { return next(e); }
}

// Generic collect handler factory: validate → stage → mark task → return vector.
function makeCollectHandler(section, taskKey, validate) {
  return async function collect(req, res, next) {
    try {
      const resolved = await resolveSubjectJourney(req);
      if (resolved.error) return res.status(resolved.error.status).json({ message: resolved.error.message });
      const { journey } = resolved;
      // Subject is the resolved journey — the body NEVER selects the subject.
      const body = (req.body && typeof req.body === 'object') ? { ...req.body } : {};
      delete body.employeeId; // defence-in-depth: a body employeeId is ignored.

      // Per-section validation (statutory needs the entity country).
      let countryCode = null;
      if (validate) {
        if (section === 'statutory') {
          countryCode = await resolveCountryCode(journey.businessId, {
            entityId: journey.entityId,
            employeeId: journey.employeeId,
          });
        }
        const result = validate(body, countryCode);
        if (!result.ok) {
          return res.status(422).json({ message: 'Validation failed', errors: result.errors });
        }
      }

      const out = await prisma.$transaction(async (tx) => {
        const ss = await stageSection(tx, journey, section, body);
        await markCollectTask(tx, journey.id, taskKey, req.customer ? req.customer.id : null);
        const tasks = await loadTasks(tx, journey.id);
        return { selfService: ss, completeness: completenessVector({ ...journey, selfServiceJson: ss }, tasks) };
      });
      return res.json(out);
    } catch (e) { return next(e); }
  };
}

// Light shape checks for the non-statutory sections (statutory is the strict one).
function validatePersonal(body) {
  const errors = {};
  if (!body.firstName && !body.fullName) errors.firstName = 'Name is required';
  if (body.dateOfBirth && Number.isNaN(new Date(body.dateOfBirth).getTime())) {
    errors.dateOfBirth = 'Enter a valid date of birth';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

function validateBank(body, _cc) {
  // Country-aware bank validation: reuse the statutory bank-code validators.
  const { isValidIFSC, isValidNZBank } = require('../validators');
  const errors = {};
  if (!body.accountNumber) errors.accountNumber = 'Account number is required';
  if (!body.accountHolderName) errors.accountHolderName = 'Account holder name is required';
  // IFSC (IN) or NZ bank account string — accept whichever the tenant uses.
  const hasIfsc = body.ifsc != null && body.ifsc !== '';
  const hasNz = body.nzBankAccount != null && body.nzBankAccount !== '';
  if (hasIfsc && !isValidIFSC(body.ifsc)) errors.ifsc = 'Enter a valid IFSC code';
  if (hasNz && !isValidNZBank(body.nzBankAccount)) errors.nzBankAccount = 'Enter a valid NZ bank account';
  if (!hasIfsc && !hasNz) errors.ifsc = 'A bank routing detail (IFSC or NZ account) is required';
  return { ok: Object.keys(errors).length === 0, errors };
}

function validateEmergency(body) {
  const errors = {};
  if (!body.name) errors.name = 'Contact name is required';
  if (!body.phone) errors.phone = 'Contact phone is required';
  return { ok: Object.keys(errors).length === 0, errors };
}

const postPersonal = makeCollectHandler('personal', 'COLLECT_PERSONAL', (b) => validatePersonal(b));
const postStatutory = makeCollectHandler('statutory', 'COLLECT_STATUTORY', (b, cc) => validateStatutory(cc, b));
const postBank = makeCollectHandler('bank', 'COLLECT_BANK', (b, cc) => validateBank(b, cc));
const postEmergency = makeCollectHandler('emergency', 'COLLECT_EMERGENCY', (b) => validateEmergency(b));

// ── POST /me/onboarding/documents ────────────────────────────────────────────
// Accept a base64 data-URL, store via s3.uploadDataUrl, write a REAL
// EmployeeDocument row (category/fileUrl/name/mimeType/sizeBytes/fileHash) for
// SELF, then mark the UPLOAD_DOCS task. EmployeeDocument requires an employeeId,
// so a real row is only written once the journey is employee-anchored
// (post-provision); a pre-provision candidate stages the upload metadata into
// selfServiceJson.documents[] for promotion at provisioning (4c).
async function postDocuments(req, res, next) {
  try {
    const resolved = await resolveSubjectJourney(req);
    if (resolved.error) return res.status(resolved.error.status).json({ message: resolved.error.message });
    const { journey } = resolved;
    const body = req.body || {};
    const { category, name, fileHash } = body;
    const dataUrl = body.fileBase64 || body.dataUrl;
    if (!dataUrl) return res.status(400).json({ message: 'A file (fileBase64 data URL) is required' });
    if (!category) return res.status(400).json({ message: 'A document category is required' });
    // Category must be a real DocumentCategory enum value (L) — else Prisma 500s.
    if (!DOCUMENT_CATEGORIES.has(category)) {
      return res.status(422).json({ message: `Invalid document category: ${category}` });
    }

    // Validate the payload (MIME allow-list + ≤10 MB cap) BEFORE decoding/storing.
    // This runs on BOTH the S3 path AND the data-URL fallback so the fallback
    // cannot bypass the allow-list (M) and an oversize upload is rejected up-front
    // (H, 413/422). We trust the VALIDATED mime/size, not the client-claimed ones.
    const docCheck = validateDocDataUrl(dataUrl);
    if (!docCheck.ok) {
      return res.status(docCheck.status).json({ message: docCheck.message });
    }
    const mimeType = docCheck.mime;
    const sizeBytes = docCheck.bytes;

    // Store the bytes. When S3 is not configured (dev), fall back to embedding the
    // data URL as the fileUrl so the row is still written with real schema fields
    // (regression guard, §7 QA 22) — the same allow-list + cap already applied.
    let fileUrl;
    if (s3.isConfigured()) {
      const up = await s3.uploadDataUrl({ dataUrl, businessId: journey.businessId, scope: 'onboarding-doc' });
      fileUrl = up.url;
    } else {
      fileUrl = dataUrl;
    }

    const employeeId = journey.employeeId || resolved.employeeId || null;

    const out = await prisma.$transaction(async (tx) => {
      let employeeDocumentId = null;
      if (employeeId) {
        // Real EmployeeDocument row against the REAL schema fields (§4.4).
        const doc = await tx.employeeDocument.create({
          data: {
            businessId: journey.businessId,
            employeeId,
            category,
            name: name || 'Onboarding document',
            fileUrl,
            fileHash: fileHash || null,
            mimeType,
            sizeBytes,
            visibility: 'HR_ONLY',
            isEmployeeUploaded: true,
          },
        });
        employeeDocumentId = doc.id;
        // Bind the produced doc to the UPLOAD_DOCS task for audit/dedup.
        const upTask = await tx.lifecycleTask.findFirst({ where: { journeyId: journey.id, taskKey: 'UPLOAD_DOCS' } });
        if (upTask && !['DONE', 'SKIPPED', 'NOT_APPLICABLE'].includes(upTask.status)) {
          await tx.lifecycleTask.update({
            where: { id: upTask.id },
            data: { status: 'DONE', employeeDocumentId, completedAt: new Date(), completedByUserId: req.customer ? req.customer.id : null, version: { increment: 1 } },
          });
        }
      } else {
        // Pre-provision: stage the upload metadata; promoted to EmployeeDocument
        // rows at provisioning (4c, provision.js step 11).
        const ss = journey.selfServiceJson && typeof journey.selfServiceJson === 'object'
          ? { ...journey.selfServiceJson } : {};
        const docs = Array.isArray(ss.documents) ? ss.documents.slice() : [];
        docs.push({ category, name: name || 'Onboarding document', fileUrl, fileHash: fileHash || null, mimeType, sizeBytes, stagedAt: new Date().toISOString() });
        ss.documents = docs;
        await tx.lifecycleJourney.update({ where: { id: journey.id }, data: { selfServiceJson: ss, version: { increment: 1 } } });
        await markCollectTask(tx, journey.id, 'UPLOAD_DOCS', req.customer ? req.customer.id : null);
      }
      const tasks = await loadTasks(tx, journey.id);
      const fresh = await tx.lifecycleJourney.findUnique({ where: { id: journey.id } });
      return { employeeDocumentId, completeness: completenessVector(fresh, tasks) };
    });
    return res.status(201).json(out);
  } catch (e) { return next(e); }
}

// ── POST /me/onboarding/submit ───────────────────────────────────────────────
// Guarded: blocked (422) until the required docs are uploaded + the required
// SELF_ONBOARDING tasks are DONE. On pass, advances SELF_ONBOARDING → DOCS_ESIGN
// via the pure engine and persists the new stage/status.
async function submitOnboarding(req, res, next) {
  try {
    const resolved = await resolveSubjectJourney(req);
    if (resolved.error) return res.status(resolved.error.status).json({ message: resolved.error.message });
    const { journey } = resolved;
    if (journey.currentStage !== 'SELF_ONBOARDING' && journey.currentStage !== 'PRE_JOIN') {
      // Already past self-onboarding — idempotent: report current state, not an error.
      const tasks0 = await loadTasks(prisma, journey.id);
      return res.json({ currentStage: journey.currentStage, status: journey.status, completeness: completenessVector(journey, tasks0) });
    }
    const tasks = await loadTasks(prisma, journey.id);
    const gate = selfOnboardingGate(tasks);
    if (!gate.ok) {
      return res.status(422).json({
        message: 'Complete all required steps before submitting',
        pending: gate.pending,
        completeness: completenessVector(journey, tasks),
      });
    }

    const out = await prisma.$transaction(async (tx) => {
      // Re-run the pure engine; with SELF_ONBOARDING cleared it advances the stage.
      const fresh = await tx.lifecycleJourney.findUnique({ where: { id: journey.id } });
      const freshTasks = await tx.lifecycleTask.findMany({ where: { journeyId: journey.id } });
      const advance = advanceJourney(fresh, freshTasks);
      // INVALIDATE the pre-join magic-link token on submit (H): null out the hash
      // and stamp the expiry into the past so a replayed token can no longer
      // resolve this journey (a consumed link 401s on reuse). The submit is the
      // self-service finish line — the candidate now proceeds via their session.
      const advanceChanged = advance.currentStage !== fresh.currentStage || advance.status !== fresh.status;
      const hadToken = fresh.preJoinTokenHash != null;
      if (advanceChanged || hadToken) {
        await tx.lifecycleJourney.update({
          where: { id: journey.id },
          data: {
            ...(advanceChanged ? { currentStage: advance.currentStage, status: advance.status } : {}),
            ...(hadToken ? { preJoinTokenHash: null, preJoinTokenExpiresAt: new Date(0) } : {}),
            version: { increment: 1 },
          },
        });
      }
      const tasksAfter = await loadTasks(tx, journey.id);
      return {
        currentStage: advance.currentStage,
        status: advance.status,
        completeness: completenessVector({ ...fresh, currentStage: advance.currentStage }, tasksAfter),
      };
    });
    return res.json(out);
  } catch (e) { return next(e); }
}

module.exports = {
  getMyOnboarding,
  postPersonal,
  postStatutory,
  postBank,
  postEmergency,
  postDocuments,
  submitOnboarding,
  // the offer-accept seed path mints a pre-join token via this (always w/ expiry)
  hashToken,
  mintPreJoinToken,
  // exported for unit tests
  _internals: {
    hashToken, mintPreJoinToken, resolveSubjectJourney, completenessVector,
    selfOnboardingGate, resolveCountryCode, validateDocDataUrl,
    DOCUMENT_CATEGORIES, ALLOWED_DOC_MIME, MAX_DOC_BYTES, PRE_JOIN_TOKEN_TTL_DAYS,
  },
};
