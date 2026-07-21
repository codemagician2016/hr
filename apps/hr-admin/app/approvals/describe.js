// Plain-language summarisers for an approval chain — used on the Process cards
// and in the "current chain" line. Zero jargon: "Manager → Finance if over ₹50k".

import { whoKeyForStep, WHO_OPTIONS } from '@/lib/widgets';

const SHORT = {
  MANAGER_1: 'Manager',
  MANAGER_2: "Manager's manager",
  MANAGER_ALL: 'Whole chain',
  DEPARTMENT_HEAD: 'Dept head',
  HR: 'HR',
  PAYROLL_MANAGER: 'Finance',
  SPECIFIC_ROLE: 'A role',
  SPECIFIC_EMPLOYEE: 'A person',
  AUTO_APPROVE: 'Auto-approve',
};

// Render a single condition as a short human phrase. Mirrors the conditions.js
// grammar: {amount:{">":50000}}, {categoryCode:{in:[...]}}, {days:{">=":5}} …
export function describeCondition(cond) {
  if (!cond || typeof cond !== 'object') return '';
  const parts = [];
  for (const [key, test] of Object.entries(cond)) {
    if (key === 'any') { parts.push('any of a few rules'); continue; }
    if (!test || typeof test !== 'object') continue;
    const [op, val] = Object.entries(test)[0] || [];
    const field =
      key === 'amount' ? 'amount'
      : key === 'days' ? 'days'
      : key === 'categoryCode' ? 'category'
      : key === 'departmentId' ? 'department'
      : key === 'employeeLevel' ? 'level'
      : key;
    if (op === 'in' && Array.isArray(val)) parts.push(`${field} is ${val.join('/')}`);
    else if (op === '>') parts.push(`${field} over ${fmt(field, val)}`);
    else if (op === '>=') parts.push(`${field} ${fmt(field, val)}+`);
    else if (op === '<') parts.push(`${field} under ${fmt(field, val)}`);
    else if (op === '<=') parts.push(`${field} up to ${fmt(field, val)}`);
    else if (op === '==' || op === 'eq') parts.push(`${field} is ${val}`);
    else parts.push(`${field} ${op} ${val}`);
  }
  return parts.join(' and ');
}

function fmt(field, val) {
  if (field === 'amount') {
    const n = Number(val);
    if (Number.isFinite(n)) return `₹${n.toLocaleString('en-IN')}`;
  }
  return String(val);
}

// Group steps into parallel levels (same stepOrder) and produce a one-liner.
export function describeChain(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return 'Auto-approve (no one needs to say yes).';
  const byOrder = new Map();
  for (const s of steps) {
    const o = s.stepOrder;
    if (!byOrder.has(o)) byOrder.set(o, []);
    byOrder.get(o).push(s);
  }
  const levels = [...byOrder.keys()].sort((a, b) => a - b).map((o) => byOrder.get(o));
  const segs = levels.map((level) => {
    const names = level.map((s) => SHORT[whoKeyForStep(s)] || s.approverType);
    let label = names.length > 1 ? names.join(' & ') : names[0];
    const cond = level.map((s) => s.conditionJson).find(Boolean);
    if (cond) {
      const c = describeCondition(cond);
      if (c) label += ` if ${c}`;
    }
    return label;
  });
  return segs.join(' → ');
}

// Summarise a definition's scopeJson as a short human line. The resolver grammar
// (workflowResolver.js): { departmentIds:[], employeeLevels:[], locationIds:[] } —
// arrays of ids; every present array must include the requester's value. Note
// employeeLevels holds GRADE ids (platform convention — surfaced as "Grade").
// `lookups` = { departments:[{id,name}], grades:[...], locations:[...] } so we
// can print names, not ids. No scope (or all-empty arrays) = "Whole company".
export function describeScope(scopeJson, lookups = {}) {
  if (!scopeJson || typeof scopeJson !== 'object') return 'Whole company';
  const nameOf = (list, id) => (list || []).find((x) => x.id === id)?.name || 'unknown';
  const parts = [];
  if (Array.isArray(scopeJson.departmentIds) && scopeJson.departmentIds.length > 0) {
    parts.push(`Dept: ${scopeJson.departmentIds.map((id) => nameOf(lookups.departments, id)).join(', ')}`);
  }
  if (Array.isArray(scopeJson.employeeLevels) && scopeJson.employeeLevels.length > 0) {
    parts.push(`Grade: ${scopeJson.employeeLevels.map((id) => nameOf(lookups.grades, id)).join(', ')}`);
  }
  if (Array.isArray(scopeJson.locationIds) && scopeJson.locationIds.length > 0) {
    parts.push(`Location: ${scopeJson.locationIds.map((id) => nameOf(lookups.locations, id)).join(', ')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Whole company';
}

export const WHO_SHORT = SHORT;
export { WHO_OPTIONS };
