'use strict';

/**
 * setup/talent/checklistItems.js — the DECLARATIVE registry for the HIRING track.
 *
 * A SECOND registry, not a second engine. Everything that turns a registry into a
 * payload — the three filters, the prerequisite pass, the percentage clamps, the
 * next-best action ranking, the stage roll-up, the completion stamp — lives in
 * setupChecklist.controller.js and is parameterised over a track descriptor
 * (setup/tracks.js). This file only declares WHAT hiring setup means.
 *
 * WHY A SEPARATE ARRAY, and not a `track:` field on the core one:
 * a company that does not hire must be able to reach 100% on core HR while this
 * track sits untouched at 0%. Because the core request iterates the CORE array and
 * this request iterates THIS one, a hiring step cannot enter the core denominator —
 * that is a structural guarantee rather than one forgotten `if`. The four
 * recruitment rows that used to sit inside the core registry were deleted in the
 * same change and re-authored here.
 *
 * THE FINISH LINE IS NOT "you ran payroll". It is "your careers page is live and
 * taking applications", which is why the last stage ends on a URL a recruiter can
 * actually send to a candidate (see talent/activation.js).
 *
 * Step keys are GLOBALLY unique across both registries — Business.setupState keeps
 * ONE flat `dismissed` map, and talentChecklist.test.js asserts the two key sets do
 * not intersect.
 *
 * The whole track is gated on the `talent_acquisition` add-on AT THE TRACK LEVEL
 * (tracks.js), so no individual row here carries an `entitlement`: an unentitled
 * tenant gets the upsell envelope and never reaches these rows at all.
 */

const { deriveRegistry } = require('../checklistItems');

// ── Stages ────────────────────────────────────────────────────────────────────
const STAGES = [
  { key: 'brand',     title: 'Your employer brand',     subtitle: 'What a candidate sees before they decide to apply',   order: 1 },
  { key: 'pipeline',  title: 'How you hire',            subtitle: 'The stages, questions and scorecards every role runs on', order: 2 },
  { key: 'candidate', title: 'The candidate experience', subtitle: 'What you send people, and when it goes out',          order: 3 },
  { key: 'golive',    title: 'Go live',                 subtitle: 'Post the role and switch your careers page on',        order: 4 },
];

// Every recruitment WRITE route is requireAny('canManageHiring','canManageEmployees')
// — the `canManage` gate in talent/routes/recruitment.routes.js — and the track's own
// route (tracks.js TALENT.anyPermission) opens on the same pair. A step must be scored
// on the gate its screen enforces, not a narrower one: an operator holding only the
// legacy super-set key can genuinely finish every row below, and scoring them on
// `canManageHiring` alone would flag all ten "someone else's access" and then, with
// nothing left in their denominator, show them a green 100% over zero steps.
// `permission` stays the PRIMARY key — it is what the UI turns into words
// ("someone who can manage hiring") — and is deliberately still serialised.
const HIRING_WRITE = Object.freeze(['canManageHiring', 'canManageEmployees']);

