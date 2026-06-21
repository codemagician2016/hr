'use client';

// Pre-launch checklist banner shown above the Overview tab.
// Required items must be filled before the "Launch my website" CTA enables;
// recommended items are optional with a "launch anyway?" confirm prompt.
//
// Extracted from [slug]/admin/page.js 2026-04-29 as part of the admin
// split — vertical isolation rule applies but this is shared shell UI
// (every vertical's tenant has a launch checklist).

import { useState } from 'react';
import { useConfirm } from '@/components/ConfirmDialog';
import { api } from '@/lib/adminApi';

export default function LaunchChecklist({ onTabChange, checklist }) {
  const [launching, setLaunching] = useState(false);
  const confirm = useConfirm();

  async function doLaunch() {
    setLaunching(true);
    try {
      await api('/api/business/launch', { method: 'POST' });
      alert('Your website is now live! Visitors can start using it.');
      window.location.reload();
    } catch (err) {
      // Backend returns missingRequired[] when required items aren't filled.
      const missing = err?.data?.missingRequired;
      if (Array.isArray(missing) && missing.length > 0) {
        alert(`Can't launch yet — please fill in:\n\n• ${missing.join('\n• ')}`);
      } else {
        alert(err.message || 'Launch failed');
      }
    } finally { setLaunching(false); }
  }

  async function handleLaunch() {
    // Required items complete but some recommendations pending → confirm.
    const pending = (checklist.recommendedItems || []).filter((i) => !i.completed);
    if (pending.length > 0) {
      const msg = `You haven't filled in these recommended items yet:\n\n• ${pending.map((p) => p.label).join('\n• ')}\n\nYour site can still go live with sensible defaults, but customers may see less info. Launch anyway?`;
      if (!await confirm(msg, { title: 'Launch with defaults?', confirmLabel: 'Launch anyway' })) return;
    }
    await doLaunch();
  }

  if (!checklist) return null;
  // When live, the status pill lives in the TopBar — nothing to render here.
  if (checklist.isLive) return null;

  const requiredItems = checklist.requiredItems || checklist.items?.filter((i) => i.required) || [];
  const recommendedItems = checklist.recommendedItems || checklist.items?.filter((i) => !i.required) || [];
  const canLaunch = !!checklist.allRequiredComplete;
  const requiredDone = requiredItems.filter((i) => i.completed).length;

  function ChecklistRow({ item }) {
    return (
      <button
        onClick={() => onTabChange(item.tab)}
        className={`w-full flex items-center gap-3 p-3 rounded-xl text-left transition-colors ${
          item.completed ? 'bg-white/60' : 'bg-white hover:bg-white/80'
        }`}
      >
        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0 ${
          item.completed
            ? 'bg-emerald-500 text-white'
            : item.required
              ? 'border-2 border-amber-500 text-amber-500'
              : 'border-2 border-gray-300 text-gray-400'
        }`}>
          {item.completed ? '✓' : '○'}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-medium ${item.completed ? 'text-gray-500 line-through' : 'text-gray-900'}`}>
              {item.label}
            </span>
            {item.required && !item.completed && (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-amber-200 text-amber-900">
                Required
              </span>
            )}
            {!item.required && !item.completed && (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-gray-200 text-gray-600">
                Optional
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-0.5">{item.description}</p>
        </div>
        {!item.completed && (
          <span className="text-xs font-medium px-2 py-1 rounded-lg flex-shrink-0" style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
            Edit →
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="mb-6 rounded-2xl border-2 border-amber-300 bg-amber-50 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-amber-900">
            {canLaunch ? 'Ready to launch' : 'Business and Hero sections required to complete before launch'}
          </h2>
          <p className="text-sm text-amber-800 mt-1">
            {canLaunch
              ? `Both required sections are filled (${requiredDone}/${requiredItems.length}). You can launch now — recommended items can wait.`
              : `${requiredDone}/${requiredItems.length} done. Your website shows "Coming soon" until both sections are filled and you click Launch.`}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-20 h-2 rounded-full bg-amber-200 overflow-hidden">
            <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${requiredItems.length ? (requiredDone / requiredItems.length) * 100 : 0}%` }} />
          </div>
          <span className="text-xs font-semibold text-amber-700">{requiredItems.length ? Math.round((requiredDone / requiredItems.length) * 100) : 0}%</span>
        </div>
      </div>

      {/* Required section — show only items that aren't yet done. Once a
          required item is satisfied it drops out of this list entirely
          (rather than sitting there as a green strikethrough), so the owner
          always sees just what's left to do. When all required items are
          complete the whole section is hidden and the green Launch button
          takes its place below. */}
      {requiredItems.filter((i) => !i.completed).length > 0 && (
        <div className="mt-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 mb-2">
            Required to launch
          </p>
          <div className="space-y-2">
            {requiredItems.filter((i) => !i.completed).map((item) => <ChecklistRow key={item.key} item={item} />)}
          </div>
        </div>
      )}

      {recommendedItems.length > 0 && (
        <div className="mt-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
            Recommended (optional — defaults will apply)
          </p>
          <div className="space-y-2">
            {recommendedItems.map((item) => <ChecklistRow key={item.key} item={item} />)}
          </div>
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-amber-200">
        <button onClick={handleLaunch} disabled={launching || !canLaunch}
          className="w-full py-3 text-base font-bold rounded-xl text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors">
          {launching ? 'Launching...' : canLaunch ? '🚀 Launch my website' : 'Publish unavailable — complete required items first'}
        </button>
        {canLaunch ? (
          <p className="text-xs text-amber-700 text-center mt-2">
            Once launched, your website goes live for visitors. Skipped items fall back to sensible defaults.
          </p>
        ) : (
          <div className="mt-3 rounded-lg border border-amber-300 bg-white/80 p-3">
            <p className="text-xs font-semibold text-amber-900 mb-2">
              Complete before launch:
            </p>
            <ul className="space-y-2">
              {/* Only the still-unfilled items live here. As soon as one is
                  saved (auto-refresh keeps this fresh) it drops off the list,
                  so the owner always sees what's left rather than a roll-call
                  of ticked boxes. */}
              {requiredItems.filter((i) => !i.completed).map((item) => (
                <li key={item.key} className="flex items-center gap-3">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0 ml-[5px] mr-[5px]" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-amber-900">{item.label}</p>
                    <p className="text-[11px] text-amber-700">{item.description}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onTabChange(item.tab)}
                    className="text-[11px] font-semibold px-2 py-1 rounded-md bg-amber-500 text-white hover:bg-amber-600 flex-shrink-0"
                  >
                    Edit →
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
