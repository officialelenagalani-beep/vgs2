/**
 * Phase 4 / Step 21 -- RBAC.
 *
 * Centralized, explicit permission model for the three real roles
 * business_members.role already holds (owner/manager/employee -- see
 * 013_business_members_and_tenant_integrity.sql). Every function here
 * takes the ROLE ITSELF, never a user id or session -- the caller is
 * always responsible for resolving that role server-side via
 * resolveBusinessFromSession() (lib/business-context.ts) first. This file
 * intentionally has no knowledge of cookies, sessions, or Supabase --
 * keeping it a pure, trivially-testable function of "role in, allowed
 * out" is what makes it safe to reuse from every admin page and server
 * action without duplicating the trust chain in each one.
 *
 * A `null` role (no membership / no session / role not yet resolved) is
 * never granted by any of these -- every function below returns `false`
 * for `null`, fail-closed.
 */

export const ROLES = {
  OWNER: "owner",
  MANAGER: "manager",
  EMPLOYEE: "employee",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/**
 * Staff management: creating/editing employees, their schedules, blocked
 * dates, and service assignments (app/admin/(dashboard)/employees/*).
 * Owner + Manager, per this step's approved permission matrix. Real and
 * enforced starting this step -- previously permissive scaffolding that
 * always returned true (see PHASE4_STEP19_README.md's own note on this).
 */
export function canManageStaff(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER;
}

/**
 * Billing management. No billing functionality exists yet in this
 * codebase (explicitly out of scope for this step and every step so
 * far) -- this function is not called anywhere today. It exists, same as
 * before this step, so a future billing step has a stable, already-real
 * permission check to build on rather than permissive scaffolding.
 * Owner-only, per this step's approved permission matrix.
 */
export function canManageBilling(role: Role | null): boolean {
  return role === ROLES.OWNER;
}

/**
 * Phase 4 / Step 19 -- Business Management authorization.
 *
 * Editing a business's own name/slug/contact info/working hours is
 * genuinely tenant-sensitive. Owner-only, unchanged by this step's
 * broader RBAC rollout -- the approved permission matrix keeps business
 * management conservative rather than extending it to managers.
 */
export function canManageBusiness(role: Role | null): boolean {
  return role === ROLES.OWNER;
}

/**
 * Phase 4 / Step 21 -- Invitations.
 *
 * Only an owner may create, list (implicitly -- gated at the page level
 * too), or revoke invitations for their business. Managers/employees
 * cannot invite anyone, per this step's task spec (§4: "Managers and
 * employees must be rejected server-side").
 */
export function canManageInvitations(role: Role | null): boolean {
  return role === ROLES.OWNER;
}

/**
 * Phase 4 / Step 21 -- Member role changes / removal.
 *
 * Only an owner may change an existing member's role (manager <->
 * employee) or remove a member outright. This is deliberately a
 * SEPARATE function from canManageInvitations() even though both
 * currently resolve to "owner only" -- they are different operations
 * (mutating an EXISTING membership vs. creating a NEW one via
 * invitation) and the task spec calls them out as distinct concerns;
 * keeping them as distinct functions means a future change to one (e.g.
 * if managers are ever allowed to invite but still never allowed to
 * change roles) doesn't require touching call sites for the other.
 */
export function canManageRoles(role: Role | null): boolean {
  return role === ROLES.OWNER;
}

/**
 * Phase 4 / Step 21 -- Analytics.
 *
 * Owner + Manager, per this step's approved permission matrix. Employees
 * do not get business-wide analytics.
 */
export function canViewAnalytics(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER;
}

/**
 * Phase 4 / Step 21 -- Audit logs.
 *
 * Owner + Manager, per this step's approved permission matrix.
 */
export function canViewAuditLogs(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER;
}

/**
 * Phase 4 / Step 22 -- Service & Service-Category management.
 *
 * Creating/editing/reordering the business's bookable service catalog
 * (services + service_categories) is treated the same as staff
 * management for permission purposes -- both are core, frequent,
 * operational configuration a shop manager is expected to handle day to
 * day, not just the owner. Owner + Manager, mirroring canManageStaff()
 * exactly (kept as a separate function rather than reusing
 * canManageStaff() itself, since "who can manage the catalog" and "who
 * can manage staff" are different concerns that happen to currently
 * resolve to the same two roles -- see canManageInvitations()/
 * canManageRoles()'s own doc comment for why this codebase prefers
 * distinct functions over sharing one across unrelated features).
 */
export function canManageServices(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER;
}

/**
 * Phase 4 / Step 22 -- Business branding (logo, brand color).
 *
 * Branding is part of the business's own public identity, same category
 * as name/slug/contact info -- so it follows canManageBusiness()'s
 * existing, conservative owner-only precedent rather than the broader
 * canManageStaff()-style owner+manager access. Kept as its own function
 * (rather than reusing canManageBusiness() directly) so a future change
 * to who may edit branding specifically doesn't require touching business
 * name/slug/contact-info's own permission boundary.
 */
export function canManageBranding(role: Role | null): boolean {
  return role === ROLES.OWNER;
}

/**
 * Phase 4 / Step 21 -- Appointments.
 *
 * Owner + Manager + Employee, per this step's approved permission
 * matrix -- appointment handling is core operational work for all three
 * roles. This does not (and, per this step's explicit scope, must not)
 * introduce per-employee appointment scoping ("only appointments
 * assigned to me") -- the existing admin appointment actions
 * (app/admin/actions.ts) have no such concept today (they operate on
 * the whole business's appointment list, keyed only by business_id), and
 * building that scoping is a materially different feature than gating
 * *whether* a role may use the existing actions at all. Documented as a
 * known boundary in PHASE4_STEP21_README.md.
 */
export function canManageAppointments(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER || role === ROLES.EMPLOYEE;
}

/**
 * Phase 4 / Step 25 -- Loyalty program configuration.
 *
 * Editing business_loyalty_settings (earn rate, redemption value,
 * thresholds, limits) and service_loyalty_settings (per-service earn/
 * redemption overrides) is a tenant-sensitive, business-rule-defining
 * action, not day-to-day operational work -- rule 22 ("LOYALTY SETTINGS
 * PERMISSION -- LOCKED: only owner + manager can change business Loyalty
 * Settings. Employees cannot change these settings.") is explicit and
 * locked. Owner + Manager. Kept as its own function (rather than reusing
 * canManageServices() or canManageBusiness()) since loyalty configuration
 * is its own distinct concern -- see canManageInvitations()/
 * canManageRoles()'s own doc comment for why this codebase prefers
 * distinct functions per operation even when today's matrix happens to
 * coincide with another feature's.
 */
export function canManageLoyaltySettings(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER;
}

/**
 * Phase 4 / Step 25 -- Manual loyalty point adjustments.
 *
 * Rule 12/23: "All staff roles may perform manual point adjustments --
 * owner, manager, employee." Deliberately a SEPARATE function from
 * canManageLoyaltySettings() even though this one is broader -- a
 * manual adjustment is a day-to-day operational action (like handling an
 * appointment), not a change to the business's own configured rules, and
 * the spec explicitly calls out the two as having different permission
 * matrices.
 */
export function canCreateManualLoyaltyAdjustment(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER || role === ROLES.EMPLOYEE;
}

/**
 * Roadmap Step 26 -- Customer notes (staff notes about a customer).
 *
 * Reading and adding: every staff role. Notes are day-to-day working
 * information ("prefers scissors only"), needed by whoever serves the
 * customer; this follows the existing rule for customer data itself
 * (canManageAppointments(): owner + manager + employee).
 */
export function canViewCustomerNotes(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER || role === ROLES.EMPLOYEE;
}

export function canCreateCustomerNote(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER || role === ROLES.EMPLOYEE;
}

/**
 * Roadmap Step 26 -- Editing or removing an existing customer note.
 *
 * Owner and manager: any note of the business. Employee: ONLY a note they
 * wrote themselves -- an employee can never rewrite or remove what a
 * colleague (or the owner) recorded about a customer.
 *
 * `isAuthor` must be decided server-side, by comparing the note's stored
 * author_id with the authenticated user's id (services/customer-notes.ts).
 * A note whose author account no longer exists (author_id NULL) is nobody's
 * "own" note: only owner/manager can change it.
 */
export function canEditCustomerNote(role: Role | null, isAuthor: boolean): boolean {
  if (role === ROLES.OWNER || role === ROLES.MANAGER) return true;
  if (role === ROLES.EMPLOYEE) return isAuthor === true;
  return false;
}

/**
 * Roadmap Step 26 -- Reviews.
 *
 * Seeing the business's reviews in the dashboard (including ones that are
 * waiting for approval or were rejected), issuing a review link for a
 * completed appointment, and approving / rejecting a review are all
 * Owner + Manager.
 *
 * Employees get none of the three. A review is, in part, a judgement of
 * the employee who served the customer: the person being judged must not
 * be the one who decides whether it is published, must not be able to
 * issue (and then fill in) a link for their own appointment, and has no
 * need to read reviews the business decided not to publish. Approved
 * reviews are public, so an employee can still read those like anyone else.
 *
 * Three functions rather than one, for the reason given at
 * canManageInvitations()/canManageRoles(): they are different operations
 * that happen to share a matrix today.
 */
export function canViewReviews(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER;
}

export function canIssueReviewLinks(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER;
}

export function canModerateReviews(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER;
}

/**
 * Data-protection requests about one customer (GDPR): exporting everything
 * the business holds about them, and erasing it. Owner only -- erasure
 * cannot be undone, and both are legal acts of the business itself.
 */
export function canManageCustomerData(role: Role | null): boolean {
  return role === ROLES.OWNER;
}

/**
 * Spending a customer's loyalty points against a service at the counter.
 * Day-to-day work like completing an appointment: all three staff roles.
 * The business's own rules (what can be redeemed, limits) are enforced by
 * the database function redeem_loyalty_points() whoever asks.
 */
/**
 * 2026-10-09 (owner's decision): an employee may add or remove at most this
 * many points in one manual adjustment; larger amounts are for the owner or
 * a manager. The business sets the number (business_loyalty_settings.
 * employee_adjustment_limit_points, default 50; NULL = no limit).
 * Returns the limit that applies to `role`, or null for "no limit".
 */
export const DEFAULT_EMPLOYEE_ADJUSTMENT_LIMIT = 50;
export function manualAdjustmentLimitFor(role: Role | null, employeeLimit: number | null | undefined): number | null {
  if (role === ROLES.OWNER || role === ROLES.MANAGER) return null;
  if (employeeLimit === undefined) return DEFAULT_EMPLOYEE_ADJUSTMENT_LIMIT;
  return employeeLimit;
}

/**
 * Gift cards (042). Selling a card and charging it on a visit happen at the
 * counter, so every staff role can do them; undoing a charge and voiding a
 * card change money already accounted for, so only owner and manager can.
 */
export function canSellGiftCards(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER || role === ROLES.EMPLOYEE;
}
export function canRedeemGiftCards(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER || role === ROLES.EMPLOYEE;
}
export function canManageGiftCards(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER;
}

/**
 * Memberships (043). Plans, signing a customer up and ending a membership
 * involve money: owner and manager. Recording a visit happens at the chair:
 * every staff role. Undoing a recorded visit: owner and manager.
 */
export function canManageMemberships(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER;
}
export function canRecordMembershipVisits(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER || role === ROLES.EMPLOYEE;
}

/** Discount codes (041): creating, changing and switching off codes -- owner and manager. */
export function canManageDiscountCodes(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER;
}

export function canRedeemLoyaltyPoints(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER || role === ROLES.EMPLOYEE;
}

/** Campaigns (048): writing to customers in the shop's name -- owner and manager. */
export function canManageCampaigns(role: Role | null): boolean {
  return role === ROLES.OWNER || role === ROLES.MANAGER;
}
