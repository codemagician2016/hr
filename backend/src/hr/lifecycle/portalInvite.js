'use strict';

/**
 * portalInvite.js — Employee portal-invitation / credential flow.
 *
 * provisionEmployee() mints the new hire's ESS Customer login (login = work
 * email) with a RANDOM temp password and a comment that "the invite flow resets
 * it / the new hire claims it". THIS module is that invite flow: it mints a
 * single-use, expiring, hashed-at-rest token, builds the tenant set-password
 * link, fans the welcome out over the HR notification engine (best-effort), and
 * exposes the public accept path that lets the new hire set their own password.
 *
 * SECURITY invariants:
 *   • The RAW token is returned to the caller (for the email + the copyable link)
 *     but only its SHA-256 HASH is persisted. A DB leak never yields a usable
 *     token; look-ups go by the hash.
 *   • Single-use: accept stamps usedAt + status=ACCEPTED. A re-invite REVOKEs the
 *     prior PENDING token (its hash still resolves, but status≠PENDING → rejected).
 *   • Expiring: PORTAL_INVITE_TTL_DAYS (default 7).
 *   • Tenant-isolated: every read/write is scoped by businessId; the public accept
 *     resolves the tenant FROM the token row, so a token can only ever touch the
 *     tenant that minted it.
 *   • No clobber: we never reset an ALREADY-active (claimed/logged-in) Customer
 *     unless the caller explicitly asks for a reset.
 *
 * This module is transport-agnostic — the admin controller and the public
 * customer controller both call into it. Notifications are best-effort: a mail
 * failure never breaks the invite record (the copyable link is still returned).
 */

const crypto = require('crypto');
const prisma = require('../../core/lib/prisma');

let _hostForSlug;
try { ({ hostForSlug: _hostForSlug } = require('../../core/lib/subdomainProvision')); } catch { _hostForSlug = null; }

// Keep the MODULE reference (not a destructured fn) so the fan-out always reads
// the live `notifyHrEvent` — a test can spy on `notifications.notifyHrEvent` and
// see the invite call go through it.
let _notifications;
try { _notifications = require('../integrations/notifications'); } catch { _notifications = null; }

// 7-day default validity (overridable via env, clamped to a sane 1–30 days).
function ttlMs() {
  const n = parseInt(process.env.PORTAL_INVITE_TTL_DAYS || '7', 10);
  const days = Number.isFinite(n) ? Math.min(Math.max(n, 1), 30) : 7;
  return days * 24 * 60 * 60 * 1000;
}

// 32 random bytes → URL-safe base64 (no padding/+/). ~43 chars, 256 bits of
// entropy — unguessable, and safe to drop straight into a query string.
function generateRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// One-way SHA-256 hex of the raw token. The ONLY thing we persist.
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

