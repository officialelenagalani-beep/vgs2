import "server-only";
import { createServerClient } from "@/lib/supabase/server";
import { normalizeGreekPhoneForIdentity } from "@/lib/phone";
import type {
  Customer,
  CustomerListItem,
  FindOrCreateCustomerInput,
  CreateCustomerInput,
  UpdateCustomerInput,
} from "@/types/customers";
import type { Appointment } from "@/types/appointments";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

/**
 * Phase 4 / Step 24 -- Client / Customer Management.
 *
 * Same module shape as every other services/*.ts file in this project:
 * every function takes `businessId` as its first argument and scopes
 * every read/write to it (`.eq("business_id", businessId)`); this module
 * has no knowledge of sessions/roles -- callers
 * (app/admin/(dashboard)/customers/actions.ts, services/appointments.ts)
 * are responsible for resolving businessId and checking permissions
 * before calling anything here.
 */

// ---------------------------------------------------------------------------
// Email normalization -- same convention already established in
// services/business-invitations.ts's own normalizeEmail(). Duplicated
// here (four lines, zero feature-specific logic) rather than imported
// from that file, matching this codebase's own precedent of small
// independent per-feature functions over cross-feature sharing (see
// lib/auth/roles.ts's canManageInvitations()/canManageRoles() comment).
// ---------------------------------------------------------------------------

function normalizeEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanName(name: string): string {
  return name.trim();
}

// ---------------------------------------------------------------------------
// Unique-violation classification -- mirrors the exact pattern
// services/appointments.ts's own isSlotUniqueViolation() already
// established in Step 23: check the Postgres SQLSTATE (23505) AND that
// the error text names THIS constraint specifically, so an unrelated
// unique-violation is never misclassified.
// ---------------------------------------------------------------------------

function isCustomerPhoneUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; message?: string; details?: string };
  if (e.code !== "23505") return false;
  const text = `${e.message ?? ""} ${e.details ?? ""}`;
  return text.includes("uq_customers_business_normalized_phone");
}

// ─── Reads ───────────────────────────────────────────────────────────────

export async function getCustomerById(
  businessId: string,
  customerId: string
): Promise<Customer | null> {
  const { data, error } = await db()
    .from("customers")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", customerId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.error("[customers] getCustomerById:", error);
    return null;
  }
  return (data as Customer) ?? null;
}

/**
 * Internal lookup used by findOrCreateCustomer(). Only ever matches an
 * ACTIVE (not soft-deleted) customer -- a soft-deleted customer's phone
 * number is free for a genuinely new customer to reuse (see the partial
 * unique index in 019_customers.sql), so a deleted row must never be
 * returned here as if it were still the current customer for that phone.
 */
export async function findCustomerByNormalizedPhone(
  businessId: string,
  normalizedPhone: string
): Promise<Customer | null> {
  const { data, error } = await db()
    .from("customers")
    .select("*")
    .eq("business_id", businessId)
    .eq("normalized_phone", normalizedPhone)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.error("[customers] findCustomerByNormalizedPhone:", error);
    return null;
  }
  return (data as Customer) ?? null;
}

/**
 * Quotes a value for use inside a PostgREST `or=(...)` filter string, so
 * reserved characters (`,` `(` `)` `.` `:`) in it are data, not syntax.
 * PostgREST's rule: wrap in double quotes; escape `\` and `"` with `\`.
 */
