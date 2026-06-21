'use client';

// Decision-fork modal shown when an admin clicks "Edit category" on the
// Settings → Business details tab. Most admins clicking that button don't
// actually want a different *category* — they want their site to look
// different. Redirect them to the cheaper / safer alternatives first
// (theme & colours, layout) and treat changing the category itself as the
// last resort.
//
// Three options:
//   1. Change colours & fonts  → /<slug>/admin?tab=content (Theme picker)
//   2. Change layout           → /<slug>/admin?tab=content (Layout picker)
//   3. Change category         → opens the existing CategoryPicker UI
//      via onChooseCategory()  — that flow already has its own
//      "switch theme too?" follow-up confirm.
//
// The category branch is intentionally framed as the *I'm a different
// kind of business* path — it's the right call for someone who pivoted,
// not for someone who just wants a fresh coat of paint.

import { Modal } from '@/components/admin-ui';

function OptionCard({ icon, title, description, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-xl border border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-colors p-4 flex items-start gap-3"
    >
      <span className="text-2xl flex-shrink-0" aria-hidden="true">{icon}</span>
      <span className="flex-1">
        <span className="block text-sm font-semibold text-gray-900">{title}</span>
        <span className="block text-xs text-gray-600 mt-0.5">{description}</span>
      </span>
    </button>
  );
}

export default function CategoryChangeForkModal({ onChooseTheme, onChooseLayout, onChooseCategory, onCancel }) {
  return (
    <Modal title="What do you want to change?" onClose={onCancel}>
      <p className="text-sm text-gray-600 mb-4">
        Most people clicking "Edit category" actually want their site to <em>look</em> different.
        Pick the option that matches what you're after — your content stays untouched in all three cases.
      </p>

      <div className="space-y-2">
        <OptionCard
          icon="🎨"
          title="Change colours &amp; fonts"
          description="Same content, just a different look. Recommended for most refreshes."
          onClick={onChooseTheme}
        />
        <OptionCard
          icon="📐"
          title="Change layout"
          description="Rearrange sections or swap section variants on your homepage."
          onClick={onChooseLayout}
        />
        <OptionCard
          icon="🏷️"
          title="Change business category"
          description="I'm a different kind of business now. Updates default labels and may suggest a matching theme — your typed content is preserved."
          onClick={onChooseCategory}
        />
      </div>

      <div className="mt-5 flex justify-end">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">
          Cancel
        </button>
      </div>
    </Modal>
  );
}
