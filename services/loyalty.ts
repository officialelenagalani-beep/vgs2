import { paidPrice } from "@/lib/discounts";
import "server-only";
import crypto from "crypto";
import { createServerClient } from "@/lib/supabase/server";
import { getCustomerById } from "@/services/customers";
import {
  DEFAULT_BUSINESS_LOYALTY_SETTINGS,
  DEFAULT_SERVICE_LOYALTY_SETTINGS,
  LOYALTY_LEDGER_PAGE_SIZE,
} from "@/types/loyalty";
import type {
  BusinessLoyaltySettings,
  UpdateBusinessLoyaltySettingsInput,
  ServiceLoyaltySettings,
  ResolvedServiceLoyaltySettings,
  UpdateServiceLoyaltySettingsInput,
  LoyaltyLedgerEntry,
  LoyaltyLedgerPage,
  CreateManualLoyaltyAdjustmentInput,
  RedeemLoyaltyPointsInput,
  AvailableRedemption,
} from "@/types/loyalty";
import type { Appointment } from "@/types/appointments";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

// ---------------------------------------------------------------------------
// Tenant safety -- which columns a settings update may write.
//
// Both update functions below receive `input` from a server action, i.e.
// whatever JSON the browser sent; its TypeScript type is not enforced at
// runtime. Only the columns listed here are ever copied out of it.
// business_id / service_id are never among them -- they are always set
// from the server-resolved arguments.
// ---------------------------------------------------------------------------

const BUSINESS_LOYALTY_SETTINGS_FIELDS = [
  "is_enabled",
  "earn_rate_points_per_currency_unit",
  "redemption_value_per_point",
  "min_redemption_points",
  "max_redemption_percent",
  "daily_redemption_limit_points",
  "monthly_redemption_limit_points",
  "employee_adjustment_limit_points",
] as const satisfies ReadonlyArray<keyof UpdateBusinessLoyaltySettingsInput>;

const SERVICE_LOYALTY_SETTINGS_FIELDS = [
  "earn_allowed",
  "redemption_allowed",
  "restrict_same_service_redemption",
] as const satisfies ReadonlyArray<keyof UpdateServiceLoyaltySettingsInput>;

/** Copies only `fields` out of an untrusted object. `undefined` = not sent; `null` is kept (it clears an optional limit). */
function pickFields(input: unknown, fields: ReadonlyArray<string>): Record<string, unknown> {
  const source = (input ?? {}) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined) {
      picked[field] = source[field];
    }
  }
  return picked;
}


/**
 * Phase 4 / Step 25 -- Loyalty.
 *
 * Same module shape as every other services/*.ts file in this project:
 * every function takes `businessId` as its first argument (or inside its
 * input object) and scopes every read/write to it; this module has no
 * knowledge of sessions/roles -- callers
 * (app/admin/(dashboard)/loyalty/actions.ts, services/appointments.ts,
 * app/admin/(dashboard)/customers/actions.ts) are responsible for
 * resolving businessId and checking permissions (lib/auth/roles.ts)
 * before calling anything here.
 *
 * There is NO mutable loyalty balance anywhere in this module or the
 * schema it reads/writes -- see getCustomerLoyaltyBalance() and
 * loyalty_ledger's own header comment (022_loyalty_ledger.sql).
 */

// ---------------------------------------------------------------------------
// Business settings
// ---------------------------------------------------------------------------

/**
 * Always returns a usable settings object, even if the business has never
 * configured loyalty (no row yet) -- in that case, a disabled, all-zero
 * default (DEFAULT_BUSINESS_LOYALTY_SETTINGS) is returned rather than
 * null, so every caller (the settings form, the earning/redemption logic)
 * can treat "never configured" and "configured but disabled" identically,
 * matching 021_business_loyalty_settings.sql's own documented intent.
 * Fails closed (same shape) on a DB error too -- never throws.
 */
export async function getBusinessLoyaltySettings(businessId: string): Promise<BusinessLoyaltySettings> {
  const { data, error } = await db()
    .from("business_loyalty_settings")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();

  if (error) {
    console.error("[loyalty] getBusinessLoyaltySettings:", JSON.stringify(error));
  }

  if (!data) {
    return { business_id: businessId, created_at: "", updated_at: "", ...DEFAULT_BUSINESS_LOYALTY_SETTINGS };
  }
  return data as BusinessLoyaltySettings;
}

