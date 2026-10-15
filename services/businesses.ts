import { createServerClient } from "@/lib/supabase/server";
import type { Business, Employee, PublicBusiness, PublicEmployee, CreateEmployeeInput } from "@/types/businesses";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

export async function getBusinessBySlug(slug: string): Promise<Business | null> {
  const { data, error } = await db().from("businesses").select("*").eq("slug", slug).eq("is_active", true).single();
  if (error || !data) return null;
  return data as Business;
}

export async function getBusinessById(id: string): Promise<Business | null> {
  const { data, error } = await db().from("businesses").select("*").eq("id", id).eq("is_active", true).single();
  if (error || !data) return null;
  return data as Business;
}

export function toPublicBusiness(b: Business): PublicBusiness {
  // Phase 4 / Step 22: brand_color is a harmless, already-public-facing
  // hex value (no different from employees.color), so it's safe to
  // expose here. logo_url is deliberately NOT included -- it's a
  // private storage object path, never a public URL (see
  // types/businesses.ts's own comment on that field); exposing it here
  // would leak the raw bucket path. Signed-URL logo display is an
  // admin-only concern for this step -- see PHASE4_STEP22_README.md.
  return { slug: b.slug, name: b.name, phone: b.phone, email: b.email, address: b.address, city: b.city, country: b.country, timezone: b.timezone, currency: b.currency, brand_color: b.brand_color };
}

export async function getEmployeesByBusiness(businessId: string): Promise<Employee[]> {
  const { data, error } = await db().from("employees").select("*").eq("business_id", businessId).eq("is_active", true).order("name", { ascending: true });
  if (error) { console.error("[businesses] getEmployeesByBusiness:", error); return []; }
  return (data ?? []) as Employee[];
}

export async function getEmployeeBySlug(businessId: string, slug: string): Promise<Employee | null> {
  const { data, error } = await db().from("employees").select("*").eq("business_id", businessId).eq("slug", slug).eq("is_active", true).single();
  if (error || !data) return null;
  return data as Employee;
}

// Removed (tenant-safety): getEmployeeById(id), updateEmployee(id, input)
// and deactivateEmployee(id). All three addressed an employee by id ALONE,
// with no business_id filter, and updateEmployee() wrote its input object
// unfiltered -- a ready-made cross-tenant read/write for whoever called
// them next. Nothing in the application called them. The tenant-scoped
// equivalents live in services/employees.ts (getEmployeeByIdForAdmin,
// updateEmployee, setEmployeeActive), which is what the dashboard uses.

export function toPublicEmployee(e: Employee): PublicEmployee {
  return { id: e.id, slug: e.slug, name: e.name, color: e.color, role: e.role };
}

export async function createEmployee(businessId: string, input: CreateEmployeeInput): Promise<Employee> {
  const { data, error } = await db().from("employees").insert({
    business_id: businessId, slug: input.slug, name: input.name.trim(),
    phone: input.phone?.trim() ?? null, email: input.email?.trim() ?? null,
    color: input.color ?? null, role: input.role ?? "employee", is_active: true,
  }).select().single();
  if (error) {
    console.error("[businesses] createEmployee:", error);
    if (error.code === "23505") throw new Error(`Το slug "${input.slug}" χρησιμοποιείται ήδη.`);
    throw new Error("Σφάλμα κατά τη δημιουργία υπαλλήλου.");
  }
  return data as Employee;
}

export async function requireBusiness(slug: string): Promise<Business | null> {
  return getBusinessBySlug(slug);
}

export interface CreateBusinessInput {
  name: string;
  slug: string;
  phone?: string;
  email?: string;
}

/**
 * Phase 4 / Step 18 -- Business Onboarding.
 *
 * Creates a brand-new business (tenant root) and makes `userId` its
 * owner, via the atomic `create_business_with_owner()` DB function
 * (015_business_onboarding.sql) -- either both the `businesses` row and
 * the `business_members` row are written, or neither is.
 *
 * SECURITY: `userId` must always be the caller's OWN authenticated user
 * id, resolved server-side via lib/auth/session.ts's getUser()/
 * requireUser() -- never a client-supplied value. This is what stands
 * between "the person who is logged in becomes the owner of the business
 * they just created" and an IDOR that lets anyone hand ownership of a
 * new business to an arbitrary user id. The DB function itself also
 * cannot be called by anything other than the service-role client (see
 * that migration's REVOKE/GRANT), as defense in depth against this same
 * mistake.
 */