export function quoteFilterValue(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * Admin customer list. total_appointments/last_appointment_at/
 * next_appointment_at are computed live from `appointments`, per Step 24
 * decision #7 (no denormalized counters on `customers` itself). `search`
 * matches name, phone (raw), and email (raw) case/whitespace-insensitively
 * -- normalized_phone/normalized_email are also searched so a customer can
 * be found regardless of how their number/email was originally typed.
 */
export async function getCustomersForAdmin(
  businessId: string,
  options: { search?: string } = {}
): Promise<CustomerListItem[]> {
  let query = db()
    .from("customers")
    .select("*")
    .eq("business_id", businessId)
    .is("deleted_at", null);

  const search = options.search?.trim().slice(0, 100);
  if (search) {
    // The search text is user input placed inside a PostgREST filter
    // expression, where "," separates conditions and "(" ")" group them.
    // Unquoted, a search such as `a,deleted_at.not.is.null` was parsed as
    // an extra condition instead of as text. Wrapping the value in double
    // quotes (with \ and " escaped) makes PostgREST treat every character
    // literally -- see quoteFilterValue().
    const term = quoteFilterValue(`%${search}%`);
    query = query.or(
      `name.ilike.${term},phone.ilike.${term},email.ilike.${term},normalized_phone.ilike.${term},normalized_email.ilike.${term}`
    );
  }

  const { data: customers, error } = await query.order("name", { ascending: true });
  if (error) {
    console.error("[customers] getCustomersForAdmin:", error);
    return [];
  }

  const rows = (customers ?? []) as Customer[];
  if (rows.length === 0) return [];

  const ids = rows.map((c) => c.id);
  const { data: appts, error: apptError } = await db()
    .from("appointments")
    .select("customer_id, appointment_date, appointment_time")
    .eq("business_id", businessId)
    .in("customer_id", ids)
    .is("deleted_at", null);

  if (apptError) {
    console.error("[customers] getCustomersForAdmin (appointments aggregate):", apptError);
    // Fail closed on the aggregate only, not the whole list -- a customer
    // is still worth showing with zeroed stats rather than not at all.
    return rows.map((c) => ({
      ...c,
      total_appointments: 0,
      last_appointment_at: null,
      next_appointment_at: null,
    }));
  }

  const nowISO = new Date().toISOString();
  const byCustomer = new Map<string, { date: string; time: string }[]>();
  for (const a of (appts ?? []) as { customer_id: string; appointment_date: string; appointment_time: string }[]) {
    const list = byCustomer.get(a.customer_id) ?? [];
    list.push({ date: a.appointment_date, time: a.appointment_time });
    byCustomer.set(a.customer_id, list);
  }

  return rows.map((c) => {
    const list = byCustomer.get(c.id) ?? [];
    const stamps = list
      .map((x) => `${x.date}T${x.time}`)
      .sort();
    const past = stamps.filter((s) => s <= nowISO);
    const future = stamps.filter((s) => s > nowISO);
    return {
      ...c,
      total_appointments: stamps.length,
      last_appointment_at: past.length > 0 ? past[past.length - 1] : null,
      next_appointment_at: future.length > 0 ? future[0] : null,
    };
  });
}

/**
 * Full appointment history (past and upcoming) for one customer's detail
 * page. Tenant-scoped by businessId in addition to customerId, exactly
 * like every other per-entity read in this codebase (never trust the id
 * alone).
 */
export async function getCustomerAppointments(
  businessId: string,
  customerId: string
): Promise<Appointment[]> {
  const { data, error } = await db()
    .from("appointments")
    // Roadmap Step 26 (client history): the joined employee, so the history
    // can show who served the customer. Same embed the appointment lists use
    // (APPOINTMENT_SELECT, services/appointments.ts).
    .select("*, employee:employees(id, name, slug, color)")
    .eq("business_id", businessId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("appointment_date", { ascending: false })
    .order("appointment_time", { ascending: false });
  if (error) {
    console.error("[customers] getCustomerAppointments:", error);
    return [];
  }
  return (data ?? []) as Appointment[];
}

// ─── Writes ──────────────────────────────────────────────────────────────

/**
 * Low-level insert, used both by createCustomer() (manual admin creation)
 * and findOrCreateCustomer() (booking flow). Handles the concurrent-
 * create race (Step 24 decision, concurrency section): if a
 * uq_customers_business_normalized_phone violation is caught, a
 * concurrent request already created the row for this exact
 * (business_id, normalized_phone) -- re-select and return that existing
 * customer instead of failing, mirroring services/appointments.ts's own
 * isSlotUniqueViolation() -> friendly-recovery pattern from Step 23.
 */
async function insertCustomer(
  businessId: string,
  input: { name: string; phone: string | null; normalizedPhone: string | null; email: string | null; normalizedEmail: string | null }
): Promise<Customer> {
  const { data, error } = await db()
    .from("customers")
    .insert({
      business_id: businessId,
      name: input.name,
      phone: input.phone,
      normalized_phone: input.normalizedPhone,
      email: input.email,
      normalized_email: input.normalizedEmail,
    })
    .select()
    .single();

  if (error) {
    if (input.normalizedPhone && isCustomerPhoneUniqueViolation(error)) {
      const existing = await findCustomerByNormalizedPhone(businessId, input.normalizedPhone);
      if (existing) return existing;
      // Extremely unlikely (the row that caused the violation should be
      // selectable immediately after): fall through to a generic error
      // rather than returning something incorrect.
    }
    console.error("[customers] insertCustomer error:", JSON.stringify(error));
    throw new Error("Σφάλμα κατά τη δημιουργία πελάτη. Δοκιμάστε ξανά.");
  }

  return data as Customer;
}

/**
 * Manual admin "create customer" -- unlike findOrCreateCustomer(), this
 * may create a customer with no usable phone at all (e.g. a walk-in
 * recorded with only a name), per Step 24 decision #3's carve-out for
 * manual admin creation.
 */
export async function createCustomer(
  businessId: string,
  input: CreateCustomerInput
): Promise<Customer> {
  const name = cleanName(input.name);
  if (name.length < 1) {
    throw new Error("Το όνομα είναι υποχρεωτικό.");
  }
  const rawPhone = input.phone?.trim() || null;
  const normalizedPhone = rawPhone ? normalizeGreekPhoneForIdentity(rawPhone) : null;
  const rawEmail = input.email?.trim() || null;
  const normalizedEmail = rawEmail ? normalizeEmail(rawEmail) : null;

  return insertCustomer(businessId, {
    name,
    phone: rawPhone,
    normalizedPhone,
    email: rawEmail,
    normalizedEmail,
  });
}

export async function updateCustomer(
  businessId: string,
  customerId: string,
  input: UpdateCustomerInput
): Promise<Customer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = {};

  if (input.name !== undefined) {
    const name = cleanName(input.name);
    if (name.length < 1) {
      throw new Error("Το όνομα είναι υποχρεωτικό.");
    }
    patch.name = name;
  }
  if (input.phone !== undefined) {
    const rawPhone = input.phone?.trim() || null;
    patch.phone = rawPhone;
    patch.normalized_phone = rawPhone ? normalizeGreekPhoneForIdentity(rawPhone) : null;
  }
  if (input.email !== undefined) {
    const rawEmail = input.email?.trim() || null;
    patch.email = rawEmail;
    patch.normalized_email = rawEmail ? normalizeEmail(rawEmail) : null;
  }

  const { data, error } = await db()
    .from("customers")
    .update(patch)
    .eq("business_id", businessId)
    .eq("id", customerId)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    // No row: unknown, another business's, or already deleted / erased.
    if ((error as { code?: string }).code === "PGRST116") throw new Error("Ο πελάτης δεν βρέθηκε.");
    console.error("[customers] updateCustomer error:", JSON.stringify(error));
    if (isCustomerPhoneUniqueViolation(error)) {
      throw new Error("Υπάρχει ήδη πελάτης με αυτό το τηλέφωνο.");
    }
    throw new Error("Σφάλμα κατά την ενημέρωση πελάτη. Δοκιμάστε ξανά.");
  }

  return data as Customer;
}