// Build the set-password link a new hire clicks to claim their login.
//
// Unlike the careers/letters links, this one is deliberately NOT on the tenant's
// own host — see the long note in the body. A credential-claim link has to
// survive sitting in an inbox while an admin renames their portal or binds a
// domain, and the tenant host does not survive either.
async function buildSetPasswordLink(businessId, rawToken) {
  const biz = await prisma.business
    .findUnique({
      where: { id: businessId },
      select: {
        slug: true,
        // The host that was ACTUALLY provisioned, not one re-derived from the
        // slug. subdomainProvision writes these three together after the DNS
        // record exists, so they are the only trustworthy answer to "does this
        // tenant have a portal address that resolves?".
        subscription: { select: { customDomain: true, customDomainStatus: true, customDomainVerified: true } },
      },
    })
    .catch(() => null);
  const slug = biz && biz.slug ? biz.slug : null;
  const path = `/set-password?token=${encodeURIComponent(rawToken)}`;

  // Prefer the provisioned host. hostForSlug() only computes `{slug}.drifthr.com`
  // from the slug — it never checks that the record exists, so on a tenant whose
  // provisioning silently failed (it is best-effort and swallows every error) it
  // returns a confident-looking URL that resolves nowhere. That is how a new
  // tenant emails invites whose links report "not valid": the page never loads.
  const sub = biz && biz.subscription ? biz.subscription : null;
  const boundHost = sub && sub.customDomainVerified && sub.customDomainStatus === 'ACTIVE'
    ? (sub.customDomain || null)
    : null;

  let derivedHost = null;
  try { derivedHost = slug && _hostForSlug ? _hostForSlug(slug) : null; } catch { derivedHost = null; }

  // When the tenant has no PROVISIONED host, do not emit a link to a guessed one
  // — a hostname that was never created returns DNS_PROBE_FINISHED_NXDOMAIN and
  // the new hire simply cannot claim their account. Fall back to the platform
  // host, which always resolves and now serves /set-password
  // (apps/platform/app/set-password). That works because the invite token is the
  // only thing identifying the tenant: acceptInvite looks the row up by tokenHash
  // and reads businessId off it, so no host or slug context is needed.
  //
  // WHY THE PLATFORM HOST IS ALWAYS USED, even when the tenant has its own:
  //
  // An invite sits in an inbox for days. The tenant's portal host is NOT stable
  // over that window — changing the slug, or binding a custom domain,
  // deprovisions the old hostname (changeSlug calls deprovisionSubdomain). Any
  // invite already sent to the old host dies the moment the admin does either,
  // and nobody finds out until a new hire reports a broken link. A branded URL is
  // not worth a credential-claim link that silently expires on a settings change.
  //
  // The platform host is the only host-stable option: it resolves before a domain
  // is bound, after one is bound, and after one is CHANGED, because the token —
  // not the hostname — identifies the tenant.
  //
  // `boundHost` is still resolved above and returned as `tenantHost` so callers
  // can show the admin their branded portal address; it is just not what the
  // one-shot claim link depends on.
  const platformHost = process.env.PLATFORM_DOMAIN || 'drifthr.com';
  const host = platformHost;
  const origin = `https://${host}`;
  return {
    url: `${origin}${path}`,
    path,
    host,
    // The tenant's own portal address when it exists — for display, not routing.
    tenantHost: boundHost || null,
    // Whether the TENANT has a provisioned portal address at all. It no longer
    // affects the link (that is always the platform host now) — it drives the
    // nudge telling an admin their employees have no branded address to sign in
    // at afterwards.
    hostVerified: !!boundHost,
    // Diagnostics: what the slug WOULD have produced. Answers "why isn't this on
    // my domain?" without anyone having to read hostForSlug.
    derivedHost: derivedHost || null,
  };
}

/**
 * Derive an employee's portal-access status WITHOUT extra round-trips when the
 * caller already has the Customer + the latest invite. Pure — no DB.
 *   NOT_INVITED — no invite ever sent and no claimed Customer login
 *   INVITED     — a PENDING, unexpired token exists (awaiting claim)
 *   ACTIVE      — the ESS Customer login is claimed (emailVerified / has logged in)
 *   EXPIRED     — the latest invite lapsed and the login was never claimed
 *   REVOKED     — the latest invite was superseded and the login isn't claimed
 * `customer` is the work-email Customer row (or null). `invite` is the most
 * recent EmployeeInvite row for the employee (or null).
 */
function derivePortalStatus({ customer, invite, now = new Date() }) {
  // An ACTIVE login is the terminal state: the new hire has claimed it. We treat
  // emailVerified (set by accept-invite) OR a passwordChangedAt (they changed it
  // post-claim / via reset) as "claimed", as long as the row is live.
  const claimed =
    !!customer &&
    customer.isActive &&
    !customer.anonymisedAt &&
    (customer.emailVerified === true || customer.passwordChangedAt != null);
  if (claimed) return { state: 'ACTIVE', invite: inviteMeta(invite) };

  if (invite) {
    if (invite.status === 'ACCEPTED') return { state: 'ACTIVE', invite: inviteMeta(invite) };
    if (invite.status === 'PENDING') {
      if (invite.expiresAt && new Date(invite.expiresAt) <= now) {
        return { state: 'EXPIRED', invite: inviteMeta(invite) };
      }
      return { state: 'INVITED', invite: inviteMeta(invite) };
    }
    if (invite.status === 'REVOKED') return { state: 'REVOKED', invite: inviteMeta(invite) };
  }
  return { state: 'NOT_INVITED', invite: null };
}

function inviteMeta(invite) {
  if (!invite) return null;
  return {
    id: invite.id,
    status: invite.status,
    expiresAt: invite.expiresAt || null,
    usedAt: invite.usedAt || null,
    createdAt: invite.createdAt || null,
  };
}

/**
 * Look up the work-email Customer (ESS login) for an employee, tenant-scoped.
 * The Employee↔Customer link is by (businessId, workEmail) — there is no hard FK
 * (the Customer is a shared multi-product identity). Returns null when the
 * employee has no work email or no Customer row yet.
 */
async function findEssCustomer(client, { businessId, workEmail }) {
  if (!workEmail) return null;
  const email = String(workEmail).toLowerCase();
  return client.customer.findUnique({
    where: { businessId_email: { businessId, email } },
    select: { id: true, email: true, isActive: true, emailVerified: true, anonymisedAt: true, passwordChangedAt: true },
  });
}

