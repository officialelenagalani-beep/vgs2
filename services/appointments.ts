import { createServerClient } from "@/lib/supabase/server";
// DiscountCodeError is re-exported for callers that already import from here.
export { DiscountCodeError } from "@/lib/discounts";
import { DiscountCodeError, discountRefusalFromError, normalizeDiscountCode } from "@/lib/discounts";
import { getSlotsForDate } from "@/lib/schedule";
import {
  getServiceAvailability,
  assignEmployeeForBooking,
  getFreeSlotsForReschedule,
  getEligibleEmployees,
  resolveBookableService,
} from "@/services/employee-availability";
import { findOrCreateCustomer, recordBookingMarketingConsent } from "@/services/customers";
import { todayInTimeZone, addDaysISO } from "@/lib/booking-rules";
import { STATUS_LABELS_EL, isStatusTransitionAllowed } from "@/types/appointments";
import type { Appointment, AppointmentStatus, CreateAppointmentInput, UpdateAppointmentInput, AvailabilityResponse } from "@/types/appointments";
import {
  RECURRENCE_INTERVAL_WEEKS_MIN,
  RECURRENCE_INTERVAL_WEEKS_MAX,
  RECURRENCE_OCCURRENCES_MIN,
  RECURRENCE_OCCURRENCES_MAX,
} from "@/types/recurring-appointments";
import type {
  CreateRecurringAppointmentSeriesInput,
  RecurringAppointmentSeries,
  RecurringAppointmentSeriesResult,
  RecurringSeriesCancelResult,
} from "@/types/recurring-appointments";
import {
  notifyAppointmentConfirmed,
  notifyAppointmentCancelled,
  notifyAppointmentRescheduled,
} from "@/services/notifications";
import {
  awardEarnedPointsForCompletedAppointment,
  reverseEarnedPoints,
} from "@/services/loyalty";


// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

function parseDate(dateISO: string): Date {
  return new Date(`${dateISO}T00:00:00`);
}

/**
 * Phase 4 / Step 23 -- narrow detection of the specific DB-level race-
 * condition backstop (uix_appointments_slot, 003_indexes.sql) tripping on
 * an insert. Two concurrent requests can both pass the app-level
 * isSlotTaken() pre-check (a genuine TOCTOU race) and both reach the
 * INSERT below; the unique index is what actually prevents the second one
 * from succeeding -- this function exists only to recognize THAT specific,
 * already-correctly-rejected case so createAppointment() can surface the
 * same friendly "slot no longer available" message (and, via each route's
 * existing message.includes(...) check, the same 409 status) it already
 * returns for the pre-check case, instead of a generic 500.
 *
 * Deliberately checks BOTH the Postgres unique-violation SQLSTATE (23505)
 * AND that the error text names uix_appointments_slot specifically --
 * matching on the code alone would risk misclassifying some other,
 * unrelated unique-constraint violation (e.g. a future constraint) as a
 * slot conflict. Does not relax, remove, or otherwise touch the
 * constraint itself -- purely reclassifies an error already produced by
 * it.
 */
function isSlotUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; message?: string; details?: string };
  if (e.code !== "23505") return false;
  const text = `${e.message ?? ""} ${e.details ?? ""}`;
  return text.includes("uix_appointments_slot");
}

/**
 * Migration 030 -- the second DB-level backstop, for OVERLAPPING
 * appointments rather than identical start times:
 * excl_appointments_employee_overlap rejects any active appointment whose
 * [start, start + duration) range overlaps another active appointment of
 * the same employee. Postgres reports that as SQLSTATE 23P01
 * (exclusion_violation), a different code from the unique-violation above.
 *
 * Same narrow matching as isSlotUniqueViolation() and for the same reason:
 * the code AND the constraint name must both match, so an unrelated
 * exclusion constraint (employee breaks, blocked dates) is never
 * misreported as a booking conflict.
 */
function isSlotOverlapViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; message?: string; details?: string };
  if (e.code !== "23P01") return false;
  const text = `${e.message ?? ""} ${e.details ?? ""}`;
  return text.includes("excl_appointments_employee_overlap");
}

/** True when the database refused a write because the time is already taken -- same start time (003) or an overlapping range (030). */
function isSlotConflictViolation(error: unknown): boolean {
  return isSlotUniqueViolation(error) || isSlotOverlapViolation(error);
}

// ---------------------------------------------------------------------------
// Service resolution
// ---------------------------------------------------------------------------
//
// Phase 4 / Step 16 (services-catalog cutover): service id/name/price/
// duration are now resolved exclusively via resolveBookableService()
// (services/employee-availability.ts), which reads the per-business DB
// `services` table. Previously this file had its own separate, lighter
// resolveServiceId() (id-only) used by the explicit-employee branch below,
// while price/duration/name fell back to lib/services.ts's static,
// single-tenant catalog -- removed; resolveBookableService() is now the
// single source of truth for all four fields, for both branches.

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export async function getAvailability(
  businessId: string,
  dateISO: string,
  options: { excludeId?: string; employeeId?: string; service?: string } = {}
): Promise<AvailabilityResponse> {
  // Phase 3 / Step 1: when a `service` is given, delegate to the real
  // employee-aware availability engine (working hours, breaks, blocked
  // dates, and existing appointments of employees actually assigned to
  // perform that service -- see services/employee-availability.ts).
  //
  // When no `service` is given, fall through to the legacy business-wide
  // logic below unchanged, for backward compatibility with callers that
  // don't (yet) select a service before checking availability (e.g. the
  // admin "new appointment" modal). This preserves all previous-phase
  // behavior exactly as it was.
  if (options.service) {
    return getServiceAvailability(businessId, dateISO, options.service, {
      excludeId: options.excludeId,
      employeeId: options.employeeId,
    });
  }

  const date = parseDate(dateISO);
  const allSlots = getSlotsForDate(date);

  const baseMeta: AvailabilityResponse = {
    date: dateISO,
    business_id: businessId,
    employee_id: options.employeeId ?? null,
    service_id: null,
    all_slots: allSlots,
    booked_slots: [],
    available_slots: allSlots,
  };

  if (allSlots.length === 0) {
    return { ...baseMeta, all_slots: [], available_slots: [] };
  }

  let query = db()
    .from("appointments")
    .select("appointment_time")
    .eq("business_id", businessId)
    .eq("appointment_date", dateISO)
    // Phase 4 / Step 15: match uix_appointments_slot (003_indexes.sql) and
    // the employee-aware engine (employee-availability.ts), both of which
    // block on 'confirmed' AND 'pending' -- this legacy fallback path
    // previously only blocked 'confirmed', which was inconsistent (though
    // harmless today, since nothing in this codebase currently creates a
    // 'pending' appointment).
    .in("status", ["confirmed", "pending"])
    .is("deleted_at", null);

  if (options.employeeId) query = query.eq("employee_id", options.employeeId);
  if (options.excludeId)  query = query.neq("id", options.excludeId);

  const { data, error } = await query;

  if (error) {
    console.error("[appointments] getAvailability error:", JSON.stringify(error));
    return baseMeta;
  }

  const bookedSlots = ((data ?? []) as { appointment_time: string }[]).map(
    (r) => r.appointment_time.slice(0, 5)
  );
  const availableSlots = allSlots.filter((s) => !bookedSlots.includes(s));

  return { ...baseMeta, booked_slots: bookedSlots, available_slots: availableSlots };
}