/**
 * Upserts business_loyalty_settings. Validation of individual field ranges
 * (rate >= 0, percent 0-100, etc) is intentionally re-checked here even
 * though the DB CHECK constraints are the actual backstop -- same
 * "friendly error before the DB error" precedent as
 * app/admin/(dashboard)/business/actions.ts's own field validation ahead
 * of updateBusiness().
 */
export async function updateBusinessLoyaltySettings(
  businessId: string,
  input: UpdateBusinessLoyaltySettingsInput
): Promise<BusinessLoyaltySettings> {
  if (input.earn_rate_points_per_currency_unit !== undefined && input.earn_rate_points_per_currency_unit < 0) {
    throw new Error("Ο ρυθμός συγκέντρωσης πόντων δεν μπορεί να είναι αρνητικός.");
  }
  if (input.redemption_value_per_point !== undefined && input.redemption_value_per_point < 0) {
    throw new Error("Η αξία εξαργύρωσης πόντων δεν μπορεί να είναι αρνητική.");
  }
  if (input.min_redemption_points !== undefined && input.min_redemption_points < 0) {
    throw new Error("Το ελάχιστο όριο εξαργύρωσης δεν μπορεί να είναι αρνητικό.");
  }
  if (
    input.max_redemption_percent !== undefined &&
    (input.max_redemption_percent < 0 || input.max_redemption_percent > 100)
  ) {
    throw new Error("Το μέγιστο ποσοστό εξαργύρωσης πρέπει να είναι μεταξύ 0 και 100.");
  }
  if (input.daily_redemption_limit_points !== undefined && input.daily_redemption_limit_points !== null && input.daily_redemption_limit_points <= 0) {
    throw new Error("Το ημερήσιο όριο εξαργύρωσης πρέπει να είναι θετικός αριθμός ή κενό.");
  }
  if (input.monthly_redemption_limit_points !== undefined && input.monthly_redemption_limit_points !== null && input.monthly_redemption_limit_points <= 0) {
    throw new Error("Το μηνιαίο όριο εξαργύρωσης πρέπει να είναι θετικός αριθμός ή κενό.");
  }
  if (
    input.employee_adjustment_limit_points !== undefined &&
    input.employee_adjustment_limit_points !== null &&
    (!Number.isInteger(input.employee_adjustment_limit_points) || input.employee_adjustment_limit_points <= 0)
  ) {
    throw new Error("Το όριο πόντων για υπαλλήλους πρέπει να είναι θετικός ακέραιος ή κενό.");
  }

  const { data, error } = await db()
    .from("business_loyalty_settings")
    // Tenant-safety fix: only the known settings columns are taken from
    // `input`, and business_id is always the server-resolved value. The
    // previous `{ business_id: businessId, ...input }` let a
    // caller-supplied `business_id` inside `input` override it, i.e. write
    // another business's loyalty settings.
    .upsert(
      { ...pickFields(input, BUSINESS_LOYALTY_SETTINGS_FIELDS), business_id: businessId },
      { onConflict: "business_id" }
    )
    .select()
    .single();

  if (error) {
    console.error("[loyalty] updateBusinessLoyaltySettings:", JSON.stringify(error));
    throw new Error("Σφάλμα κατά την ενημέρωση των ρυθμίσεων πόντων.");
  }
  return data as BusinessLoyaltySettings;
}

// ---------------------------------------------------------------------------
// Service settings
// ---------------------------------------------------------------------------

/**
 * Always fully resolved: rule 15's permissive defaults are applied when
 * no override row exists for this service. See
 * types/loyalty.ts's ResolvedServiceLoyaltySettings for exactly what
 * "resolved" means here.
 */
export async function getServiceLoyaltySettings(
  businessId: string,
  serviceId: string
): Promise<ResolvedServiceLoyaltySettings> {
  const { data, error } = await db()
    .from("service_loyalty_settings")
    .select("*")
    .eq("business_id", businessId)
    .eq("service_id", serviceId)
    .maybeSingle();

  if (error) {
    console.error("[loyalty] getServiceLoyaltySettings:", JSON.stringify(error));
  }

  if (!data) {
    return {
      id: null,
      business_id: businessId,
      service_id: serviceId,
      created_at: null,
      updated_at: null,
      ...DEFAULT_SERVICE_LOYALTY_SETTINGS,
    };
  }
  return data as ResolvedServiceLoyaltySettings;
}

