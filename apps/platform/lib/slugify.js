// Sprint 3.3g — single shared slugify. Replaces 5 drifted copies that
// disagreed on max length (60 vs 80) and double-dash collapsing.
//
// Behaviour:
//   - lowercase, trim
//   - replace runs of non-alphanumerics with a single dash
//   - strip leading/trailing dashes
//   - collapse runs of dashes (defensive — should be rare after the
//     prior step but cheap)
//   - slice to maxLen (default 80; pass 60 for business slugs etc.)
//   - returns '' for null / undefined / non-string input
//
// Use this in every UI surface that auto-derives a slug from a label.

export function slugify(input, maxLen = 80) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, maxLen);
}
