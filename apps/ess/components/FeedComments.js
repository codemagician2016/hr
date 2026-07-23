'use client';

// FeedComments — the collapsible comment thread in an AnnouncementCard footer.
//
//   - A "💬 N comments" toggle lazy-loads GET …/comments on first expand.
//   - Renders top-level comments + one level of replies (author + relative time +
//     "(edited)"), with a muted "[deleted]" placeholder for soft-deleted rows.
//   - A composer posts a new top-level comment; each top-level comment has a Reply
//     affordance; the caller's OWN comments carry Edit / Delete controls.
//   - @mentions in a body render as a highlighted span; the composer offers an
//     @mention autocomplete backed by the colleague directory.
//
// OWNERSHIP ("isMine"): the backend comment DTO does not flag ownership, so we infer
// it by comparing comment.authorEmployeeId to the caller's own employee id (resolved
// from /api/hr/me/profile via useProfile → employeeId, passed in as `myEmployeeId`).
// When that id is unknown (profile still loading), edit/delete simply stay hidden.
//
// Contract:
//   GET    …/comments            → { items:[{ id, parentId, body, deleted, authorName,
//                                     authorEmployeeId, mentionedEmployeeIds, editedAt,
//                                     createdAt, replies:[…], replyCount }], total }
//   POST   …/comments { body, parentId? }        → 201 { ok, comment }
//   PATCH  …/comments/:commentId { body }         → { ok, comment }  (author-only)
//   DELETE …/comments/:commentId                  → { ok, deleted }  (author soft-delete)

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from '@hr/ui';
import {
  fetchFeedComments, postFeedComment, editFeedComment, deleteFeedComment, fetchDirectory,
} from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { activeMentionQuery, insertMention } from '@/lib/mentions';

// Render a comment body with @[token] / bare @handle mentions highlighted. Mirrors the
// backend mention grammar; we highlight the token text (no link resolution needed).
const MENTION_RE = /@\[([^\]]+)\]|(^|[^A-Za-z0-9._%+-])@([A-Za-z0-9._+-]+)/g;
function renderMentions(text) {
  const str = String(text || '');
  const nodes = [];
  let last = 0;
  let key = 0;
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(str)) !== null) {
    let start;
    let label;
    if (m[1] !== undefined) {
      start = m.index;               // "@[Full Name]"
      label = m[1];
    } else {
      start = m.index + (m[2] ? m[2].length : 0); // skip the leading boundary char
      label = m[3];
    }
    if (start > last) nodes.push(<Fragment key={`t${key++}`}>{str.slice(last, start)}</Fragment>);
    nodes.push(
      <span
        key={`m${key++}`}
        className="rounded px-1 font-medium"
        style={{ background: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}
      >
        @{label}
      </span>,
    );
    last = MENTION_RE.lastIndex;
  }
  if (last < str.length) nodes.push(<Fragment key={`t${key++}`}>{str.slice(last)}</Fragment>);
  return nodes;
}

