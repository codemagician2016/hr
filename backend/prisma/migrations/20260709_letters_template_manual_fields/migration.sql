-- Feature 9 (Letters), Phase 3 — template-declared MANUAL (at-issue) fields the
-- issuer fills in the wizard, used in the body as {{manual.<key>}}. Additive,
-- nullable JSON column (array of {key,label,type,required}); forward-only.
ALTER TABLE "LetterTemplate" ADD COLUMN "manualFieldsJson" JSONB;
