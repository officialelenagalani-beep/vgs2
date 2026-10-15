export type AppointmentStatus = "confirmed" | "cancelled" | "completed" | "no_show";
export type AppointmentSource = "website" | "admin" | "ai_agent";

/**
 * Shared Greek display labels for each status. Single source of truth --
 * used by StatusBadge (UI) AND services/appointments.ts (server-side error
 * messages), so the wording an admin sees in a status pill matches exactly
 * what they see in a workflow validation error. Phase 3 / Step 6.
 */
export const STATUS_LABELS_EL: Record<AppointmentStatus, string> = {
  confirmed: "Επιβεβαιωμένο",
  completed: "Ολοκληρωμένο",
  cancelled: "Ακυρωμένο",
  no_show:   "Δεν εμφανίστηκε",
};

/**
 * Appointment status workflow -- Phase 3 / Step 6.
 *
 * Defines which status transitions are legal, application-wide. This is
 * the single source of truth for the state machine: it's imported by
 * services/appointments.ts (server-side enforcement, authoritative) AND by
 * admin components (client-side, to decide which quick-action buttons to
 * show/hide -- purely a UX nicety, never the actual authority).
 *
 * Design:
 *   confirmed -> completed | cancelled | no_show   (normal lifecycle)
 *   completed -> confirmed                          (undo / correction)
 *   cancelled -> confirmed                          (reactivate)
 *   no_show   -> confirmed                          (undo / correction)
 *
 * A terminal status (completed/cancelled/no_show) can only go back to
 * "confirmed" -- it cannot jump directly to a different terminal status
 * (e.g. cancelled -> completed is rejected; the admin must reactivate to
 * confirmed first, then complete it from there). This keeps the state
 * machine small and every transition auditable/explainable, and it means
 * "confirmed" is always the single gateway back into the active lifecycle.
 *
 * Same-status "transitions" (e.g. confirmed -> confirmed) are always a
 * no-op and are handled by the caller (updateAppointmentStatus), not by
 * this map.
 */
export const STATUS_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  confirmed: ["completed", "cancelled", "no_show"],
  completed: ["confirmed"],
  cancelled: ["confirmed"],
  no_show:   ["confirmed"],
};

/** True if `from -> to` is a legal transition (or a same-status no-op). */
export function isStatusTransitionAllowed(from: AppointmentStatus, to: AppointmentStatus): boolean {
  if (from === to) return true;
  return STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Minimal employee info joined onto an appointment for display purposes
 * (admin table / calendar). Added in Phase 3 / Step 2. Optional because
 * older call sites / mocks may not populate it, and employee_id can be
 * null (unassigned appointment).
 */
export interface AppointmentEmployee {
  id: string;
  name: string;
  slug: string;
  color: string | null;
}

export interface Appointment {
  id: string;
  business_id: string;
  employee_id: string | null;
  /** Joined employee row (Phase 3 / Step 2). Null when employee_id is null. */
  employee?: AppointmentEmployee | null;
  /**
   * FK to services.id (001_initial_schema.sql). Nullable: a service can be
   * deleted after being booked (ON DELETE SET NULL), in which case the
   * service_name/service_price/service_duration_min snapshot columns are
   * still authoritative for display. Declared here (Phase 3 / Step 5) so
   * TypeScript call sites can read the column that already comes back from
   * every `select("*", ...)` in services/appointments.ts -- used to check
   * employee_services eligibility when reassigning an appointment to a
   * different employee.
   */
  service_id: string | null;
  /**
   * Phase 4 / Step 24 -- FK to customers.id (nullable, ON DELETE SET NULL,
   * see 020_appointments_customer_id.sql). NULL for every appointment
   * created before this step, and for any booking whose submitted phone
   * could not be normalized to a valid identity (see
   * services/customers.ts's findOrCreateCustomer() -- an unusable phone
   * never blocks the booking, it just leaves this column NULL).
   * customer_name/customer_phone/customer_email below remain the
   * authoritative, never-rewritten snapshot of what was submitted for
   * THIS appointment -- this column is a separate link to the CURRENT
   * customer profile, not a replacement for the snapshot fields.
   */
  customer_id: string | null;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  service: string;
  service_name: string;
  service_price: number;
  /** Migration 041: money taken off service_price by a discount code (0 when none). Pays: service_price - discount_amount. */
  discount_amount?: number | null;
  /** The code used, as stored (upper-case), or null. */
  discount_code?: string | null;
  discount_code_id?: string | null;
  service_duration_min: number;
  appointment_date: string;
  appointment_time: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  notes: string | null;
  deleted_at: string | null;
  confirmation_sent_at: string | null;
  reminder_sent_at: string | null;
  /**
   * Recurring appointments (Phase 3 / Step 8, 011_recurring_appointments.sql).
   * NULL for a normal, non-recurring appointment -- the default, and the
   * value for every appointment created before this step. When set, this
   * row is one generated occurrence of a recurring series
   * (recurring_appointment_series.id); recurrence_index is its 1-based
   * position within that series (also NULL exactly when recurrence_id is
   * NULL -- see appointments.chk_recurrence_pair).
   */
  recurrence_id: string | null;
  recurrence_index: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAppointmentInput {
  customer_name: string;
  customer_phone: string;
  customer_email?: string;
  service: string;
  // Phase 4 / Step 17 (services-catalog cutover): name/price/duration are
  // now resolved server-side from the DB `services` table
  // (resolveBookableService(), services/employee-availability.ts) and are
  // never read from these fields by createAppointment() /
  // createRecurringAppointmentSeries() any more -- a caller may still send
  // them (kept optional for backward API compatibility with any existing
  // integration), but they are silently ignored. `service` (the slug) is
  // the only field that actually determines what gets booked.
  service_name?: string;
  service_price?: number;
  service_duration_min?: number;
  appointment_date: string;
  appointment_time: string;
  employee_id?: string;
  notes?: string;
  source?: AppointmentSource;
  /** Discount code typed by the customer (migration 041). Checked and priced by the database. */
  discount_code?: string;
  /**
   * Migration 048: the customer ticked "offers & news" on the booking form.
   * Only `true` (with an e-mail address) records consent; anything else
   * changes nothing.
   */
  marketing_opt_in?: boolean;
}

export interface UpdateAppointmentInput {
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  service?: string;
  service_name?: string;
  service_price?: number;
  service_duration_min?: number;
  appointment_date?: string;
  appointment_time?: string;
  employee_id?: string | null;
  status?: AppointmentStatus;
  notes?: string;
}

export interface ApiResponse<T = void> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface AvailabilityResponse {
  date: string;
  business_id: string;
  employee_id: string | null;
  /**
   * The resolved DB services.id for the `service` slug passed to
   * getAvailability(), or null when no `service` was requested (legacy
   * business-wide mode -- see services/appointments.ts) or when the slug
   * didn't resolve to an active service row. Added in Phase 3 / Step 1.
   */
  service_id: string | null;
  all_slots: string[];
  booked_slots: string[];
  available_slots: string[];
}
