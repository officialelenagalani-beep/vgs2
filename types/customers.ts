/**
 * Phase 4 / Step 24 -- Client / Customer Management.
 *
 * `customers` is a new, business-scoped entity, deliberately separate
 * from appointments.customer_name/customer_phone/customer_email, which
 * remain untouched historical snapshots (see services/appointments.ts's
 * own comments on service_name/service_price/service_duration_min for
 * the precedent this follows). A `Customer` row is the CURRENT profile;
 * an `Appointment`'s snapshot fields are what was true about that person
 * AT THE TIME of that specific booking, and the two are never
 * synchronized in either direction by anything in this step.
 */

export interface Customer {
  id: string;
  business_id: string;
  name: string;
  phone: string | null;
  normalized_phone: string | null;
  email: string | null;
  normalized_email: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** Accepts SMS about appointments (migration 049). Absent on older rows = true. */
  sms_notifications?: boolean;
}

/**
 * Input for findOrCreateCustomer() (the shared booking-flow resolver) and
 * for manual admin creation. `phone`/`email` are optional and may be
 * empty/unusable -- normalization and the "no usable phone -> no
 * automatic customer" rule (Step 24 decision #3) live in
 * services/customers.ts, not in this type.
 */
export interface FindOrCreateCustomerInput {
  name: string;
  phone?: string | null;
  email?: string | null;
}

/**
 * Manual admin "create customer" input. Deliberately a separate type from
 * FindOrCreateCustomerInput even though the shape overlaps today -- the
 * two operations have different rules (manual creation may create a
 * customer with no usable phone at all; the booking-flow resolver never
 * does, per decision #3), and keeping them distinct means a future change
 * to one doesn't silently change the other. Mirrors this codebase's own
 * stated preference for separate functions over shared ones across
 * different concerns (see lib/auth/roles.ts's canManageInvitations() vs.
 * canManageRoles() doc comment).
 */
export interface CreateCustomerInput {
  name: string;
  phone?: string | null;
  email?: string | null;
}

export interface UpdateCustomerInput {
  name?: string;
  phone?: string | null;
  email?: string | null;
}

/**
 * Row shape for the admin customers list (getCustomersForAdmin) --
 * total_appointments/last_appointment_at/next_appointment_at are computed
 * live via a join/aggregate against appointments, per Step 24 decision #7
 * (no denormalized counters on the customers table itself).
 */
export interface CustomerListItem extends Customer {
  total_appointments: number;
  last_appointment_at: string | null;
  next_appointment_at: string | null;
}
