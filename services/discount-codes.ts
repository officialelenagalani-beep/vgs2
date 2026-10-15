import "server-only";
import { createServerClient } from "@/lib/supabase/server";
import { resolveBookableService } from "@/services/employee-availability";
import { isRealISODate, zonedNow } from "@/lib/booking-rules";
import { computeDiscountAmount, isDiscountCodeFormat, normalizeDiscountCode, previewRefusal } from "@/lib/discounts";
import type { Business } from "@/types/businesses";
import type {
  DiscountCode,
  DiscountCodeInput,
  DiscountCodeWithUses,
  DiscountKind,
  DiscountRefusal,
} from "@/types/discount-codes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

/**
 * Discount codes (migration 041).
 *
 * TRUST MODEL: `businessId` always comes from the caller's server-side
 * session or from the public route's slug lookup -- never from input.
 * Every read and write filters by it. Whether a code may be used for a
 * booking, and how much it takes off, is decided by the database trigger
 * at insert time; the preview below only gives the customer an early answer.
 */

const COLUMNS =
  "id, business_id, code, description, kind, value, valid_from, valid_until, max_uses, max_uses_per_customer, first_visit_only, service_ids, is_active, created_by, created_at, updated_at";

export const MAX_DISCOUNT_CODES_LISTED = 500;

function toCode(row: Record<string, unknown>): DiscountCode {
  return {
    ...(row as unknown as DiscountCode),
    value: Number(row.value),
    service_ids: Array.isArray(row.service_ids) ? (row.service_ids as string[]) : [],
  };
}

/** Validates the admin form. Throws a Greek message for the person. */
export function parseDiscountCodeInput(value: unknown): DiscountCodeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Μη έγκυρα στοιχεία.");
  const v = value as Record<string, unknown>;

  const code = normalizeDiscountCode(v.code);
  if (!isDiscountCodeFormat(code)) {
    throw new Error("Ο κωδικός θέλει 4–32 λατινικά γράμματα ή αριθμούς (επιτρέπονται και - _).");
  }
  const description = typeof v.description === "string" ? v.description.trim() : "";
  if (description.length > 200) throw new Error("Η περιγραφή είναι πολύ μεγάλη (έως 200 χαρακτήρες).");

  const kind = v.kind;
  if (kind !== "percent" && kind !== "fixed") throw new Error("Διάλεξε ποσοστό ή ποσό.");
  const amount = typeof v.value === "number" ? v.value : Number.NaN;
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Η έκπτωση πρέπει να είναι μεγαλύτερη από 0.");
  if (Math.round(amount * 100) !== amount * 100) throw new Error("Η έκπτωση έχει το πολύ 2 δεκαδικά.");
  if (kind === "percent" && amount > 100) throw new Error("Το ποσοστό δεν μπορεί να ξεπερνά το 100%.");
  if (kind === "fixed" && amount > 10_000) throw new Error("Το ποσό είναι πολύ μεγάλο.");

  const date = (x: unknown, label: string): string | null => {
    if (x === null || x === undefined || x === "") return null;
    if (!isRealISODate(x)) throw new Error(`Μη έγκυρη ημερομηνία (${label}).`);
    return x;
  };
  const validFrom = date(v.valid_from, "από");
  const validUntil = date(v.valid_until, "έως");
  if (validFrom && validUntil && validUntil < validFrom) throw new Error("Η λήξη είναι πριν από την έναρξη.");

  let maxUses: number | null = null;
  if (v.max_uses !== null && v.max_uses !== undefined && v.max_uses !== "") {
    if (typeof v.max_uses !== "number" || !Number.isInteger(v.max_uses) || v.max_uses < 1 || v.max_uses > 1_000_000) {
      throw new Error("Οι συνολικές χρήσεις πρέπει να είναι θετικός ακέραιος ή κενό.");
    }
    maxUses = v.max_uses;
  }

  for (const key of ["once_per_customer", "first_visit_only", "is_active"] as const) {
    if (typeof v[key] !== "boolean") throw new Error("Μη έγκυρα στοιχεία.");
  }

  const serviceIds = Array.isArray(v.service_ids) ? v.service_ids : null;
  if (!serviceIds || serviceIds.length > 200 || !serviceIds.every((s) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s))) {
    throw new Error("Μη έγκυρη επιλογή υπηρεσιών.");
  }

  return {
    code,
    description: description || null,
    kind,
    value: amount,
    valid_from: validFrom,
    valid_until: validUntil,
    max_uses: maxUses,
    once_per_customer: v.once_per_customer as boolean,
    first_visit_only: v.first_visit_only as boolean,
    service_ids: Array.from(new Set(serviceIds as string[])),
    is_active: v.is_active as boolean,
  };
}

/** The chosen services must all belong to this business. */
async function assertOwnServices(businessId: string, serviceIds: string[]): Promise<void> {
  if (serviceIds.length === 0) return;
  const { data, error } = await db().from("services").select("id").eq("business_id", businessId).in("id", serviceIds);
  if (error) throw new Error("Σφάλμα κατά τον έλεγχο των υπηρεσιών.");
  if ((data ?? []).length !== serviceIds.length) throw new Error("Κάποια υπηρεσία δεν βρέθηκε.");
}