export async function createBusinessWithOwner(
  userId: string,
  input: CreateBusinessInput
): Promise<Business> {
  const { data, error } = await db().rpc("create_business_with_owner", {
    p_user_id: userId,
    p_slug: input.slug,
    p_name: input.name,
    p_phone: input.phone ?? null,
    p_email: input.email ?? null,
  });

  if (error) {
    console.error("[businesses] createBusinessWithOwner:", JSON.stringify(error));
    if (error.code === "23505") {
      throw new Error(`Το slug "${input.slug}" χρησιμοποιείται ήδη. Δοκίμασε κάτι διαφορετικό.`);
    }
    if (error.code === "23514") {
      throw new Error("Μη έγκυρα στοιχεία επιχείρησης. Έλεγξε το όνομα και το slug.");
    }
    throw new Error("Σφάλμα κατά τη δημιουργία της επιχείρησης.");
  }

  return data as Business;
}

export interface UpdateBusinessInput {
  name?: string;
  slug?: string;
  phone?: string | null;
  email?: string | null;
  /** Phase 4 / Step 22 -- Business Information Completion. */
  address?: string | null;
  city?: string | null;
  timezone?: string;
  currency?: string;
  /** Phase 4 / Step 22 -- Business Branding. Hex color, e.g. '#4A90E2'. */
  brand_color?: string | null;
}

/**
 * Phase 4 / Step 19 -- Business Management.
 *
 * Updates the given business's own descriptive fields (name/slug/phone/
 * email). Only the fields actually present on `input` are written -- a
 * partial patch, not a full-row replace -- so a caller updating just the
 * phone number can never accidentally blank out the name or slug.
 *
 * SECURITY: `businessId` must always be resolved server-side from the
 * acting user's own session (resolveBusinessFromSession() ->
 * business_members -> business_id), exactly like createBusinessWithOwner()'s
 * `userId` -- never a client-supplied value. This function has no way to
 * independently verify who's allowed to edit `businessId`; that check
 * happens one layer up, in the server action, before this is ever called
 * (see app/admin/(dashboard)/business/actions.ts's requireBusinessOwner()).
 * The `.eq("id", businessId)` filter below is what makes a cross-tenant
 * update physically impossible even if that upstream check had a bug:
 * this can only ever touch the single row matching the id it was given,
 * never "whatever business the (possibly-tampered) client meant".
 *
 * The businesses.slug UNIQUE constraint is the final authority on
 * duplicate slugs (defense in depth alongside the caller's own
 * isValidSlug() pre-check) -- a duplicate-slug update fails closed with a
 * friendly error and never silently overwrites/reassigns another
 * business's slug.
 */
export async function updateBusiness(
  businessId: string,
  input: UpdateBusinessInput
): Promise<Business> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.slug !== undefined) patch.slug = input.slug.trim().toLowerCase();
  if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
  if (input.email !== undefined) patch.email = input.email?.trim() || null;
  if (input.address !== undefined) patch.address = input.address?.trim() || null;
  if (input.city !== undefined) patch.city = input.city?.trim() || null;
  if (input.timezone !== undefined) patch.timezone = input.timezone.trim();
  if (input.currency !== undefined) patch.currency = input.currency.trim().toUpperCase();
  if (input.brand_color !== undefined) patch.brand_color = input.brand_color;

  const { data, error } = await db()
    .from("businesses")
    .update(patch)
    .eq("id", businessId)
    .select()
    .single();

  if (error) {
    console.error("[businesses] updateBusiness:", JSON.stringify(error));
    if (error.code === "23505") {
      throw new Error(
        `Το slug "${input.slug ?? ""}" χρησιμοποιείται ήδη. Δοκίμασε κάτι διαφορετικό.`
      );
    }
    if (error.code === "23514") {
      throw new Error("Μη έγκυρα στοιχεία επιχείρησης. Έλεγξε το όνομα και το slug.");
    }
    throw new Error("Σφάλμα κατά την ενημέρωση της επιχείρησης.");
  }
  if (!data) {
    throw new Error("Η επιχείρηση δεν βρέθηκε.");
  }

  return data as Business;
}
