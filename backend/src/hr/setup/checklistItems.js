'use strict';

/**
 * checklistItems.js — the DECLARATIVE setup-guide registry.
 *
 * Modelled on sitepresso's launch.controller.js CHECKLIST_ITEMS: one static array
 * is the single source of truth for what "set up" means, and a separate probe layer
 * (probes.js) answers "is it done?" against real tenant data. Nothing here touches
 * the database — this module is pure data plus the derived indexes we can compute
 * once at boot (declared order + the transitive `blocking` closure), so the ranking
 * of the next-best action is identical on Monday and Friday.
 *
 * Every step is grouped into a STAGE (Foundation → People → Time → Pay → Engage) so
 * the guide is never one flat 70-row list, and is marked Required or Recommended.
 *
 * FILTERS applied per request (see setupChecklist.controller.js — this file only
 * declares the inputs):
 *   countryOnly   'IN' → emitted only for an India tenant. Fails OPEN while
 *                 Business.hrCountry is still null (mirrors nav.hasCountry), so a
 *                 brand-new IN tenant sees no load-time flash.
 *   includeWhen   predicate over the probe status — a greenfield tenant never sees
 *                 the "bring your old data across" rows.
 *   entitlement   an HR add-on key; when the plan lacks it the row renders LOCKED
 *                 (upsell) and is removed from BOTH sides of the percentage, so
 *                 100% is reachable on any plan.
 *   hideWhenEntitled
 *                 the mirror of `entitlement`: the row exists ONLY as an upsell and
 *                 vanishes once the tenant owns the add-on. It is for rows that are
 *                 an advert rather than a task — there is nothing to probe and
 *                 nothing to finish — so leaving one in an entitled tenant's list
 *                 would park an uncompletable row in their denominator forever.
 *                 Today that is `talent_acquisition_addon`, which points at the
 *                 SEPARATE hiring track (setup/talent/).
 *   permission    an RBAC key from core/lib/rbac.js. A step the operator cannot do
 *                 is omitted from their score entirely (it stays in tenantPercent).
 *
 * Gating is ADVISORY throughout: nothing in the product reads this to block an
 * action. It shows a %, one next step, and a done state.
 *
 * `dismissible` is derived, never declared: a REQUIRED step can never be dismissed
 * (the POST /dismiss rejects it 422), a recommended one always can. Several rows
 * below carry a "DISMISSIBLE" note in their comment — that is emphasis for the
 * cases we expect tenants to actually turn off (hardware, geo-fencing, bank files),
 * not a different rule.
 */

// ── Stages ────────────────────────────────────────────────────────────────────
const STAGES = Object.freeze([
  { key: 'foundation', title: 'Foundation',        subtitle: 'Your company, offices and who can see what', order: 1 },
  { key: 'people',     title: 'Your people',       subtitle: 'Everyone who works for you',                 order: 2 },
  { key: 'time',       title: 'Time & attendance', subtitle: 'Working hours, leave and holidays',          order: 3 },
  { key: 'pay',        title: 'Pay & tax',         subtitle: 'Salary, payslips and government filings',    order: 4 },
  { key: 'engage',     title: 'Engage & grow',     subtitle: 'Letters, reviews, training and recognition', order: 5 },
]);

