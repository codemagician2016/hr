# Feature 73 — Reusable application-form (screening) templates

Closes the gap found when auditing recruitment: you could post a job, take public
applications, and give each job a **custom** application form (screening questions
with knockout + scoring) — but that form was per-job only, rebuilt from scratch every
time. There was no way to author a form once and reuse it, or apply a **different**
form template to different jobs.

This adds exactly that, reusing the proven `PipelineTemplate → apply-to-job` pattern
(pipelines already worked this way; the application form did not).

## What you can now do
1. **Author reusable form templates** — a named library of screening-question sets
   (all 6 kinds: Yes/No, single-choice, multi-choice, number, text, qualification;
   with knockout auto-reject + per-option scoring).
2. **Apply a template to a job** — one click stamps the template's questions onto the
   job as its screening questions (editable afterwards).
3. **A different template per job** — Job A can use the "General" form, Job B the
   "Engineering" form; each job keeps its own copy.
4. Candidates still apply on the public careers portal and are auto-scored against
   whichever form the job carries.

## Data model (schema.prisma)
`ScreeningFormTemplate` + `ScreeningFormTemplateQuestion` + `ScreeningFormTemplateOption`
— structural mirror of `PipelineTemplate`/`Stage` and of the per-job `ScreeningQuestion`/
`ScreeningOption`. businessId-scoped, `@@unique([businessId, name])`, soft-delete,
`isDefault` (at most one). Applying copies COPIES onto the job (snapshot semantics —
editing a template later never mutates a job already built from it).

## Backend (`backend/src/hr/talent/`)
- `controllers/screeningFormTemplates.controller.js` — CRUD (list/get/create/update/
  remove) + `applyTemplateToJob` + `seedDefaults`, mirroring `pipelineTemplates.controller.js`.
  `validateQuestions` enforces the same rules as a per-job question (prompt + valid
  kind; choice/qualification need ≥1 option; option needs a non-empty value; unique
  sortOrder). `applyCore` guards against clobbering an existing form (409
  `QUESTIONS_EXIST` unless `?replace=true`); replacing is safe because candidate
  answers snapshot their prompt and are keyed by application, not by a question FK.
- Routes (`routes/recruitment.routes.js`, behind the existing `talent_acquisition`
  entitlement + `canManageHiring`/`canViewHiring`):
  - `GET|POST /screening-form-templates`, `GET|PATCH|DELETE /screening-form-templates/:id`
  - `POST /screening-form-templates/seed-defaults`
  - `POST /jobs/:id/apply-screening-template` — `{ templateId, replace? }`

## Frontend (hr-admin)
- `recruitment/form-templates/page.js` — the template **library**: DataTable + a
  create/edit modal with the full question builder (kind picker, options editor with
  points, required/knockout toggles, knockoutValue as Yes/No or an option value,
  maxPoints for number/qualification) + "Seed defaults". Gated on the recruitment
  manage permission (read-only + banner otherwise).
- `recruitment/jobs/[id]/page.js` — an **Apply form template** bar on the screening
  tab: pick a template → apply; on 409 it offers to replace; on success it reloads the
  job's questions (still individually editable). Existing screening editing untouched.
- `lib/nav.js` — Talent → **Form templates** nav item.

## Verification
- Backend: `prisma validate` + `generate` clean; controller/routes load;
  `screeningFormTemplates.unit.test.js` **16/16** (validator: kind/option/knockout
  rules, normalisation, rejections).
- Live E2E `qa/e2e/e2e-screening-form-templates.js` — the whole ask end-to-end:
  author 2 templates (+ 422 choice-without-options, 409 dup-name); apply template A →
  Job 1 and template B → Job 2 and assert each job carries its template's form
  (different per job); 409 re-apply guard + `?replace=true`; make Job 1 public → the
  public job detail surfaces the templated form → a public candidate applies with
  answers → 201 → the operator sees the scored application.

## Scope note
`knockoutValue` is stored as sent (scalar or array) — the scoring engine
(`knockoutPassSet`) already accepts both, so templated knockouts score identically to
hand-built ones. The `talent_acquisition` entitlement gates the whole surface (the
demo tenant holds it).
