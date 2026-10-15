/**
 * Employee-aware availability -- Phase 3 / Step 1.
 *
 * Wires the already-built employee scheduling data (working hours, breaks,
 * blocked dates, service assignments -- Phase 2) into the public booking
 * flow's availability check and automatic employee assignment.
 *
 * Source of truth for "is employee E free at time T on date D for a slot
 * of duration M minutes" is the get_available_slots() database function
 * (005_functions.sql, extended in 010_employee_aware_availability.sql to
 * also respect employee_breaks and real duration-based appointment
 * overlap). This module does not re-implement that logic in TypeScript --
 * it calls the function once per eligible employee and combines results.
 */

import { createServerClient } from "@/lib/supabase/server";
import { slotsBetween } from "@/lib/schedule";
import type { AvailabilityResponse } from "@/types/appointments";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

export type BookableService = { id: string; name: string; price: number; duration_min: number };
export type EligibleEmployee = { id: string; name: string; slug: string; color: string | null };

/** Raised when no active employee can perform the requested service at all. */
export class NoEligibleEmployeeError extends Error {}

/** Raised when eligible employees exist, but none is free at the requested time. */
export class SlotUnavailableError extends Error {}

// ---------------------------------------------------------------------------
// Service resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the local catalog slug (lib/services.ts `id`, chosen to match
 * services.slug exactly -- see 002_seed_medusa.sql) to the real DB service
 * row, including its duration -- needed to compute real, duration-aware
 * availability. Returns null if no matching active service row exists.
 */
/**
 * Resolves a service slug to its full bookable record for one business:
 * id, name, price, and duration_min, all sourced from the DB `services`
 * table -- never from lib/services.ts's static catalog. Returns null for
 * an unknown, inactive, or cross-tenant slug (never falls back to any
 * default/other-business row).
 *
 * Phase 4 / Step 16 (services-catalog cutover): before this change, only
 * `id` and `duration_min` were selected here, and services/appointments.ts
 * separately fell back to lib/services.ts's static, single-tenant catalog
 * for `name` and `price` on every real booking (since the public booking
 * flow never sent `service_price`/`service_duration_min`, and always
 * trusted the client-supplied `service_name` verbatim). This is now the
 * single source of truth for all four fields, per business.
 */
export async function resolveBookableService(
  businessId: string,
  serviceSlug: string
): Promise<BookableService | null> {
  const { data, error } = await db()
    .from("services")
    .select("id, name, price, duration_min")
    .eq("business_id", businessId)
    .eq("slug", serviceSlug)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("[employee-availability] resolveBookableService error:", JSON.stringify(error));
    return null;
  }
  return data
    ? {
        id: data.id as string,
        name: data.name as string,
        price: Number(data.price),
        duration_min: data.duration_min as number,
      }
    : null;
}

// ---------------------------------------------------------------------------
// Eligible employees
// ---------------------------------------------------------------------------

/**
 * Active employees assigned (via employee_services) to perform the given
 * service. Ordered by id ascending for a stable, deterministic iteration
 * order -- used downstream by the auto-assignment tie-break rule.
 * Inactive employees are never returned, even if still linked to the
 * service (an employee can be deactivated without removing assignments).
 */
export async function getEligibleEmployees(
  businessId: string,
  serviceId: string
): Promise<EligibleEmployee[]> {
  const client = db();

  const { data: links, error: linksError } = await client
    .from("employee_services")
    .select("employee_id")
    .eq("business_id", businessId)
    .eq("service_id", serviceId);

  if (linksError) {
    console.error("[employee-availability] getEligibleEmployees (links) error:", JSON.stringify(linksError));
    return [];
  }

  const employeeIds = ((links ?? []) as { employee_id: string }[]).map((r) => r.employee_id);
  if (employeeIds.length === 0) return [];

  const { data: employees, error: employeesError } = await client
    .from("employees")
    .select("id, name, slug, color")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .in("id", employeeIds)
    .order("id", { ascending: true });

  if (employeesError) {
    console.error("[employee-availability] getEligibleEmployees (employees) error:", JSON.stringify(employeesError));
    return [];
  }

  return (employees ?? []) as EligibleEmployee[];
}

// ---------------------------------------------------------------------------
// Per-employee slot lookups
// ---------------------------------------------------------------------------

/**
 * Free slot start times ("HH:MM") for one employee on one date, respecting
 * working hours (falling back to business hours), recurring breaks,
 * blocked dates/vacations, and existing appointments -- via
 * get_available_slots(). This is the real availability check; everything
 * else in this file is orchestration around it.
 */
