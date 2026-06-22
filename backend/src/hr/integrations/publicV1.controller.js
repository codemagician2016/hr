'use strict';

/**
 * publicV1.controller.js — minimal READ-ONLY public HR API.
 *
 * Auth: ApiKey via requireApiKey middleware → req.business + req.apiKey.
 * Tenant scope: req.business.id (NOT req.user — this is API-key auth, no session).
 * Scope gate: requireScope('read', 'employees').
 *
 * Endpoints:
 *   GET /api/hr/v1/whoami           — identity probe (no scope)
 *   GET /api/hr/v1/employees        — paginated employee directory
 *   GET /api/hr/v1/employees/:id    — single employee
 *
 * Only non-sensitive directory fields are exposed (no bank/PAN/salary).
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Whitelist of safe, directory-level fields. Never select compensation,
// bank, government IDs, or other sensitive PII into the public API.
const PUBLIC_EMPLOYEE_SELECT = Object.freeze({
  id: true,
  code: true,
  firstName: true,
  middleName: true,
  lastName: true,
  preferredName: true,
  workEmail: true,
  status: true,
  hireDate: true,
  countryCode: true,
  managerEmployeeId: true,
  createdAt: true,
  updatedAt: true,
});

function shape(e) {
  if (!e) return null;
  return {
    id: e.id,
    code: e.code,
    firstName: e.firstName,
    middleName: e.middleName || null,
    lastName: e.lastName,
    preferredName: e.preferredName || null,
    name: [e.firstName, e.lastName].filter(Boolean).join(' '),
    workEmail: e.workEmail || null,
    status: e.status,
    hireDate: e.hireDate ? new Date(e.hireDate).toISOString().slice(0, 10) : null,
    countryCode: e.countryCode || null,
    managerEmployeeId: e.managerEmployeeId || null,
    createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : null,
    updatedAt: e.updatedAt ? new Date(e.updatedAt).toISOString() : null,
  };
}

// GET /v1/whoami — confirms key works; echoes business + scopes.
function whoami(req, res) {
  return res.json({
    business: { id: req.business.id, slug: req.business.slug, name: req.business.name },
    apiKey: { id: req.apiKey.id, name: req.apiKey.name, scopes: req.apiKey.scopes },
    api: 'hr/v1',
  });
}

// GET /v1/employees — paginated, tenant-scoped, excludes soft-deleted.
async function listEmployees(req, res) {
  try {
    const businessId = req.business.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage, 10) || 50));
    const where = { businessId, deletedAt: null };
    if (req.query.status) where.status = String(req.query.status).toUpperCase();

    const [rows, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        select: PUBLIC_EMPLOYEE_SELECT,
        orderBy: { code: 'asc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      prisma.employee.count({ where }),
    ]);

    return res.json({ data: rows.map(shape), page, perPage, total });
  } catch (err) {
    console.error('[hr.publicV1] listEmployees', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'internal_error', message: 'Failed to list employees' });
  }
}

// GET /v1/employees/:id — tenant-scoped single fetch.
async function getEmployee(req, res) {
  try {
    const businessId = req.business.id;
    const e = await prisma.employee.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      select: PUBLIC_EMPLOYEE_SELECT,
    });
    if (!e) return res.status(404).json({ error: 'not_found', message: 'Employee not found' });
    return res.json({ data: shape(e) });
  } catch (err) {
    console.error('[hr.publicV1] getEmployee', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'internal_error', message: 'Failed to fetch employee' });
  }
}

module.exports = { whoami, listEmployees, getEmployee, PUBLIC_EMPLOYEE_SELECT, shape };
