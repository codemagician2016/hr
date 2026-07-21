'use strict';

/**
 * categories.controller.js — Feature 11. Expense category + per-category ExpensePolicy
 * CRUD, now gated by canManageExpensePolicy (config, not a per-claim action). Folds the
 * ExpensePolicy daily/monthly/enforcement fields into the same editor.
 */

const prisma = require('../../core/lib/prisma');

const CATEGORY_FIELDS = ['code', 'name', 'glCode', 'isActive'];
function pickCategory(body) {
  const out = {};
  for (const f of CATEGORY_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

const POLICY_FIELDS = ['name', 'maxPerClaim', 'maxPerMonth', 'dailyCap', 'requireReceipt', 'enforcement', 'isActive'];
function pickPolicy(body) {
  const out = {};
  for (const f of POLICY_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

async function listCategories(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.expenseCategory.findMany({
      where: { businessId, deletedAt: null },
      // Feature 45 — gradeRules ride along so the admin grade-grid seeds from a
      // fresh load (the PUT is replace-all; a blank-seeded re-save would wipe rules).
      include: { policies: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, include: { gradeRules: { orderBy: { gradeRank: 'asc' } } } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function createCategory(req, res, next) {
  try {
    const { businessId } = req.user;
    const { code, name } = req.body;
    if (!code || !name) return res.status(400).json({ message: 'code and name are required' });
    const item = await prisma.expenseCategory.create({ data: { ...pickCategory(req.body), businessId } });
    res.status(201).json(item);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A category with that code already exists' });
    next(e);
  }
}

async function updateCategory(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.expenseCategory.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Category not found' });
    const item = await prisma.expenseCategory.update({ where: { id: req.params.id }, data: pickCategory(req.body) });
    res.json(item);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A category with that code already exists' });
    next(e);
  }
}

async function removeCategory(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.expenseCategory.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Category not found' });
    await prisma.expenseCategory.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// Set (create or replace) the per-category ExpensePolicy.
async function upsertCategoryPolicy(req, res, next) {
  try {
    const { businessId } = req.user;
    const category = await prisma.expenseCategory.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!category) return res.status(404).json({ message: 'Category not found' });
    const existing = await prisma.expensePolicy.findFirst({ where: { businessId, categoryId: category.id, deletedAt: null } });
    const data = pickPolicy(req.body);
    if (!data.name) data.name = `${category.name} policy`;
    let policy;
    if (existing) {
      policy = await prisma.expensePolicy.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } });
    } else {
      policy = await prisma.expensePolicy.create({ data: { ...data, businessId, categoryId: category.id } });
    }
    res.status(201).json(policy);
  } catch (e) { next(e); }
}

// ── PUT /categories/:id/policy/grade-rules — Feature 45 per-JOB-LEVEL caps ────
// REPLACE-ALL semantics (mirrors the travel per-diem/hotel/transport PUTs):
// body { rules: [{ gradeRank|null, maxPerClaim?, maxPerMonth?, dailyCap? }] }.
// gradeRank null = all levels; at most one null-rank row; ranks unique.
async function replaceGradeRules(req, res, next) {
  try {
    const { businessId } = req.user;
    const category = await prisma.expenseCategory.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!category) return res.status(404).json({ message: 'Category not found' });
    const policy = await prisma.expensePolicy.findFirst({ where: { businessId, categoryId: category.id, deletedAt: null } });
    if (!policy) return res.status(409).json({ message: 'Set the category policy (limits) before adding grade rules' });

    const rules = Array.isArray(req.body && req.body.rules) ? req.body.rules : [];
    const seen = new Set();
    const cleaned = [];
    for (const r of rules) {
      const rank = r.gradeRank == null || r.gradeRank === '' ? null : Number(r.gradeRank);
      if (rank != null && (!Number.isInteger(rank) || rank < 0)) {
        return res.status(400).json({ message: 'gradeRank must be a non-negative integer or null (all levels)' });
      }
      const key = rank == null ? '*' : String(rank);
      if (seen.has(key)) return res.status(400).json({ message: `Duplicate rule for grade rank ${key}` });
      seen.add(key);
      const numOrNull = (v) => {
        if (v == null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : NaN;
      };
      const row = { gradeRank: rank, maxPerClaim: numOrNull(r.maxPerClaim), maxPerMonth: numOrNull(r.maxPerMonth), dailyCap: numOrNull(r.dailyCap) };
      if ([row.maxPerClaim, row.maxPerMonth, row.dailyCap].some((v) => Number.isNaN(v))) {
        return res.status(400).json({ message: 'Caps must be non-negative numbers' });
      }
      if (row.maxPerClaim == null && row.maxPerMonth == null && row.dailyCap == null) {
        return res.status(400).json({ message: 'A grade rule must set at least one cap' });
      }
      cleaned.push(row);
    }

    const out = await prisma.$transaction(async (tx) => {
      await tx.expenseGradeRule.deleteMany({ where: { businessId, policyId: policy.id } });
      if (cleaned.length) {
        await tx.expenseGradeRule.createMany({
          data: cleaned.map((r) => ({ businessId, policyId: policy.id, ...r })),
        });
      }
      return tx.expenseGradeRule.findMany({ where: { businessId, policyId: policy.id }, orderBy: { gradeRank: 'asc' } });
    });
    res.status(201).json({ items: out });
  } catch (e) { next(e); }
}

module.exports = { listCategories, createCategory, updateCategory, removeCategory, upsertCategoryPolicy, replaceGradeRules };
