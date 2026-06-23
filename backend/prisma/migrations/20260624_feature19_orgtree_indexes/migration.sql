-- Feature 19 — Scalable Org Chart (1000+ employees, multi-level hierarchy).
-- ADDITIVE only: two covering b-tree indexes on "Employee" so the lazy-tree API
-- (children pages, name sort, search prefix) stays index-only at 1000+ employees.
-- No new tables/columns, no data backfill, no NOT NULL — safe to apply on a live
-- tenant (mirrors the additive migrations of feature10/13). CREATE INDEX IF NOT
-- EXISTS keeps it idempotent against a schema that was previously `db push`-ed.
--
-- The existing (businessId, managerEmployeeId) index already serves child-listing
-- and the recursive CTE join; these two add the (lastName, firstName) sort columns
-- so keyset-paginated sibling pages and the tenant-wide name search avoid a sort
-- step. At >50k employees the documented next step is a pg_trgm GIN index on
-- lower(firstName||' '||lastName) — flagged, not built (a b-tree prefix is ample
-- at 1000s).

CREATE INDEX IF NOT EXISTS "Employee_businessId_managerEmployeeId_lastName_firstName_idx"
  ON "Employee" ("businessId", "managerEmployeeId", "lastName", "firstName");

CREATE INDEX IF NOT EXISTS "Employee_businessId_lastName_firstName_idx"
  ON "Employee" ("businessId", "lastName", "firstName");
