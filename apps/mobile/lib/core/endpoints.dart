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
}