/**
 * Resolve the portal status for a SET of employees in two batched reads (the
 * latest invite per employee + the matching Customer rows). Returns a Map keyed
 * by employeeId → { state, invite, loginEmail }. Used by the employee LIST read.
 */
async function portalStatusForEmployees(businessId, employees) {
  const out = new Map();
  if (!employees || employees.length === 0) return out;

  const ids = employees.map((e) => e.id);
  const emails = employees
    .map((e) => (e.workEmail ? String(e.workEmail).toLowerCase() : null))
    .filter(Boolean);

  // Latest invite per employee — pull all and keep the newest per employeeId.
  const invites = await prisma.employeeInvite.findMany({
    where: { businessId, employeeId: { in: ids } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, employeeId: true, status: true, expiresAt: true, usedAt: true, createdAt: true },
  });
  const latestInvite = new Map();
  for (const inv of invites) {
    if (!latestInvite.has(inv.employeeId)) latestInvite.set(inv.employeeId, inv);
  }

  // Customer rows by work email (tenant-scoped).
  const customers = emails.length
    ? await prisma.customer.findMany({
        where: { businessId, email: { in: emails } },
        select: { email: true, isActive: true, emailVerified: true, anonymisedAt: true, passwordChangedAt: true },
      })
    : [];
  const customerByEmail = new Map();
  for (const c of customers) customerByEmail.set(String(c.email).toLowerCase(), c);

  for (const e of employees) {
    const email = e.workEmail ? String(e.workEmail).toLowerCase() : null;
    const customer = email ? customerByEmail.get(email) || null : null;
    const invite = latestInvite.get(e.id) || null;
    const { state, invite: inviteInfo } = derivePortalStatus({ customer, invite });
    out.set(e.id, { state, invite: inviteInfo, loginEmail: e.workEmail || null });
  }
  return out;
}

/** Single-employee portal status (detail read). */
async function portalStatusForEmployee(businessId, employee) {
  const customer = await findEssCustomer(prisma, { businessId, workEmail: employee.workEmail });
  const invite = await prisma.employeeInvite.findFirst({
    where: { businessId, employeeId: employee.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, expiresAt: true, usedAt: true, createdAt: true },
  });
  const { state, invite: inviteInfo } = derivePortalStatus({ customer, invite });
  return { state, invite: inviteInfo, loginEmail: employee.workEmail || null };
}

/**
 * Mint (or re-mint) a portal invite for ONE employee and fan out the welcome.
 *
 * Behaviour:
 *   • Validates the employee is in-tenant, not soft-deleted, and HAS a work email
 *     (the login identity). Terminated employees are refused (no portal for a
 *     separated worker).
 *   • If the ESS login is ALREADY claimed (ACTIVE) we refuse unless allowReset.
 *   • Atomically REVOKEs any prior PENDING invite (single live token) and creates
 *     a fresh one (status PENDING, hashed token, expiry).
 *   • Best-effort notification (HR_PORTAL_INVITE) over email + WhatsApp — a send
 *     failure NEVER throws; the invite row + copyable link are always returned.
 *
 * @returns { ok, reason?, invite?, link?, notified?, loginEmail?, alreadyActive? }
 */
