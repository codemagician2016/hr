// The complete DriftHR ESS endpoint map this app talks to. Every path below is a
// real backend route (verified against backend/src/hr/routes). The self-service
// surface is `/api/hr/me/*` — the subject employee is resolved SERVER-SIDE from
// the customer session, so NO employeeId is ever sent from the client (SELF_ONLY).

class Api {
  Api._();

  // Auth (customer session; cookie + Bearer fallback)
  static const login = '/api/customer/login';
  static const logout = '/api/customer/logout';

  // "Me" — rich profile + country/currency gate (authoritative country source)
  static const meProfile = '/api/hr/me/profile'; // { customer?, employeeId, countryCode, payCurrency, profile }
  static const meProfileFull = '/api/hr/me/profile/full'; // sectioned + per-field policy
  static const meCountryContext = '/api/hr/me/country-context'; // { country, currency, capabilities }
  static const meTasks = '/api/hr/me/tasks'; // pending self-service tasks

  // Attendance
  static const punch = '/api/hr/me/attendance/punch'; // POST { type, [punchAt], geoLat, geoLng, selfieDataUrl? }
  static const punches = '/api/hr/me/attendance/punches'; // ?from=&to=&pageSize=
  static const attendanceSummary = '/api/hr/me/attendance/summary'; // ?from=&to=
  static const attendanceDays = '/api/hr/me/attendance/days'; // ?from=&to=
  static const schedule = '/api/hr/me/attendance/schedule'; // { shift, assignment }
  static const holidays = '/api/hr/me/attendance/holidays'; // ?year=
  static const regularizations = '/api/hr/me/attendance/regularizations'; // GET + POST

  // Feature 2 — multi-mode capture: the policy that applies to me (which methods are
  // required) + self face-enrolment for the FACE mode.
  static const capturePolicy = '/api/hr/me/attendance/policy'; // GET { requireGeo/Ip/Face, faceEnrolled, … }
  static const faceEnrollment = '/api/hr/me/attendance/face'; // GET { enrolled, enrolledAt }
  static const faceEnroll = '/api/hr/me/attendance/face/enroll'; // POST { selfieDataUrl }

  // Leave
  static const leaveTypes = '/api/hr/me/leave/types';
  static const leaveBalances = '/api/hr/me/leave/balances';
  static const leaveHistory = '/api/hr/me/leave/history'; // ?page=&pageSize=
  static const leaveRequests = '/api/hr/me/leave/requests'; // GET + POST
  static String leaveCancel(String id) => '/api/hr/me/leave/requests/$id/cancel';

  // Pay
  static const payslips = '/api/hr/me/payslips'; // ?page=&pageSize=
  static String payslip(String id) => '/api/hr/me/payslips/$id';
  static String payslipPdf(String id) => '/api/hr/me/payslips/$id/pdf';
  static const compensation = '/api/hr/me/compensation'; // { current, history }
  static const compensationPdf = '/api/hr/me/compensation/pdf';

  // Tax (India)
  static const taxDeclaration = '/api/hr/me/tax-declaration'; // GET + POST
  static const taxProjection = '/api/hr/me/tax-projection'; // India-only
  static const taxProjectionPdf = '/api/hr/me/tax-projection/pdf';

  // Approvals (manager / anyone in an approval chain)
  static const approvals = '/api/hr/me/approvals'; // { items: [...] }
  static String approvalDecide(String id) => '/api/hr/me/approvals/$id/decide';

  // Letters
  static const letters = '/api/hr/me/letters'; // ?page=&pageSize=
  static const letterRequests = '/api/hr/me/letters/requests'; // GET + POST
  static const letterRequestable = '/api/hr/me/letters/requestable'; // { items, allowCustom } (Feature 42)
  static String letterDownload(String id) => '/api/hr/me/letters/$id/download';

  // Expenses / reimbursements (Feature 45) — mirrors apps/ess/app/reimbursements
  static const expenseReference = '/api/hr/me/expenses/reference'; // { categories, policy }
  static const expensePolicyPreview = '/api/hr/me/expenses/policy/preview'; // POST → { verdict, … }
  static const expenseClaims = '/api/hr/me/expenses/claims'; // GET { items } + POST create draft
  static String expenseClaim(String id) => '/api/hr/me/expenses/claims/$id';
  static String expenseClaimLines(String id) => '/api/hr/me/expenses/claims/$id/lines'; // POST → { line, verdict }
  static String expenseClaimLine(String id, String lineId) => '/api/hr/me/expenses/claims/$id/lines/$lineId'; // DELETE
  static String expenseClaimSubmit(String id) => '/api/hr/me/expenses/claims/$id/submit';
  static String expenseClaimCancel(String id) => '/api/hr/me/expenses/claims/$id/cancel';

  // Company directory (READ-only colleague list) — used by the feed @mention picker.
  static const directory = '/api/hr/me/directory'; // ?q=&page=&pageSize= → { items:[{id,name,designation,…}], total }

  // Engagement — the news feed / engagement wall (SELF-scope, audience-gated).
  static const feed = '/api/hr/me/engagement/feed'; // ?page=&pageSize= → { items, total }
  static const feedUnreadCount = '/api/hr/me/engagement/feed/unread-count'; // { unread, visible }
  static const feedReadAll = '/api/hr/me/engagement/feed/read-all'; // POST → { ok, marked }
  static String feedRead(String id) => '/api/hr/me/engagement/feed/$id/read'; // POST (mark read)
  static String feedReaction(String id) => '/api/hr/me/engagement/feed/$id/reaction'; // PUT {kind} / DELETE
  static String feedComments(String id) => '/api/hr/me/engagement/feed/$id/comments'; // GET + POST {body,parentId?}
  static String feedComment(String id, String commentId) =>
      '/api/hr/me/engagement/feed/$id/comments/$commentId'; // PATCH {body} / DELETE
  static const celebrations = '/api/hr/me/engagement/celebrations'; // { birthdays, anniversaries, windowDays }

