'use client';

// Profile field policy (Feature 13) — the governance map that decides which profile
// fields an employee can edit freely, which need HR approval, and which are read-only.
// v1 is a sensible default map in code (a per-tenant override is deferred), so this
// page reads GET /api/hr/profile/policy and renders it for transparency. It answers
// the owner's "which fields need approval?" question at a glance.

import { useEffect, useState } from 'react';
import { Spinner, ErrorBanner } from '@hr/ui';
import { get } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import ModuleGuide from '@/components/ModuleGuide';

const POLICY_META = {
  'self-edit': { label: 'Self-service', color: '#16a34a', desc: 'The employee edits this freely.' },
  'hr-approval': { label: 'HR approval', color: '#d97706', desc: 'A change files a request HR must approve before it applies.' },
  'read-only': { label: 'Read-only', color: '#6b7280', desc: 'HR / lifecycle owns this; the employee only views it.' },
};

export default function ProfilePolicyPage() {
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let aborted = false;
    get('/api/hr/profile/policy')
      .then((res) => { if (!aborted) { setFields(res.fields || []); setLoading(false); } })
      .catch((e) => { if (!aborted) { setError(e); setLoading(false); } });
    return () => { aborted = true; };
  }, []);

  const groups = ['hr-approval', 'self-edit', 'read-only'];

  return (
    <div className="space-y-5">
      <PageHeader title="Profile field policy" subtitle="Which profile fields employees can edit, which need HR approval, and which are read-only. (v1 is a sensible default; a per-tenant editor is on the roadmap.)" />

      <ModuleGuide
        id="profile-policy"
        title="Read the profile-field governance map"
        what="This page shows the system's rule for every employee-profile field: who can change it. Each field is sorted into Self-service (the employee edits it freely), HR approval (a change files a request HR must clear first), or Read-only (HR / lifecycle owns it). It tells you, at a glance, which edits will quietly self-apply and which will land in your approvals queue."
        steps={[
          'Scan the three columns — HR approval, Self-service, Read-only — to see how each field is governed.',
          'Read each field’s key (e.g. bankAccount, panNumber) and the count badge on its column header.',
          'Note the optional and private tags on a row: private fields hold sensitive data and stay masked.',
          'Use the HR approval column to anticipate what will show up in your pending-approvals work — these are the changes you must review.',
          'Treat Read-only fields (e.g. employeeId, CTC, date of joining) as owned by HR/payroll — employees only view them.',
        ]}
        example={<>When <b>Aarav Sharma</b> updates his <b>bankAccount</b> for salary credit, that field sits under <b>HR approval</b>, so his edit files a request you must approve before the June 2026 payroll run picks it up. But when he fixes his <b>personal email</b> (a <b>Self-service</b> field), it saves instantly with no approval. His <b>PAN</b> and <b>CTC</b> are <b>Read-only</b> — owned by HR/payroll for Form 16 and TDS accuracy.</>}
        tips={[
          'Anything affecting pay or statutory filings — bank details, PAN, name as per PAN — should sit under HR approval so a typo can’t derail EPF/TDS or salary credit.',
          'v1 is a fixed default map in code; a per-tenant editor is on the roadmap, so flag any field you’d want governed differently for that change.',
        ]}
      />

      {loading ? <Spinner /> : error ? <ErrorBanner message={error.message || 'Could not load the policy'} /> : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {groups.map((g) => {
            const meta = POLICY_META[g];
            const list = fields.filter((f) => f.policy === g);
            return (
              <section key={g} className="rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: '#e5e7eb' }}>
                <div className="mb-1 flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
                  <h2 className="text-sm font-semibold text-gray-900">{meta.label}</h2>
                  <span className="text-xs text-gray-400">({list.length})</span>
                </div>
                <p className="mb-3 text-xs text-gray-500">{meta.desc}</p>
                <ul className="space-y-1">
                  {list.map((f) => (
                    <li key={f.fieldKey} className="flex items-center justify-between gap-2 text-sm">
                      <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700">{f.fieldKey}</code>
                      <span className="flex items-center gap-1 text-[11px] text-gray-400">
                        {f.optional && <span className="rounded bg-gray-50 px-1 py-0.5">optional</span>}
                        {f.sensitive && <span className="rounded bg-amber-50 px-1 py-0.5 text-amber-700">private</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