async function createInvite({ businessId, employeeId, createdByUserId = null, allowReset = false }) {
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, workEmail: true, phone: true, countryCode: true, status: true },
  });
  if (!employee) return { ok: false, reason: 'EMPLOYEE_NOT_FOUND' };
  if (!employee.workEmail) return { ok: false, reason: 'NO_WORK_EMAIL' };
  if (employee.status === 'TERMINATED' || employee.status === 'RETIRED') {
    return { ok: false, reason: 'EMPLOYEE_SEPARATED' };
  }

  const loginEmail = String(employee.workEmail).toLowerCase();
  const customer = await findEssCustomer(prisma, { businessId, workEmail: loginEmail });
  const { state } = derivePortalStatus({ customer, invite: null });
  // Don't clobber a claimed login on a routine (re-)invite. An explicit reset
  // (allowReset) is allowed — it re-mints a token so the worker can re-set.
  if (state === 'ACTIVE' && !allowReset) {
    return { ok: false, reason: 'ALREADY_ACTIVE', alreadyActive: true, loginEmail };
  }
  // Mark a token as a RESET only when it is the EXPLICIT path that re-mints over an
  // ALREADY-active login. That is the ONLY token acceptInvite() will let overwrite a
  // claimed login's password — a first-claim (non-reset) token can never take over an
  // account that has since been activated. A plain invite of a not-yet-active login is
  // NOT a reset (isReset stays false) so it still can't clobber if the login races to
  // active before the token is used.
  const isReset = state === 'ACTIVE' && allowReset === true;

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlMs());

  // Atomic: revoke any live PENDING token (re-invite invalidates the old link),
  // then mint the fresh one. Same transaction so there's never a window with two
  // live tokens for the employee.
  const invite = await prisma.$transaction(async (tx) => {
    await tx.employeeInvite.updateMany({
      where: { businessId, employeeId, status: 'PENDING' },
      data: { status: 'REVOKED' },
    });
    return tx.employeeInvite.create({
      data: { businessId, employeeId, email: loginEmail, tokenHash, expiresAt, status: 'PENDING', isReset, createdByUserId },
    });
  });

  const link = await buildSetPasswordLink(businessId, rawToken);

  // Best-effort fan-out. Never throws; never blocks the invite record.
  let notified = { ok: false, reason: 'NOT_ATTEMPTED' };
  try {
    notified = await fanOutInvite({ businessId, employee, loginEmail, link, expiresAt, inviteId: invite.id });
  } catch (_e) {
    notified = { ok: false, reason: 'NOTIFY_THREW' };
  }

  // An unverified host means the tenant's portal address was never provisioned,
  // so this link almost certainly does not resolve. We still create and send the
  // invite (refusing outright would break dev and self-hosted installs, where DNS
  // provisioning is not configured at all), but we say so plainly in the response
  // instead of reporting a clean success over a dead link.
  if (!link.hostVerified) {
    console.warn(
      `[portalInvite] business ${businessId}: no provisioned portal address `
      + `(would have been ${link.derivedHost || 'unknown'}). The invite link itself is fine — `
      + `it is on ${link.host}, which does not depend on tenant DNS — but employees have `
      + 'nowhere branded to sign in afterwards. Set it in Settings → Domain.',
    );
  }

  return {
    ok: true,
    invite: inviteMeta(invite),
    // The RAW token is intentionally NOT returned (only ever lives in the link).
    link: link.url || link.path,
    linkHost: link.host,
    linkHostVerified: link.hostVerified,
    ...(link.hostVerified ? {} : {
      warning: 'PORTAL_HOST_UNPROVISIONED',
      warningMessage:
        'This invite link works — it uses our shared sign-in page, which keeps working even '
        + 'if you change your portal address later. You have not set a portal address yet, '
        + 'though, so your team has nowhere branded to sign in afterwards. Set one in '
        + 'Settings → Domain.',
    }),
    notified,
    loginEmail,
  };
}

// Fire the HR_PORTAL_INVITE template over the notification engine. The engine
// cascades WhatsApp → SMS → Email (email is the always-on fallback) and is itself
// best-effort, but we still guard so a thrown error can't escape the invite path.
async function fanOutInvite({ businessId, employee, loginEmail, link, expiresAt, inviteId }) {
  if (!_notifications || typeof _notifications.notifyHrEvent !== 'function') {
    return { ok: false, reason: 'NOTIFY_UNAVAILABLE' };
  }
  const biz = await prisma.business
    .findUnique({ where: { id: businessId }, select: { name: true } })
    .catch(() => null);
  const bizName = (biz && biz.name) || 'your employer';
  const expiry = expiresAt instanceof Date ? expiresAt.toISOString().slice(0, 10) : String(expiresAt);
  const url = link.url || link.path || '';
  return _notifications.notifyHrEvent({
    businessId,
    event: 'portal.invite',
    recipientEmail: loginEmail,
    recipientPhone: employee.phone || null,
    recipientCountry: employee.countryCode || undefined,
    variables: {
      NAME: employee.firstName || 'there',
      BIZ: bizName,
      EMAIL: loginEmail,
      EXPIRY: expiry,
      LINK: url,
    },
    triggeredBy: `HR_PORTAL_INVITE:${inviteId}`,
  });
}

/**
 * PUBLIC accept path. Resolves the tenant + employee FROM the token (so this is
 * truly token-driven, no tenant context needed), validates single-use/expiry/
 * status, sets the Customer password, marks the row claimed. GENERIC errors only
 * (no token-enumeration / account-existence oracle).
 *
 * Caller (customer.controller) handles password-strength validation + cookie
 * issuance. This returns the resolved customer + invite so the controller can
 * issue the session.
 *
 * @returns { ok, reason?, customer?, businessId?, employeeId? }
 *   reason on failure is always a generic 'INVALID' (the controller maps it to a
 *   single non-revealing message). Never distinguishes wrong/expired/used.
 */
