// Pure @mention helpers for the feed composer (no React, no I/O) — mirrors the
// backend's mention grammar (backend/src/hr/engagement/feedSocial.js) so what the
// employee picks resolves the same way server-side.
//
// SYNTAX:
//   @[token]  bracketed — may contain spaces/dots so a full name or email works.
//   @handle   bare — a run of [A-Za-z0-9._+-]; only starts a mention at the start
//             of the string or after a non-word char (so an email is never a mention).

// Is the caret currently inside a *bare* mention token being typed? Returns
// { at, query } where `at` is the index of the '@' and `query` is the partial text
// after it (may contain spaces so "Jane D" matches a full-name search), else null.
export function activeMentionQuery(value, caret) {
  const upto = String(value || '').slice(0, Math.max(0, caret || 0));
  const at = upto.lastIndexOf('@');
  if (at < 0) return null;
  // The char before '@' must be a boundary (start / non-word) — never mid-word/email.
  const before = at === 0 ? '' : upto[at - 1];
  if (before && /[A-Za-z0-9._%+-]/.test(before)) return null;
  const frag = upto.slice(at + 1);
  if (frag.length > 40) return null;
  // A newline, a closing bracket, or a second '@' means we're no longer in the token.
  if (/[\n\r\]@]/.test(frag)) return null;
  // Allow the characters a name / code / email local-part can contain (+ spaces).
  if (!/^[A-Za-z0-9 ._+-]*$/.test(frag)) return null;
  return { at, query: frag };
}

// Replace the in-progress bare token (from `at` up to `caret`) with a bracketed
// mention `@[display] `. Returns { value, caret } with the caret after the insert.
export function insertMention(value, at, caret, display) {
  const str = String(value || '');
  const token = `@[${String(display || '').trim()}] `;
  const next = str.slice(0, at) + token + str.slice(caret);
  return { value: next, caret: at + token.length };
}
