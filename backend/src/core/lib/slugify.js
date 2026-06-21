// Sprint 3.3g — single shared slugify (backend).
// Mirror of platform/lib/slugify.js — verticals don't share code so
// each app keeps its own copy. Behaviour is identical: lowercase,
// trim, run-of-non-alnum → single dash, strip leading/trailing dashes,
// collapse run-of-dashes, cap at maxLen. Returns '' on falsy input.

function slugify(input, maxLen = 80) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, maxLen);
}

module.exports = { slugify };
