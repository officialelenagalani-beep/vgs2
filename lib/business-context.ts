import "server-only";
import crypto from "crypto";
import { cookies } from "next/headers";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/session";
import { getBusinessBySlug, getBusinessById } from "@/services/businesses";
import { getBusinessMemberships, getPrimaryBusinessMembership } from "@/services/business-members";
import type { Business } from "@/types/businesses";
import { isDomain, type BusinessDomain } from "@/lib/domains";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

/**
 * Phase 4 / Step 16 -- central business-context resolution.
 *
 * Before this module, every admin action, admin page, and legacy API route
 * resolved "which business" independently, via a copy-pasted
 *   const id = process.env.MEDUSA_BUSINESS_ID
 * (12 call sites -- see the Step 16 audit report, section 3). That only
 * worked because exactly one business existed. This module replaces every
 * one of those call sites with a resolver named for the trust boundary it
 * actually operates in -- the point of the Step 16 architecture is that
 * business identity is never accepted as a bare client-supplied value, only
 * ever resolved from something the server already trusts:
 *
 *   resolveBusinessFromSlug(slug)   -- a public URL path segment, used only
 *                                       to LOOK UP a business row (never
 *                                       trusted as an id past that lookup).
 *                                       Wraps the existing, already-correct
 *                                       getBusinessBySlug().
 *   resolveBusinessFromSession()    -- the admin app: authenticated Supabase
 *                                       Auth session -> business_members ->
 *                                       business_id. Replaces every
 *                                       env-var-based getBusinessId() in
 *                                       app/admin/**.
 *   resolveBusinessFromApiKey(req)  -- AI agent / mobile / integrations:
 *                                       hashes the X-Api-Key header and
 *                                       looks it up in the api_keys table
 *                                       (already existed in the schema
 *                                       since 001_initial_schema.sql, never
 *                                       previously read by application
 *                                       code). Replaces the single global
 *                                       ADMIN_SECRET / X-Admin-Key check.
 *   resolveLegacyBusiness()         -- DEPRECATED, but still LIVE. Reads
 *                                       MEDUSA_BUSINESS_ID directly. Step
 *                                       23 correction: this was previously
 *                                       (incorrectly) believed to have no
 *                                       remaining real callers and was
 *                                       briefly deleted during Step 23
 *                                       implementation; restored once a
 *                                       direct search for callers of the
 *                                       FUNCTION itself (not just the
 *                                       legacy API routes) turned up two
 *                                       real ones: app/(site)/page.tsx and
 *                                       app/(site)/services/page.tsx --
 *                                       the public marketing site's own
 *                                       homepage and services page, which
 *                                       use it to resolve which single
 *                                       business's catalog to render
 *                                       server-side. Its OTHER former
 *                                       callers (app/api/appointments/
 *                                       route.ts, app/api/appointments/
 *                                       [id]/route.ts, and
 *                                       app/api/availability/route.ts's
 *                                       anonymous branch) were genuinely
 *                                       dead and were removed in Step 23 --
 *                                       only the two site pages above keep
 *                                       this function alive. Do not delete
 *                                       this function (or MEDUSA_BUSINESS_ID)
 *                                       without first migrating those two
 *                                       pages onto a real per-business
 *                                       resolution path -- out of scope for
 *                                       Step 23, which is a security-
 *                                       hardening pass, not a rewrite of
 *                                       public-site rendering.
 */

export type BusinessContextResult =
  | { ok: true; business: Business; role?: "owner" | "manager" | "employee" }
  | { ok: false; reason: "not_found" | "unauthorized" | "no_membership" | "not_configured" | "wrong_domain" };

/**
 * Phase 4 / Step 20 -- Business Switcher.
 *
 * Name of the httpOnly cookie that stores the authenticated admin's
 * currently-selected business. Exported so the ONLY other place that
 * writes it (app/admin/switch-business/actions.ts) reuses this literal
 * instead of duplicating the string -- if this ever needs to change, it
 * changes in exactly one place.
 *
 * The cookie is never trusted on its own: resolveBusinessFromSession()
 * below re-validates its value against the authenticated user's real
 * business_members rows on every single resolution, every request. Losing
 * or tampering with this cookie can, at worst, make the resolver fall
 * back to the user's primary membership -- it can never grant access to a
 * business the user doesn't actually belong to (see the writer's own
 * validateBusinessSwitch() check, services/business-members.ts).
 */