async function acceptInvite({ token, passwordHash }) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'INVALID' };
  const tokenHash = hashToken(token);

  // Resolve the invite by hash — tenant + employee come FROM the row.
  const invite = await prisma.employeeInvite.findUnique({
    where: { tokenHash },
    select: { id: true, businessId: true, employeeId: true, email: true, status: true, expiresAt: true, usedAt: true, isReset: true },
  });
  // Generic reject for unknown / used / revoked / expired — same message to the
  // client so a token can't be probed for validity.
  if (!invite) return { ok: false, reason: 'INVALID' };
  if (invite.status !== 'PENDING') return { ok: false, reason: 'INVALID' };
  if (invite.usedAt) return { ok: false, reason: 'INVALID' };
  if (!invite.expiresAt || new Date(invite.expiresAt) <= new Date()) return { ok: false, reason: 'INVALID' };

  const { businessId, employeeId, email, isReset } = invite;

  // Atomically: re-check the token is still PENDING (guards a double-submit /
  // race), set the Customer password + verify + activate, and mark the invite
  // claimed. If the Customer row is missing (edge: invite minted before the ESS
  // identity existed) we create it — the login is the work email, tenant-scoped.
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Single-use guard inside the tx — a concurrent accept that already flipped
      // the row loses here (claimed=0 → abort).
      const claimed = await tx.employeeInvite.updateMany({
        where: { id: invite.id, status: 'PENDING', usedAt: null },
        data: { status: 'ACCEPTED', usedAt: new Date() },
      });
      if (claimed.count !== 1) throw new Error('RACE');

      const existing = await tx.customer.findUnique({
        where: { businessId_email: { businessId, email } },
        select: {
          id: true,
          anonymisedAt: true,
          isActive: true,
          emailVerified: true,
          passwordChangedAt: true,
        },
      });

      // ACCOUNT-TAKEOVER GUARD. The token is bound to exactly this (businessId, email)
      // — it resolves the Customer FROM the invite row, never from caller context, so
      // it can only ever touch the tenant + login that minted it. On top of that
      // binding: a token must NOT overwrite the password of an ALREADY-CLAIMED login
      // (active + emailVerified OR a prior passwordChangedAt) UNLESS it was explicitly
      // minted as a RESET (isReset). This closes the replay where a stale first-claim
      // PENDING token is presented after the login was activated through another path
      // — without it that token would silently reset the live account's password.
      // Generic throw → the controller maps every failure to one non-revealing message
      // (no enumeration / account-existence oracle).
      const alreadyClaimed =
        !!existing &&
        !existing.anonymisedAt &&
        existing.isActive === true &&
        (existing.emailVerified === true || existing.passwordChangedAt != null);
      if (alreadyClaimed && !isReset) throw new Error('ALREADY_CLAIMED');

      let customer;
      if (!existing) {
        // No ESS identity yet (provision skipped it, or this is a direct invite):
        // mint it now. Name from the employee record.
        const emp = await tx.employee.findFirst({
          where: { id: employeeId, businessId },
          select: { firstName: true, lastName: true },
        });
        const name = `${(emp && emp.firstName) || ''} ${(emp && emp.lastName) || ''}`.trim() || email;
        customer = await tx.customer.create({
          data: {
            businessId,
            email,
            password: passwordHash,
            name,
            emailVerified: true,
            isActive: true,
            hasPassword: true,
            passwordChangedAt: new Date(),
          },
          select: { id: true, businessId: true, email: true },
        });
      } else if (existing.anonymisedAt) {
        // A GDPR-anonymised row — do NOT silently un-anonymise via a public path.
        throw new Error('ANONYMISED');
      } else {
        customer = await tx.customer.update({
          where: { id: existing.id },
          data: {
            password: passwordHash,
            emailVerified: true,
            isActive: true,
            hasPassword: true,
            // Revoke any pre-claim sessions/refresh tokens.
            passwordChangedAt: new Date(),
          },
          select: { id: true, businessId: true, email: true },
        });
      }
      return customer;
    });

    return { ok: true, customer: result, businessId, employeeId };
  } catch (_e) {
    // Any failure (race, anonymised, write error) → generic reject.
    return { ok: false, reason: 'INVALID' };
  }
}

module.exports = {
  // token primitives
  generateRawToken,
  hashToken,
  ttlMs,
  // link builder
  buildSetPasswordLink,
  // status
  derivePortalStatus,
  portalStatusForEmployee,
  portalStatusForEmployees,
  findEssCustomer,
  // lifecycle
  createInvite,
  acceptInvite,
};