// ── Steps (declared order IS the display order; `order` is stamped below) ─────
// Route values are BARE — the client appends ?from=setup / &from=setup itself.
const STEPS = [
  // ═══ FOUNDATION ═══════════════════════════════════════════════════════════
  {
    key: 'country',
    label: 'Choose where you run payroll',
    description: "This decides which government rules and payslip format we use. You pick it once and it can't be changed.",
    why: 'Every tax rule, payslip and statutory form below depends on this answer.',
    explain: {
      plain: 'India and New Zealand have completely different payroll law, so we ask once and then only ever show you your own rules.',
      example: 'Pick India and you get PF, ESI, professional tax and TDS. Pick New Zealand and you get PAYE, KiwiSaver and ACC.',
      ifYouSkip: 'Nothing country-specific can be set up, and payroll cannot be run at all.',
    },
    stage: 'foundation', required: true,
    route: '/settings/company-profile?tab=country', cta: 'Choose your country',
    permission: 'canManageCompanyProfile', prismaModel: 'Business',
    dependsOn: [], minutes: 1, doneBy: 'the Owner',
  },
  {
    key: 'company_profile',
    label: 'Add your company details',
    description: 'Your legal name and tax numbers. These print on every payslip, letter and year-end tax form.',
    why: 'Your legal name and tax numbers print on everything we generate for you.',
    explain: {
      plain: 'This is the identity of the business as the government knows it, which is often not the name on the door.',
      example: '"Acme Technologies Private Limited" on the payslip, "Acme" on the website.',
      ifYouSkip: 'Payslips and letters go out with a blank or wrong company name, and year-end tax forms are rejected.',
    },
    stage: 'foundation', required: true,
    route: '/settings/company-profile?tab=profile', cta: 'Add company details',
    permission: 'canManageCompanyProfile', prismaModel: 'Business.companyProfile',
    dependsOn: ['country'], minutes: 5, doneBy: 'the Owner',
  },
  {
    key: 'entity',
    label: 'Add your registered company',
    description: 'The company your staff are legally employed by. Payslips and filings are issued per company.',
    why: 'Pay runs, payslips and filings are all issued per registered company.',
    explain: {
      plain: 'A company here is a legal employer. Most businesses have exactly one; add more only if you genuinely have separate registered companies.',
      example: 'Acme India Pvt Ltd employs everyone in Bengaluru and Pune, so that is one company with two offices.',
      ifYouSkip: 'There is nothing to attach people, salaries or pay dates to, so payroll cannot start.',
    },
    stage: 'foundation', required: true,
    route: '/org#entities', cta: 'Add your company',
    permission: 'canManageOrg', prismaModel: 'Entity',
    dependsOn: ['country'], minutes: 5, doneBy: 'the Owner',
  },
  {
    key: 'locations',
    label: 'Add your offices and work sites',
    description: 'Where your people actually work. Holidays and attendance rules follow the site someone works at.',
    why: 'Holiday lists and attendance rules follow the site someone works at.',
    explain: {
      plain: 'A site is a physical place people work from. It is how we give the Bengaluru office a different holiday list from the Mumbai one.',
      example: 'Head office in Bengaluru, a plant in Pune, and a fully-remote group.',
      ifYouSkip: 'Everyone shares one holiday list, and you cannot fence attendance to an office.',
    },
    stage: 'foundation', required: false,
    route: '/org#locations', cta: 'Add a work site',
    permission: 'canManageOrg', prismaModel: 'Location',
    dependsOn: ['entity'], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'departments',
    label: 'Add your departments',
    description: 'The teams your people belong to. Used for reporting, approval routing and who sees what.',
    why: 'Reports, approval routing and access rules are all grouped by department.',
    explain: {
      plain: 'Departments are how you slice every report and how approval chains find the right approver.',
      example: 'Engineering, Sales, Finance, People.',
      ifYouSkip: 'Headcount and cost reports come out as one undifferentiated block.',
    },
    stage: 'foundation', required: false,
    route: '/org#departments', cta: 'Add a department',
    permission: 'canManageOrg', prismaModel: 'Department',
    dependsOn: ['entity'], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'designations',
    label: 'Add your job titles',
    description: 'The titles people hold, like Software Engineer or HR Manager. They print on offer and experience letters.',
    why: 'Job titles print on offer, appointment and experience letters.',
    explain: {
      plain: 'A job title is what a person is called. It is separate from their pay level, so two people on the same grade can hold different titles.',
      example: 'Software Engineer, Senior Software Engineer, Engineering Manager.',
      ifYouSkip: 'Letters go out with a blank designation and you cannot rate people against a role.',
    },
    stage: 'foundation', required: false,
    route: '/org#designations', cta: 'Add a job title',
    permission: 'canManageOrg', prismaModel: 'Designation',
    dependsOn: ['entity'], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'grades',
    label: 'Add your pay levels',
    description: 'Your salary grades, from junior to senior. Used to set different expense limits for different levels.',
    why: 'Expense caps and travel entitlements are set per pay level.',
    explain: {
      plain: 'A pay level groups roles of similar seniority so you can set one rule for the whole level instead of per person.',
      example: 'L1 to L5, where L4 and above may book a higher hotel category.',
      ifYouSkip: 'Every expense and travel limit has to be the same for everyone.',
    },
    stage: 'foundation', required: false,
    route: '/org#grades', cta: 'Add a pay level',
    permission: 'canManageOrg', prismaModel: 'Grade',
    dependsOn: ['entity'], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'employee_number',
    label: 'Choose how employee IDs look',
    description: 'Decide what your staff ID numbers look like, for example EMP-0001 or ACME-IN-001.',
    why: 'Staff IDs are hard to change later, so it is worth picking the format now.',
    explain: {
      plain: 'Every person gets an ID automatically when you add them. You choose the prefix, how many digits, and where the numbering starts.',
      example: 'Coming from another system at EMP-0450? Start the count at 451 so nothing collides.',
      ifYouSkip: 'We use EMP-000001 and you carry that format forever.',
    },
    stage: 'foundation', required: false,
    route: '/settings/employee-number', cta: 'Set the ID format',
    permission: 'canManageCompanyProfile', prismaModel: 'NumberSequence',
    dependsOn: [], minutes: 2, doneBy: 'HR',
  },
  {
    key: 'branding',
    label: 'Add your logo and colours',
    description: 'Put your own logo and colours on the admin console, the employee app and both sign-in screens.',
    why: 'Your team should see your brand, not ours, the moment they sign in.',
    explain: {
      plain: 'One logo and one colour are re-used across the console, the employee app, both sign-in pages and your letterhead.',
      example: 'Upload a transparent PNG logo and your brand hex, and the sign-in page changes immediately.',
      ifYouSkip: 'Your staff sign in to a product that looks like it belongs to someone else.',
    },
    stage: 'foundation', required: false,
    route: '/settings/branding', cta: 'Upload your logo',
    permission: 'canEditBranding', prismaModel: 'TenantBrand',
    dependsOn: [], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'custom_domain',
    label: 'Use your own web address',
    description: 'Let your team sign in at your own web address instead of the default one.',
    why: 'A familiar web address is the difference between "this is ours" and "is this a phishing link?".',
    explain: {
      plain: 'You point a sub-domain at us with one DNS record, we verify it, and your team signs in there instead.',
      example: 'people.acme.com instead of the shared default address.',
      ifYouSkip: 'Nothing breaks — your team just signs in at our address.',
    },
    stage: 'foundation', required: false,
    route: '/settings/domain', cta: 'Connect your domain',
    permission: 'canEditDomain', prismaModel: 'Subscription',
    dependsOn: ['branding'], minutes: 15, doneBy: 'your IT person',
  },
  {
    key: 'hr_team_roles',
    label: 'Invite your HR and finance team',
    description: 'Add the other people who run HR and payroll, and choose exactly what each of them can do.',
    why: 'Nobody should run payroll from a shared login, and approvals need a second pair of hands.',
    explain: {
      plain: 'You give each colleague their own sign-in and pick exactly which screens and actions they get.',
      example: 'Your accountant approves pay runs but cannot see the hiring pipeline.',
      ifYouSkip: 'One person holds every key, and approvals that should need two people need one.',
    },
    stage: 'foundation', required: false,
    route: '/approvals/roles', cta: 'Invite a colleague',
    permission: 'canManageRoles', prismaModel: 'BusinessRole',
    dependsOn: [], minutes: 10, doneBy: 'the Owner',
  },
  {
    key: 'sso',
    label: 'Turn on single sign-on',
    description: 'Let people sign in with your company Google or Microsoft account instead of another password.',
    why: 'One less password to leak, and access ends the moment IT disables the company account.',
    explain: {
      plain: 'We hand sign-in over to your existing identity provider, so joiners and leavers are controlled in one place.',
      example: 'Someone leaves, IT disables their Microsoft account, and they lose access here too — automatically.',
      ifYouSkip: 'Everyone keeps a separate password here, and off-boarding needs a manual step.',
    },
    stage: 'foundation', required: false,
    route: '/settings/sso', cta: 'Set up sign-on',
    permission: 'canManageSso', prismaModel: 'SsoConnection',
    dependsOn: ['hr_team_roles'], minutes: 30, doneBy: 'your IT person',
  },

  // ═══ PEOPLE ═══════════════════════════════════════════════════════════════
  {
    key: 'employees',
    label: 'Add your people',
    description: 'Create your staff records, one at a time or all at once from a spreadsheet.',
    why: 'So we know who to pay and who can sign in.',
    explain: {
      plain: 'A person record is the anchor for their pay, leave, attendance and documents. Add one by hand or upload a spreadsheet.',
      example: 'Twelve people? Add them by hand. A hundred and twenty? Use the spreadsheet upload.',
      ifYouSkip: 'Nothing else in the product has anyone to act on.',
    },
    stage: 'people', required: true,
    route: '/people', cta: 'Add an employee',
    permission: 'canManageEmployees', prismaModel: 'Employee',
    dependsOn: ['entity'], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'managers',
    label: 'Set who reports to whom',
    description: "Tell us each person's manager. Leave and expense requests go to them for approval.",
    why: 'Leave and expense requests have nowhere to go until each person has a manager.',
    explain: {
      plain: 'Every person except the one at the very top needs a manager. That single field drives the whole approval chain.',
      example: 'Priya reports to Rahul, so Priya\'s leave request lands in Rahul\'s inbox.',
      ifYouSkip: 'Requests sit unrouted and your team assumes the app is broken.',
    },
    stage: 'people', required: true,
    route: '/approvals/org', cta: 'Set the reporting line',
    permission: 'canManageHierarchy', prismaModel: 'Employee.managerEmployeeId',
    dependsOn: ['employees'], minutes: 10, doneBy: 'HR',
  },
  {
    key: 'portal_invites',
    label: 'Invite your people to the employee app',
    description: 'Send everyone their sign-in so they can see payslips, apply for leave and mark attendance.',
    why: 'A manager who has never signed in cannot be picked as an approver at all.',
    explain: {
      plain: 'The invite turns a staff record into a person who can actually sign in. Approval routing only ever picks people who can.',
      example: 'Invite everyone at once from the people list, and they each get a sign-in link.',
      ifYouSkip: 'Payslips have nobody to reach, and uninvited managers silently drop out of approval chains.',
    },
    stage: 'people', required: true,
    route: '/people', cta: 'Send invites',
    permission: 'canManageEmployees', prismaModel: 'Employee.userId',
    dependsOn: ['employees'], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'statutory_ids',
    label: "Add each person's tax and ID numbers",
    description: 'In India: PAN, UAN and ESI. In New Zealand: IRD number and KiwiSaver choice. Without these, tax comes out wrong.',
    why: 'Tax is calculated per person from these numbers, and filings are rejected without them.',
    explain: {
      plain: 'These are the government identifiers we quote on filings. They belong to the person, not to you, so collect them once at joining.',
      example: 'A missing PAN pushes an India employee to a much higher flat TDS rate.',
      ifYouSkip: 'People are taxed wrongly and your quarterly filings bounce.',
    },
    stage: 'people', required: true,
    route: '/people', cta: 'Add tax numbers',
    permission: 'canManageStatutory', prismaModel: 'StatutoryProfile',
    dependsOn: ['employees'], minutes: 20, doneBy: 'HR',
  },
  {
    key: 'bank_accounts',
    label: "Add everyone's salary bank account",
    description: "Where each person's salary is paid. Needed before we can build a bank payment file.",
    why: 'Without an account we cannot build the file your bank needs to pay everyone.',
    explain: {
      plain: 'One account per person, marked as the salary account. We only ever use it to build the payment file you upload to your bank.',
      example: 'Account number plus IFSC in India, or the 16-digit account number in New Zealand.',
      ifYouSkip: 'Payroll and payslips still work — you just pay everyone by hand from your bank portal.',
    },
    stage: 'people', required: false,
    route: '/people', cta: 'Add bank details',
    permission: 'canManageEmployees', prismaModel: 'BankAccount',
    dependsOn: ['employees'], minutes: 20, doneBy: 'HR',
  },
  {
    key: 'approval_workflows',
    label: 'Decide who approves what',
    description: 'Build your own approval chains, so a big expense claim can need HR as well as the manager.',
    why: 'Out of the box everything goes to the manager. Your rules are probably more nuanced.',
    explain: {
      plain: 'A chain is a list of steps with a condition. You choose the condition, the approvers and the order.',
      example: 'Claims over ₹25,000 go to the manager first, then Finance.',
      ifYouSkip: 'Everything routes to the direct manager only, however large the request.',
    },
    stage: 'people', required: false,
    route: '/approvals', cta: 'Build a chain',
    permission: 'canManageApprovalWorkflows', prismaModel: 'WorkflowDefinition',
    dependsOn: ['managers'], minutes: 15, doneBy: 'HR',
  },
  {
    key: 'field_access',
    label: 'Control who sees sensitive details',
    description: "Hide salary, ID numbers or home addresses from the roles that shouldn't see them.",
    why: 'Everyone with HR access can see everything until you say otherwise.',
    explain: {
      plain: 'You pick a role and mark groups of fields as hidden, read-only or editable for that role.',
      example: 'Your recruitment coordinator can open a profile but never sees the salary.',
      ifYouSkip: 'Nothing breaks — but every operator role can read every field. DISMISSIBLE if that is what you want.',
    },
    stage: 'people', required: false,
    route: '/settings/field-access', cta: 'Restrict a field',
    permission: 'canManageEmployees', prismaModel: 'BusinessRole.fieldAccess',
    dependsOn: ['hr_team_roles'], minutes: 10, doneBy: 'HR',
  },
  {
    key: 'custom_fields',
    label: 'Add your own employee fields',
    description: "Track anything we don't already ask for, like shirt size or blood group.",
    why: 'Every company tracks something we did not think of.',
    explain: {
      plain: 'You define the field once, pick its type, and it appears on every profile and in exports.',
      example: 'Blood group, T-shirt size, or the badge number from your access-control system.',
      ifYouSkip: 'That information lives in a spreadsheet somewhere else.',
    },
    stage: 'people', required: false,
    route: '/settings/custom-fields', cta: 'Add a field',
    permission: 'canManageEmployees', prismaModel: 'CustomFieldDefinition',
    dependsOn: ['employees'], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'onboarding_checklist',
    label: 'Build your new-joiner checklist',
    description: 'The tasks that happen for every new hire, like laptop and ID card, so nothing is forgotten.',
    why: 'The same five things are forgotten for every new joiner until this exists.',
    explain: {
      plain: 'A template of tasks, each with an owner and a due day relative to the joining date. It starts itself when someone joins.',
      example: 'IT issues a laptop on day minus one; HR collects documents on day one.',
      ifYouSkip: 'On-boarding runs off memory and a chat thread.',
    },
    stage: 'people', required: false,
    route: '/settings/lifecycle', cta: 'Build the checklist',
    permission: 'canManageOnboarding', prismaModel: 'LifecycleTemplate',
    dependsOn: ['employees'], minutes: 15, doneBy: 'HR',
  },
  {
    key: 'offboarding_checklist',
    label: 'Build your exit checklist',
    description: 'The steps that happen when someone leaves, like handover, asset return and final pay.',
    why: 'Exits are where laptops and access are quietly lost.',
    explain: {
      plain: 'The mirror image of the joiner checklist, triggered when a separation is raised.',
      example: 'Collect the laptop, revoke access, run the final settlement, issue the relieving letter.',
      ifYouSkip: 'Assets and access go unrecovered and the final settlement is late.',
    },
    stage: 'people', required: false,
    route: '/settings/lifecycle', cta: 'Build the checklist',
    permission: 'canManageOnboarding', prismaModel: 'LifecycleTemplate',
    dependsOn: ['employees'], minutes: 15, doneBy: 'HR',
  },
  {
    key: 'probation_policy',
    label: 'Set your probation rules',
    description: 'How long new joiners stay on probation, and whether they are confirmed automatically.',
    why: 'Confirmations slip past their date when nobody is tracking them.',
    explain: {
      plain: 'You set the probation length once and we track each joiner against it, either confirming automatically or reminding you.',
      example: 'Six months for everyone, three months for interns.',
      ifYouSkip: 'People stay on probation long after they should have been confirmed.',
    },
    stage: 'people', required: false,
    route: '/settings/lifecycle', cta: 'Set probation',
    permission: 'canManageOnboarding', prismaModel: 'ProbationPolicy',
    dependsOn: ['entity'], minutes: 5, doneBy: 'HR',
  },

  // ═══ TIME & ATTENDANCE ════════════════════════════════════════════════════
  {
    key: 'holidays',
    label: "Publish this year's holiday list",
    description: 'Your company holidays for the year. These are paid days off and are never counted as leave.',
    why: 'Without a holiday list, a public holiday is treated as an ordinary working day.',
    explain: {
      plain: 'A dated list of paid days off for the year. Attendance and leave both read it, so nobody is marked absent on a holiday.',
      example: 'Republic Day, Holi, Independence Day, Diwali, Christmas.',
      ifYouSkip: 'People are marked absent on holidays and pay is docked.',
    },
    stage: 'time', required: true,
    route: '/attendance?tab=holidays', cta: 'Publish holidays',
    permission: 'canManageAttendance', prismaModel: 'Holiday',
    dependsOn: ['locations'], minutes: 15, doneBy: 'HR',
  },
  {
    key: 'shifts',
    label: 'Set your working hours and weekly offs',
    description: 'Your working hours and which days are weekly offs, for example 9:30 to 6:30 with Saturday and Sunday off.',
    why: 'This is the only place a weekly off is defined — everything about a working day starts here.',
    explain: {
      plain: 'A pattern is start time, end time, break and which days of the week are off. Most companies need exactly one.',
      example: '9:30 to 18:30, Monday to Friday, Saturday and Sunday off.',
      ifYouSkip: 'We have no idea which days are working days, so attendance and late-coming are meaningless.',
    },
    stage: 'time', required: true,
    route: '/attendance?tab=shifts', cta: 'Set working hours',
    permission: 'canManageAttendance', prismaModel: 'ShiftPattern',
    dependsOn: ['entity'], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'shift_assignment',
    label: 'Put everyone on a working pattern',
    description: 'Attach each person to a pattern so we know their working days, hours and weekly offs.',
    why: 'A pattern nobody is attached to does nothing.',
    explain: {
      plain: 'Assign the pattern to everyone at once, or give the night shift its own. You can change it from any future date.',
      example: 'Everyone on General, except the support team on Night from 1 September.',
      ifYouSkip: 'Attendance reports read as blank for unassigned people. DISMISSIBLE if you do not track attendance at all.',
    },
    stage: 'time', required: false,
    route: '/roster', cta: 'Assign the pattern',
    permission: 'canManageAttendance', prismaModel: 'ShiftAssignment',
    dependsOn: ['shifts', 'employees'], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'leave_types',
    label: 'Set up your leave types',
    description: 'The kinds of leave you offer, like earned leave, sick leave, casual leave and unpaid leave.',
    why: 'Nothing is pre-loaded — the whole leave module is inert until you define at least one type.',
    explain: {
      plain: 'A leave type is a bucket people apply against. You decide whether it is paid, whether it needs proof, and who can see it.',
      example: 'Earned leave, sick leave, casual leave, loss of pay.',
      ifYouSkip: 'Your team cannot apply for leave at all.',
    },
    stage: 'time', required: true,
    route: '/leave?tab=types', cta: 'Add a leave type',
    permission: 'canManageOrg', prismaModel: 'LeaveType',
    dependsOn: ['country'], minutes: 10, doneBy: 'HR',
  },
  {
    key: 'leave_policies',
    label: 'Set how much leave people get',
    description: 'How many days of each leave type people earn, when it lands, and how much carries into next year.',
    why: 'The type says what leave is; the rule says how much of it people actually get.',
    explain: {
      plain: 'You set the yearly quota, whether it accrues monthly or lands in one go, and how many days carry forward.',
      example: 'Earned leave, 18 days a year, accrued 1.5 days a month, up to 30 carried forward.',
      ifYouSkip: 'Every balance shows zero and nobody can take a day off.',
    },
    stage: 'time', required: true,
    route: '/leave?tab=policies', cta: 'Set the quota',
    permission: 'canManageOrg', prismaModel: 'LeavePolicy',
    dependsOn: ['leave_types'], minutes: 15, doneBy: 'HR',
  },
  {
    key: 'leave_assignments',
    label: 'Give your people their leave rules',
    description: 'Apply each leave rule to the right group, otherwise everyone\'s balance shows zero.',
    why: 'So everyone sees the right leave balance instead of zero.',
    explain: {
      plain: 'A leave rule only gives days to the people you attach it to.',
      example: "Attach 'Earned leave — 18 days' to Acme India Pvt Ltd, and every person in that company starts earning.",
      ifYouSkip: "Your team opens the app, sees zero leave, and assumes it's broken.",
    },
    stage: 'time', required: true,
    route: '/leave?tab=policies', cta: 'Apply the rules',
    permission: 'canManageOrg', prismaModel: 'LeavePolicyAssignment',
    dependsOn: ['leave_policies', 'employees'], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'leave_opening_balances',
    label: 'Bring in current leave balances',
    description: 'Moving from another system part-way through the year? Upload everyone\'s balance as it stands today.',
    why: 'Mid-year switchers lose everything they had banked unless you bring it across.',
    explain: {
      plain: 'One spreadsheet of person, leave type and days remaining. We land it as an opening balance so the maths carries on from where it stopped.',
      example: 'Priya had 11.5 earned leave days left in the old system on 31 August.',
      ifYouSkip: 'Everyone starts from zero and your team is, correctly, upset.',
    },
    stage: 'time', required: false,
    route: '/settings/import', cta: 'Upload balances',
    permission: 'canManageImports', prismaModel: 'ImportJob',
    dependsOn: ['leave_assignments'], minutes: 20, doneBy: 'HR',
    // Only for tenants that actually came from somewhere else — a greenfield
    // tenant never sees this row (it would be a permanently-red nag).
    includeWhen: (status) => !!status._migratedFromAnotherSystem,
  },
  {
    key: 'attendance_capture',
    label: 'Choose how people mark attendance',
    description: 'Decide how staff clock in: from the web, from their phone with location, from office wi-fi, or with a face scan.',
    why: 'Out of the box anyone can punch from anywhere. You decide whether that is fine.',
    explain: {
      plain: 'You pick which proofs a punch must carry — a location inside a fence, an office IP address, or a face match.',
      example: 'Office staff must be on the office wi-fi; field staff must be inside a customer geofence.',
      ifYouSkip: 'Plain web punches keep working with no checks. DISMISSIBLE — that is a legitimate end state.',
    },
    stage: 'time', required: false,
    route: '/settings/attendance/capture', cta: 'Choose a method',
    permission: 'canManageAttendance', prismaModel: 'AttendanceCapturePolicy',
    dependsOn: ['locations'], minutes: 10, doneBy: 'HR',
  },
  {
    key: 'biometric_devices',
    label: 'Connect your attendance machines',
    description: 'Link your fingerprint or face machines so punches flow in on their own.',
    why: 'Otherwise someone re-types the device log into a spreadsheet every month.',
    explain: {
      plain: 'Register the machine by its serial number and map each device user id to a person. Punches then arrive on their own.',
      example: 'The ZKTeco unit at reception pushes punches straight into the daily attendance sheet.',
      ifYouSkip: 'Nothing breaks unless you own machines. DISMISSIBLE if you do not.',
    },
    stage: 'time', required: false,
    route: '/settings/attendance/biometric', cta: 'Add a device',
    permission: 'canManageAttendance', prismaModel: 'PunchDevice',
    dependsOn: ['attendance_capture'], minutes: 20, doneBy: 'your IT person',
  },
  {
    key: 'work_policies',
    label: 'Set overtime and late-coming rules',
    description: 'When overtime is paid, and what happens if someone is repeatedly late.',
    why: 'Overtime and lateness are judged by hand until you write the rule down.',
    explain: {
      plain: 'You set the threshold after which extra hours count, the rate they are paid at, and how many late marks become a half day.',
      example: 'Overtime after 9 hours at 2x; three late marks in a month cost half a day.',
      ifYouSkip: 'Overtime is calculated manually and lateness is argued about case by case.',
    },
    stage: 'time', required: false,
    route: '/settings/attendance/work-policies', cta: 'Set the rules',
    permission: 'canManageAttendance', prismaModel: 'OvertimeRule',
    dependsOn: ['shifts'], minutes: 10, doneBy: 'HR',
  },
  {
    key: 'restricted_holidays',
    label: 'Allow optional holidays',
    description: 'Let staff pick a few festival holidays of their own from a list you approve.',
    why: 'India has more festivals than anyone gets days for, so people choose their own.',
    explain: {
      plain: 'You publish a pool of optional festival days and set how many each person may take. They pick; you approve.',
      example: 'A pool of eight festivals, two picks each.',
      ifYouSkip: 'Everyone gets the same fixed list and takes ordinary leave for their own festivals.',
    },
    stage: 'time', required: false,
    route: '/attendance?tab=holidays', cta: 'Set the allowance',
    permission: 'canManageAttendance', prismaModel: 'Business.featureFlags.leave',
    countryOnly: 'IN', dependsOn: ['holidays'], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'comp_off',
    label: 'Turn on comp-off',
    description: 'Let people bank a day off when they work on a weekly off or a holiday, instead of losing it.',
    why: 'People who work a Sunday should not simply lose the day.',
    explain: {
      plain: 'When someone works on a weekly off or a holiday they bank a day, which they can take later within a window you set.',
      example: 'Worked Sunday for a release? Bank one day, use it within 60 days.',
      ifYouSkip: 'Weekend work is tracked in someone\'s head and forgotten.',
    },
    stage: 'time', required: false,
    route: '/comp-off-admin', cta: 'Turn on comp-off',
    permission: 'canManageOrg', prismaModel: 'LeavePolicy.compOffConfig',
    dependsOn: ['leave_types'], minutes: 10, doneBy: 'HR',
  },
  {
    key: 'leave_encashment',
    label: 'Let people cash in unused leave',
    description: 'Allow staff to convert spare leave days into money, within limits you set.',
    why: 'Otherwise banked leave only ever converts to cash when someone resigns.',
    explain: {
      plain: 'You allow a leave type to be encashed while people are still employed, with a floor balance and a yearly cap.',
      example: 'Encash up to 10 earned-leave days a year, provided 15 remain.',
      ifYouSkip: 'Balances only ever pay out in the final settlement.',
    },
    stage: 'time', required: false,
    route: '/leave-encashment', cta: 'Allow encashment',
    permission: 'canManageOrg', prismaModel: 'LeavePolicy.encashInService',
    dependsOn: ['leave_policies'], minutes: 5, doneBy: 'HR',
  },

  // ═══ PAY & TAX ════════════════════════════════════════════════════════════
  {
    key: 'ctc_policy',
    label: 'Build your salary structure',
    description: 'A reusable template that splits a total salary into basic pay, house rent and allowances.',
    why: 'Every salary you set from now on is built from this template.',
    explain: {
      plain: 'You describe the split once as percentages and rules, and then every offer is just one number: the total.',
      example: 'Basic 40% of CTC, HRA 50% of basic, the rest as a special allowance.',
      ifYouSkip: 'Every salary has to be broken down by hand, and the breakups drift apart.',
    },
    stage: 'pay', required: true,
    route: '/compensation/policies', cta: 'Build the structure',
    permission: 'canManageCompensation', prismaModel: 'CtcPolicy',
    dependsOn: ['entity'], minutes: 20, doneBy: 'Finance',
  },
  {
    key: 'pay_components',
    label: 'Add your own pay items',
    description: "Extra earnings or deductions your company uses that aren't in the standard list, like a fuel allowance.",
    why: 'The standard list covers most companies, but never all of them.',
    explain: {
      plain: 'You add the item, say whether it is an earning or a deduction and how it is taxed, and it becomes available to every structure.',
      example: 'A fuel allowance, a night-shift allowance, or a canteen deduction.',
      ifYouSkip: 'Anything unusual has to be squeezed into a special allowance.',
    },
    stage: 'pay', required: false,
    route: '/compensation?tab=components', cta: 'Add a pay item',
    permission: 'canManageCompensation', prismaModel: 'SalaryComponent',
    dependsOn: ['ctc_policy'], minutes: 10, doneBy: 'Finance',
  },
  {
    key: 'salary_assigned',
    label: 'Give everyone a salary',
    description: 'Attach a salary to each person. Anyone without one is skipped by payroll and gets no payslip.',
    why: 'A person with no salary is silently skipped by every pay run.',
    explain: {
      plain: 'You give the total; the structure does the split. It applies from a date, so mid-month joiners and increments both work.',
      example: '₹12,00,000 a year from 1 April, and the basic, HRA and allowances fill in themselves.',
      ifYouSkip: 'That person gets no payslip and no money, with no error to warn you.',
    },
    stage: 'pay', required: true,
    route: '/compensation?tab=revisions', cta: 'Assign salaries',
    permission: 'canManageCompensation', prismaModel: 'CompensationRevision',
    dependsOn: ['ctc_policy', 'employees'], minutes: 20, doneBy: 'Finance',
  },
  {
    key: 'pay_calendar',
    label: 'Set your pay dates',
    description: 'How often you pay people, which day salary lands, and the cut-off date for attendance.',
    why: 'A pay run cannot exist without one — this is a hard requirement, not a preference.',
    explain: {
      plain: 'You set the cycle (usually monthly), the day salary is paid, and the day attendance is frozen for that month.',
      example: 'Monthly, paid on the last working day, attendance cut off on the 25th.',
      ifYouSkip: 'You cannot create a pay run at all.',
    },
    stage: 'pay', required: true,
    route: '/settings/payroll', cta: 'Set pay dates',
    permission: 'canRunPayroll', prismaModel: 'PayCalendar',
    dependsOn: ['entity'], minutes: 5, doneBy: 'Finance',
  },
  {
    key: 'salary_day_basis',
    label: "Choose how a day's pay is worked out",
    description: 'Whether a day of pay is one thirtieth, one twenty-sixth, or the real number of days in the month.',
    why: 'It changes what a half-month joiner is actually paid.',
    explain: {
      plain: 'When someone joins, leaves or takes unpaid leave mid-month, we divide their salary by this number of days.',
      example: 'On a 26-day basis, one unpaid day costs 1/26th of the month, not 1/31st.',
      ifYouSkip: 'We use the real calendar days in the month, which is a perfectly normal choice.',
    },
    stage: 'pay', required: false,
    route: '/settings/payroll', cta: 'Choose the basis',
    permission: 'canManageOrg', prismaModel: 'Entity.prorationBasis',
    dependsOn: ['pay_calendar'], minutes: 2, doneBy: 'Finance',
  },
  {
    key: 'statutory_registrations',
    label: 'Add your PF, ESI, PT and TDS numbers',
    description: 'Your EPFO, ESIC, professional tax and TAN registration numbers. Filings and registers are built from these.',
    why: 'Your filing calendar and every statutory register are generated from these registrations.',
    explain: {
      plain: 'These are the numbers the government issued to you as an employer, one per scheme, per company.',
      example: 'EPFO establishment code, ESIC code, a professional-tax registration per state, and your TAN.',
      ifYouSkip: 'No filing reminders, no statutory registers, and returns prepared by hand.',
    },
    stage: 'pay', required: true,
    route: '/org/registrations', cta: 'Add registrations',
    permission: 'canManageStatutory', prismaModel: 'StatutoryRegistration',
    countryOnly: 'IN', dependsOn: ['entity'], minutes: 15, doneBy: 'Finance',
  },
  {
    key: 'payslip_settings',
    label: 'Choose how payslips are protected',
    description: 'Decide whether payslip files open with a password, usually the person\'s date of birth.',
    why: 'A payslip forwarded by mistake should not be readable by whoever receives it.',
    explain: {
      plain: 'Either the PDF opens freely, or it opens with the person\'s date of birth as the password.',
      example: 'Born 4 August 1994? The password is 04081994.',
      ifYouSkip: 'Payslip PDFs open for anyone who has the file.',
    },
    stage: 'pay', required: false,
    route: '/settings/payroll', cta: 'Set the protection',
    permission: 'canRunPayroll', prismaModel: 'Business.featureFlags.payroll',
    dependsOn: ['pay_calendar'], minutes: 2, doneBy: 'Finance',
  },
  {
    key: 'variance_thresholds',
    label: 'Set your payroll safety limits',
    description: 'Tell us how big a change from last month should pause a pay run for review. Your safety net against a typo.',
    why: 'It is the one thing standing between a mistyped salary and a paid pay run.',
    explain: {
      plain: 'We compare this month to last month and flag anything that moved more than you allow, before you approve.',
      example: 'Flag anyone whose net pay moved by more than 20%, or the total by more than 10%.',
      ifYouSkip: 'Sensible defaults still apply — this only tightens or loosens them.',
    },
    stage: 'pay', required: false,
    route: '/payroll', cta: 'Set the limits',
    permission: 'canApprovePayroll', prismaModel: 'VarianceThreshold',
    dependsOn: ['pay_calendar'], minutes: 5, doneBy: 'Finance',
  },
  {
    key: 'payroll_history_import',
    label: "Bring in this year's pay history",
    description: 'Already paid salaries this tax year elsewhere? Upload that history so tax and year-end forms come out right.',
    why: 'Income tax is worked out across the whole year, not from the month you joined us.',
    explain: {
      plain: 'Upload what each person was paid and what tax was deducted earlier this year, so the remaining months are calculated correctly.',
      example: 'You moved to us in September — April to August has to come across, or December\'s tax is wrong.',
      ifYouSkip: 'Tax is under-deducted all year and year-end forms do not tally.',
    },
    stage: 'pay', required: false,
    route: '/settings/import', cta: 'Upload pay history',
    permission: 'canManageImports', prismaModel: 'ImportJob',
    dependsOn: ['salary_assigned'], minutes: 30, doneBy: 'Finance',
    // Only when someone was already on the payroll before this tax year started.
    includeWhen: (status) => (status._joinedBeforeTaxYearStart || 0) > 0,
  },
  {
    key: 'tax_regime_policy',
    label: 'Set your default income-tax option',
    description: 'Choose whether new joiners start on the new or the old tax option, and until when they can switch.',
    why: 'Everyone needs a tax option from their first payslip, whether or not they have chosen one.',
    explain: {
      plain: 'India offers two income-tax regimes. You pick the default for people who have not chosen, and the date after which choices are locked.',
      example: 'Default to the new regime; lock choices on 31 January.',
      ifYouSkip: 'Monthly tax is deducted on an assumption nobody agreed to.',
    },
    stage: 'pay', required: false,
    route: '/tax/regime', cta: 'Set the default',
    permission: 'canManageStatutory', prismaModel: 'TaxRegimePolicy',
    countryOnly: 'IN', dependsOn: ['employees'], minutes: 5, doneBy: 'Finance',
  },
  {
    key: 'tax_declaration_window',
    label: 'Open the tax-saving declaration window',
    description: "Let staff declare their investments and rent, so their monthly tax isn't higher than it needs to be.",
    why: 'Undeclared investments mean over-deducted tax and a refund your team waits a year for.',
    explain: {
      plain: 'You open a window; people declare rent, insurance and investments; we lower their monthly tax accordingly and collect proof later.',
      example: 'Declarations open in April, proofs due by January.',
      ifYouSkip: 'Everyone is taxed as though they saved nothing.',
    },
    stage: 'pay', required: false,
    route: '/tax/declaration-window', cta: 'Open the window',
    permission: 'canManageStatutory', prismaModel: 'InvestmentDeclarationWindow',
    countryOnly: 'IN', dependsOn: ['tax_regime_policy'], minutes: 5, doneBy: 'Finance',
  },
  {
    key: 'fbp_plan',
    label: 'Offer flexible allowances',
    description: 'Let staff move part of their pay into tax-friendly heads like fuel, phone bills or meal cards.',
    why: 'It raises take-home pay at no extra cost to you.',
    explain: {
      plain: 'You define a basket of heads with caps; each person allocates part of their package into the ones they will actually claim.',
      example: 'Fuel up to ₹2,000 a month, phone up to ₹1,500, the rest as a special allowance.',
      ifYouSkip: 'Everything is taxed as ordinary salary.',
    },
    stage: 'pay', required: false,
    route: '/compensation/fbp', cta: 'Build the basket',
    permission: 'canManageCompensation', prismaModel: 'FbpPlan',
    countryOnly: 'IN', dependsOn: ['ctc_policy'], minutes: 20, doneBy: 'Finance',
  },
  {
    key: 'first_payroll',
    label: 'Run your first payroll',
    description: 'Create the month\'s pay run, check the payslips, then approve it. This is the moment we start working for you.',
    why: 'This is the moment everything you set up starts paying off.',
    explain: {
      plain: 'Create the run, review the register and the variance flags, then approve. Payslips are published to your team in one step.',
      example: 'Run September, check the four flagged people, approve, and everyone has a payslip.',
      ifYouSkip: 'Nothing you have set up has actually been used yet.',
    },
    stage: 'pay', required: true,
    route: '/payroll', cta: 'Run payroll',
    permission: 'canRunPayroll', prismaModel: 'PayRun',
    dependsOn: ['pay_calendar', 'salary_assigned', 'statutory_ids'], minutes: 30, doneBy: 'Finance',
  },
  {
    key: 'disbursement_bank',
    label: 'Pick the bank you pay salaries from',
    description: 'Choose your salary bank so we build the payment file in exactly the format that bank expects.',
    why: 'Every bank wants a slightly different file, and the wrong one is rejected on upload.',
    explain: {
      plain: 'You name the bank once and we generate the payment file in that bank\'s own format.',
      example: 'HDFC, ICICI, Axis, Kotak, SBI, or a generic NEFT/RTGS file.',
      ifYouSkip: 'You choose the bank each time you build a batch. DISMISSIBLE.',
    },
    stage: 'pay', required: false,
    route: '/settings/payroll', cta: 'Pick your bank',
    permission: 'canManageOrg', prismaModel: 'Entity.defaultPayoutBank',
    countryOnly: 'IN', dependsOn: ['entity'], minutes: 2, doneBy: 'Finance',
  },
  {
    key: 'first_disbursement',
    label: 'Make your first salary payment file',
    description: 'Turn an approved pay run into the file you upload to your bank, then match the payments back.',
    why: 'It closes the loop: approved pay run in, bank file out, payments matched back.',
    explain: {
      plain: 'We build the file from the approved run, you upload it to your bank, and then mark the batch paid so the ledger ties out.',
      example: 'Download the batch, upload it in your bank portal, mark it paid.',
      ifYouSkip: 'You pay from your bank portal by hand. DISMISSIBLE — plenty of tenants do.',
    },
    stage: 'pay', required: false,
    route: '/payroll/disbursement', cta: 'Build the file',
    permission: 'canRunPayroll', prismaModel: 'PayoutBatch',
    dependsOn: ['first_payroll', 'bank_accounts'], minutes: 15, doneBy: 'Finance',
  },
  {
    key: 'compliance_calendar',
    label: 'Switch on filing reminders',
    description: 'Get reminded before every PF, ESI, professional tax and TDS deadline, and keep proof of what you filed.',
    why: 'Late statutory filings carry interest and penalties that dwarf the effort of a reminder.',
    explain: {
      plain: 'We read your registrations and build a dated calendar of every filing you owe, then remind you before each one.',
      example: 'PF by the 15th, ESI by the 15th, TDS by the 7th, quarterly 24Q by the end of the following month.',
      ifYouSkip: 'Deadlines live in someone\'s calendar and are missed when they are on leave.',
    },
    stage: 'pay', required: false,
    route: '/payroll/compliance', cta: 'Turn on reminders',
    permission: 'canManageStatutory', prismaModel: 'ComplianceObligation',
    countryOnly: 'IN', dependsOn: ['statutory_registrations'], minutes: 5, doneBy: 'Finance',
  },
  {
    key: 'statutory_registers',
    label: 'Set up your labour registers',
    description: 'The muster roll and wage registers an inspector can ask for. We build them from data you already have.',
    why: 'An inspector can ask for these on the day, and they are built from data you already hold.',
    explain: {
      plain: 'The muster roll and wage registers are just formatted views over your attendance and payroll, per state.',
      example: 'Form 25 wage register and the muster roll, exported for the month an inspector asks about.',
      ifYouSkip: 'The registers are assembled by hand under time pressure.',
    },
    stage: 'pay', required: false,
    route: '/payroll/registers', cta: 'Set up registers',
    permission: 'canManageStatutory', prismaModel: 'RegisterDefinition',
    countryOnly: 'IN', dependsOn: ['statutory_registrations'], minutes: 10, doneBy: 'Finance',
  },
  {
    key: 'expense_categories',
    label: 'Set up your expense categories',
    description: 'The kinds of expenses staff can claim, like travel, meals or internet.',
    why: 'People cannot file a claim until there is something to file it against.',
    explain: {
      plain: 'A category is what a claim is for. It drives the approval route, the tax treatment and the accounting code.',
      example: 'Travel, meals, internet, client entertainment.',
      ifYouSkip: 'Reimbursements arrive as emails with photos attached.',
    },
    stage: 'pay', required: false,
    route: '/settings/travel-policy', cta: 'Add a category',
    permission: 'canManageExpensePolicy', prismaModel: 'ExpenseCategory',
    dependsOn: ['entity'], minutes: 10, doneBy: 'Finance',
  },
  {
    key: 'expense_policy',
    label: 'Set your expense and travel limits',
    description: 'Daily allowances, hotel limits and travel rules by city and level, so claims are checked for you.',
    why: 'Otherwise every claim is judged by whoever happens to open it.',
    explain: {
      plain: 'You set daily allowances and hotel caps by city tier and pay level, and we check each claim against them automatically.',
      example: '₹5,000 a night in a metro for L4 and above, ₹3,000 elsewhere.',
      ifYouSkip: 'Approvers check limits from memory, inconsistently.',
    },
    stage: 'pay', required: false,
    route: '/settings/travel-policy', cta: 'Set the limits',
    permission: 'canManageExpensePolicy', prismaModel: 'ExpensePolicy',
    dependsOn: ['expense_categories'], minutes: 20, doneBy: 'Finance',
  },
  {
    key: 'variable_pay_scheme',
    label: 'Set up bonus and incentive plans',
    description: 'Define how performance bonuses or sales incentives are worked out and approved before they reach payroll.',
    why: 'Bonuses arrive in payroll as a spreadsheet nobody can audit until this exists.',
    explain: {
      plain: 'You describe the plan, the period and the payout rule; awards are approved once and then flow into a pay run.',
      example: 'A quarterly sales incentive at 2% of collected revenue, approved by Finance.',
      ifYouSkip: 'Bonuses go in as one-off manual entries. DISMISSIBLE if you do not pay any.',
    },
    stage: 'pay', required: false,
    route: '/payroll/variable-pay', cta: 'Add a plan',
    permission: 'canManageCompensation', prismaModel: 'VariablePayScheme',
    dependsOn: ['salary_assigned'], minutes: 20, doneBy: 'Finance',
  },
  {
    key: 'report_schedule',
    label: 'Get your key reports by email',
    description: 'Have the reports you care about arrive in your inbox on a schedule you pick.',
    why: 'The reports you actually read are the ones that arrive without you asking.',
    explain: {
      plain: 'Save a report once, then have it emailed to a list of people daily, weekly or monthly.',
      example: 'The payroll register to Finance on the 1st of every month.',
      ifYouSkip: 'Someone remembers to run and forward them. Usually.',
    },
    stage: 'pay', required: false,
    route: '/reports', cta: 'Schedule a report',
    permission: 'canScheduleReports', prismaModel: 'ReportSchedule',
    dependsOn: ['first_payroll'], minutes: 10, doneBy: 'Finance',
  },

  // ═══ ENGAGE & GROW ════════════════════════════════════════════════════════
  {
    key: 'letterheads',
    label: 'Upload your letterhead',
    description: 'Your printed letter design, so offer and experience letters come out on your own stationery.',
    why: 'An offer letter on blank paper does not look like a real offer.',
    explain: {
      plain: 'Upload the letterhead image once and mark it the default. Every letter is composed on top of it.',
      example: 'Your header band and footer, with the body text flowing between them.',
      ifYouSkip: 'Letters generate as plain unbranded documents.',
    },
    stage: 'engage', required: false,
    route: '/letters/letterheads', cta: 'Upload letterhead',
    permission: 'canManageLetters', prismaModel: 'CompanyLetterhead',
    dependsOn: ['branding'], minutes: 10, doneBy: 'HR',
  },
  {
    key: 'letter_templates',
    label: 'Write your letter templates',
    description: 'Write your offer, appointment and relieving letters once, with each person\'s details filled in for you.',
    why: 'Write it once and every future letter takes seconds instead of an afternoon.',
    explain: {
      plain: 'You write the wording with placeholders; we fill in the person, the date, the salary and the designation at issue time.',
      example: 'One offer-letter template covers every offer you will ever send.',
      ifYouSkip: 'Every letter starts from a copied Word document.',
    },
    stage: 'engage', required: false,
    route: '/letters/templates', cta: 'Write a template',
    permission: 'canManageLetters', prismaModel: 'LetterTemplate',
    dependsOn: ['letterheads'], minutes: 30, doneBy: 'HR',
  },
  {
    key: 'helpdesk_categories',
    label: 'Open your HR helpdesk',
    description: 'The list of things staff can raise a ticket about, so questions stop arriving as chat messages.',
    why: 'HR questions arrive as chat messages and get lost until there is a queue.',
    explain: {
      plain: 'You define what people can raise a ticket about; each category gets its own queue and response target.',
      example: 'Payslip query, leave query, document request, IT access.',
      ifYouSkip: 'The same five questions arrive on chat, repeatedly, unanswered.',
    },
    stage: 'engage', required: false,
    route: '/helpdesk', cta: 'Add a category',
    permission: 'canManageHelpdesk', prismaModel: 'HelpdeskCategory',
    dependsOn: ['employees'], minutes: 10, doneBy: 'HR',
  },
  {
    key: 'first_announcement',
    label: 'Post your first announcement',
    description: 'Tell your team the employee app is live and what they can do in it.',
    why: 'People do not use an app nobody told them about.',
    explain: {
      plain: 'An announcement lands in the employee app for the audience you choose, and can be scheduled ahead of time.',
      example: '"Payslips are now in the app — here is how to sign in."',
      ifYouSkip: 'You invited everyone and nobody knows why.',
    },
    stage: 'engage', required: false,
    route: '/announcements', cta: 'Write an announcement',
    permission: 'canManageAnnouncements', prismaModel: 'Announcement',
    dependsOn: ['portal_invites'], minutes: 5, doneBy: 'HR',
  },
  {
    key: 'recognition_setup',
    label: 'Turn on rewards and recognition',
    description: 'Let people give each other kudos against your company values, with points they can spend.',
    why: 'Recognition that has to go through you barely happens.',
    explain: {
      plain: 'You define your values and badges; people give each other kudos in the app and earn points to redeem.',
      example: '"Customer first" and "Ship it" as values, with a monthly point budget per manager.',
      ifYouSkip: 'Good work is noticed privately, if at all.',
    },
    stage: 'engage', required: false,
    route: '/recognition', cta: 'Set up recognition',
    permission: 'canManageRecognition', prismaModel: 'RecognitionValue',
    dependsOn: ['portal_invites'], minutes: 15, doneBy: 'HR',
  },
  {
    key: 'first_survey',
    label: 'Run your first pulse survey',
    description: 'Ask your team a short set of questions and see the results without anyone being named.',
    why: 'You cannot fix what nobody feels safe telling you.',
    explain: {
      plain: 'A short set of questions, answered anonymously, with results only shown once enough people have replied.',
      example: 'A five-question monthly pulse plus one open comment.',
      ifYouSkip: 'You find out how people felt at their exit interview.',
    },
    stage: 'engage', required: false,
    route: '/surveys', cta: 'Create a survey',
    permission: 'canManageSurveys', prismaModel: 'Survey',
    dependsOn: ['portal_invites'], minutes: 15, doneBy: 'HR',
  },
  {
    key: 'competency_framework',
    label: 'Build your skills framework',
    description: 'The skills and behaviours you rate people on, so reviews mean the same thing across teams.',
    why: 'Without it, "exceeds expectations" means something different on every team.',
    explain: {
      plain: 'You list the skills and behaviours that matter and what each level looks like, then reviews rate against them.',
      example: 'Technical depth, ownership, collaboration, communication — each with four levels.',
      ifYouSkip: 'Reviews are free text and ratings are not comparable.',
    },
    stage: 'engage', required: false,
    route: '/performance/competencies', cta: 'Add a skill',
    permission: 'canManagePerformanceCycle', prismaModel: 'Competency',
    dependsOn: ['designations'], minutes: 30, doneBy: 'HR',
  },
  {
    key: 'performance_cycle',
    label: 'Launch your first review round',
    description: 'Set up goals and a review round, with the self-review and manager steps built in.',
    why: 'Reviews that are not scheduled do not happen.',
    explain: {
      plain: 'You set the period and the dates; everyone gets a self-review, managers get theirs, and you can calibrate before release.',
      example: 'An October to March half-year round, self-reviews due 5 April.',
      ifYouSkip: 'Reviews happen ad hoc, if at all, and nothing is comparable.',
    },
    stage: 'engage', required: false,
    route: '/performance', cta: 'Launch a round',
    permission: 'canManagePerformanceCycle', prismaModel: 'ReviewCycle',
    dependsOn: ['managers'], minutes: 30, doneBy: 'HR',
  },
  {
    key: 'first_course',
    label: 'Publish your first training course',
    description: 'Put a course, induction module or safety training online for staff to complete.',
    why: 'Compliance training you cannot evidence is training you did not do.',
    explain: {
      plain: 'Build a course from lessons and a quiz, assign it, and track who has completed it.',
      example: 'A code-of-conduct induction every new joiner must finish in week one.',
      ifYouSkip: 'Completion is tracked in a spreadsheet, if anywhere.',
    },
    stage: 'engage', required: false,
    route: '/learning', cta: 'Publish a course',
    permission: 'canManageLearning', prismaModel: 'Course',
    dependsOn: ['portal_invites'], minutes: 30, doneBy: 'HR',
  },
  // ── The one recruitment row in the core guide: an advert, not a task ────────
  // Hiring is its own TRACK (setup/talent/) with its own denominator, because a
  // company that does not hire must still be able to reach 100% here. What is left
  // behind is a single LOCKED row explaining what the add-on does — and
  // `hideWhenEntitled` deletes even that the moment they own it, so an entitled
  // tenant never carries an unprobeable advert in its score.
  {
    key: 'talent_acquisition_addon',
    label: 'Hire on your own careers page',
    description: 'Post jobs to a careers page in your own branding, collect every application in one place, score candidates against the same scorecard, and turn the person you hire into an employee without re-typing anything.',
    why: 'Hiring in inboxes and spreadsheets is where good candidates get lost.',
    explain: {
      plain: 'Talent Acquisition adds a public careers page, an application pipeline, interview scorecards and candidate emails to your workspace. Nothing you already use changes.',
      example: 'Post "Senior Engineer, Bengaluru", share one link, and every CV arrives in one ranked list instead of forty emails.',
      ifYouSkip: 'Nothing breaks — the rest of your setup is unaffected, and this row never counts towards your 100%.',
    },
    stage: 'engage', required: false,
    route: '/settings?tab=billing&highlight=talent_acquisition', cta: "See what's included",
    permission: 'canManageHiring',
    entitlement: 'talent_acquisition', // → renders LOCKED, out of BOTH sides of the fraction
    hideWhenEntitled: true,            // → and out of the registry entirely once owned
    prismaModel: null, dependsOn: [], minutes: null, doneBy: 'the Owner',
  },
];

