'use client';

// The "What is this?" panel for one setup step. Three short beats, in the order
// a non-technical owner actually asks them: what it is, what it looks like when
// you've done it, and what breaks if you skip it. Purely explanatory — it never
// navigates and never operates the feature.
//
// Rendered inside a container the caller labels with `aria-controls`, so the
// disclosure button that toggles it owns the announcement.

// The server writes copy with {currency} / {country} placeholders so one
// sentence reads correctly for an India tenant (₹, INR) and a New Zealand one.
function fill(text, currency, country) {
  if (typeof text !== 'string') return text;
  return text
    .replaceAll('{currency}', currency || '')
    .replaceAll('{country}', country || '');
}

export default function StepExplainer({ explain, currency, country, id }) {
  if (!explain) return null;
  const { plain, example, ifYouSkip } = explain;

  return (
    <div
      id={id}
      className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm leading-relaxed"
    >
      {plain && <p className="text-gray-700">{fill(plain, currency, country)}</p>}

      {example && (
        <p className="mt-2 text-gray-700">
          <span className="mr-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-600">
            For example
          </span>
          {fill(example, currency, country)}
        </p>
      )}

      {ifYouSkip && (
        <p className="mt-2 text-gray-700">
          <span className="mr-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-600">
            If you skip it
          </span>
          {fill(ifYouSkip, currency, country)}
        </p>
      )}
    </div>
  );
}