/**
 * Soft delete only -- never a hard delete, matching every other
 * mutable/business-owned table in this schema (appointments.deleted_at,
 * services'/employees' is_active). appointments.customer_id is
 * ON DELETE SET NULL at the DB level regardless, but soft-deleting here
 * additionally frees the phone number for reuse via the partial unique
 * index's WHERE deleted_at IS NULL clause.
 */
export async function deleteCustomer(businessId: string, customerId: string): Promise<void> {
  const { error } = await db()
    .from("customers")
    .update({ deleted_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", customerId)
    .is("deleted_at", null);

  if (error) {
    console.error("[customers] deleteCustomer error:", JSON.stringify(error));
    throw new Error("Σφάλμα κατά τη διαγραφή πελάτη. Δοκιμάστε ξανά.");
  }
}

/**
 * The one shared customer-identity resolver -- used by createAppointment()
 * (services/appointments.ts) for ALL booking paths (public website, admin
 * "New Appointment", and any future AI-phone-agent/API caller that ends
 * up calling createAppointment() too), so there is exactly one place
 * customer identity logic lives, per Step 24's core requirement.
 *
 * Rules (Step 24 final decisions):
 *  - Phone is the ONLY automatic identity signal. Name/email are never
 *    used to match or merge.
 *  - If the phone doesn't normalize to a valid 10-digit Greek number,
 *    returns `null` -- the caller must NOT let this block appointment
 *    creation, and must NOT create a customer from it (a single garbage/
 *    missing phone must never spawn a new "customer" of its own, since
 *    every subsequent invalid submission would otherwise pile up as
 *    distinct anonymous customer rows).
 *  - If an active customer already exists for (businessId,
 *    normalizedPhone), it is returned AS-IS -- name/email are never
 *    overwritten by a booking (Step 24 decision #4). Only an explicit
 *    admin edit (updateCustomer) changes a customer's profile.
 *  - If no active customer exists yet, one is created. Concurrent
 *    duplicate-create attempts are resolved by insertCustomer()'s
 *    catch-unique-violation-and-re-select path -- see its own comment.
 */
export async function findOrCreateCustomer(
  businessId: string,
  input: FindOrCreateCustomerInput
): Promise<Customer | null> {
  const rawPhone = input.phone?.trim() || "";
  const normalizedPhone = rawPhone ? normalizeGreekPhoneForIdentity(rawPhone) : null;

  if (!normalizedPhone) {
    return null;
  }

  const existing = await findCustomerByNormalizedPhone(businessId, normalizedPhone);
  if (existing) {
    return existing;
  }

  const name = cleanName(input.name) || "Άγνωστος πελάτης";
  const rawEmail = input.email?.trim() || null;
  const normalizedEmail = rawEmail ? normalizeEmail(rawEmail) : null;

  return insertCustomer(businessId, {
    name,
    phone: rawPhone,
    normalizedPhone,
    email: rawEmail,
    normalizedEmail,
  });
}

/**
 * Migration 048: the customer ticked "Θέλω να λαμβάνω προσφορές και νέα" on
 * the booking form. Records the consent (time + source "booking") and, if
 * the profile has no e-mail yet, the address they gave. Never withdraws
 * consent (an unticked box means "no change"), never overwrites an existing
 * address, and never throws -- the booking is already saved.
 */
export async function recordBookingMarketingConsent(businessId: string, customerId: string, email: string): Promise<void> {
  const address = email.trim();
  if (!address) return;
  try {
    const { error: emailError } = await db()
      .from("customers")
      .update({ email: address, normalized_email: normalizeEmail(address) })
      .eq("business_id", businessId)
      .eq("id", customerId)
      .is("deleted_at", null)
      .is("email", null);
    if (emailError) console.error("[customers] consent e-mail:", JSON.stringify(emailError));
    const { error } = await db()
      .from("customers")
      .update({ email_marketing: true, email_marketing_at: new Date().toISOString(), email_marketing_source: "booking" })
      .eq("business_id", businessId)
      .eq("id", customerId)
      .is("deleted_at", null)
      .eq("email_marketing", false);
    if (error) console.error("[customers] consent:", JSON.stringify(error));
  } catch (err) {
    console.error("[customers] consent unexpected:", err instanceof Error ? err.message : err);
  }
}