function toRow(input: DiscountCodeInput) {
  return {
    code: input.code,
    description: input.description,
    kind: input.kind,
    value: input.value,
    valid_from: input.valid_from,
    valid_until: input.valid_until,
    max_uses: input.max_uses,
    max_uses_per_customer: input.once_per_customer ? 1 : null,
    first_visit_only: input.first_visit_only,
    service_ids: input.service_ids,
    is_active: input.is_active,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

/** Counts bookings per code that hold a use (not cancelled, not deleted). */
async function countUses(businessId: string, codeIds: string[]): Promise<Map<string, number>> {
  const uses = new Map<string, number>();
  if (codeIds.length === 0) return uses;
  const { data, error } = await db()
    .from("appointments")
    .select("discount_code_id")
    .eq("business_id", businessId)
    .in("discount_code_id", codeIds)
    .neq("status", "cancelled")
    .is("deleted_at", null)
    .limit(100_000);
  if (error) {
    console.error("[discount-codes] countUses:", JSON.stringify(error));
    throw new Error("Σφάλμα κατά τη φόρτωση των κωδικών.");
  }
  for (const r of (data ?? []) as Array<{ discount_code_id: string }>) {
    uses.set(r.discount_code_id, (uses.get(r.discount_code_id) ?? 0) + 1);
  }
  return uses;
}

export async function listDiscountCodes(businessId: string): Promise<DiscountCodeWithUses[]> {
  const { data, error } = await db()
    .from("discount_codes")
    .select(COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(MAX_DISCOUNT_CODES_LISTED);
  if (error) {
    console.error("[discount-codes] list:", JSON.stringify(error));
    throw new Error("Σφάλμα κατά τη φόρτωση των κωδικών.");
  }
  const codes = ((data ?? []) as Record<string, unknown>[]).map(toCode);
  const uses = await countUses(businessId, codes.map((c) => c.id));
  return codes.map((c) => ({ ...c, uses: uses.get(c.id) ?? 0 }));
}

export async function createDiscountCode(businessId: string, actorId: string | null, value: unknown): Promise<DiscountCode> {
  const input = parseDiscountCodeInput(value);
  await assertOwnServices(businessId, input.service_ids);
  const { data, error } = await db()
    .from("discount_codes")
    .insert({ ...toRow(input), business_id: businessId, created_by: actorId })
    .select(COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error)) throw new Error("Υπάρχει ήδη κωδικός με αυτό το όνομα.");
    console.error("[discount-codes] create:", JSON.stringify(error));
    throw new Error("Ο κωδικός δεν αποθηκεύτηκε. Δοκίμασε ξανά.");
  }
  return toCode(data);
}

export async function updateDiscountCode(businessId: string, codeId: string, value: unknown): Promise<DiscountCode> {
  const input = parseDiscountCodeInput(value);
  await assertOwnServices(businessId, input.service_ids);
  const { data, error } = await db()
    .from("discount_codes")
    .update({ ...toRow(input), updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", codeId)
    .select(COLUMNS)
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error)) throw new Error("Υπάρχει ήδη κωδικός με αυτό το όνομα.");
    console.error("[discount-codes] update:", JSON.stringify(error));
    throw new Error("Ο κωδικός δεν αποθηκεύτηκε. Δοκίμασε ξανά.");
  }
  if (!data) throw new Error("Ο κωδικός δεν βρέθηκε.");
  return toCode(data);
}

export type DiscountPreview =
  | { ok: true; code: string; description: string | null; kind: DiscountKind; value: number; price: number; discount: number; finalPrice: number; firstVisitOnly: boolean; oncePerCustomer: boolean }
  | { ok: false; reason: DiscountRefusal | "bad_service" };

/**
 * Early answer for the booking form: does this code apply to this service
 * today, and what would the price be? Customer-specific rules (once per
 * customer, first visit) are checked at booking, when the phone is known.
 */
export async function previewDiscount(business: Pick<Business, "id" | "timezone">, rawCode: unknown, serviceSlug: unknown, now: Date = new Date()): Promise<DiscountPreview> {
  const code = normalizeDiscountCode(rawCode);
  if (!isDiscountCodeFormat(code)) return { ok: false, reason: "not_found" };
  if (typeof serviceSlug !== "string" || serviceSlug.length === 0 || serviceSlug.length > 100) return { ok: false, reason: "bad_service" };

  const service = await resolveBookableService(business.id, serviceSlug);
  if (!service) return { ok: false, reason: "bad_service" };

  const { data, error } = await db()
    .from("discount_codes")
    .select(COLUMNS)
    .eq("business_id", business.id)
    .eq("code", code)
    .maybeSingle();
  if (error) {
    console.error("[discount-codes] preview:", JSON.stringify(error));
    return { ok: false, reason: "not_found" };
  }
  if (!data) return { ok: false, reason: "not_found" };
  const row = toCode(data);
  const uses = row.max_uses !== null ? (await countUses(business.id, [row.id])).get(row.id) ?? 0 : 0;
  const refusal = previewRefusal(row, { today: zonedNow(business.timezone, now).date, serviceId: service.id, uses });
  if (refusal) return { ok: false, reason: refusal };

  const discount = computeDiscountAmount(row.kind, row.value, service.price);
  return {
    ok: true,
    code: row.code,
    description: row.description,
    kind: row.kind,
    value: row.value,
    price: service.price,
    discount,
    finalPrice: Math.round((service.price - discount) * 100) / 100,
    firstVisitOnly: row.first_visit_only,
    oncePerCustomer: row.max_uses_per_customer !== null,
  };
}
