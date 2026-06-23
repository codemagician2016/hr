'use client';

// ServerPagination — controlled pager for SERVER-paginated ESS lists.
//
// The ESS list endpoints (payslips, leave history, my-letters) now accept
// `?page=&pageSize=` and return `{ items, total, page, pageSize }`. The page owns
// `page`/`pageSize` state, feeds them into the request path, passes the server's
// `total` here, and refetches via the onChange callbacks. Theme-aware (uses the
// same CSS variables as the rest of the ESS shell) and accessible (real buttons).
//
// Backward-compatible by design: a page that doesn't pass page/pageSize to the
// API still gets the full list, and simply doesn't render this control.

export function ServerPagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  sizes = [10, 25, 50],
  noun = 'items',
}) {
  const t = Number(total) || 0;
  const ps = Number(pageSize) || 25;
  const p = Math.max(1, Number(page) || 1);
  const pageCount = Math.max(1, Math.ceil(t / ps));
  const start = t === 0 ? 0 : (p - 1) * ps + 1;
  const end = Math.min(p * ps, t);
  if (t === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 px-1 py-3 text-sm"
      style={{ color: 'var(--theme-muted)' }}
    >
      <div className="flex items-center gap-2">
        <span>
          Showing <span style={{ color: 'var(--theme-text)', fontWeight: 600 }}>{start}</span>–
          <span style={{ color: 'var(--theme-text)', fontWeight: 600 }}>{end}</span> of{' '}
          <span style={{ color: 'var(--theme-text)', fontWeight: 600 }}>{t}</span> {noun}
        </span>
        {onPageSizeChange && (
          <label className="ml-2 inline-flex items-center gap-1">
            <span className="sr-only">Rows per page</span>
            <select
              value={ps}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="rounded-md border bg-white px-2 py-1 text-xs"
              style={{ borderColor: 'var(--theme-border)' }}
            >
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s} / page
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(p - 1)}
          disabled={p <= 1}
          className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-40"
          style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
        >
          ← Prev
        </button>
        <span className="text-xs">
          Page {p} of {pageCount}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(p + 1)}
          disabled={p >= pageCount}
          className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-40"
          style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