/**
 * All service_loyalty_settings rows a business has ever saved (i.e. every
 * service with NON-default behavior). Services with no row here use the
 * rule-15 defaults -- the admin UI is responsible for merging this list
 * with the business's full service catalog (services/catalog-admin.ts) to
 * show every service, most rows implied-default. Fails closed to an empty
 * array on a DB error.
 */
export async function getAllServiceLoyaltySettings(businessId: string): Promise<ServiceLoyaltySettings[]> {
  const { data, error } = await db()
    .from("service_loyalty_settings")
    .select("*")
    .eq("business_id", businessId);

  if (error) {
    console.error("[loyalty] getAllServiceLoyaltySettings:", JSON.stringify(error));
    return [];
  }
  return (data ?? []) as ServiceLoyaltySettings[];
}

/**
 * Upserts a service_loyalty_settings row. Tenant safety comes from the
 * composite FK (fk_service_loyalty_settings_service_tenant) -- if
 * serviceId doesn't belong to businessId, the insert/upsert itself fails
 * at the database level; this function re-checks first anyway, purely to
 * return a friendly error instead of a raw Postgres constraint message
 * (same precedent as every other admin actions.ts / service pairing in
 * this codebase).
 */
export async function updateServiceLoyaltySettings(
  businessId: string,
  serviceId: string,
  input: UpdateServiceLoyaltySettingsInput
): Promise<ResolvedServiceLoyaltySettings> {
  const { data: service, error: serviceError } = await db()
    .from("services")
    .select("id")
    .eq("business_id", businessId)
    .eq("id", serviceId)
    .maybeSingle();

  if (serviceError || !service) {
    throw new Error("Η υπηρεσία δεν βρέθηκε.");
  }

  const { data, error } = await db()
    .from("service_loyalty_settings")
    .upsert(
      // Tenant-safety fix: same as updateBusinessLoyaltySettings() --
      // business_id and service_id always come from the server-resolved
      // arguments (serviceId was verified against businessId just above),
      // never from `input`.
      {
        ...pickFields(input, SERVICE_LOYALTY_SETTINGS_FIELDS),
        business_id: businessId,
        service_id: serviceId,
      },
      { onConflict: "business_id,service_id" }
    )
    .select()
    .single();

  if (error) {
    console.error("[loyalty] updateServiceLoyaltySettings:", JSON.stringify(error));
    throw new Error("Σφάλμα κατά την ενημέρωση των ρυθμίσεων πόντων για την υπηρεσία.");
  }
  return data as ResolvedServiceLoyaltySettings;
}

// ---------------------------------------------------------------------------
// Balance + history reads
// ---------------------------------------------------------------------------

/**
 * Derived, never stored -- see get_customer_loyalty_balance()
 * (023_loyalty_functions.sql) and loyalty_ledger's own header comment.
 * Fails closed to 0 on a DB error, matching this project's general "never
 * throw on a read, degrade safely" convention (e.g.
 * getBusinessWorkingHours' own "fails closed to an all-closed schedule").
 */
export async function getCustomerLoyaltyBalance(businessId: string, customerId: string): Promise<number> {
  const { data, error } = await db().rpc("get_customer_loyalty_balance", {
    p_business_id: businessId,
    p_customer_id: customerId,
  });

  if (error) {
    console.error("[loyalty] getCustomerLoyaltyBalance:", JSON.stringify(error));
    return 0;
  }
  return typeof data === "number" ? data : Number(data ?? 0);
}

/**
 * Paginated, business-scoped ledger history for one customer, newest
 * first -- same offset-based pagination shape as getAuditLogs()
 * (services/audit-log.ts).
 */
export async function getCustomerLoyaltyLedger(
  businessId: string,
  customerId: string,
  page: number
): Promise<LoyaltyLedgerPage> {
  const from = page * LOYALTY_LEDGER_PAGE_SIZE;
  const to = from + LOYALTY_LEDGER_PAGE_SIZE - 1;

  const { data, error } = await db()
    .from("loyalty_ledger")
    .select("*")
    .eq("business_id", businessId)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .range(from, to + 1);

  if (error) {
    console.error("[loyalty] getCustomerLoyaltyLedger:", JSON.stringify(error));
    return { entries: [], hasMore: false };
  }

  const rows = (data ?? []) as LoyaltyLedgerEntry[];
  const hasMore = rows.length > LOYALTY_LEDGER_PAGE_SIZE;
  return { entries: hasMore ? rows.slice(0, LOYALTY_LEDGER_PAGE_SIZE) : rows, hasMore };
}

