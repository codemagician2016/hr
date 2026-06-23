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
