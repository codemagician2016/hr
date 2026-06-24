-- Feature 4 (security hardening) — account-takeover guard for accept-invite.
-- ADDITIVE only: one new nullable-with-default boolean column on EmployeeInvite.
-- No backfill needed (DEFAULT false applies to every existing row), no NOT NULL on
-- an existing column without a default, safe on a live tenant. IF NOT EXISTS guard
-- keeps it idempotent (mirrors the other additive feature migrations).
--
-- SECURITY: `isReset` marks a token that was minted as an EXPLICIT password reset
-- for an already-claimed login. acceptInvite() refuses to overwrite the password of
-- an already-active login UNLESS the presenting token has isReset = true — so a
-- stale first-claim PENDING token can never take over an account that has since been
-- activated. Existing rows default to false (non-reset → fail-closed).

ALTER TABLE "EmployeeInvite"
  ADD COLUMN IF NOT EXISTS "isReset" BOOLEAN NOT NULL DEFAULT false;