// ---------------------------------------------------------------------------
// Earning -- called exclusively from services/appointments.ts's
// updateAppointmentStatus(), never directly from an admin action. See
// that function for the full "entering/leaving completed" integration.
// ---------------------------------------------------------------------------

/**
 * Rule 3: FLOOR, never round or ceil. Rounds toward zero for a
 * non-negative input, which is exactly floor() for the non-negative
 * amounts this is always called with (service_price and earn_rate are
 * both CHECK'd >= 0 at their respective tables).
 */
function calculateEarnedPoints(servicePrice: number, earnRate: number): number {
  return Math.floor(servicePrice * earnRate);
}

/**
 * Awards points for a newly-completed appointment. A pure no-op (returns
 * null, writes nothing) -- never throws -- for every one of rules 2/4-9's
 * "do not earn" cases, so a loyalty configuration gap never blocks the
 * appointment status change that triggered this call (see
 * services/appointments.ts's own try/catch around this, matching its
 * existing notification-side-effect convention).
 *
 * IDEMPOTENCY (rule 14): the idempotency key includes a "completion
 * cycle" number -- the count of 'earn' transactions this exact
 * appointment has ever produced. A fresh completion (cycle 0) gets
 * `earn:<appointmentId>:0`; if the appointment is later un-completed
 * (reversed) and completed again, the next award naturally computes
 * cycle 1, a DIFFERENT key -- so it is never blocked by the first
 * completion's key, while a genuine RETRY of the SAME completion (same
 * cycle count, because no new earn row has been written yet) always
 * reuses the same key and is safely absorbed by award_loyalty_points'
 * own idempotency-key uniqueness check.
 */
export async function awardEarnedPointsForCompletedAppointment(
  businessId: string,
  appointment: Appointment
): Promise<LoyaltyLedgerEntry | null> {
  if (!appointment.customer_id) return null;

  const settings = await getBusinessLoyaltySettings(businessId);
  if (!settings.is_enabled) return null;

  if (!appointment.service_id) return null;
  const serviceSettings = await getServiceLoyaltySettings(businessId, appointment.service_id);
  if (!serviceSettings.earn_allowed) return null;

  // Points are earned on what the customer actually paid (after any discount code, 041).
  const points = calculateEarnedPoints(paidPrice(appointment), Number(settings.earn_rate_points_per_currency_unit));
  if (points <= 0) return null;

  const { data: priorEarns, error: priorError } = await db()
    .from("loyalty_ledger")
    .select("id")
    .eq("business_id", businessId)
    .eq("appointment_id", appointment.id)
    .eq("transaction_type", "earn");

  if (priorError) {
    console.error("[loyalty] awardEarnedPointsForCompletedAppointment (cycle lookup):", JSON.stringify(priorError));
    return null;
  }

  const completionCycle = (priorEarns ?? []).length;
  const idempotencyKey = `earn:${appointment.id}:${completionCycle}`;

  const { data, error } = await db().rpc("award_loyalty_points", {
    p_business_id: businessId,
    p_customer_id: appointment.customer_id,
    p_appointment_id: appointment.id,
    p_service_id: appointment.service_id,
    p_amount: points,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    console.error("[loyalty] awardEarnedPointsForCompletedAppointment (award):", JSON.stringify(error));
    return null;
  }
  return (data as LoyaltyLedgerEntry[] | LoyaltyLedgerEntry | null) as LoyaltyLedgerEntry | null;
}

/**
 * Reverses whichever 'earn' transaction is currently active (un-reversed)
 * for this appointment, if any. A pure no-op if none exists -- e.g.
 * loyalty was disabled/misconfigured at completion time, the appointment
 * had no customer_id, or this exact reversal already happened (retried
 * call) -- matching rule 19's "cancelled before completion needs no
 * reversal" spirit generalized to "nothing was ever earned, so there is
 * nothing to undo".
 */
export async function reverseEarnedPoints(
  businessId: string,
  appointmentId: string
): Promise<LoyaltyLedgerEntry | null> {
  const { data: rows, error } = await db()
    .from("loyalty_ledger")
    .select("*")
    .eq("business_id", businessId)
    .eq("appointment_id", appointmentId)
    .in("transaction_type", ["earn", "reversal"])
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[loyalty] reverseEarnedPoints (lookup):", JSON.stringify(error));
    return null;
  }

  const entries = (rows ?? []) as LoyaltyLedgerEntry[];
  const reversedEarnIds = new Set(
    entries.filter((e) => e.transaction_type === "reversal").map((e) => e.reverses_transaction_id)
  );
  const activeEarn = entries.find((e) => e.transaction_type === "earn" && !reversedEarnIds.has(e.id));

  if (!activeEarn) return null;

  const idempotencyKey = `reversal:${activeEarn.id}`;

  const { data, error: rpcError } = await db().rpc("reverse_loyalty_points", {
    p_business_id: businessId,
    p_earn_transaction_id: activeEarn.id,
    p_idempotency_key: idempotencyKey,
  });

  if (rpcError) {
    console.error("[loyalty] reverseEarnedPoints (reverse):", JSON.stringify(rpcError));
    return null;
  }
  return (data as LoyaltyLedgerEntry[] | LoyaltyLedgerEntry | null) as LoyaltyLedgerEntry | null;
}

