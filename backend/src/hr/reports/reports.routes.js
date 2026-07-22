'use strict';

/**
 * reports.routes.js — HR reports API, mounted at /api/hr/reports.
 *
 * Two surfaces share the mount:
 *
 * 1. FIXED reports (legacy, read-only, JSON + NEW file exports):
 *      GET /runs                              pay-run selector
 *      GET /runs/:id/register                 payroll register (JSON)
 *      GET /runs/:id/register/export          …as CSV/XLSX/PDF (?format=)
 *      GET /runs/:id/statutory                statutory summary (JSON)
 *      GET /runs/:id/statutory/export         …as CSV/XLSX/PDF
 *      GET /headcount                         headcount & attrition (JSON)
 *      GET /headcount/export                  …as CSV/XLSX/PDF
 *      GET /leave-liability                   leave liability (JSON)
 *      GET /leave-liability/export            …as CSV/XLSX/PDF
 *    RBAC: canViewPayrollReports OR canViewReports (legacy key kept as an OR
 *    for back-compat — existing payroll-report roles lose nothing).
 *
 * 2. REPORT BUILDER (Reports Platform gap-fill wave):
 *      GET    /datasets                       whitelist registry metadata
 *      POST   /definitions                    save a definition
 *      GET    /definitions                    list (shared + own)
 *      GET    /definitions/:id
 *      PATCH  /definitions/:id                (creator only)
 *      DELETE /definitions/:id                soft delete (creator only)
 *      POST   /definitions/:id/run            { page, pageSize } → rows+totals
 *      GET    /definitions/:id/export         ?format=CSV|XLSX|PDF
 *      POST   /run-adhoc                      unsaved definition body → preview rows
 *    RBAC: canViewReports.
 *
 * 3. SCHEDULES (email delivery of saved definitions):
 *      POST   /schedules
 *      GET    /schedules
 *      GET    /schedules/:id
 *      PATCH  /schedules/:id
 *      DELETE /schedules/:id
 *      POST   /schedules/:id/run-now
 *    RBAC: canScheduleReports.
 *
 * Feature 1: every surface honours the actor's data scope by construction —
 * attachSelfEmployee resolves the anchor; withEmployeeScope attaches req.scope
 * which the controllers/datasets AND into every query (NONE → empty, fail-closed).
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission, requireAnyPermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('./reports.controller');
const b = require('./reportBuilder.controller');

router.use(protect);
router.use(attachSelfEmployee);

// ── 1. Fixed reports — legacy key OR the new viewer key ──────────────────────
const fixedGate = [requireAnyPermission(['canViewPayrollReports', 'canViewReports']), withEmployeeScope('canViewPayrollReports')];

router.get('/runs', fixedGate, c.listRuns);
router.get('/runs/:id/register', fixedGate, c.payrollRegister);
router.get('/runs/:id/register/export', fixedGate, c.payrollRegisterExport);
router.get('/runs/:id/statutory', fixedGate, c.statutorySummary);
router.get('/runs/:id/statutory/export', fixedGate, c.statutorySummaryExport);
router.get('/headcount', fixedGate, c.headcount);
router.get('/headcount/export', fixedGate, c.headcountExport);
router.get('/leave-liability', fixedGate, c.leaveLiability);
router.get('/leave-liability/export', fixedGate, c.leaveLiabilityExport);

// ── 2. Report builder — canViewReports ───────────────────────────────────────
const viewGate = [requirePermission('canViewReports'), withEmployeeScope('canViewReports')];

router.get('/datasets', viewGate, b.getDatasets);
router.post('/definitions', viewGate, b.createDefinition);
router.get('/definitions', viewGate, b.listDefinitions);
router.get('/definitions/:id', viewGate, b.getDefinition);
router.patch('/definitions/:id', viewGate, b.updateDefinition);
router.delete('/definitions/:id', viewGate, b.deleteDefinition);
router.post('/definitions/:id/run', viewGate, b.runDefinition);
router.get('/definitions/:id/export', viewGate, b.exportDefinition);
router.post('/run-adhoc', viewGate, b.runAdhoc);

// ── 3. Schedules — canScheduleReports ────────────────────────────────────────
// (No withEmployeeScope: the DELIVERY runs under the schedule creator's scope,
// resolved server-side in reportScheduleRunner — not the HTTP requester's.)
const scheduleGate = [requirePermission('canScheduleReports')];

router.post('/schedules', scheduleGate, b.createSchedule);
router.get('/schedules', scheduleGate, b.listSchedules);
router.get('/schedules/:id', scheduleGate, b.getSchedule);
router.patch('/schedules/:id', scheduleGate, b.updateSchedule);
router.delete('/schedules/:id', scheduleGate, b.deleteSchedule);
router.post('/schedules/:id/run-now', scheduleGate, b.runScheduleNow);

module.exports = router;