/**
 * deriveRegistry — stamp the derived indexes onto a declared registry and freeze it.
 *
 * Exported and reused by setup/talent/checklistItems.js, because `order`,
 * `stageOrder`, `dismissible` and above all `blocking` are the inputs to
 * nextAction.js's ranking: if a second track derived them even slightly
 * differently, "do this next" would mean two different things in one product.
 * The step ARRAYS stay in physically separate modules — that separation is what
 * makes it structurally impossible for a hiring step to land in the core
 * denominator — but the arithmetic over them is this one function.
 */
function deriveRegistry(stages, steps) {
  const stageOrder = Object.freeze(Object.fromEntries(stages.map((s) => [s.key, s.order])));

  // Stamp the global declared order (stable forever — the UI renders "Step 4 of 44"
  // against the operator's scoped position, but `order` itself never moves) and the
  // derived `dismissible` flag. Freeze so a controller bug can never mutate the
  // registry for every subsequent request in the process.
  steps.forEach((s, i) => {
    s.order = i + 1;
    s.stageOrder = stageOrder[s.stage];
    // A required step is never dismissible — POST /dismiss rejects it with 422.
    s.dismissible = !s.required;
    Object.freeze(s.explain);
  });

  const byKey = new Map(steps.map((s) => [s.key, s]));

  // Transitive dependency closure per step: every key this step (directly or
  // indirectly) waits on. Depth-first with a visited set — the declaration is a DAG,
  // and checklistItems.test.js asserts that (a cycle here would be a boot-time hang).
  function ancestorsOf(key, seen = new Set()) {
    const step = byKey.get(key);
    if (!step) return seen;
    for (const dep of step.dependsOn) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      ancestorsOf(dep, seen);
    }
    return seen;
  }

  // `blocking` = how many steps are (transitively) waiting on this one. It is the
  // primary sort key of the next-best action, so finishing the step that unblocks
  // nine others always outranks a leaf. Computed here, never per request, never
  // randomised — the same operator sees the same next step on Monday and Friday.
  const blocking = Object.create(null);
  for (const s of steps) blocking[s.key] = 0;
  for (const s of steps) {
    for (const anc of ancestorsOf(s.key)) blocking[anc] += 1;
  }
  steps.forEach((s) => { s.blocking = blocking[s.key]; Object.freeze(s); });

  Object.freeze(steps);
  Object.freeze(blocking);

  return {
    STAGES: Object.freeze(stages),
    STAGE_ORDER: stageOrder,
    STEPS: steps,
    BY_KEY: byKey,
    BLOCKING: blocking,
    ancestorsOf,
  };
}

// ── Derived, computed ONCE at module load ─────────────────────────────────────
const CORE = deriveRegistry(STAGES, STEPS);

// NOTE on serialisation: nothing here is spread into the response. The controller
// builds each public step field-by-field from PUBLIC_STEP_FIELDS, so the internals
// (the `includeWhen` predicate, the `hideWhenEntitled` flag, the next-action CTA
// verb, the numeric stageOrder) cannot leak the way a `{ ...step }` would — the
// same concern sitepresso solves with its `const { includeWhen, verticals, ...rest }`
// strip, one step stricter.

module.exports = {
  STAGES: CORE.STAGES,
  STAGE_ORDER: CORE.STAGE_ORDER,
  STEPS: CORE.STEPS,
  BY_KEY: CORE.BY_KEY,
  BLOCKING: CORE.BLOCKING,
  ancestorsOf: CORE.ancestorsOf,
  deriveRegistry,
};