export async function isSlotTaken(
  businessId: string,
  dateISO: string,
  time: string,
  options: { excludeId?: string; employeeId?: string } = {}
): Promise<boolean> {
  const normalizedTime = time.slice(0, 5);

  let query = db()
    .from("appointments")
    .select("id")
    .eq("business_id", businessId)
    .eq("appointment_date", dateISO)
    .eq("appointment_time", normalizedTime)
    // Phase 4 / Step 15: see the matching comment in getAvailability()
    // above -- block on 'pending' too, matching the DB unique index.
    .in("status", ["confirmed", "pending"])
    .is("deleted_at", null)
    .limit(1);

  if (options.employeeId) query = query.eq("employee_id", options.employeeId);
  if (options.excludeId)  query = query.neq("id", options.excludeId);

  const { data } = await query;
  return (data ?? []).length > 0;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createAppointment(
  businessId: string,
  input: CreateAppointmentInput
): Promise<Appointment> {
  const normalizedTime = input.appointment_time.slice(0, 5);

  // Phase 4 / Step 16 (services-catalog cutover): id/name/price/duration
  // are resolved once, up front, exclusively from the DB `services` table
  // for this business, via resolveBookableService() -- never from
  // lib/services.ts's static, single-tenant catalog, and never trusted
  // verbatim from the client. An unknown, inactive, or cross-tenant
  // `service` slug is rejected outright here, rather than (as before this
  // change) silently falling back to a 0-price / 30-minute-duration
  // appointment with a client-supplied name.
  const bookableService = await resolveBookableService(businessId, input.service);
  if (!bookableService) {
    throw new Error("Η υπηρεσία δεν βρέθηκε.");
  }
  const resolvedServiceId   = bookableService.id;
  const resolvedServiceName = bookableService.name;
  const resolvedPrice       = bookableService.price;

  // Phase 3 / Step 1: the public booking flow never lets the customer pick
  // an employee, so `employee_id` is normally omitted -- in that case,
  // automatically assign the best available, service-qualified employee
  // (deterministic: least-loaded that day, tied-broken by employee id --
  // see assignEmployeeForBooking). assignEmployeeForBooking() already runs
  // every check below (eligibility, working hours/breaks/blocked dates,
  // duration-aware overlap) via the real availability engine.
  //
  // Phase 4 / Step 15: callers that pass employee_id explicitly (admin's
  // "New Appointment" modal with a specific barber selected, or any
  // v1/AI-agent caller) previously skipped that entire engine and only
  // got a bare isSlotTaken() exact-time-collision check -- no working
  // hours, no breaks, no blocked dates, no duration-based overlap with a
  // differently-sized existing appointment, and no check that the
  // employee even exists / is active / belongs to this business / is
  // actually assigned to perform this service. This branch now validates
  // the employee (mirroring reassignAppointmentEmployee's own checks
  // below) and then re-uses the exact same getFreeSlotsForReschedule ->
  // get_available_slots() engine every other mutation path already relies
  // on, instead of a second, weaker, hand-rolled check.
  let employeeId = input.employee_id ?? null;
  let resolvedDuration: number;

  if (employeeId) {
    resolvedDuration = bookableService.duration_min;

    const { data: targetEmployee, error: employeeError } = await db()
      .from("employees")
      .select("id")
      .eq("id", employeeId)
      .eq("business_id", businessId) // tenant guard
      .eq("is_active", true)
      .maybeSingle();

    if (employeeError || !targetEmployee) {
      throw new Error("Ο υπάλληλος δεν βρέθηκε.");
    }

    const eligible = await getEligibleEmployees(businessId, resolvedServiceId);
    if (!eligible.some((e) => e.id === employeeId)) {
      throw new Error("Ο υπάλληλος δεν εκτελεί αυτή την υπηρεσία.");
    }

    const freeSlots = await getFreeSlotsForReschedule(
      businessId,
      employeeId,
      input.appointment_date,
      resolvedDuration
    );
    if (!freeSlots.includes(normalizedTime)) {
      throw new Error(
        `Ο υπάλληλος δεν είναι διαθέσιμος στις ${normalizedTime} (ωράριο, διαλείμματα ή μπλοκαρισμένη ημέρα, ή επικαλυπτόμενο ραντεβού).`
      );
    }
  } else {
    // assignEmployeeForBooking() performs its own resolveBookableService()
    // lookup internally (needed for its own duration-aware slot search);
    // assignment.serviceId/serviceName/servicePrice are the same values
    // already resolved above by construction (same businessId + slug), so
    // they're not re-read here -- only durationMin is taken from it, since
    // it's the one value this branch doesn't already have another source
    // for at this point.
    const assignment = await assignEmployeeForBooking(
      businessId,
      input.appointment_date,
      normalizedTime,
      input.service
    );
    employeeId = assignment.employeeId;
    resolvedDuration = assignment.durationMin;
  }

  // Final race-condition safety net immediately before insert (same role
  // the DB's uix_appointments_slot unique index plays as the ultimate
  // backstop) -- kept in addition to the engine check above, not instead
  // of it.
  const taken = await isSlotTaken(businessId, input.appointment_date, normalizedTime, {
    employeeId: employeeId ?? undefined,
  });
  if (taken) {
    throw new Error("Η συγκεκριμένη ώρα δεν είναι πλέον διαθέσιμη. Επιλέξτε άλλη ώρα.");
  }

  // Phase 4 / Step 24: resolve (or create) the customer profile this
  // booking belongs to, via the ONE shared resolver every booking path
  // (public website, admin "New Appointment", and any future AI-agent/
  // API caller that also ends up calling createAppointment()) converges
  // on -- see services/customers.ts's own doc comment for the full rule
  // set. This never blocks the booking: an unusable phone simply resolves
  // to `null` here, and the appointment is still created normally with
  // customer_id left NULL and its own customer_name/phone/email snapshot
  // fields stored exactly as submitted, unchanged from before this step.
  const customer = await findOrCreateCustomer(businessId, {
    name: input.customer_name,
    phone: input.customer_phone,
    email: input.customer_email,
  });

  const { data, error } = await db()
    .from("appointments")
    .insert({
      business_id:          businessId,
      employee_id:          employeeId,
      service_id:           resolvedServiceId,
      customer_id:          customer?.id ?? null,
      customer_name:        input.customer_name.trim(),
      customer_phone:       input.customer_phone.trim(),
      customer_email:       input.customer_email?.trim() ?? null,
      service_name:         resolvedServiceName,
      service_price:        resolvedPrice,
      service_duration_min: resolvedDuration,
      appointment_date:     input.appointment_date,
      appointment_time:     normalizedTime,
      status:               "confirmed",
      source:               input.source ?? "website",
      notes:                input.notes?.trim() || null,
      // Migration 041: only the code is sent (and only when there is one);
      // the database checks it and works out discount_amount itself.
      ...(input.discount_code ? { discount_code: normalizeDiscountCode(input.discount_code) } : {}),
    })
    .select()
    .single();

  if (error) {
    const refusal = discountRefusalFromError((error as { message?: unknown }).message);
    if (refusal) throw new DiscountCodeError(refusal);
    console.error("[appointments] createAppointment error:", JSON.stringify(error));
    // Phase 4 / Step 23: a uix_appointments_slot unique-violation here means
    // a concurrent request won the same race isSlotTaken() just checked for
    // above -- the insert was correctly rejected by the DB, so this is not
    // a generic failure. Reuse the exact same friendly message the
    // app-level pre-check already throws, so every caller's existing
    // `message.includes("πλέον διαθέσιμη") ? 409 : 500` classification
    // (app/api/v1/businesses/[slug]/appointments/route.ts,
    // app/api/v1/appointments/[id]/route.ts) now also returns 409 for this
    // case, instead of 500.
    // Migration 030: the same applies to excl_appointments_employee_overlap
    // (an overlapping, not identical, appointment won the race).
    if (isSlotConflictViolation(error)) {
      throw new Error("Η συγκεκριμένη ώρα δεν είναι πλέον διαθέσιμη. Επιλέξτε άλλη ώρα.");
    }
    throw new Error("Σφάλμα κατά την αποθήκευση. Δοκιμάστε ξανά.");
  }

  const created = data as Appointment;

  // Phase 3 / Step 7: fire the confirmation notification only after the
  // insert above has actually succeeded. notifyAppointmentConfirmed() is
  // guaranteed to never throw (see services/notifications.ts), but it's
  // still wrapped here so a failure can NEVER surface as a failure of
  // appointment creation itself -- the appointment is already saved and
  // must be returned to the caller regardless of what happens next.
  try {
    await notifyAppointmentConfirmed(businessId, created);
  } catch (notifyErr) {
    console.error("[appointments] notifyAppointmentConfirmed error:", notifyErr);
  }

  // Migration 048: "offers & news" ticked on the booking form. Never blocks
  // or fails the booking (recordBookingMarketingConsent never throws).
  if (input.marketing_opt_in === true && customer?.id && input.customer_email?.trim()) {
    await recordBookingMarketingConsent(businessId, customer.id, input.customer_email);
  }

  return created;
}

// ---------------------------------------------------------------------------
// Recurring appointments -- Phase 3 / Step 8
// ---------------------------------------------------------------------------

/**
 * Computes the ISO date (YYYY-MM-DD) of every occurrence in a weekly
 * recurring series: startDateISO, startDateISO + intervalWeeks weeks,
 * startDateISO + 2*intervalWeeks weeks, ... for `occurrencesCount` total
 * dates. Pure date arithmetic -- no DB access, no availability logic
 * (that's validated separately, per occurrence, in
 * createRecurringAppointmentSeries below). Uses the same parseDate()
 * helper as the rest of this file for consistent date handling.
 */
function computeRecurrenceDates(
  startDateISO: string,
  intervalWeeks: number,
  occurrencesCount: number
): string[] {
  // Pure calendar arithmetic on the ISO date (lib/booking-rules.ts). The
  // previous version built a local-midnight Date and read it back with
  // toISOString() (UTC), which returns the PREVIOUS day on any server whose
  // own timezone is ahead of UTC (e.g. TZ=Europe/Athens) -- every
  // occurrence of a series would then land one day early.
  const dates: string[] = [];
  for (let i = 0; i < occurrencesCount; i++) {
    dates.push(addDaysISO(startDateISO, i * intervalWeeks * 7));
  }
  return dates;
}

/**
 * Creates a recurring appointment series: one `recurring_appointment_series`
 * row (the recurrence rule) plus N normal `appointments` rows, one per
 * occurrence -- each a completely ordinary appointment, indistinguishable
 * from a one-time booking except for its recurrence_id/recurrence_index
 * (011_recurring_appointments.sql). Every occurrence goes through the
 * exact same employee-aware availability engine
 * (getFreeSlotsForReschedule / assignEmployeeForBooking ->
 * get_available_slots()) that createAppointment(), rescheduleAppointmentDate(),
 * reassignAppointmentEmployee(), and updateAppointmentStatus() already use
 * -- no availability logic is duplicated here.
 *
 * ATOMIC FAILURE BEHAVIOR (this step's core requirement): every occurrence
 * is validated BEFORE anything is written. If even one occurrence is
 * unavailable, this function throws a Greek error identifying exactly
 * which occurrence/date failed, and creates NOTHING -- no series row, no
 * appointment rows. Only once every occurrence has been validated does it
 * write the series row and then every appointment row in a single bulk
 * `.insert([...])` call, which Postgres executes as one SQL statement --
 * i.e. atomic at the database level too: if a race condition (another
 * booking taking a slot between validation and this insert) trips
 * uix_appointments_slot on even one generated row, the ENTIRE insert is
 * rolled back by Postgres itself, and the compensating cleanup below
 * removes the now-orphaned series row. There is no code path in this
 * function that can leave a partial series behind.
 *
 * EMPLOYEE HANDLING: if `input.employee_id` is given, that exact employee
 * is validated against every occurrence and used for every occurrence --
 * if they're unavailable for even one, the entire series is rejected (no
 * silent reassignment to a different employee, per this step's
 * requirement). If `input.employee_id` is omitted, each occurrence is
 * independently auto-assigned via assignEmployeeForBooking() (the same
 * function createAppointment() already uses for auto-assign), so
 * different occurrences may end up with different employees depending on
 * each date's real load/availability -- exactly how a normal auto-assigned
 * one-time booking already behaves, applied per occurrence.
 *
 * STATUS: every generated appointment is created with status "confirmed",
 * identical to a normal createAppointment() call -- no new status is
 * invented. Phase 3 / Step 6's status workflow is fully authoritative over
 * every generated row from the moment it's created.
 *
 * NOTIFICATIONS: one notifyAppointmentConfirmed() call per generated
 * appointment (Phase 3 / Step 7's existing abstraction -- this function
 * never inserts into notification_log directly), after the bulk insert
 * has succeeded, each independently try/catch-wrapped so a notification
 * failure can never affect the appointments already created. See the
 * Step 8 addition in services/notifications.ts's duplicate-window check
 * for why each occurrence still gets its own logged notification despite
 * all being created within the same request.
 */
export async function createRecurringAppointmentSeries(
  businessId: string,
  input: CreateRecurringAppointmentSeriesInput
): Promise<RecurringAppointmentSeriesResult> {
  // ---- Server-side validation of recurrence parameters. Never trust
  // ---- interval/occurrence counts from the client beyond what's typed --
  // ---- re-validate the actual bounds here regardless of what the UI sent.
  const intervalWeeks = Math.trunc(input.interval_weeks);
  const occurrencesCount = Math.trunc(input.occurrences_count);

  if (
    !Number.isFinite(intervalWeeks) ||
    intervalWeeks < RECURRENCE_INTERVAL_WEEKS_MIN ||
    intervalWeeks > RECURRENCE_INTERVAL_WEEKS_MAX
  ) {
    throw new Error(
      `Η επανάληψη πρέπει να είναι κάθε ${RECURRENCE_INTERVAL_WEEKS_MIN}-${RECURRENCE_INTERVAL_WEEKS_MAX} εβδομάδες.`
    );
  }
  if (
    !Number.isFinite(occurrencesCount) ||
    occurrencesCount < RECURRENCE_OCCURRENCES_MIN ||
    occurrencesCount > RECURRENCE_OCCURRENCES_MAX
  ) {
    throw new Error(
      `Ο αριθμός επαναλήψεων πρέπει να είναι μεταξύ ${RECURRENCE_OCCURRENCES_MIN} και ${RECURRENCE_OCCURRENCES_MAX}.`
    );
  }

  const normalizedTime = input.appointment_time.slice(0, 5);
  const today = todayInTimeZone(); // the business-local date (Europe/Athens), not the UTC date
  if (input.appointment_date < today) {
    throw new Error("Δεν μπορείτε να δημιουργήσετε επαναλαμβανόμενο ραντεβού σε παρελθοντική ημερομηνία.");
  }

  // ---- Resolve service (id/name/price/duration), same DB-backed
  // ---- resolution createAppointment() uses -- resolveBookableService()
  // ---- (services/employee-availability.ts) is the single source of
  // ---- truth for all four fields, per business; never lib/services.ts's
  // ---- static catalog, and never trusted verbatim from the client
  // ---- (Phase 4 / Step 16 services-catalog cutover).
  const bookable = await resolveBookableService(businessId, input.service);
  if (!bookable) {
    throw new Error("Η υπηρεσία δεν βρέθηκε.");
  }
  const resolvedServiceId   = bookable.id;
  const resolvedServiceName = bookable.name;
  const resolvedDuration    = bookable.duration_min;
  const resolvedPrice       = bookable.price;

  // ---- If a specific employee was requested, validate them up front:
  // ---- exists, active, belongs to this business (tenant guard), and is
  // ---- actually assigned to perform this service -- same checks
  // ---- reassignAppointmentEmployee() already makes, reused inline rather
  // ---- than duplicated as a separate helper (it's three short queries,
  // ---- not worth a new abstraction for a single caller).
  let fixedEmployeeId: string | null = null;
  if (input.employee_id) {
    const { data: targetEmployee, error: employeeError } = await db()
      .from("employees")
      .select("id")
      .eq("id", input.employee_id)
      .eq("business_id", businessId)
      .eq("is_active", true)
      .maybeSingle();

    if (employeeError || !targetEmployee) {
      throw new Error("Ο υπάλληλος δεν βρέθηκε.");
    }

    if (resolvedServiceId) {
      const eligible = await getEligibleEmployees(businessId, resolvedServiceId);
      if (!eligible.some((e) => e.id === input.employee_id)) {
        throw new Error("Ο υπάλληλος δεν εκτελεί αυτή την υπηρεσία.");
      }
    }

    fixedEmployeeId = input.employee_id;
  }

  const occurrenceDates = computeRecurrenceDates(input.appointment_date, intervalWeeks, occurrencesCount);

  // ---- Validate EVERY occurrence before writing anything. This is the
  // ---- atomic pre-check: the loop below never touches the database for
  // ---- writes, only reads (availability lookups) -- the first occurrence
  // ---- that fails throws immediately and NOTHING has been created yet.
  const resolvedEmployeeByOccurrence: (string | null)[] = [];
  for (let i = 0; i < occurrenceDates.length; i++) {
    const dateISO = occurrenceDates[i];
    const occurrenceNumber = i + 1;

    if (fixedEmployeeId) {
      const freeSlots = await getFreeSlotsForReschedule(
        businessId,
        fixedEmployeeId,
        dateISO,
        resolvedDuration
      );
      if (!freeSlots.includes(normalizedTime)) {
        throw new Error(
          `Δεν είναι δυνατή η δημιουργία της σειράς ραντεβού: η εμφάνιση #${occurrenceNumber} ` +
          `(${dateISO} στις ${normalizedTime}) δεν είναι διαθέσιμη για τον επιλεγμένο υπάλληλο ` +
          `(ωράριο, διαλείμματα ή μπλοκαρισμένη ημέρα). Δεν δημιουργήθηκε κανένα ραντεβού από τη σειρά.`
        );
      }
      resolvedEmployeeByOccurrence.push(fixedEmployeeId);
    } else {
      try {
        const assignment = await assignEmployeeForBooking(businessId, dateISO, normalizedTime, input.service);
        resolvedEmployeeByOccurrence.push(assignment.employeeId);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Η ώρα δεν είναι διαθέσιμη.";
        throw new Error(
          `Δεν είναι δυνατή η δημιουργία της σειράς ραντεβού: η εμφάνιση #${occurrenceNumber} ` +
          `(${dateISO} στις ${normalizedTime}) δεν είναι διαθέσιμη -- ${reason} ` +
          `Δεν δημιουργήθηκε κανένα ραντεβού από τη σειρά.`
        );
      }
    }
  }

  // ---- Every occurrence validated. Create the series metadata row first.
  const { data: seriesRow, error: seriesError } = await db()
    .from("recurring_appointment_series")
    .insert({
      business_id: businessId,
      employee_id: fixedEmployeeId,
      service_id: resolvedServiceId,
      frequency: "weekly",
      interval_weeks: intervalWeeks,
      occurrences_count: occurrencesCount,
      start_date: input.appointment_date,
    })
    .select()
    .single();

  if (seriesError || !seriesRow) {
    console.error("[appointments] createRecurringAppointmentSeries series insert error:", JSON.stringify(seriesError));
    throw new Error("Σφάλμα κατά τη δημιουργία της σειράς ραντεβού. Δοκιμάστε ξανά.");
  }

  // ---- Insert every occurrence in a SINGLE bulk insert -- one SQL
  // ---- statement, atomic: if any row violates uix_appointments_slot
  // ---- (e.g. a race since the validation loop above), Postgres rolls
  // ---- back the entire statement and zero appointment rows are created.
  //
  // Customer link: resolved ONCE for the whole series, the same way
  // createAppointment() does for a single booking. Until now recurring
  // appointments were written with customer_id NULL, so a regular
  // customer's standing appointments never appeared in their history and
  // never earned loyalty points. As in createAppointment(), resolving the
  // customer must never block the booking itself -- any failure simply
  // leaves customer_id NULL.
  let seriesCustomerId: string | null = null;
  try {
    const customer = await findOrCreateCustomer(businessId, {
      name: input.customer_name,
      phone: input.customer_phone,
      email: input.customer_email,
    });
    seriesCustomerId = customer?.id ?? null;
  } catch (customerErr) {
    console.error("[appointments] createRecurringAppointmentSeries customer resolution error:", customerErr);
  }

  const rows = occurrenceDates.map((dateISO, i) => ({
    business_id: businessId,
    employee_id: resolvedEmployeeByOccurrence[i],
    service_id: resolvedServiceId,
    customer_id: seriesCustomerId,
    customer_name: input.customer_name.trim(),
    customer_phone: input.customer_phone.trim(),
    customer_email: input.customer_email?.trim() ?? null,
    service_name: resolvedServiceName,
    service_price: resolvedPrice,
    service_duration_min: resolvedDuration,
    appointment_date: dateISO,
    appointment_time: normalizedTime,
    status: "confirmed",
    source: input.source ?? "admin",
    notes: input.notes?.trim() || null,
    recurrence_id: seriesRow.id,
    recurrence_index: i + 1,
  }));

  const { data: createdRows, error: insertError } = await db()
    .from("appointments")
    .insert(rows)
    .select();

  if (insertError || !createdRows) {
    console.error("[appointments] createRecurringAppointmentSeries bulk insert error:", JSON.stringify(insertError));
    // Compensating cleanup: the series row must never be left orphaned,
    // referencing zero appointments (see this function's doc comment --
    // "no code path can leave a partial series behind").
    const { error: cleanupError } = await db()
      .from("recurring_appointment_series")
      .delete()
      .eq("id", seriesRow.id);
    if (cleanupError) {
      console.error(
        "[appointments] createRecurringAppointmentSeries cleanup error (orphaned series row):",
        JSON.stringify(cleanupError)
      );
    }
    throw new Error(
      "Μία ή περισσότερες εμφανίσεις έγιναν μη διαθέσιμες τη στιγμή της δημιουργίας " +
      "(πιθανό ταυτόχρονο ραντεβού). Δεν δημιουργήθηκε καμία εμφάνιση από τη σειρά. Δοκιμάστε ξανά."
    );
  }

  const createdAppointments = createdRows as Appointment[];

  // ---- Notify once per generated appointment, via the existing Step 7
  // ---- abstraction only -- never a direct notification_log insert.
  // ---- Never allowed to affect this function's return value.
  for (const appt of createdAppointments) {
    try {
      // One customer e-mail for the whole series (the first occurrence),
      // not one per occurrence -- a 52-week series must not send 52 e-mails.
      await notifyAppointmentConfirmed(businessId, appt, { skipEmail: appt !== createdAppointments[0] });
    } catch (notifyErr) {
      console.error("[appointments] notifyAppointmentConfirmed (recurring) error:", notifyErr);
    }
  }

  return { series: seriesRow as RecurringAppointmentSeries, appointments: createdAppointments };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// Phase 3 / Step 2: every read of appointments below embeds the assigned
// employee's display info (name/slug/color) via PostgREST's embedded-resource
// select, using the existing appointments.employee_id -> employees.id FK
// (001_initial_schema.sql). Aliased to `employee` (singular) to match the
// `AppointmentEmployee | null` field added to the Appointment type. No new
// query round-trip and no migration needed -- the FK already exists.
const APPOINTMENT_SELECT = "*, employee:employees(id, name, slug, color)";

export async function getAppointmentById(businessId: string, id: string): Promise<Appointment | null> {
  const { data, error } = await db()
    .from("appointments").select(APPOINTMENT_SELECT)
    .eq("business_id", businessId).eq("id", id).is("deleted_at", null).single();
  if (error || !data) return null;
  return data as Appointment;
}

export async function getAppointmentsByDate(businessId: string, dateISO: string): Promise<Appointment[]> {
  const { data, error } = await db()
    .from("appointments").select(APPOINTMENT_SELECT)
    .eq("business_id", businessId).eq("appointment_date", dateISO).is("deleted_at", null)
    .order("appointment_time", { ascending: true });
  if (error) { console.error("[appointments] getAppointmentsByDate:", JSON.stringify(error)); return []; }
  return (data ?? []) as Appointment[];
}

export async function getAppointmentsRange(businessId: string, fromISO: string, toISO: string): Promise<Appointment[]> {
  const { data, error } = await db()
    .from("appointments").select(APPOINTMENT_SELECT)
    .eq("business_id", businessId).gte("appointment_date", fromISO).lte("appointment_date", toISO)
    .is("deleted_at", null).order("appointment_date", { ascending: true }).order("appointment_time", { ascending: true });
  if (error) { console.error("[appointments] getAppointmentsRange:", JSON.stringify(error)); return []; }
  return (data ?? []) as Appointment[];
}

export async function getAllAppointments(businessId: string): Promise<Appointment[]> {
  const { data, error } = await db()
    .from("appointments").select(APPOINTMENT_SELECT)
    .eq("business_id", businessId).is("deleted_at", null)
    .order("appointment_date", { ascending: false }).order("appointment_time", { ascending: true });
  if (error) { console.error("[appointments] getAllAppointments:", JSON.stringify(error)); return []; }
  return (data ?? []) as Appointment[];
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

// Phase 4 / Step 15: the raw, unvalidated field writer. Issues the actual
// UPDATE and nothing else -- no status-machine validation, no availability
// check. Never exported: the only two callers are updateAppointment() below
// (after it has validated whatever the caller asked for) and
// updateAppointmentStatus() further down (which does its own,
// state-machine-specific validation first). Every external caller must go
// through one of those two validated entry points, never straight to the
// database.
async function writeAppointmentFields(
  businessId: string,
  id: string,
  fields: UpdateAppointmentInput
): Promise<Appointment> {
  const { data, error } = await db()
    .from("appointments").update(fields)
    .eq("business_id", businessId).eq("id", id).is("deleted_at", null)
    .select().single();

  if (error) {
    console.error("[appointments] writeAppointmentFields error:", JSON.stringify(error));
    // Migration 030: an update can collide too -- moving an appointment,
    // reassigning it, lengthening it, or reactivating a cancelled one while
    // another booking has taken (part of) its time in the meantime. The
    // callers above already check availability first, so reaching this
    // point means a concurrent request won the race; the DB rejected the
    // write correctly. Same wording as updateAppointment()'s own
    // availability check, so callers' existing `includes("διαθέσιμη")`
    // -> 409 classification keeps working.
    if (isSlotConflictViolation(error)) {
      throw new Error("Η συγκεκριμένη ώρα δεν είναι διαθέσιμη. Επιλέξτε άλλη ώρα.");
    }
    throw new Error("Σφάλμα κατά την ενημέρωση. Δοκιμάστε ξανά.");
  }

  return data as Appointment;
}

/**
 * The complete list of appointment columns a caller of updateAppointment()
 * may change. Everything else on the row is either owned by the server
 * (business_id, customer_id, service_id, source, created_at, deleted_at,
 * recurrence_*), changed only through its own dedicated function (status
 * -> updateAppointmentStatus(), deleted_at -> deleteAppointment()), or not
 * exposed for editing at all (internal_notes, *_sent_at).
 *
 * `service` and `status` are deliberately absent: `service` is a
 * client-side lookup key, not a column, and `status` is routed through
 * updateAppointmentStatus() by updateAppointment() itself.
 */
const UPDATABLE_APPOINTMENT_FIELDS = [
  "customer_name",
  "customer_phone",
  "customer_email",
  "service_name",
  "service_price",
  "service_duration_min",
  "appointment_date",
  "appointment_time",
  "employee_id",
  "notes",
] as const satisfies ReadonlyArray<keyof UpdateAppointmentInput>;

/**
 * Copies only UPDATABLE_APPOINTMENT_FIELDS out of an untrusted input
 * object. A key whose value is `undefined` is treated as "not sent"
 * (matching how it would be dropped when serialized to the database
 * anyway); `null` is kept, because `employee_id: null` is a real
 * instruction -- "unassign".
 */
function pickUpdatableAppointmentFields(input: UpdateAppointmentInput): UpdateAppointmentInput {
  const source = (input ?? {}) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of UPDATABLE_APPOINTMENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined) {
      picked[field] = source[field];
    }
  }
  return picked as UpdateAppointmentInput;
}

export async function updateAppointment(
  businessId: string,
  id: string,
  input: UpdateAppointmentInput
): Promise<Appointment> {
  // `service` is a client-side-only field used to look up the local service
  // catalog (see NewAppointmentModal / EditAppointmentModal). It is not a
  // column on the appointments table and must never be sent to Supabase.
  //
  // Phase 4 / Step 15: `status` is pulled out separately and, when present,
  // is handled exclusively through updateAppointmentStatus() -- the single
  // authoritative entry point for status changes (legal-transition check,
  // the "can't complete/no-show a future appointment" date rule, and the
  // reactivation slot re-check). Previously this function wrote `status`
  // straight to the row like any other field, so any caller of this
  // generic update path -- not just the admin UI, which happens to always
  // go through updateAppointmentStatusAction separately -- could set an
  // appointment to any status and bypass every rule the workflow is
  // supposed to enforce.
  //
  // Tenant-safety fix: ONLY the fields listed in
  // UPDATABLE_APPOINTMENT_FIELDS are ever copied out of `input`. This
  // function is reached from a server action and from two API routes, so
  // `input` is whatever JSON the caller sent -- its TypeScript type is not
  // enforced at runtime. The previous `...rest` spread forwarded every
  // extra property straight into the UPDATE, which let a caller set
  // columns this function was never meant to touch (business_id,
  // customer_id, service_id, deleted_at, internal_notes, source,
  // recurrence_id ...) -- including moving an appointment into another
  // business. See pickUpdatableAppointmentFields() above.
  const status = input.status;
  const picked = pickUpdatableAppointmentFields(input);
  const normalizedInput: UpdateAppointmentInput = {
    ...picked,
    ...(typeof picked.appointment_time === "string" && picked.appointment_time
      ? { appointment_time: picked.appointment_time.slice(0, 5) }
      : {}),
  };

  let result: Appointment | undefined;

  if (status !== undefined) {
    result = await updateAppointmentStatus(businessId, id, status);
    if (Object.keys(normalizedInput).length === 0) {
      return result;
    }
  }

  // Phase 4 / Step 15: when the date, time, or employee is actually
  // changing, re-validate against the same employee-aware availability
  // engine (working hours, breaks, blocked dates, duration-based overlap)
  // that rescheduleAppointmentDate() and reassignAppointmentEmployee()
  // already use for the drag-and-drop paths -- instead of the previous
  // isSlotTaken() check, which only caught an exact appointment_time
  // collision and ignored everything else. The admin UI's own client-side
  // slot fetch already prevents a well-behaved save from hitting this, but
  // there was previously no server-side defense at all for a race, or for
  // any other caller of this shared function (e.g. a direct API request).
  //
  // Only runs when something is actually moving (mirrors the same
  // no-op-on-unchanged-value convention rescheduleAppointmentDate/
  // reassignAppointmentEmployee already follow) -- so re-saving a form
  // with the same date/time/employee (the common case: editing an
  // unrelated field like the customer's name) never re-validates an
  // already-existing, already-valid booking against rules that may have
  // changed since it was made (e.g. a since-added blocked date).
  if (normalizedInput.appointment_date || normalizedInput.appointment_time || "employee_id" in normalizedInput) {
    const current = result ?? (await getAppointmentById(businessId, id));
    if (!current) {
      throw new Error("Το ραντεβού δεν βρέθηκε.");
    }

    const currentTime = current.appointment_time.slice(0, 5);
    const effectiveDate = normalizedInput.appointment_date ?? current.appointment_date;
    const effectiveTime = normalizedInput.appointment_time ?? currentTime;
    const effectiveEmployee = "employee_id" in normalizedInput ? (normalizedInput.employee_id ?? null) : current.employee_id;
    const effectiveDuration = normalizedInput.service_duration_min ?? current.service_duration_min;

    const somethingActuallyMoved =
      effectiveDate !== current.appointment_date ||
      effectiveTime !== currentTime ||
      effectiveEmployee !== current.employee_id;

    // Phase 4 / Step 16: tenant guard. This generic update path is the one
    // place in this file that could previously accept a new employee_id
    // without ever checking it belongs to this business -- createAppointment's
    // explicit-employee branch and reassignAppointmentEmployee() both already
    // had this check (see their own "// tenant guard" comments); this path
    // did not, and only happened to be safe because a single-tenant
    // deployment has no "other business" to attack. getFreeSlotsForReschedule
    // -> get_available_slots() also now rejects a cross-tenant employee_id at
    // the database level (013_business_members_and_tenant_integrity.sql) --
    // this check exists in addition to that, so the rejection is a clean,
    // expected application error rather than a raw DB exception surfacing to
    // the caller.
    if (
      "employee_id" in normalizedInput &&
      normalizedInput.employee_id &&
      normalizedInput.employee_id !== current.employee_id
    ) {
      const { data: targetEmployee, error: employeeError } = await db()
        .from("employees")
        .select("id")
        .eq("id", normalizedInput.employee_id)
        .eq("business_id", businessId) // tenant guard
        .eq("is_active", true)
        .maybeSingle();

      if (employeeError || !targetEmployee) {
        throw new Error("Ο υπάλληλος δεν βρέθηκε.");
      }
    }

    if (somethingActuallyMoved) {
      const freeSlots = await getFreeSlotsForReschedule(
        businessId,
        effectiveEmployee,
        effectiveDate,
        effectiveDuration,
        id
      );
      if (!freeSlots.includes(effectiveTime)) {
        throw new Error("Η συγκεκριμένη ώρα δεν είναι διαθέσιμη. Επιλέξτε άλλη ώρα.");
      }
    }
  }

  return writeAppointmentFields(businessId, id, normalizedInput);
}

// Phase 3 / Step 6: cancellation now goes through the same validated
// status-workflow function as every other status change (see
// updateAppointmentStatus below), instead of force-writing "cancelled"
// unconditionally. This is a deliberate tightening: previously this
// function would silently overwrite ANY appointment's status to
// "cancelled" regardless of its current state (e.g. a completed
// appointment could be "cancelled" after the fact with no guard at all).
// Same-status calls (cancelling an already-cancelled appointment) remain
// a harmless no-op, exactly as before -- see updateAppointmentStatus's
// own no-op guard.
export async function cancelAppointment(businessId: string, id: string): Promise<Appointment> {
  return updateAppointmentStatus(businessId, id, "cancelled");
}

// ---------------------------------------------------------------------------
// Reschedule (drag-and-drop) -- Phase 3 / Step 4
// ---------------------------------------------------------------------------

/**
 * Moves a confirmed appointment to a new date, keeping its existing time
 * and assigned employee, for the Admin Calendar's drag-and-drop reschedule.
 *
 * Validates the target date/time against the same employee-aware
 * availability engine used by the public booking flow and the reschedule
 * modal (get_available_slots(), via getFreeSlotsForReschedule) -- so
 * working hours, recurring breaks, blocked dates, appointment-duration
 * overlap, and the assigned employee are all respected. If the appointment
 * has no assigned employee, availability falls back to business-wide hours
 * (employeeId = null), the same behavior get_available_slots() already
 * defines for that case elsewhere in the app.
 *
 * Throws with a Greek error message (never touches the row) if:
 *   - the appointment doesn't exist,
 *   - it isn't currently confirmed (only confirmed appointments are shown
 *     as draggable on the calendar in the first place),
 *   - the target date is in the past,
 *   - or the appointment's existing time isn't free on the target date.
 */
export async function rescheduleAppointmentDate(
  businessId: string,
  id: string,
  newDateISO: string
): Promise<Appointment> {
  const appointment = await getAppointmentById(businessId, id);
  if (!appointment) {
    throw new Error("Το ραντεβού δεν βρέθηκε.");
  }
  if (appointment.status !== "confirmed") {
    throw new Error("Μόνο επιβεβαιωμένα ραντεβού μπορούν να μετακινηθούν.");
  }

  const today = todayInTimeZone(); // the business-local date (Europe/Athens), not the UTC date
  if (newDateISO < today) {
    throw new Error("Δεν μπορείτε να μετακινήσετε ραντεβού σε παρελθοντική ημερομηνία.");
  }

  if (newDateISO === appointment.appointment_date) {
    return appointment;
  }

  const time = appointment.appointment_time.slice(0, 5);
  const freeSlots = await getFreeSlotsForReschedule(
    businessId,
    appointment.employee_id,
    newDateISO,
    appointment.service_duration_min,
    id
  );

  if (!freeSlots.includes(time)) {
    throw new Error(
      `Η ώρα ${time} δεν είναι διαθέσιμη στη νέα ημερομηνία. Ελέγξτε το ωράριο, τα διαλείμματα και τυχόν μπλοκαρισμένες ημέρες.`
    );
  }

  const previousDateISO = appointment.appointment_date;
  const rescheduled = await updateAppointment(businessId, id, { appointment_date: newDateISO });

  // Phase 3 / Step 7: notify only after the date change above has actually
  // been written. Never allowed to affect this function's return value --
  // see notifyAppointmentRescheduled()'s guarantee in
  // services/notifications.ts.
  try {
    await notifyAppointmentRescheduled(businessId, rescheduled, previousDateISO);
  } catch (notifyErr) {
    console.error("[appointments] notifyAppointmentRescheduled error:", notifyErr);
  }

  return rescheduled;
}

// ---------------------------------------------------------------------------
// Employee reassignment (drag-and-drop) -- Phase 3 / Step 5
// ---------------------------------------------------------------------------

/**
 * Moves a confirmed appointment to a different employee, keeping its
 * existing date and time, for the Admin Calendar's drag-and-drop employee
 * reassignment.
 *
 * Validates the target employee against the exact same employee-aware
 * availability engine used by rescheduleAppointmentDate() above and the
 * public booking flow (getFreeSlotsForReschedule -> get_available_slots())
 * -- so the new employee's working hours, recurring breaks, blocked dates,
 * and existing appointment-duration overlap are all respected. It also
 * confirms the target employee is actually assigned (employee_services,
 * Phase 2 / Step 5) to perform the appointment's service, reusing
 * getEligibleEmployees() from services/employee-availability.ts rather than
 * re-implementing that check here.
 *
 * Throws with a Greek error message (never touches the row) if:
 *   - the appointment doesn't exist,
 *   - it isn't currently confirmed (only confirmed appointments are shown
 *     as draggable on the calendar in the first place),
 *   - the target employee doesn't exist, is inactive, or belongs to a
 *     different business (tenant guard),
 *   - the target employee isn't assigned to perform the appointment's
 *     service (skipped only when the appointment's service was deleted
 *     after booking -- service_id is then null, same "nothing to check
 *     against" behavior createAppointment/resolveServiceId already have
 *     for that case),
 *   - or the appointment's existing date/time isn't free for the target
 *     employee once reassigned.
 *
 * Passing `newEmployeeId = null` unassigns the appointment -- validated
 * against business-wide hours, the same fallback
 * rescheduleAppointmentDate() and get_available_slots() already define for
 * unassigned appointments. Dropping onto the appointment's own current
 * employee (including staying unassigned) is a no-op.
 */
export async function reassignAppointmentEmployee(
  businessId: string,
  id: string,
  newEmployeeId: string | null
): Promise<Appointment> {
  const appointment = await getAppointmentById(businessId, id);
  if (!appointment) {
    throw new Error("Το ραντεβού δεν βρέθηκε.");
  }
  if (appointment.status !== "confirmed") {
    throw new Error("Μόνο επιβεβαιωμένα ραντεβού μπορούν να μεταφερθούν σε άλλον υπάλληλο.");
  }

  if (newEmployeeId === appointment.employee_id) {
    return appointment;
  }

  if (newEmployeeId) {
    const { data: targetEmployee, error: employeeError } = await db()
      .from("employees")
      .select("id")
      .eq("id", newEmployeeId)
      .eq("business_id", businessId) // tenant guard
      .eq("is_active", true)
      .maybeSingle();

    if (employeeError || !targetEmployee) {
      throw new Error("Ο υπάλληλος δεν βρέθηκε.");
    }

    // appointments.service_id can be null (the service was deleted after
    // booking -- see its ON DELETE SET NULL comment in
    // 001_initial_schema.sql). When it's null there is nothing to check
    // assigned-services eligibility against, matching the same permissive
    // behavior the rest of this file already has for that case.
    if (appointment.service_id) {
      const eligible = await getEligibleEmployees(businessId, appointment.service_id);
      if (!eligible.some((e) => e.id === newEmployeeId)) {
        throw new Error("Ο υπάλληλος δεν εκτελεί αυτή την υπηρεσία.");
      }
    }
  }

  const time = appointment.appointment_time.slice(0, 5);
  const freeSlots = await getFreeSlotsForReschedule(
    businessId,
    newEmployeeId,
    appointment.appointment_date,
    appointment.service_duration_min,
    id
  );

  if (!freeSlots.includes(time)) {
    throw new Error(
      `Ο υπάλληλος δεν είναι διαθέσιμος στις ${time} (ωράριο, διαλείμματα ή μπλοκαρισμένη ημέρα). Επιλέξτε άλλον υπάλληλο ή ώρα.`
    );
  }

  // Phase 3 / Step 7 note: reassignment deliberately does NOT trigger a
  // notification. It changes date/time/name/price nothing -- only which
  // employee performs an already-confirmed service at an already-confirmed
  // time -- and notification_log's `type` CHECK constraint
  // (001_initial_schema.sql) has no "employee changed" value among
  // 'confirmation' | 'reminder' | 'cancellation' | 'rescheduled' | 'custom'.
  // Forcing this into 'custom' would invent a notification-worthy event
  // this step's core requirements don't call for (confirmation,
  // cancellation, rescheduling, and status-change notifications). Left as
  // a candidate for a future step if the business wants customers told
  // when their barber changes.
  return updateAppointment(businessId, id, { employee_id: newEmployeeId });
}

// ---------------------------------------------------------------------------
// Status workflow -- Phase 3 / Step 6
// ---------------------------------------------------------------------------

/**
 * Validated status transition for an appointment. This is the single,
 * authoritative entry point for every status change in the admin app --
 * the quick-action buttons in AppointmentsTable, EditAppointmentModal's
 * status dropdown, and cancelAppointment() (above) all funnel through this
 * function rather than writing `status` directly, so the workflow rules
 * below are enforced no matter which UI path triggered the change.
 *
 * Rules enforced (see STATUS_TRANSITIONS, types/appointments.ts, for the
 * full state machine and its rationale):
 *
 *   1. The transition itself must be legal (e.g. "cancelled" can only go
 *      back to "confirmed" -- it cannot jump directly to "completed").
 *      Same-status calls are always a no-op: no validation, no write.
 *
 *   2. "completed" and "no_show" can only be set for an appointment whose
 *      date is today or in the past -- an appointment that hasn't
 *      happened yet cannot be marked as done or as a no-show.
 *
 *   3. Reactivating a terminal appointment back to "confirmed" re-checks
 *      that its original date/time/employee slot is STILL free, using the
 *      exact same employee-aware availability engine as
 *      rescheduleAppointmentDate/reassignAppointmentEmployee
 *      (getFreeSlotsForReschedule -> get_available_slots()). This matters
 *      because the DB's uniqueness guard (uix_appointments_slot,
 *      003_indexes.sql) only blocks 'confirmed'/'pending' rows -- while
 *      this appointment was cancelled/completed/no_show, another
 *      appointment may have been booked into that exact slot in the
 *      meantime. Reactivating without this check could silently create a
 *      double-booking (or, at best, fail with an opaque DB error instead
 *      of a clear one).
 *
 * Throws a Greek error (and writes nothing) if the appointment doesn't
 * exist, the transition is illegal, the date rule is violated, or (for
 * reactivation) the original slot is no longer free.
 */
export async function updateAppointmentStatus(
  businessId: string,
  id: string,
  newStatus: AppointmentStatus
): Promise<Appointment> {
  const appointment = await getAppointmentById(businessId, id);
  if (!appointment) {
    throw new Error("Το ραντεβού δεν βρέθηκε.");
  }

  // Same status requested -- idempotent no-op, matches the pattern already
  // established by rescheduleAppointmentDate/reassignAppointmentEmployee
  // for their own "nothing actually changed" cases.
  if (newStatus === appointment.status) {
    return appointment;
  }

  if (!isStatusTransitionAllowed(appointment.status, newStatus)) {
    throw new Error(
      `Δεν είναι δυνατή η μετάβαση από "${STATUS_LABELS_EL[appointment.status]}" σε ` +
      `"${STATUS_LABELS_EL[newStatus]}". Μεταβείτε πρώτα σε "${STATUS_LABELS_EL.confirmed}".`
    );
  }

  const today = todayInTimeZone(); // the business-local date (Europe/Athens), not the UTC date
  if ((newStatus === "completed" || newStatus === "no_show") && appointment.appointment_date > today) {
    throw new Error(
      newStatus === "completed"
        ? "Δεν μπορείτε να σημειώσετε ως ολοκληρωμένο ένα ραντεβού που δεν έχει γίνει ακόμα."
        : "Δεν μπορείτε να σημειώσετε ως \"δεν εμφανίστηκε\" ένα ραντεβού που δεν έχει γίνει ακόμα."
    );
  }

  if (newStatus === "confirmed") {
    const time = appointment.appointment_time.slice(0, 5);
    const freeSlots = await getFreeSlotsForReschedule(
      businessId,
      appointment.employee_id,
      appointment.appointment_date,
      appointment.service_duration_min,
      id
    );
    if (!freeSlots.includes(time)) {
      throw new Error(
        `Η ώρα ${time} στις ${appointment.appointment_date} δεν είναι πλέον διαθέσιμη -- ` +
        `έχει κλειστεί άλλο ραντεβού στο μεταξύ. Μετακινήστε πρώτα το ραντεβού σε άλλη ` +
        `ημερομηνία/ώρα ή υπάλληλο.`
      );
    }
  }

  // Phase 4 / Step 15: writes directly via the raw field writer, not the
  // public updateAppointment() -- this function IS the validation
  // updateAppointment() delegates to for status changes; calling back into
  // updateAppointment() here would recurse.
  const updated = await writeAppointmentFields(businessId, id, { status: newStatus });

  // Phase 3 / Step 7: notify only after the status write above has
  // actually succeeded, and only for the transitions that are genuinely
  // customer-facing:
  //
  //   - -> cancelled   : customer needs to know their slot is gone.
  //   - -> confirmed   : only reachable here as a *reactivation* (the
  //                      same-status no-op above already returned early,
  //                      and STATUS_TRANSITIONS only allows terminal ->
  //                      confirmed) -- i.e. an appointment that was
  //                      cancelled/completed/no_show is active again, so
  //                      it's re-confirmed to the customer the same way a
  //                      brand new booking is.
  //   - -> completed / no_show : deliberately NOT notified. These are
  //                      internal, after-the-fact record-keeping states
  //                      about something that has already happened --
  //                      there is nothing actionable to tell the customer,
  //                      and notification_log's `type` values don't
  //                      include one for either. Sending an SMS telling
  //                      someone their haircut (that they were just
  //                      physically present for) is "completed" has no
  //                      customer value.
  //
  // Never allowed to affect this function's return value -- see the
  // relevant notifyAppointment*() guarantee in services/notifications.ts.
  try {
    if (newStatus === "cancelled") {
      await notifyAppointmentCancelled(businessId, updated);
    } else if (newStatus === "confirmed") {
      await notifyAppointmentConfirmed(businessId, updated);
    }
  } catch (notifyErr) {
    console.error("[appointments] status-change notification error:", notifyErr);
  }

  // Phase 4 / Step 25 -- Loyalty: award/reverse points as a side effect of
  // this same authoritative status transition -- the only place loyalty
  // hooks into the appointment state machine (rule: "do NOT create a
  // second appointment status mechanism"). Same non-blocking convention
  // as the notification side effect immediately above: a loyalty failure
  // must never roll back or block an otherwise-valid status change.
  //
  //   - Entering "completed"  -> attempt to award points. A safe no-op if
  //     loyalty isn't configured/enabled, the service excludes earning,
  //     the computed amount is 0, or the appointment has no linked
  //     customer_id -- see awardEarnedPointsForCompletedAppointment()
  //     (services/loyalty.ts) for each of those cases.
  //   - Leaving "completed"   -> reverse whichever earn transaction is
  //     currently active for this appointment, if any. Written as "the
  //     status we're leaving WAS completed" (appointment.status, captured
  //     before this write, holds the pre-transition status) rather than
  //     "the new status is specifically confirmed" -- STATUS_TRANSITIONS
  //     only actually allows completed -> confirmed today, but this stays
  //     correct without changes if that ever expands to a direct
  //     completed -> cancelled/no_show transition.
  try {
    if (newStatus === "completed") {
      await awardEarnedPointsForCompletedAppointment(businessId, updated);
    } else if (appointment.status === "completed") {
      await reverseEarnedPoints(businessId, id);
    }
  } catch (loyaltyErr) {
    console.error("[appointments] status-change loyalty error:", loyaltyErr);
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Soft Delete
// ---------------------------------------------------------------------------

export async function deleteAppointment(businessId: string, id: string): Promise<void> {
  const { error } = await db()
    .from("appointments").update({ deleted_at: new Date().toISOString() })
    .eq("business_id", businessId).eq("id", id);

  if (error) {
    console.error("[appointments] deleteAppointment error:", JSON.stringify(error));
    throw new Error("Σφάλμα κατά τη διαγραφή. Δοκιμάστε ξανά.");
  }
}

// ---------------------------------------------------------------------------
// Recurring series management -- Phase 3 / Step 9
//
// Step 8 (011_recurring_appointments.sql, createRecurringAppointmentSeries
// above) built the recurrence foundation but deliberately implemented no
// series-level management. Every function below is read/write ONLY through
// the existing `appointments` table + `recurring_appointment_series` FK --
// no second appointment system, no duplicated availability/status/
// notification logic. Series-level "cancel" reuses updateAppointmentStatus()
// (Step 6) per occurrence, exactly like every other individual cancellation
// in this file -- so the same legal-transition checks and the same
// notifyAppointmentCancelled() (Step 7) call happen for each one.
// ---------------------------------------------------------------------------

/**
 * Retrieves a recurring series and every occurrence linked to it, scoped to
 * `businessId` on BOTH the series row and its appointments (tenant
 * isolation -- an admin can never inspect or act on a recurrence_id that
 * belongs to a different business, even if they somehow obtained its UUID).
 * `businessId` must always come from the server-side requireBusinessId() (session -> business_members, see lib/business-context.ts)
 * mechanism (see app/admin/actions.ts) -- this function trusts whatever
 * caller passes it, so it is never safe to forward a client-supplied
 * business_id here.
 *
 * Returns null when the series doesn't exist for this business (also used
 * by the two cancellation functions below to reject a foreign/unknown
 * recurrence_id up front, before touching any appointment row).
 */
export async function getRecurringAppointmentSeries(
  businessId: string,
  recurrenceId: string
): Promise<RecurringAppointmentSeriesResult | null> {
  const { data: seriesRow, error: seriesError } = await db()
    .from("recurring_appointment_series")
    .select("*")
    .eq("id", recurrenceId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (seriesError) {
    console.error("[appointments] getRecurringAppointmentSeries series lookup error:", JSON.stringify(seriesError));
    return null;
  }
  if (!seriesRow) {
    return null;
  }

  const { data: apptRows, error: apptError } = await db()
    .from("appointments")
    .select(APPOINTMENT_SELECT)
    .eq("business_id", businessId)
    .eq("recurrence_id", recurrenceId)
    .is("deleted_at", null)
    .order("recurrence_index", { ascending: true });

  if (apptError) {
    console.error("[appointments] getRecurringAppointmentSeries appointments lookup error:", JSON.stringify(apptError));
    return null;
  }

  return {
    series: seriesRow as RecurringAppointmentSeries,
    appointments: (apptRows ?? []) as Appointment[],
  };
}

/**
 * Cancels a batch of appointments belonging to the same series, one at a
 * time, through the existing Step 6 status workflow -- never a direct
 * status write. Shared by cancelFutureRecurringAppointments() and
 * cancelRecurringAppointmentSeries() below so both series-level operations
 * report failures identically.
 *
 * Classification (per occurrence), so a series action never touches an
 * appointment it shouldn't:
 *   - already "cancelled"       -> skipped, not re-cancelled (no duplicate
 *                                  cancellation / no duplicate notification).
 *   - "completed" / "no_show"   -> skipped, historical record left exactly
 *                                  as-is (STATUS_TRANSITIONS wouldn't allow
 *                                  a direct jump to "cancelled" from either
 *                                  anyway -- classified explicitly here so
 *                                  it's reported as an expected skip, not a
 *                                  workflow "error").
 *   - "confirmed"                -> cancelled via updateAppointmentStatus(),
 *                                  same validation + notification path as
 *                                  any single cancellation. If that call
 *                                  throws for any reason, this occurrence is
 *                                  recorded as skipped with the real error
 *                                  message -- it never aborts the rest of
 *                                  the batch.
 */
async function cancelAppointmentsBatch(
  businessId: string,
  appointments: Appointment[]
): Promise<RecurringSeriesCancelResult> {
  const cancelled: Appointment[] = [];
  const skipped: RecurringSeriesCancelResult["skipped"] = [];

  for (const appt of appointments) {
    if (appt.status === "cancelled") {
      skipped.push({ id: appt.id, recurrence_index: appt.recurrence_index, reason: "Ήδη ακυρωμένο." });
      continue;
    }
    if (appt.status === "completed" || appt.status === "no_show") {
      skipped.push({
        id: appt.id,
        recurrence_index: appt.recurrence_index,
        reason: `Δεν ακυρώνεται -- είναι ήδη "${STATUS_LABELS_EL[appt.status]}".`,
      });
      continue;
    }

    try {
      const updated = await updateAppointmentStatus(businessId, appt.id, "cancelled");
      cancelled.push(updated);
    } catch (err) {
      skipped.push({
        id: appt.id,
        recurrence_index: appt.recurrence_index,
        reason: err instanceof Error ? err.message : "Άγνωστο σφάλμα κατά την ακύρωση.",
      });
    }
  }

  return { cancelled, skipped };
}

/**
 * Cancels every occurrence of `recurrenceId` with recurrence_index >=
 * `fromRecurrenceIndex` (inclusive of the selected occurrence itself --
 * matches the admin UI's "from this appointment and onward" framing).
 * Occurrences from OTHER series, and occurrences of this series before
 * `fromRecurrenceIndex`, are never touched (they aren't even fetched --
 * getRecurringAppointmentSeries() only returns this series' own rows).
 *
 * Throws only when the series itself can't be found for this business
 * (unknown or foreign recurrence_id); once past that check, every
 * individual occurrence failure is reported in the returned `skipped`
 * list instead of throwing, so one bad occurrence never blocks the rest.
 */
export async function cancelFutureRecurringAppointments(
  businessId: string,
  recurrenceId: string,
  fromRecurrenceIndex: number
): Promise<RecurringSeriesCancelResult> {
  const seriesResult = await getRecurringAppointmentSeries(businessId, recurrenceId);
  if (!seriesResult) {
    throw new Error("Η σειρά ραντεβού δεν βρέθηκε.");
  }

  const targets = seriesResult.appointments.filter(
    (a) => a.recurrence_index !== null && a.recurrence_index >= fromRecurrenceIndex
  );

  return cancelAppointmentsBatch(businessId, targets);
}

/**
 * Cancels every legally-cancellable occurrence of the entire series
 * `recurrenceId` (i.e. every occurrence currently "confirmed"; already-
 * cancelled and completed/no_show occurrences are left untouched -- see
 * cancelAppointmentsBatch()). The `recurring_appointment_series` row itself
 * is intentionally NOT deleted -- it remains for auditing and any future
 * series-level display, exactly like every appointment it produced is
 * soft-cancelled rather than hard-deleted.
 *
 * Throws only when the series itself can't be found for this business.
 */
export async function cancelRecurringAppointmentSeries(
  businessId: string,
  recurrenceId: string
): Promise<RecurringSeriesCancelResult> {
  const seriesResult = await getRecurringAppointmentSeries(businessId, recurrenceId);
  if (!seriesResult) {
    throw new Error("Η σειρά ραντεβού δεν βρέθηκε.");
  }

  return cancelAppointmentsBatch(businessId, seriesResult.appointments);
}
