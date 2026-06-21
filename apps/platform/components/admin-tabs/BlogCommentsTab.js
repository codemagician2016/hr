'use client';

// Blog comment moderation queue.
//
// Mounts inside BlogPanel as the "Comments" sub-tab. Lists comments
// for the tenant — filterable by status (Pending / Approved / Spam /
// All) — with one-click moderation actions per row. Endpoints:
//   GET    /api/blog/comments?status=...
//   PUT    /api/blog/comments/:id/moderate { status }
//   DELETE /api/blog/comments/:id
//
// Author email is shown to the admin (it's only redacted on the
// public storefront read endpoint). Pending comments get an amber
// highlight matching the Quill design.

import { useEffect, useState } from 'react';
import { useConfirm } from '@/components/ConfirmDialog';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const STATUS_TABS = [
  { id: 'PENDING', label: 'Pending' },
  { id: 'APPROVED', label: 'Approved' },
  { id: 'SPAM', label: 'Spam' },
  { id: 'ALL', label: 'All' },
];

function StatusBadge({ status }) {
  if (status === 'PENDING') return <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">Pending</span>;
  if (status === 'APPROVED') return <span className="text-xs bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">Approved</span>;
  if (status === 'SPAM') return <span className="text-xs bg-rose-100 text-rose-800 px-2 py-0.5 rounded-full">Spam</span>;
  return null;
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export default function BlogCommentsTab() {
  const [tab, setTab] = useState('PENDING');
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const confirm = useConfirm();

  async function load() {
    setLoading(true);
    setError('');
    try {
      const qs = tab === 'ALL' ? '' : `?status=${tab}`;
      const data = await api(`/api/blog/comments${qs}`);
      setComments(data.comments || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-line */ }, [tab]);

  // Quick counts come from the current tab's response. The API doesn't
  // return per-status counts in one call, so we leave the badge generic
  // — clicking a tab fires a fresh fetch.
  const visibleCount = comments.length;

  async function moderate(id, status) {
    setBusyId(id);
    setError('');
    try {
      await api(`/api/blog/comments/${id}/moderate`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id) {
    if (!await confirm('Delete this comment? This cannot be undone — it will also remove any replies underneath.', { confirmLabel: 'Delete', tone: 'danger' })) return;
    setBusyId(id);
    setError('');
    try {
      await api(`/api/blog/comments/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900">Comments</h3>
        <p className="text-sm text-gray-500">
          Moderate reader comments on your blog posts. New comments land in <strong>Pending</strong> until you approve them.
        </p>
      </div>

      {/* Status tab strip */}
      <div className="inline-flex rounded-xl border border-gray-200 bg-white p-1">
        {STATUS_TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                active ? 'bg-gray-900 text-white' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {t.label}
              {active && <span className="ml-1.5 opacity-70">· {visibleCount}</span>}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : comments.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-gray-300 rounded-2xl">
          <p className="text-3xl">💬</p>
          <p className="mt-3 text-sm font-medium text-gray-900">
            {tab === 'PENDING' ? 'Inbox zero — nothing waiting' : 'No comments here'}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {tab === 'PENDING'
              ? 'New comments will show up here for moderation.'
              : 'Try a different tab or check back when readers comment.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => (
            <CommentRow
              key={c.id}
              comment={c}
              busy={busyId === c.id}
              onApprove={() => moderate(c.id, 'APPROVED')}
              onMarkSpam={() => moderate(c.id, 'SPAM')}
              onPending={() => moderate(c.id, 'PENDING')}
              onDelete={() => remove(c.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CommentRow({ comment, busy, onApprove, onMarkSpam, onPending, onDelete }) {
  const isPending = comment.status === 'PENDING';
  const isSpam = comment.status === 'SPAM';
  const isApproved = comment.status === 'APPROVED';
  const isReply = !!comment.parentId;
  return (
    <li className={`rounded-xl border p-4 ${
      isPending ? 'border-amber-200 bg-amber-50/40'
      : isSpam ? 'border-rose-200 bg-rose-50/30'
      : 'border-gray-200 bg-white'
    }`}>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-gray-200 text-gray-600 flex items-center justify-center text-sm font-semibold flex-shrink-0">
          {(comment.authorName || '?').slice(0, 1).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-gray-900">{comment.authorName || 'Anonymous'}</span>
            <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
              comment.authorType === 'CUSTOMER' ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600'
            }`}>
              {comment.authorType === 'CUSTOMER' ? 'Member' : 'Guest'}
            </span>
            {isReply && <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">Reply</span>}
            <StatusBadge status={comment.status} />
            <span className="text-xs text-gray-400">· {fmtDate(comment.createdAt)}</span>
          </div>
          <div className="mt-0.5 text-xs text-gray-500">
            {comment.authorEmail}
            {comment.post?.title && (
              <> · on <span className="text-gray-700 font-medium">{comment.post.title}</span></>
            )}
          </div>
          <p className="mt-2 text-sm text-gray-800 whitespace-pre-wrap break-words">{comment.body}</p>

          <div className="mt-3 flex flex-wrap gap-2">
            {isPending && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onApprove}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-300"
                >Approve</button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onMarkSpam}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 text-gray-700 hover:bg-gray-50"
                >Mark as spam</button>
              </>
            )}
            {isApproved && (
              <button
                type="button"
                disabled={busy}
                onClick={onPending}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 text-gray-700 hover:bg-gray-50"
              >Move to pending</button>
            )}
            {isSpam && (
              <button
                type="button"
                disabled={busy}
                onClick={onApprove}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-emerald-300 text-emerald-700 hover:bg-emerald-50"
              >Restore (approve)</button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={onDelete}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
            >Delete</button>
          </div>
        </div>
      </div>
    </li>
  );
}