export const ACTIVE_BUSINESS_COOKIE = "medusa_active_business_id";

/**
 * Resolves a business from a public URL slug. Never trusts the slug as an
 * id -- it only ever looks a business row up by it. Safe to call from any
 * public, unauthenticated route.
 */
export async function resolveBusinessFromSlug(slug: string): Promise<BusinessContextResult> {
  const business = await getBusinessBySlug(slug);
  if (!business) return { ok: false, reason: "not_found" };
  return { ok: true, business };
}

/**
 * Resolves the business an authenticated admin session acts on.
 *
 * Trust chain: Supabase Auth session (verified server-side via getUser(),
 * never client input) -> business_members row(s) for that user_id (also
 * never client input) -> the business_id of the SELECTED membership. A
 * session with no membership row resolves to `no_membership`, never a
 * default/fallback business.
 *
 * Phase 4 / Step 20 -- Business Switcher: a user may belong to more than
 * one business. Which of the user's own memberships is "active" is
 * decided as follows, in order:
 *
 *   1. If the ACTIVE_BUSINESS_COOKIE cookie is set AND its value matches
 *      one of THIS user's own memberships (checked against the same
 *      getBusinessMemberships() call below -- never a separate,
 *      independently-trusted lookup), that membership is used. This is
 *      the only way the cookie's value is ever allowed to matter: it's a
 *      hint about a possibly-stale prior choice, re-verified against the
 *      user's real memberships on every single call.
 *   2. Otherwise (no cookie, or the cookie's value doesn't match any of
 *      this user's own memberships -- e.g. it's missing, malformed,
 *      points at a business this user was since removed from, or was
 *      somehow set for a different user's session) -- fall back to
 *      getPrimaryBusinessMembership()'s existing "first membership"
 *      behavior, completely unchanged from Steps 16-19. This is also
 *      exactly what happens for every user with a single membership,
 *      cookie or no cookie -- the single-business case is byte-for-byte
 *      identical to before this step.
 *
 * getBusinessById()'s existing `is_active = true` filter is untouched --
 * a selected membership whose business has since been deactivated still
 * fails closed with `not_found`, exactly as it always has.
 *
 * NOT wrapped in React `cache()`: this project pins `react@18.3.1` (see
 * package.json), whose public `react` package export map has no `cache`
 * export at all (verified directly against the installed package -- only
 * available starting from the React canary channel / React 19, which
 * Next.js 14.2.x does not require or bundle a substitute for here).
 * Importing `cache` from `react` in this dependency tree resolves to
 * `undefined` and would throw at the first call site, in both `next
 * build` and `vitest`. So this function is still called once per
 * page/action, same as Steps 16-19 -- Step 20 adds exactly one more call
 * per admin page (the new one in the dashboard layout, for the
 * switcher), a small, known, and acceptable duplicate-read cost given the
 * indexed, single-row-per-table lookups involved -- not a correctness
 * issue, and not something to work around with unrelated dependency
 * upgrades in this step.
 *
 * Replaces every `process.env.MEDUSA_BUSINESS_ID` read in app/admin/**.
 *
 * Step 26 -- Business domains: this is the BARBER module's resolver. Every
 * existing caller (all app/admin/(dashboard) pages and server actions,
 * app/api/employees, app/api/availability) is barber code, so it now only
 * ever resolves a business whose domain is "barber". For barber businesses
 * (Medusa and every business that existed before migration 025) the
 * result is byte-for-byte what it was before. A session whose active
 * business belongs to another domain (e.g. a travel agency) resolves to
 * `wrong_domain` instead -- so barber pages, server actions and admin APIs
 * can never read or write anything for a travel business, even if called
 * directly. Domain-neutral code (the admin shells) uses
 * resolveActiveBusinessFromSession(); travel code uses
 * resolveBusinessFromSessionForDomain("travel").
 */
export async function resolveBusinessFromSession(): Promise<BusinessContextResult> {
  return resolveBusinessFromSessionForDomain("barber");
}

/**
 * Step 26 -- the session's active business restricted to one domain
 * module. Same trust chain as resolveActiveBusinessFromSession(); a
 * business of any other (or unknown) domain fails closed with
 * `wrong_domain`.
 */
