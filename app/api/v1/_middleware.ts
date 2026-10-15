import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { getBusinessBySlug } from "@/services/businesses";
import { resolveBusinessFromApiKey } from "@/lib/business-context";
import type { Business } from "@/types/businesses";
import { isDomain } from "@/lib/domains";

type RouteResult = { ok: true; business: Business } | { ok: false; response: NextResponse };

export async function resolveBusiness(slug: string): Promise<RouteResult> {
  const business = await getBusinessBySlug(slug);
  // Step 26 -- Business domains: every /api/v1/businesses/[slug]/* route is
  // the BARBER booking API (services, availability, appointments). A
  // business of any other domain (e.g. a travel agency) is answered exactly
  // like an unknown slug -- 404 -- so these endpoints can never expose or
  // write barber-style data for it. Barber businesses are unaffected.
  if (!business || !isDomain(business, "barber")) {
    return { ok: false, response: NextResponse.json({ success: false, error: "Η επιχείρηση δεν βρέθηκε." }, { status: 404 }) };
  }
  return { ok: true, business };
}

/**
 * Phase 4 / Step 16: replaces the single global X-Admin-Key/ADMIN_SECRET
 * check for endpoints that are NOT already scoped by a :slug path segment
 * (i.e. app/api/v1/appointments/** ). Resolves the caller's business_id
 * from the api_keys table (already existed in the schema since
 * 001_initial_schema.sql, never previously read by application code) via
 * a hashed X-Api-Key header -- see lib/business-context.ts. This is what
 * makes these endpoints safe for more than one business to use
 * concurrently: each business gets its own key, and a key can only ever
 * act on the business it belongs to.
 *
 * requireAdminKey() below is kept, temporarily, as a fallback for any
 * caller still sending the legacy X-Admin-Key header against
 * MEDUSA_BUSINESS_ID -- see its own deprecation note. New code should use
 * only this function.
 */
export type ApiKeyRouteResult =
  | { ok: true; business: Business; permissions: string[] }
  | { ok: false; response: NextResponse };

export async function requireApiKeyBusiness(request: NextRequest): Promise<ApiKeyRouteResult> {
  const rawKey = request.headers.get("x-api-key");
  const context = await resolveBusinessFromApiKey(rawKey);
  // Step 26: the X-Api-Key endpoints (/api/v1/appointments/**) are barber
  // endpoints too -- a key belonging to a non-barber business is rejected
  // exactly like an invalid key.
  if (!context || !isDomain(context.business, "barber")) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: "Unauthorized. Invalid, missing, or expired X-Api-Key header." },
        { status: 401 }
      ),
    };
  }
  return { ok: true, business: context.business, permissions: context.permissions };
}

/**
 * DEPRECATED -- Phase 4 / Step 16 legacy shim, kept only during the
 * transition to per-business API keys (see requireApiKeyBusiness above).
 * A single global ADMIN_SECRET cannot correctly scope access once more
 * than one business exists behind this deployment -- anyone holding it
 * can act as whichever business the caller's business_id resolves to
 * (today, always MEDUSA_BUSINESS_ID). New code must use
 * requireApiKeyBusiness() instead. Remove this function, ADMIN_SECRET,
 * and every remaining caller together once the AI-agent/integration
 * caller(s) have been issued a real api_keys row (Step 16 plan, section
 * 15, step 8).
 */
/** A legacy secret shorter than this is treated as not set (the endpoints stay closed). */
export const MIN_ADMIN_SECRET_LENGTH = 32;

export function requireAdminKey(request: NextRequest): NextResponse | null {
  const adminSecret = process.env.ADMIN_SECRET?.trim() ?? "";
  if (adminSecret.length < MIN_ADMIN_SECRET_LENGTH) {
    return NextResponse.json({ success: false, error: "Unauthorized. Invalid or missing X-Admin-Key header." }, { status: 401 });
  }
  const providedKey = request.headers.get("x-admin-key") ?? "";
  // Compare fixed-size digests in constant time, so response timing says nothing about the secret.
  const a = createHash("sha256").update(providedKey).digest();
  const b = createHash("sha256").update(adminSecret).digest();
  if (!providedKey || !timingSafeEqual(a, b)) {
    return NextResponse.json({ success: false, error: "Unauthorized. Invalid or missing X-Admin-Key header." }, { status: 401 });
  }
  return null;
}

/**
 * What each X-Api-Key operation on /api/v1/appointments/** needs. The names
 * are the ones documented on api_keys.permissions (001_initial_schema.sql).
 * A key holding none of the listed capabilities gets 403. A key with no
 * permissions at all can do nothing here.
 */
export const APPOINTMENT_PERMISSIONS = {
  read: ["read:appointments", "manage:appointments"],
  cancel: ["write:appointments:cancel", "write:appointments", "manage:appointments"],
  update: ["write:appointments", "manage:appointments"],
  delete: ["manage:appointments"],
} as const;

export function hasAnyPermission(granted: readonly string[], anyOf: readonly string[]): boolean {
  return anyOf.some((p) => granted.includes(p));
}

export type CallerResult = { ok: true; businessId: string; via: "api_key" | "legacy" } | { ok: false; response: NextResponse };

/**
 * Who is calling /api/v1/appointments/** and for which business:
 *   - a per-business X-Api-Key, which must carry one of `anyOf`;
 *   - otherwise (temporarily) the legacy X-Admin-Key, which only ever acts on
 *     MEDUSA_BUSINESS_ID -- the single business it was issued for.
 */
export async function resolveAppointmentsCaller(request: NextRequest, anyOf: readonly string[]): Promise<CallerResult> {
  const apiKey = await requireApiKeyBusiness(request);
  if (apiKey.ok) {
    if (!hasAnyPermission(apiKey.permissions, anyOf)) {
      return { ok: false, response: err("Forbidden. This API key does not allow this operation.", 403) };
    }
    return { ok: true, businessId: apiKey.business.id, via: "api_key" };
  }
  const legacyError = requireAdminKey(request);
  const medusaId = process.env.MEDUSA_BUSINESS_ID?.trim();
  if (legacyError || !medusaId) {
    return { ok: false, response: err("Unauthorized. Invalid or missing API key.", 401) };
  }
  return { ok: true, businessId: medusaId, via: "legacy" };
}

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ success: true, data }, { status });
}

export function err(message: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error: message }, { status });
}

/**
 * Step 23C: shared 429 response shape for every rate-limited v1 route.
 * `err()` above doesn't support custom headers, and Retry-After is
 * required on a 429 -- this exists so every route constructs it
 * identically rather than each hand-rolling its own NextResponse.json
 * call with headers.
 */
export function tooManyRequests(message: string, retryAfterSeconds: string): NextResponse {
  return NextResponse.json(
    { success: false, error: message },
    { status: 429, headers: { "Retry-After": retryAfterSeconds } }
  );
}
