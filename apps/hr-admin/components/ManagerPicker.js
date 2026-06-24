'use client';

// Searchable single-select for picking an employee's manager (Feature 1).
//
// Backs the `managerEmployeeId` field on the create/edit employee flows. Now a
// thin wrapper over the reusable EmployeeSearchSelect — so the manager picker
// gets the same premium click-to-browse directory list (avatar + name + code +
// designation/department, keyboard-navigable, server-paginated for 1000+) used
// by the other employee pickers across hr-admin. The same-tenant directory and
// F1 scope are enforced server-side by GET /api/hr/employees.
//
// Contract is unchanged for callers:
//   value          — selected employeeId ('' when none)
//   selectedLabel  — display for a server-pre-filled value (no refetch)
//   onChange(id)   — fires with the employeeId on pick, or '' on clear
//   excludeId      — an id to hide (e.g. the employee can't manage themselves)
//   label / hint   — passthrough

import EmployeeSearchSelect from '@/components/EmployeeSearchSelect';

export default function ManagerPicker({ label = 'Manager', value, selectedLabel, onChange, excludeId, hint }) {
  return (
    <EmployeeSearchSelect
      label={label}
      value={value || ''}
      selectedLabel={selectedLabel}
      excludeId={excludeId}
      hint={hint}
      placeholder="Search by name, code or email…"
      // The manager field is id-only: map the selected row → its id (or '' on clear).
      onSelect={(emp) => onChange(emp ? emp.id : '')}
    />
  );
}