  // Notifications inbox (the feed social layer + fan-outs land here).
  static const notifications = '/api/hr/me/notifications'; // ?page=&pageSize= → { items, total, unlinked? }
  static const notificationsUnreadCount = '/api/hr/me/notifications/unread-count'; // { unread }
  static const notificationsReadAll = '/api/hr/me/notifications/read-all'; // POST → { ok, marked }
  static String notificationRead(String id) => '/api/hr/me/notifications/$id/read'; // POST (mark read)

  // Surveys — open pulses to fill (SELF-scope, audience-gated, anonymity firewall).
  static const surveys = '/api/hr/me/engagement/surveys'; // { items:[{occurrenceId,state,survey,…}] }
  static String survey(String occurrenceId) => '/api/hr/me/engagement/surveys/$occurrenceId'; // GET fill view
  static String surveySubmit(String occurrenceId) =>
      '/api/hr/me/engagement/surveys/$occurrenceId/submit'; // POST {answers} → { receiptToken }
  static String surveyDismiss(String occurrenceId) =>
      '/api/hr/me/engagement/surveys/$occurrenceId/dismiss'; // POST → { ok, dismissed }

  // Rewards & Recognition (Feature 35) — SELF-scope /api/hr/me/*. Peer kudos wall,
  // points wallet + ledger, rewards catalog + redemptions, nomination awards, and
  // the wall leaderboard. The subject employee is resolved server-side (SELF_ONLY).
  static const recognitions = '/api/hr/me/recognitions'; // GET ?direction=given|received|all + POST give
  static const recognitionValues = '/api/hr/me/recognition/values'; // { values:[…], badges:[…] } — the Give picker
  static const recognitionLeaderboard = '/api/hr/me/recognition/leaderboard'; // ?period=month|quarter|allTime&board=earners|givers
  static const wallet = '/api/hr/me/wallet'; // { pointsEnabled, balance, lifetimeEarned, inrPerPoint, inrValue }
  static const walletLedger = '/api/hr/me/wallet/ledger'; // ?page=&pageSize= → { items:[{points(signed),reason,note?,expiresAt?,createdAt}] }
  static const catalog = '/api/hr/me/catalog'; // { pointsEnabled, balance, items:[{id,name,pointsCost,affordable,inStock,…}] }
  static const redemptions = '/api/hr/me/redemptions'; // GET my redemptions + POST { catalogItemId }
  static String redemptionCancel(String id) => '/api/hr/me/redemptions/$id/cancel'; // POST (own + PENDING only)
  static const awardCycles = '/api/hr/me/award-cycles'; // { items:[{id,name,awardType,nominateCloseAt,…}] } open cycles
  static const awardNominations = '/api/hr/me/award-nominations'; // GET { made, won } + POST { cycleId, nomineeEmployeeId, citation }

  // ── Parity wave 2 — Helpdesk · Documents · Directory profiles · Comp-off ──────
  // Every path below is a real backend route (verified against the meHelpdesk /
  // documents / meDirectory / meCompOff controllers). SELF-scope: the subject
  // employee is resolved server-side, so no employeeId is ever sent from here.

  // HR Helpdesk — raise + track tickets.
  static const helpdeskReference = '/api/hr/me/helpdesk/reference'; // { categories:[{id,name,slaHours}], priorities:['LOW','NORMAL','HIGH','URGENT'] }
  static const helpdeskTickets = '/api/hr/me/helpdesk/tickets'; // GET { items:[ticket + category + _count.messages + breached], total } + POST { subject, description?, priority?, categoryId? }
  static String helpdeskTicket(String id) => '/api/hr/me/helpdesk/tickets/$id'; // { ...ticket, category, messages:[{id,authorUserId,body,createdAt}], breached }
  static String helpdeskReply(String id) => '/api/hr/me/helpdesk/tickets/$id/reply'; // POST { body }
  static String helpdeskReopen(String id) => '/api/hr/me/helpdesk/tickets/$id/reopen'; // POST { reason? }
  static String helpdeskRate(String id) => '/api/hr/me/helpdesk/tickets/$id/rate'; // POST { rating(1-5), comment? }

  // My HR documents. Each row carries a `fileUrl` (an S3 URL or a base64 data URL)
  // — there is NO dedicated /download route; the client opens the fileUrl itself.
  static const documents = '/api/hr/me/documents'; // GET { items:[{id,name,category,mimeType,sizeBytes,fileUrl,expiresAt,expired,expiringSoon,verifiedAt,signatureStatus,createdAt}], total }
  static String document(String id) => '/api/hr/me/documents/$id';

  // Company directory — profile detail + my own contact-visibility preferences.
  // (The colleague search list reuses `directory` above.)
  static String directoryProfile(String id) => '/api/hr/me/directory/$id'; // { ...card, reportsCount, orgChart }
  static const directoryFilters = '/api/hr/me/directory/filters'; // { departments, entities, locations }
  static const directoryPreferences = '/api/hr/me/directory/preferences'; // GET { hideWorkPhone, hasWorkPhone, linked } / PATCH { hideWorkPhone }

  // Comp-off — read-only balance + credit lots. Availing a comp-off is an ordinary
  // leave application on the COMP_OFF leave type (POST /me/leave/requests), so there
  // is no apply endpoint here.
  static const compOffBalance = '/api/hr/me/comp-off/balance'; // { available, lotCount, soonestExpiry }
  static const compOffCredits = '/api/hr/me/comp-off/credits'; // { credits:[{id,quantity,consumed,remaining,earnedOn,expiresOn,status,sourceKind,reason}] }
}