// ---------------------------------------------------------------------------
// Manual adjustments -- rules 9/11/12/23. Any of owner/manager/employee
// may call this; the caller (app/admin/(dashboard)/customers/actions.ts)
// is responsible for the canCreateManualLoyaltyAdjustment() RBAC check
// before calling here (see lib/auth/roles.ts).
// ---------------------------------------------------------------------------

export async function createManualLoyaltyAdjustment(
  input: CreateManualLoyaltyAdjustmentInput
): Promise<LoyaltyLedgerEntry> {
  const amount = Math.trunc(input.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error("Το ποσό της χειροκίνητης προσαρμογής πρέπει να είναι μη μηδενικός ακέραιος αριθμός.");
  }
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error("Απαιτείται αιτιολογία για τη χειροκίνητη προσαρμογή πόντων.");
  }

  const customer = await getCustomerById(input.businessId, input.customerId);
  if (!customer) {
    throw new Error("Ο πελάτης δεν βρέθηκε.");
  }

  const idempotencyKey = `manual:${crypto.randomUUID()}`;

  const { data, error } = await db()
    .from("loyalty_ledger")
    .insert({
      business_id: input.businessId,
      customer_id: input.customerId,
      transaction_type: "manual_adjustment",
      amount,
      reason,
      actor_id: input.actorId,
      actor_email: input.actorEmail,
      idempotency_key: idempotencyKey,
    })
    .select()
    .single();

  if (error) {
    console.error("[loyalty] createManualLoyaltyAdjustment:", JSON.stringify(error));
    throw new Error("Σφάλμα κατά την καταχώρηση της χειροκίνητης προσαρμογής πόντων.");
  }
  return data as LoyaltyLedgerEntry;
}

// ---------------------------------------------------------------------------
// Redemption -- rules 6/8/12/13/14/16/17/18. See
// redeem_loyalty_points()/preview_loyalty_redemption()
// (023_loyalty_functions.sql) for the actual, authoritative validation
// and concurrency-safe accounting; this module's role is just to shape
// inputs/outputs and translate known failure messages into friendly Greek
// errors, matching this project's existing pattern (see
// services/appointments.ts's own Greek error strings).
// ---------------------------------------------------------------------------