export async function getEmployeeFreeSlots(
  businessId: string,
  employeeId: string,
  dateISO: string,
  slotDurationMin: number,
  excludeAppointmentId?: string
): Promise<string[]> {
  const { data, error } = await db().rpc("get_available_slots", {
    p_business_id: businessId,
    p_date: dateISO,
    p_employee_id: employeeId,
    p_slot_duration: slotDurationMin,
    p_exclude_appt_id: excludeAppointmentId ?? null,
  });

  if (error) {
    console.error("[employee-availability] getEmployeeFreeSlots error:", JSON.stringify(error));
    return [];
  }

  return ((data ?? []) as { slot_time: string }[]).map((r) => r.slot_time.slice(0, 5));
}

/**
 * Free slot start times ("HH:MM") for a single appointment being moved by
 * the Admin Calendar's drag-and-drop reschedule (Phase 3 / Step 4).
 *
 * Same underlying source of truth as getEmployeeFreeSlots() -- the
 * get_available_slots() database function -- but also accepts
 * employeeId = null, which get_available_slots() already supports
 * (p_employee_id DEFAULT NULL means "business-wide hours, no per-employee
 * breaks/blocked-dates"). getEmployeeFreeSlots() itself is left untouched
 * (its `employeeId: string` signature is relied upon by the booking flow
 * in assignEmployeeForBooking/getServiceAvailability, which is out of
 * scope for this step) -- this is a small, additive sibling function for
 * the one new caller that needs the nullable case.
 */
export async function getFreeSlotsForReschedule(
  businessId: string,
  employeeId: string | null,
  dateISO: string,
  slotDurationMin: number,
  excludeAppointmentId?: string
): Promise<string[]> {
  const { data, error } = await db().rpc("get_available_slots", {
    p_business_id: businessId,
    p_date: dateISO,
    p_employee_id: employeeId,
    p_slot_duration: slotDurationMin,
    p_exclude_appt_id: excludeAppointmentId ?? null,
  });

  if (error) {
    console.error("[employee-availability] getFreeSlotsForReschedule error:", JSON.stringify(error));
    return [];
  }

  return ((data ?? []) as { slot_time: string }[]).map((r) => r.slot_time.slice(0, 5));
}

/**
 * The employee's full working-hour grid for one date (open..close, every
 * SLOT_INTERVAL_MINUTES), ignoring bookings/breaks entirely. Used only to
 * populate AvailabilityResponse.all_slots / booked_slots for contract
 * parity with the pre-employee-aware response shape (BookingWizard itself
 * only reads available_slots). Reuses get_business_schedule() (005), the
 * same employee-hours-fall-back-to-business-hours resolver
 * get_available_slots() uses internally.
 */
async function getEmployeeDayGrid(businessId: string, employeeId: string, dateISO: string): Promise<string[]> {
  const dayOfWeek = new Date(`${dateISO}T00:00:00`).getDay();

  const { data, error } = await db().rpc("get_business_schedule", {
    p_business_id: businessId,
    p_employee_id: employeeId,
  });

  if (error) {
    console.error("[employee-availability] getEmployeeDayGrid error:", JSON.stringify(error));
    return [];
  }

  type ScheduleRow = { day_of_week: number; is_closed: boolean; open_time: string | null; close_time: string | null };
  const day = ((data ?? []) as ScheduleRow[]).find((r) => r.day_of_week === dayOfWeek);
  if (!day || day.is_closed || !day.open_time || !day.close_time) return [];

  return slotsBetween(day.open_time.slice(0, 5), day.close_time.slice(0, 5));
}

// ---------------------------------------------------------------------------
// Public availability (union across eligible employees)
// ---------------------------------------------------------------------------

/**
 * Real, employee-aware availability for a service on a date: the union of
 * every eligible, active employee's free slots. The customer never sees
 * or picks an individual employee -- a slot is simply "available" if at
 * least one qualified employee is free for it; the specific employee is
 * decided automatically at booking time (see assignEmployeeForBooking).
 *
 * If `options.employeeId` is given, availability is narrowed to that one
 * employee (used by the admin reschedule modal / v1 API's per-barber
 * check) -- if that employee isn't eligible for the service, the result
 * is correctly empty.
 */