export async function resolveBusinessFromSessionForDomain(domain: BusinessDomain): Promise<BusinessContextResult> {
  const result = await resolveActiveBusinessFromSession();
  if (!result.ok) return result;
  if (!isDomain(result.business, domain)) return { ok: false, reason: "wrong_domain" };
  return result;
}

/**
 * Step 26 -- the session's active business, WHATEVER its domain. This is
 * exactly the pre-Step-26 body of resolveBusinessFromSession(), unchanged.
 * Only for domain-neutral code that has to decide where to send the user
 * (the admin layouts); never use it to read or write domain data.
 */
export async function resolveActiveBusinessFromSession(): Promise<BusinessContextResult> {
  const user = await getUser();
  if (!user) return { ok: false, reason: "unauthorized" };

  const memberships = await getBusinessMemberships(user.id);
  if (memberships.length === 0) return { ok: false, reason: "no_membership" };

  const cookieBusinessId = (await cookies()).get(ACTIVE_BUSINESS_COOKIE)?.value;
  const selected =
    (cookieBusinessId && memberships.find((m) => m.business_id === cookieBusinessId)) ||
    // Falls back to the same "first membership" rule
    // getPrimaryBusinessMembership() has always used -- reusing it here
    // (rather than re-implementing "pick memberships[0]") keeps that rule
    // defined in exactly one place.
    (await getPrimaryBusinessMembership(user.id));

  if (!selected) return { ok: false, reason: "no_membership" };

  const business = await getBusinessById(selected.business_id);
  if (!business) return { ok: false, reason: "not_found" };

  return { ok: true, business, role: selected.role };
}

export interface ApiKeyContext {
  business: Business;
  permissions: string[];
  apiKeyId: string;
}

/**
 * Resolves the business behind a raw X-Api-Key header value.
 *
 * The raw key is never stored (see api_keys.key_hash's own comment in
 * 001_initial_schema.sql) -- only its SHA-256 hash is looked up, mirroring
 * how GitHub/Stripe-style tokens are verified. Returns null for any
 * invalid, inactive, expired, or unknown key -- callers must treat null as
 * "reject the request", never as "fall back to any business".
 */
export async function resolveBusinessFromApiKey(rawKey: string | null): Promise<ApiKeyContext | null> {
  if (!rawKey) return null;

  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

  const { data: keyRow, error } = await db()
    .from("api_keys")
    .select("id, business_id, permissions, expires_at, is_active")
    .eq("key_hash", keyHash)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !keyRow) return null;
  if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) return null;

  const business = await getBusinessById(keyRow.business_id);
  if (!business) return null;

  // Best-effort usage tracking -- never blocks the request if it fails.
  db()
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", keyRow.id)
    .then(() => {}, () => {});

  return { business, permissions: keyRow.permissions ?? [], apiKeyId: keyRow.id };
}

// Step 23: resolveLegacyBusiness() (the anonymous MEDUSA_BUSINESS_ID shim)
// was restored -- its only two callers -- app/api/appointments/route.ts,
// app/api/appointments/[id]/route.ts (both confirmed dead, deleted this
// same step) and app/api/availability/route.ts's anonymous branch (also
// removed this step, that route is now admin-only) -- are gone, but the
// function ITSELF is still live: app/(site)/page.tsx and
// app/(site)/services/page.tsx (the public marketing site) still call it
// directly to resolve which business's catalog to render. See the module
// doc comment above for the full correction note. Kept exactly as it was
// before this step -- unchanged behavior, only the two now-dead callers
// (and their comment references) were removed elsewhere.
//
// The separate, still-live v1 API-key legacy fallback
// (requireAdminKey()/ADMIN_SECRET/X-Admin-Key in
// app/api/v1/_middleware.ts, and MEDUSA_BUSINESS_ID's own remaining read
// in app/api/v1/appointments/[id]/route.ts) is untouched -- that one still
// has a real external-integration compatibility concern and stays until
// that migration is separately confirmed complete.
export async function resolveLegacyBusiness(): Promise<BusinessContextResult> {
  const id = process.env.MEDUSA_BUSINESS_ID;
  if (!id) return { ok: false, reason: "not_configured" };
  const business = await getBusinessById(id);
  if (!business) return { ok: false, reason: "not_found" };
  return { ok: true, business };
}