const REDEMPTION_ERROR_TRANSLATIONS: Array<[RegExp, string]> = [
  [/loyalty is not enabled/i, "Το πρόγραμμα πόντων δεν είναι ενεργό για αυτή την επιχείρηση."],
  [/customer .* not found/i, "Ο πελάτης δεν βρέθηκε."],
  [/service .* not found/i, "Η υπηρεσία δεν βρέθηκε."],
  [/redemption is disabled for this service/i, "Η εξαργύρωση πόντων δεν επιτρέπεται για αυτή την υπηρεσία."],
  [/below the minimum redemption threshold/i, "Ο αριθμός πόντων είναι μικρότερος από το ελάχιστο όριο εξαργύρωσης."],
  [/insufficient eligible points/i, "Ο πελάτης δεν έχει αρκετούς διαθέσιμους πόντους για αυτή την εξαργύρωση."],
  [/exceeds the max coverage/i, "Η εξαργύρωση υπερβαίνει το μέγιστο ποσοστό κάλυψης για αυτή την υπηρεσία."],
  [/daily redemption limit/i, "Θα ξεπεραστεί το ημερήσιο όριο εξαργύρωσης πόντων."],
  [/monthly redemption limit/i, "Θα ξεπεραστεί το μηνιαίο όριο εξαργύρωσης πόντων."],
  [/redemption_value_per_point is not configured/i, "Η αξία εξαργύρωσης πόντων δεν έχει ρυθμιστεί για αυτή την επιχείρηση."],
];

function translateRedemptionError(message: string | undefined): string {
  const text = message ?? "";
  for (const [pattern, greek] of REDEMPTION_ERROR_TRANSLATIONS) {
    if (pattern.test(text)) return greek;
  }
  return "Σφάλμα κατά την εξαργύρωση πόντων.";
}

/**
 * Executes an actual redemption. All validation (rules 1-11 of the
 * REDEMPTION LOGIC section) plus the concurrency-safe accounting happen
 * inside redeem_loyalty_points() (023_loyalty_functions.sql) -- this
 * function does not re-implement or duplicate any of those checks, only
 * translates a failure into a friendly message. Points is always a
 * positive integer (rule 8's partial redemption -- the caller decides how
 * many of the customer's eligible points to spend; this never requires
 * spending the full balance).
 */
export async function redeemLoyaltyPoints(input: RedeemLoyaltyPointsInput): Promise<LoyaltyLedgerEntry> {
  const points = Math.trunc(input.points);
  if (!Number.isFinite(points) || points <= 0) {
    throw new Error("Ο αριθμός πόντων προς εξαργύρωση πρέπει να είναι θετικός ακέραιος αριθμός.");
  }

  const idempotencyKey = `redeem:${input.businessId}:${input.customerId}:${input.requestId ?? crypto.randomUUID()}`;

  const { data, error } = await db().rpc("redeem_loyalty_points", {
    p_business_id: input.businessId,
    p_customer_id: input.customerId,
    p_service_id: input.serviceId,
    p_points_to_redeem: points,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    console.error("[loyalty] redeemLoyaltyPoints:", JSON.stringify(error));
    throw new Error(translateRedemptionError(error?.message));
  }
  return (Array.isArray(data) ? data[0] : data) as LoyaltyLedgerEntry;
}

/**
 * Read-only preview of what a redemption against `serviceId` would allow
 * right now, without writing anything. Backed by
 * preview_loyalty_redemption() (023_loyalty_functions.sql) -- see that
 * function's own header for why it necessarily duplicates
 * redeem_loyalty_points()'s eligibility computation, and for the
 * "momentarily stale under concurrency" caveat.
 */
export async function calculateAvailableRedemption(
  businessId: string,
  customerId: string,
  serviceId: string
): Promise<AvailableRedemption> {
  const { data, error } = await db().rpc("preview_loyalty_redemption", {
    p_business_id: businessId,
    p_customer_id: customerId,
    p_service_id: serviceId,
  });

  if (error) {
    console.error("[loyalty] calculateAvailableRedemption:", JSON.stringify(error));
    return {
      eligible: false,
      reason: "Σφάλμα κατά τον υπολογισμό διαθέσιμης εξαργύρωσης.",
      totalBalance: 0,
      eligiblePoints: 0,
      maxRedeemablePoints: 0,
      maxRedeemableValue: 0,
    };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return {
      eligible: false,
      reason: "Σφάλμα κατά τον υπολογισμό διαθέσιμης εξαργύρωσης.",
      totalBalance: 0,
      eligiblePoints: 0,
      maxRedeemablePoints: 0,
      maxRedeemableValue: 0,
    };
  }

  return {
    eligible: Boolean(row.eligible),
    reason: row.reason ?? null,
    totalBalance: Number(row.total_balance ?? 0),
    eligiblePoints: Number(row.eligible_points ?? 0),
    maxRedeemablePoints: Number(row.max_redeemable_points ?? 0),
    maxRedeemableValue: Number(row.max_redeemable_value ?? 0),
  };
}
