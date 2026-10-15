import type { Appointment, AppointmentSource } from "@/types/appointments";

/**
 * Recurring appointments -- Phase 3 / Step 8.
 *
 * Only 'weekly' is implemented by this step. Stored/typed as a union
 * (rather than assumed) so a future step can add more frequencies without
 * changing this type's shape, only widening the union and the DB CHECK
 * constraint (011_recurring_appointments.sql) alongside it.
 */
export type RecurrenceFrequency = "weekly";

/** Server-enforced bounds for recurrence parameters (see services/appointments.ts). */
export const RECURRENCE_INTERVAL_WEEKS_MIN = 1;
export const RECURRENCE_INTERVAL_WEEKS_MAX = 12;
export const RECURRENCE_OCCURRENCES_MIN = 2;
export const RECURRENCE_OCCURRENCES_MAX = 52;

/** Row shape of `recurring_appointment_series` (011_recurring_appointments.sql). */
export interface RecurringAppointmentSeries {
  id: string;
  business_id: string;
  employee_id: string | null;
  service_id: string | null;
  frequency: RecurrenceFrequency;
  interval_weeks: number;
  occurrences_count: number;
  start_date: string;
  created_at: string;
}

/**
 * Input for createRecurringAppointmentSeries(). Deliberately mirrors
 * CreateAppointmentInput (types/appointments.ts) field-for-field for
 * everything a single occurrence needs (customer info, service, employee,
 * notes), plus the recurrence rule itself. `appointment_date` /
 * `appointment_time` describe the FIRST occurrence; subsequent occurrences
 * are computed server-side from `interval_weeks` and never trusted from
 * the client (see services/appointments.ts).
 */
export interface CreateRecurringAppointmentSeriesInput {
  customer_name: string;
  customer_phone: string;
  customer_email?: string;
  service: string;
  service_name: string;
  service_price?: number;
  service_duration_min?: number;
  /** First occurrence's date. */
  appointment_date: string;
  /** Time shared by every occurrence. */
  appointment_time: string;
  /** Omit for auto-assign (validated/resolved independently per occurrence). */
  employee_id?: string;
  notes?: string;
  source?: AppointmentSource;
  /** "Every N weeks". */
  interval_weeks: number;
  /** How many appointments to generate. */
  occurrences_count: number;
}

export interface RecurringAppointmentSeriesResult {
  series: RecurringAppointmentSeries;
  appointments: Appointment[];
}

/**
 * Series-level cancellation results -- Phase 3 / Step 9
 * (cancelFutureRecurringAppointments / cancelRecurringAppointmentSeries,
 * services/appointments.ts).
 *
 * Both series-cancellation functions operate on multiple appointments at
 * once and must "clearly report failures" (per the step's requirements)
 * without letting one occurrence's problem abort the rest -- each
 * occurrence is processed independently through the existing Step 6
 * `updateAppointmentStatus()` state machine, and every occurrence ends up
 * in exactly one of the two lists below:
 *
 *   - `cancelled`: occurrences that were confirmed and are now cancelled
 *     (each went through updateAppointmentStatus(), so it was validated
 *     and notified exactly like any single cancellation).
 *   - `skipped`: occurrences intentionally left untouched (already
 *     cancelled -- no duplicate cancellation; or completed/no_show --
 *     historical records are never overwritten by a series action) OR an
 *     occurrence the status workflow itself rejected (reported with its
 *     actual error message, never silently dropped).
 */
export interface RecurringSeriesCancelSkip {
  id: string;
  recurrence_index: number | null;
  reason: string;
}

export interface RecurringSeriesCancelResult {
  cancelled: Appointment[];
  skipped: RecurringSeriesCancelSkip[];
}