// ── Steps (declared order IS the display order) ───────────────────────────────
// Route values are BARE — the client appends ?from=setup itself, and stepHref()
// already places it correctly ahead of a '#anchor'.
const STEPS = [
  // ═══ YOUR EMPLOYER BRAND ══════════════════════════════════════════════════
  {
    key: 'careers_content',
    label: 'Write your careers page',
    description: 'The headline and the few paragraphs candidates read before they decide whether to apply.',
    why: 'This page is your pitch. For most candidates it is the only thing they will ever read about you.',
    explain: {
      plain: 'A headline plus a short piece about the company and what it is like to work there. It sits above your open roles on one public page.',
      example: '"Build the payroll India actually trusts" — then two paragraphs on the team and how you work.',
      ifYouSkip: 'Candidates see our stock wording instead of yours, and your page reads like a job board.',
    },
    stage: 'brand', required: true,
    route: '/settings/careers-page', cta: 'Write the page',
    permission: 'canManageHiring', permissionAny: HIRING_WRITE, prismaModel: 'CareersPage',
    dependsOn: [], minutes: 20, doneBy: 'HR',
  },
  {
    key: 'careers_brand',
    label: 'Put your logo on your careers page',
    description: 'Your logo and brand colour, so the page looks like your company instead of ours.',
    why: 'A hiring page carrying a stranger\'s branding reads as a scam, and good candidates close the tab.',
    explain: {
      plain: 'The same logo and colour your team already sees when they sign in are re-used on the public careers page.',
      example: 'Your logo top-left, your brand colour on the Apply button.',
      ifYouSkip: 'Your careers page carries our branding, which is the fastest way to lose a good candidate.',
    },
    // Deliberately the SAME FACT the core guide's `branding` step scores. Owner
    // decision 1 forbids hiring steps entering the CORE percentage — it does not
    // forbid a shared prerequisite being counted in each track that needs it.
    stage: 'brand', required: false,
    route: '/settings/branding', cta: 'Upload your logo',
    permission: 'canEditBranding', prismaModel: 'TenantBrand',
    dependsOn: [], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'careers_extras',
    label: 'Add your perks and your social links',
    description: 'The benefits you offer and links to your LinkedIn and website, shown alongside your open roles.',
    why: 'Perks and a real social presence are what turn someone reading the page into someone filling in the form.',
    explain: {
      plain: 'A short list of benefits, plus the links that let a candidate check you are a real company.',
      example: 'Health cover for the family, four weeks of leave, hybrid — and a LinkedIn link.',
      ifYouSkip: 'The page states the job and nothing about why anyone would take it.',
    },
    stage: 'brand', required: false,
    route: '/settings/careers-page#perks', cta: 'Add your perks',
    permission: 'canManageHiring', permissionAny: HIRING_WRITE, prismaModel: 'CareersPage',
    dependsOn: ['careers_content'], minutes: 10, doneBy: 'HR',
  },

  // ═══ HOW YOU HIRE ═════════════════════════════════════════════════════════
  {
    key: 'pipeline_template',
    label: 'Set up your hiring stages',
    description: 'The stages a candidate moves through — applied, screening, interview, offer, hired.',
    why: 'Every job you post runs on these stages, and they are how you always know where a candidate has got to.',
    explain: {
      plain: 'You define the stages once and mark one set as the default. Every new job starts with those stages already on it.',
      example: 'Applied → screening → interview → offer → hired.',
      ifYouSkip: 'Candidate status lives in a spreadsheet and people are ghosted.',
    },
    stage: 'pipeline', required: true,
    route: '/settings/pipeline-templates', cta: 'Set up stages',
    permission: 'canManageHiring', permissionAny: HIRING_WRITE, prismaModel: 'PipelineTemplate',
    dependsOn: [], minutes: 10, doneBy: 'HR',
  },
  {
    key: 'screening_form',
    label: 'Build your application form',
    description: 'The handful of questions every applicant answers — notice period, location, years of experience.',
    why: 'Asking the same few questions up front is what lets you rank fifty applicants without reading fifty CVs.',
    explain: {
      plain: 'A reusable set of questions you attach to a job. Answers are scored automatically, so the list arrives ranked.',
      example: '"What is your notice period?", "Are you able to work from Bengaluru?", "Years with Node.js?"',
      ifYouSkip: 'The public form still collects name, email, phone and a CV — you just read every CV yourself.',
    },
    stage: 'pipeline', required: false,
    route: '/recruitment/form-templates', cta: 'Build the form',
    permission: 'canManageHiring', permissionAny: HIRING_WRITE, prismaModel: 'ScreeningFormTemplate',
    dependsOn: ['pipeline_template'], minutes: 15, doneBy: 'HR',
  },
  {
    key: 'scorecard_template',
    label: 'Build an interview scorecard',
    description: 'The skills your panel rates, each out of ten, so two interviewers score the same candidate the same way.',
    why: 'Without a scorecard an interview is just a memory of a conversation, and the loudest panellist wins.',
    explain: {
      plain: 'You list the skills that matter for a round; each interviewer rates them independently and the scores combine.',
      example: 'System design, coding, communication, ownership — each out of ten.',
      ifYouSkip: 'Feedback is free text, and two interviews of the same person are not comparable.',
    },
    stage: 'pipeline', required: false,
    route: '/recruitment?tab=templates', cta: 'Build a scorecard',
    permission: 'canManageHiring', permissionAny: HIRING_WRITE, prismaModel: 'ScorecardTemplate',
    dependsOn: ['pipeline_template'], minutes: 15, doneBy: 'HR',
  },

  // ═══ THE CANDIDATE EXPERIENCE ═════════════════════════════════════════════
  {
    key: 'candidate_autosend',
    label: 'Choose which emails send themselves',
    description: 'Decide what a candidate hears automatically — an acknowledgement when they apply, an interview invite, an offer, a rejection.',
    why: 'Rejections stay switched off until you turn them on, so nobody is told they were unsuccessful unless you decided it.',
    explain: {
      plain: 'One toggle per moment in the pipeline. Acknowledgements, invites and offers are on by default; rejections are not.',
      example: 'Leave the acknowledgement on so nobody wonders whether their application arrived.',
      ifYouSkip: 'Our defaults keep sending the good-news messages — you just never decided them.',
    },
    stage: 'candidate', required: false,
    route: '/settings/candidate-messages', cta: 'Choose the emails',
    permission: 'canManageHiring', permissionAny: HIRING_WRITE, prismaModel: 'Business.candidateCommsConfig',
    dependsOn: [], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'candidate_templates',
    label: 'Make the candidate emails sound like you',
    description: 'Edit the wording of the standard replies — the acknowledgement, the interview invite, the offer, the rejection.',
    why: 'Candidates remember how they were turned down far longer than they remember how they applied.',
    explain: {
      plain: 'Each standard message has stock copy you can rewrite. Your version replaces ours everywhere it is sent.',
      example: 'Rewrite the rejection so it thanks people for their time and invites them to apply again.',
      ifYouSkip: 'Our copy goes out. It is real, sendable copy — it just is not in your voice.',
    },
    stage: 'candidate', required: false,
    route: '/settings/candidate-messages#templates', cta: 'Edit the wording',
    permission: 'canManageHiring', permissionAny: HIRING_WRITE, prismaModel: 'TenantMessageTemplate',
    dependsOn: ['candidate_autosend'], minutes: 20, doneBy: 'HR',
  },

  // ═══ GO LIVE ══════════════════════════════════════════════════════════════
  {
    key: 'first_job',
    label: 'Post your first job',
    description: 'Open the role you are actually hiring for — title, team, location and how many people you need.',
    why: 'Everything above is scaffolding until there is a real job for a real person to apply to.',
    explain: {
      plain: 'A job carries the title, the team, where it is based and how many people you need. It picks up your default stages automatically.',
      example: '"Senior Engineer, Bengaluru", two openings, on the engineering team.',
      ifYouSkip: 'There is nothing for a candidate to apply to.',
    },
    stage: 'golive', required: true,
    route: '/recruitment', cta: 'Post a job',
    permission: 'canManageHiring', permissionAny: HIRING_WRITE, prismaModel: 'Job',
    dependsOn: ['pipeline_template', 'careers_content'], minutes: 15, doneBy: 'HR',
  },
  {
    key: 'job_public',
    label: 'Put the job on your careers page',
    description: 'Open the job and switch it to public, so it appears on your careers page and people can apply to it.',
    why: 'A job that is not public is invisible — your careers page will be a room with nothing in it.',
    explain: {
      plain: 'A job starts private. Publishing it puts it on your careers page and gives it its own shareable link.',
      example: 'Open the job, hit Publish, and copy the link straight into a LinkedIn post.',
      ifYouSkip: 'The role exists only inside your console, and nobody can apply.',
    },
    // The Publish control lives on /recruitment/jobs/[id], which needs a job id we
    // cannot know at registry time — so the deep link is the Jobs list and the
    // description names the control to look for.
    stage: 'golive', required: true,
    route: '/recruitment', cta: 'Publish the job',
    permission: 'canManageHiring', permissionAny: HIRING_WRITE, prismaModel: 'Job',
    dependsOn: ['first_job'], minutes: 2, doneBy: 'HR',
  },
  {
    key: 'careers_live',
    label: 'Take your careers page live',
    description: 'Publish the page. Until you do, anyone who opens your link sees our default wording instead of yours.',
    why: 'This is the finish line — one link you can put on LinkedIn, in a job ad, or in your email signature.',
    explain: {
      plain: 'Saving your edits never publishes them. Publishing is a separate, deliberate step, and it can be undone.',
      example: 'Hit Publish, copy the link, and put it in your email signature.',
      ifYouSkip: 'Your page stays a draft and every visitor sees our stock copy.',
    },
    stage: 'golive', required: true,
    route: '/settings/careers-page', cta: 'Take it live',
    permission: 'canManageHiring', permissionAny: HIRING_WRITE, prismaModel: 'CareersPage',
    dependsOn: ['careers_content', 'job_public'], minutes: 2, doneBy: 'HR',
  },
];

// Derived + frozen by the SAME helper the core registry uses, so `blocking` (and
// therefore "do this next") means exactly one thing across both tracks.
const TALENT = deriveRegistry(STAGES, STEPS);

module.exports = {
  STAGES: TALENT.STAGES,
  STAGE_ORDER: TALENT.STAGE_ORDER,
  STEPS: TALENT.STEPS,
  BY_KEY: TALENT.BY_KEY,
  BLOCKING: TALENT.BLOCKING,
  ancestorsOf: TALENT.ancestorsOf,
};