export async function getServiceAvailability(
  businessId: string,
  dateISO: string,
  serviceSlug: string,
  options: { excludeId?: string; employeeId?: string } = {}
): Promise<AvailabilityResponse> {
  const baseMeta: AvailabilityResponse = {
    date: dateISO,
    business_id: businessId,
    employee_id: options.employeeId ?? null,
    service_id: null,
    all_slots: [],
    booked_slots: [],
    available_slots: [],
  };

  const service = await resolveBookableService(businessId, serviceSlug);
  if (!service) return baseMeta;

  let employees = await getEligibleEmployees(businessId, service.id);
  if (options.employeeId) {
    employees = employees.filter((e) => e.id === options.employeeId);
  }
  if (employees.length === 0) {
    return { ...baseMeta, service_id: service.id };
  }

  const [freeSlotsByEmployee, gridByEmployee] = await Promise.all([
    Promise.all(
      employees.map((e) =>
        getEmployeeFreeSlots(businessId, e.id, dateISO, service.duration_min, options.excludeId)
      )
    ),
    Promise.all(employees.map((e) => getEmployeeDayGrid(businessId, e.id, dateISO))),
  ]);

  const availableSet = new Set<string>();
  for (const slots of freeSlotsByEmployee) for (const s of slots) availableSet.add(s);

  const allSet = new Set<string>(availableSet); // free slots are always a subset of the grid
  for (const slots of gridByEmployee) for (const s of slots) allSet.add(s);

  const available_slots = Array.from(availableSet).sort();
  const all_slots = Array.from(allSet).sort();
  const booked_slots = all_slots.filter((s) => !availableSet.has(s));

  return { ...baseMeta, service_id: service.id, all_slots, booked_slots, available_slots };
}

// ---------------------------------------------------------------------------
// Automatic employee assignment (booking-time)
// ---------------------------------------------------------------------------

/**
 * Deterministically picks the employee with the fewest existing
 * confirmed/pending appointments on the given date among `candidateIds`,
 * breaking ties by employee id (ascending). Deterministic: the same
 * inputs always produce the same output, regardless of call order or
 * database row order -- required for a reproducible, auditable
 * auto-assignment algorithm.
 */
async function pickLeastLoadedEmployee(
  businessId: string,
  dateISO: string,
  candidateIds: string[]
): Promise<string> {
  if (candidateIds.length === 1) return candidateIds[0];

  const { data, error } = await db()
    .from("appointments")
    .select("employee_id")
    .eq("business_id", businessId)
    .eq("appointment_date", dateISO)
    .in("status", ["confirmed", "pending"])
    .is("deleted_at", null)
    .in("employee_id", candidateIds);

  const counts = new Map<string, number>(candidateIds.map((id) => [id, 0]));
  if (error) {
    console.error("[employee-availability] pickLeastLoadedEmployee error:", JSON.stringify(error));
  } else {
    for (const row of (data ?? []) as { employee_id: string }[]) {
      counts.set(row.employee_id, (counts.get(row.employee_id) ?? 0) + 1);
    }
  }

  return [...candidateIds].sort((a, b) => {
    const diff = (counts.get(a) ?? 0) - (counts.get(b) ?? 0);
    if (diff !== 0) return diff;
    return a < b ? -1 : a > b ? 1 : 0;
  })[0];
}

/**
 * Resolves which employee should be assigned to a new booking, without
 * the customer ever choosing one:
 *   1. Resolve the service; must exist and be active.
 *   2. Find active employees assigned to perform it.
 *   3. Of those, find which are actually free at the requested date/time
 *      (working hours, breaks, blocked dates, existing appointments).
 *   4. Among the free ones, pick the least-loaded for that date,
 *      tie-broken by employee id -- deterministic and scalable (bounded
 *      by the number of eligible employees, not appointment volume).
 *
 * Throws NoEligibleEmployeeError if no active employee can perform the
 * service at all, or SlotUnavailableError if qualified employees exist
 * but none is free at that specific date/time (e.g. a race with another
 * booking, or a stale client-side slot list).
 */
export async function assignEmployeeForBooking(
  businessId: string,
  dateISO: string,
  time: string,
  serviceSlug: string,
  excludeAppointmentId?: string
): Promise<{ employeeId: string; serviceId: string; serviceName: string; servicePrice: number; durationMin: number }> {
  const service = await resolveBookableService(businessId, serviceSlug);
  if (!service) {
    throw new NoEligibleEmployeeError("Η υπηρεσία δεν βρέθηκε.");
  }

  const employees = await getEligibleEmployees(businessId, service.id);
  if (employees.length === 0) {
    throw new NoEligibleEmployeeError(
      "Δεν υπάρχει διαθέσιμος υπάλληλος για αυτή την υπηρεσία αυτή τη στιγμή."
    );
  }

  const normalizedTime = time.slice(0, 5);

  const freeSlotsByEmployee = await Promise.all(
    employees.map((e) =>
      getEmployeeFreeSlots(businessId, e.id, dateISO, service.duration_min, excludeAppointmentId)
    )
  );

  const candidateIds = employees
    .filter((_, i) => freeSlotsByEmployee[i].includes(normalizedTime))
    .map((e) => e.id);

  if (candidateIds.length === 0) {
    throw new SlotUnavailableError(
      "Η συγκεκριμένη ώρα δεν είναι πλέον διαθέσιμη. Επιλέξτε άλλη ώρα."
    );
  }

  const employeeId = await pickLeastLoadedEmployee(businessId, dateISO, candidateIds);

  return { employeeId, serviceId: service.id, serviceName: service.name, servicePrice: service.price, durationMin: service.duration_min };
}
