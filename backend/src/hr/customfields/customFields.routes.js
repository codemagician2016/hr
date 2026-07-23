'use strict';

/**
 * customFields.routes.js — Phase 5b. Two routers:
 *   - `definitions`: operator session (protect + canManageEmployees) — the tenant-admin
 *     CRUD for custom-field definitions. Mounted at /api/hr/custom-fields.
 *   - `me`: customer session (requireCustomer) — the signed-in employee's own visible
 *     fields + self-edit. Mounted at /api/hr/me/custom-fields. SELF_ONLY (the subject is
 *     resolved from the session; no employeeId is accepted from the client).
 *
 * The per-employee ADMIN value routes (GET/PATCH /api/hr/employees/:id/custom-fields)
 * live on employee.routes.js, where protect + withEmployeeScope(idParam) are already
 * wired, so a manager only touches their reporting sub-tree.
 */

const express = require('express');
const { protect, requireCustomer, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('./customFields.controller');

// ── operator: definition CRUD (canManageEmployees) ──
const definitions = express.Router();
definitions.use(protect);
definitions.get('/definitions', requirePermission('canManageEmployees'), c.listDefs);
definitions.post('/definitions', requirePermission('canManageEmployees'), c.createDef);
definitions.patch('/definitions/:id', requirePermission('canManageEmployees'), c.updateDef);
definitions.delete('/definitions/:id', requirePermission('canManageEmployees'), c.deleteDef);

// ── ESS: my custom fields (customer session, SELF_ONLY) ──
const me = express.Router();
me.use(requireCustomer);
me.get('/', c.getMyValues);
me.patch('/', c.patchMyValues);

module.exports = { definitions, me };
