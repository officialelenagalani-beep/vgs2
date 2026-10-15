/**
 * Booking Analytics -- Phase 4 / Step 10.
 *
 * Pure read-side types. Nothing here is persisted -- every value is
 * derived, on demand, from the existing `appointments` table (see
 * services/analytics.ts). No new database table backs this feature.
 *
 * Status vocabulary is deliberately the same one already established by
 * `AppointmentStatus` (types/appointments.ts): "confirmed" | "completed" |
 * "cancelled" | "no_show". The DB's own `chk_appointment_status` CHECK
 * constraint additionally allows a "pending" value, but a repository-wide
 * search confirmed no code path in this project ever writes or reads
 * "pending" -- it is dead status space carried over from the original
 * schema design and intentionally excluded from `AppointmentStatus` itself.
 * Analytics follows that same, already-established convention rather than
 * inventing a fifth bucket the rest of the app doesn't recognize.
 */

/**
 * A resolved, concrete date range. Always `from <= to`, both inclusive,
 * both `YYYY-MM-DD` (matches `appointments.appointment_date`'s own
 * format). This is what every analytics query actually runs against --
 * the *preset* (below) is only ever a UI-layer convenience that resolves
 * to one of these before reaching the server.
 */
export interface AnalyticsDateRange {
  from: string;
  to: string;
}

/**
 * Predefined period shortcuts the admin can pick from (Step 10, section
 * 3.J). "custom" means the admin supplied `from`/`to` directly -- the
 * preset itself carries no date math at this layer, that lives in the
 * client component that resolves a preset into a concrete
 * `AnalyticsDateRange` using the browser's local "today" (the same
 * pattern `AdminDashboard.tsx` already uses for its own today/upcoming
 * filters, kept consistent rather than introducing server-side timezone
 * conversion for a single-business, single-timezone deployment).
 */
export type AnalyticsRangePreset =
  | "today"
  | "last7"
  | "last30"
  | "thisMonth"
  | "previousMonth"
  | "custom";

export interface AnalyticsRangePresetOption {
  id: AnalyticsRangePreset;
  labelEl: string;
}

/** Raw booking counts for a period, by status. */
export interface BookingTotals {
  total: number;
  confirmed: number;
  completed: number;
  cancelled: number;
  no_show: number;
}

/**
 * Cancellation / no-show ratios (Step 10, section 3.I). Expressed as a
 * 0-100 number rounded to one decimal, not a 0-1 fraction, so UI code
 * never has to remember to multiply by 100. Both are computed against
 * `total` (every non-deleted booking in the period, matching the same
 * denominator the KPI cards show) and are `0` -- never `NaN`/`Infinity`
 * -- when `total` is `0`.
 */
export interface BookingRates {
  cancellationRate: number;
  noShowRate: number;
}

/** One point of the booking-trend series. `bucketStart` is `YYYY-MM-DD`. */
export interface BookingTrendPoint {
  bucketStart: string;
  count: number;
  /** Estimated revenue of the bucket's COMPLETED appointments. */
  revenue: number;
}

/**
 * The time granularity a trend series was grouped by. Chosen server-side
 * from the resolved range length (see `resolveTrendGranularity` in
 * services/analytics.ts) so a 7-day view isn't a flat, useless
 * one-bucket-per-month line and a 1-year view isn't 365 illegible bars.
 */
export type TrendGranularity = "day" | "week" | "month";

export interface ServicePerformanceRow {
  serviceName: string;
  /** Every booking of the service in the period, any status. */
  count: number;
  completed: number;
  /** Estimated revenue: sum of the snapshotted price of COMPLETED appointments. */
  revenue: number;
  /** revenue / completed; 0 when nothing was completed. */
  averagePrice: number;
  /** This service's share of the period's revenue, 0-100, one decimal. */
  revenueShare: number;
}

export interface EmployeePerformanceRow {
  employeeId: string | null;
  employeeName: string;
  /** Every booking assigned to the employee in the period, any status. */
  count: number;
  completed: number;
  cancelled: number;
  noShow: number;
  /** Estimated revenue of the employee's COMPLETED appointments. */
  revenue: number;
  /** revenue / completed; 0 when nothing was completed. */
  averageTicket: number;
  /** completed / (completed + no-show), 0-100: of the customers who were due, how many were served. */
  completionRate: number;
  /** no-show / count, 0-100. */
  noShowRate: number;
  /** Minutes spent serving: sum of the durations of COMPLETED appointments. */
  servedMinutes: number;
  /** This employee's share of the period's revenue, 0-100. */
  revenueShare: number;
}

/**
 * The same metrics for the period of equal length immediately before the
 * selected one, so the page can say "+12% compared to before".
 */
export interface PeriodComparison {
  previousRange: AnalyticsDateRange;
  previousRevenue: number;
  previousCompleted: number;
  /** % change of revenue; null when the previous period had no revenue (no meaningful %). */
  revenueChange: number | null;
}

/**
 * Estimated revenue for the period, derived from `appointments.service_price`
 * (snapshotted at booking time -- see `001_initial_schema.sql`'s own
 * comment on that column). Deliberately labeled "estimated": this business
 * has no payment system (customers pay in person, per the schema's own
 * documentation), so this is the sum of what was *agreed* at booking time
 * for completed appointments, not a verified collected-payment total.
 */
export interface EstimatedRevenue {
  completedTotal: number;
  currency: string;
}

export interface BookingAnalytics {
  range: AnalyticsDateRange;
  granularity: TrendGranularity;
  totals: BookingTotals;
  rates: BookingRates;
  trend: BookingTrendPoint[];
  services: ServicePerformanceRow[];
  employees: EmployeePerformanceRow[];
  revenue: EstimatedRevenue;
  /** Null when the previous period could not be read (the rest of the page is still valid). */
  comparison: PeriodComparison | null;
}
