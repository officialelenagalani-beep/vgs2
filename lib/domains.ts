/**
 * Step 26 -- Business domains (SARANTIS integration, step 3).
 *
 * One platform, several businesses, each belonging to exactly one
 * DOMAIN MODULE. The domain decides which admin experience, which tables
 * and which public APIs a business uses:
 *
 *   barber -- Medusa-style appointment businesses (the original app:
 *             employees, services, appointments, customers, loyalty).
 *   travel -- travel agencies (SARANTIS: bookings/enquiries, travelers,
 *             journeys, destinations).
 *
 * The value lives in businesses.domain (migration 025, NOT NULL DEFAULT
 * 'barber', CHECK IN ('barber','travel')). Code never branches on a
 * business slug or name -- only on the domain, through this module.
 * Adding a third domain later = add it to BUSINESS_DOMAINS + DOMAIN_CONFIG
 * here, extend the DB CHECK constraint, and add its admin module.
 *
 * Pure module (no server-only imports) so it can be unit-tested and used
 * from both server and client components.
 */

export const BUSINESS_DOMAINS = ["barber", "travel"] as const;
export type BusinessDomain = (typeof BUSINESS_DOMAINS)[number];

export interface DomainConfig {
  domain: BusinessDomain;
  /** Human label (Greek, admin-facing). */
  label: string;
  /** Where an authenticated admin of a business in this domain lands. */
  adminHome: string;
}

export const DOMAIN_CONFIG: Readonly<Record<BusinessDomain, DomainConfig>> = Object.freeze({
  barber: { domain: "barber", label: "Κουρείο / Ραντεβού", adminHome: "/admin" },
  travel: { domain: "travel", label: "Ταξιδιωτικό γραφείο", adminHome: "/admin/travel" },
});

export function isBusinessDomain(value: unknown): value is BusinessDomain {
  return typeof value === "string" && (BUSINESS_DOMAINS as readonly string[]).includes(value);
}

/**
 * The domain of a business row.
 *
 * - `domain` missing/null (a row read through an old code path or a test
 *   fixture written before migration 025) -> "barber": every business that
 *   existed before 025 IS a barber business, and the column's own DEFAULT
 *   is 'barber', so this is the same answer the database would give.
 * - any other unknown value -> null, so every guard built on this fails
 *   CLOSED (an unrecognised domain is never treated as barber or travel).
 */
export function getBusinessDomain(business: { domain?: string | null } | null | undefined): BusinessDomain | null {
  if (!business) return null;
  const value = business.domain;
  if (value === undefined || value === null) return "barber";
  return isBusinessDomain(value) ? value : null;
}

export function isDomain(business: { domain?: string | null } | null | undefined, domain: BusinessDomain): boolean {
  return getBusinessDomain(business) === domain;
}

/** Admin landing page for a business; unknown domain -> the generic /admin entry point. */
export function adminHomeFor(business: { domain?: string | null } | null | undefined): string {
  const domain = getBusinessDomain(business);
  return domain ? DOMAIN_CONFIG[domain].adminHome : "/admin";
}