// ── Composer with @mention autocomplete ───────────────────────────────────────
function CommentComposer({
  onSubmit, submitting, placeholder = 'Write a comment…', initialValue = '',
  submitLabel = 'Post', onCancel, autoFocus = false, compact = false,
}) {
  const [text, setText] = useState(initialValue);
  const [menu, setMenu] = useState(null); // { at, results, active } | null
  const taRef = useRef(null);
  const debRef = useRef(null);

  useEffect(() => () => clearTimeout(debRef.current), []);

  const search = useCallback((value, caret) => {
    const q = activeMentionQuery(value, caret);
    if (!q || q.query.trim().length < 1) { setMenu(null); return; }
    clearTimeout(debRef.current);
    debRef.current = setTimeout(async () => {
      try {
        const r = await fetchDirectory(`?q=${encodeURIComponent(q.query.trim())}&pageSize=6`);
        const results = (r && r.items ? r.items : []).slice(0, 6);
        setMenu(results.length ? { at: q.at, results, active: 0 } : null);
      } catch { setMenu(null); }
    }, 180);
  }, []);

  function onChange(e) {
    const { value, selectionStart } = e.target;
    setText(value);
    search(value, selectionStart == null ? value.length : selectionStart);
  }

  function choose(emp) {
    if (!emp) return;
    const display = emp.name || emp.code || emp.workEmail || '';
    const ta = taRef.current;
    const caret = ta && ta.selectionStart != null ? ta.selectionStart : text.length;
    const at = menu ? menu.at : caret;
    const { value, caret: nextCaret } = insertMention(text, at, caret, display);
    setText(value);
    setMenu(null);
    requestAnimationFrame(() => {
      if (taRef.current) {
        taRef.current.focus();
        taRef.current.setSelectionRange(nextCaret, nextCaret);
      }
    });
  }

  async function submit() {
    const body = text.trim();
    if (!body || submitting) return;
    try {
      await onSubmit(body);
      setText('');       // clear only on success — a failed post keeps the draft
      setMenu(null);
    } catch { /* the parent surfaces the error; keep the draft for retry */ }
  }

  function onKeyDown(e) {
    if (menu && menu.results.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenu((mm) => ({ ...mm, active: (mm.active + 1) % mm.results.length })); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenu((mm) => ({ ...mm, active: (mm.active - 1 + mm.results.length) % mm.results.length })); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); choose(menu.results[menu.active]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  }

  return (
    <div className="relative">
      <textarea
        ref={taRef}
        value={text}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setMenu(null), 120)}
        placeholder={placeholder}
        rows={compact ? 2 : 3}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        className="w-full resize-y rounded-lg border px-3 py-2 text-sm outline-none"
        style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)', background: 'white' }}
      />
      {menu && menu.results.length > 0 && (
        <ul
          className="absolute left-0 right-0 z-40 mt-1 max-h-56 overflow-auto rounded-xl border bg-white shadow-lg"
          style={{ borderColor: 'var(--theme-border)' }}
          role="listbox"
        >
          {menu.results.map((emp, i) => (
            <li key={emp.id || emp.code || i}>
              <button
                type="button"
                // preventDefault keeps the textarea focused through the click
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(emp)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm"
                style={{
                  color: 'var(--theme-text)',
                  background: i === menu.active ? 'var(--theme-primary-soft)' : 'transparent',
                }}
              >
                <span className="truncate font-medium">{emp.name}</span>
                {emp.code && <span className="shrink-0 text-xs" style={{ color: 'var(--theme-muted)' }}>{emp.code}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !text.trim()}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          style={{ background: 'var(--theme-primary)' }}
        >
          {submitting ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
          >
            Cancel
          </button>
        )}
        <span className="ml-auto text-[11px]" style={{ color: 'var(--theme-muted)' }}>
          Type @ to mention
        </span>
      </div>
    </div>
  );
}

// ── A single comment (top-level or reply) ─────────────────────────────────────
function CommentItem({
  comment, isReply, myEmployeeId, busy,
  onReply, onEdit, onDelete,
}) {
  const [editing, setEditing] = useState(false);
  const mine = !comment.deleted && comment.authorEmployeeId && comment.authorEmployeeId === myEmployeeId;

  return (
    <div className={isReply ? 'pl-4' : ''} style={isReply ? { borderLeft: '2px solid var(--theme-border)' } : undefined}>
      <div className="rounded-lg px-3 py-2" style={{ background: isReply ? 'transparent' : 'var(--theme-primary-soft)' }}>
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>
            {comment.deleted ? 'Someone' : (comment.authorName || 'A colleague')}
          </span>
          <span className="text-[11px]" style={{ color: 'var(--theme-muted)' }}>{relativeTime(comment.createdAt)}</span>
          {comment.editedAt && !comment.deleted && (
            <span className="text-[11px]" style={{ color: 'var(--theme-muted)' }}>(edited)</span>
          )}
        </div>

        {editing ? (
          <div className="mt-1">
            <CommentComposer
              initialValue={comment.body}
              submitLabel="Save"
              submitting={busy}
              autoFocus
              compact
              onCancel={() => setEditing(false)}
              onSubmit={async (body) => { await onEdit(comment, body); setEditing(false); }}
            />
          </div>
        ) : (
          <p
            className="mt-0.5 whitespace-pre-wrap text-sm"
            style={{ color: comment.deleted ? 'var(--theme-muted)' : 'var(--theme-text)', fontStyle: comment.deleted ? 'italic' : 'normal' }}
          >
            {comment.deleted ? '[deleted]' : renderMentions(comment.body)}
          </p>
        )}

        {!editing && !comment.deleted && (
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px]">
            {!isReply && (
              <button type="button" onClick={() => onReply(comment)} className="font-medium" style={{ color: 'var(--theme-primary)' }}>
                Reply
              </button>
            )}
            {mine && (
              <>
                <button type="button" onClick={() => setEditing(true)} className="font-medium" style={{ color: 'var(--theme-muted)' }}>
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(comment)}
                  disabled={busy}
                  className="font-medium disabled:opacity-50"
                  style={{ color: '#dc2626' }}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── The thread ────────────────────────────────────────────────────────────────
export default function FeedComments({ announcementId, commentCount = 0, myEmployeeId }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [items, setItems] = useState([]);
  const [count, setCount] = useState(commentCount);
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState(null); // top-level comment id we're replying to

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await fetchFeedComments(announcementId, '?page=1&pageSize=50');
      const list = (r && r.items) || [];
      setItems(list);
      // Live count of visible comments (top-level + replies), matching the feed badge.
      const live = list.reduce((n, c) => n + (c.deleted ? 0 : 1) + ((c.replies || []).length), 0);
      setCount(live);
      setLoaded(true);
    } catch (e) {
      setError(e.message || 'Could not load comments.');
    } finally {
      setLoading(false);
    }
  }, [announcementId]);

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) load();
  }

  async function addComment(body, parentId) {
    setBusy(true); setActionError('');
    try {
      await postFeedComment(announcementId, parentId ? { body, parentId } : { body });
      setReplyTo(null);
      await load();
    } catch (e) {
      setActionError(e.message || 'Could not post your comment.');
      throw e; // let the composer keep the draft
    } finally {
      setBusy(false);
    }
  }

  async function editComment(comment, body) {
    setBusy(true); setActionError('');
    try {
      await editFeedComment(announcementId, comment.id, { body });
      await load();
    } catch (e) {
      setActionError(e.message || 'Could not save your edit.');
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function removeComment(comment) {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && !window.confirm('Delete this comment?')) return;
    setBusy(true); setActionError('');
    try {
      await deleteFeedComment(announcementId, comment.id);
      await load();
    } catch (e) {
      setActionError(e.message || 'Could not delete your comment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--theme-border)' }}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className="text-xs font-medium"
        style={{ color: 'var(--theme-muted)' }}
      >
        💬 {count} {count === 1 ? 'comment' : 'comments'}
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {actionError && <p className="text-xs" style={{ color: '#dc2626' }} role="alert">{actionError}</p>}

          {/* New top-level comment */}
          <CommentComposer submitting={busy} onSubmit={(body) => addComment(body)} />

          {loading ? (
            <div className="flex justify-center py-4"><Spinner small /></div>
          ) : error ? (
            <p className="text-xs" style={{ color: '#dc2626' }}>{error}</p>
          ) : items.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>Be the first to comment.</p>
          ) : (
            <ul className="space-y-3">
              {items.map((c) => (
                <li key={c.id} className="space-y-2">
                  <CommentItem
                    comment={c}
                    myEmployeeId={myEmployeeId}
                    busy={busy}
                    onReply={(cm) => setReplyTo(replyTo === cm.id ? null : cm.id)}
                    onEdit={editComment}
                    onDelete={removeComment}
                  />
                  {(c.replies || []).length > 0 && (
                    <ul className="space-y-2">
                      {c.replies.map((r) => (
                        <li key={r.id}>
                          <CommentItem comment={r} isReply myEmployeeId={myEmployeeId} busy={busy} onEdit={editComment} onDelete={removeComment} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {replyTo === c.id && (
                    <div className="pl-4">
                      <CommentComposer
                        submitting={busy}
                        autoFocus
                        compact
                        placeholder={`Reply to ${c.authorName || 'this comment'}…`}
                        submitLabel="Reply"
                        onCancel={() => setReplyTo(null)}
                        onSubmit={(body) => addComment(body, c.id)}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
