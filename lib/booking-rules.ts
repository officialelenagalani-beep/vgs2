/**
 * Booking date/time rules shared by every public booking entry point.
 *
 * Pure functions only -- no database, no Next.js, no environment access --
 * so they can be unit-tested directly and reused by routes, services and
 * (if ever needed) the browser.
 *
 * Why this file exists: the routes used to decide "is this date in the
 * past?" with `new Date().toISOString().slice(0, 10)`, which is the date in
 * UTC. A business in Athens is two or three hours ahead of UTC, so for the
 * first hours after local midnight the server still believed it was
 * "yesterday". The routes also only checked the SHAPE of the date and time
 * ("2026-02-31" and "29:75" both passed) and never looked at the time of
 * day, so a slot earlier today could still be booked.
 */

/** Used when a business row has no (or an unusable) timezone. Matches the column default in 001_initial_schema.sql. */
export const DEFAULT_BUSINESS_TIMEZONE = "Europe/Athens";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for a real calendar day in YYYY-MM-DD form. "2026-02-30" and "2026-13-01" are false. */
export function isRealISODate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** True for a real 24-hour clock time in HH:MM form. "24:00" and "12:60" are false. */
export function isRealTime(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

/** The current calendar date and clock time in a given IANA timezone. */
export function zonedNow(timeZone?: string | null, now: Date = new Date()): { date: string; time: string } {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timeZone || DEFAULT_BUSINESS_TIMEZONE);
  } catch {
    // An unknown timezone string must never take booking down.
    parts = format(DEFAULT_BUSINESS_TIMEZONE);
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/**
 * The moment at which a wall-clock date and time in `timeZone` happens --
 * e.g. ("2026-10-09", "17:30", "Europe/Athens") -> 2026-10-09T14:30:00Z.
 * Correct across daylight-saving changes. The only ambiguous inputs are
 * the clock times inside the hour that is skipped (spring) or repeated
 * (autumn) -- around 03:00-04:00 at night in Europe -- for which one of the
 * two possible moments is returned.
 */
export function zonedDateTimeToInstant(dateISO: string, time: string, timeZone?: string | null): Date {
  const [y, m, d] = dateISO.split("-").map(Number);
  const [hh, mm] = time.slice(0, 5).split(":").map(Number);
  const wallAsUTC = Date.UTC(y, m - 1, d, hh, mm);

  // Offset (ms) of the zone at a given instant: wall-clock-as-UTC minus the instant.
  const offsetAt = (instant: number): number => {
    const z = zonedNow(timeZone, new Date(instant));
    const [zy, zm, zd] = z.date.split("-").map(Number);
    const [zh, zmin] = z.time.split(":").map(Number);
    return Date.UTC(zy, zm - 1, zd, zh, zmin) - Math.floor(instant / 60_000) * 60_000;
  };

  // Two passes settle the offset on either side of a DST change.
  let instant = wallAsUTC - offsetAt(wallAsUTC);
  instant = wallAsUTC - offsetAt(instant);
  return new Date(instant);
}

/** Today's date (YYYY-MM-DD) as the business sees it. */
export function todayInTimeZone(timeZone?: string | null, now: Date = new Date()): string {
  return zonedNow(timeZone, now).date;
}

/** dateISO plus a whole number of days, as YYYY-MM-DD. */
export function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Reads businesses.settings.advance_booking_days: how many days ahead the
 * public may book. Returns null (= no limit enforced) unless it is a whole
 * number between 1 and 730, so a missing or malformed setting can never
 * block bookings.
 */
export function readAdvanceBookingDays(settings: unknown): number | null {
  if (!settings || typeof settings !== "object") return null;
  const raw = (settings as Record<string, unknown>).advance_booking_days;
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 730) return null;
  return value;
}

export type BookingDateTimeProblem =
  | "invalid_date"
  | "invalid_time"
  | "past_date"
  | "past_time"
  | "too_far_ahead";

/**
 * Checks a requested PUBLIC booking date/time against the business's own
 * clock. Returns the first problem found, or null when the request is
 * acceptable. `time` may be omitted (availability lookups have none).
 *
 * Deliberately not used by the admin paths: staff may record a walk-in or
 * an appointment that already happened.
 */
export function checkBookingDateTime(input: {
  date: unknown;
  time?: unknown;
  timeZone?: string | null;
  maxAdvanceDays?: number | null;
  now?: Date;
}): BookingDateTimeProblem | null {
  if (!isRealISODate(input.date)) return "invalid_date";
  if (input.time !== undefined && !isRealTime(input.time)) return "invalid_time";

  const current = zonedNow(input.timeZone, input.now);
  if (input.date < current.date) return "past_date";
  if (input.time !== undefined && input.date === current.date && (input.time as string) <= current.time) {
    return "past_time";
  }
  if (input.maxAdvanceDays && input.date > addDaysISO(current.date, input.maxAdvanceDays)) {
    return "too_far_ahead";
  }
  return null;
}

/** Customer-facing wording for each problem, in the application's language. */
export function bookingDateTimeMessage(problem: BookingDateTimeProblem, maxAdvanceDays?: number | null): string {
  switch (problem) {
    case "invalid_date":
      return "Η ημερομηνία δεν είναι έγκυρη.";
    case "invalid_time":
      return "Η ώρα δεν είναι έγκυρη.";
    case "past_date":
      return "Δεν μπορείτε να κλείσετε ραντεβού σε παρελθοντική ημερομηνία.";
    case "past_time":
      return "Η ώρα αυτή έχει ήδη περάσει. Επιλέξτε άλλη ώρα.";
    case "too_far_ahead":
      return maxAdvanceDays
        ? `Οι κρατήσεις γίνονται έως ${maxAdvanceDays} ημέρες νωρίτερα.`
        : "Η ημερομηνία είναι πολύ μακριά.";
  }
}

/**
 * For availability shown to the public: on the business's own "today",
 * slots that have already started are no longer bookable. Any other date
 * is returned unchanged.
 */
export function dropPastSlots(
  slots: string[],
  dateISO: string,
  timeZone?: string | null,
  now: Date = new Date()
): string[] {
  const current = zonedNow(timeZone, now);
  if (dateISO !== current.date) return slots;
  return slots.filter((slot) => slot.slice(0, 5) > current.time);
}

/**
 * What a PUBLIC booking endpoint returns after creating an appointment.
 *
 * The caller is anonymous, so the response carries only what a customer (or
 * the AI call agent booking on a customer's behalf) needs to confirm the
 * booking: its reference, when it is, and what was booked. Internal
 * identifiers (business_id, customer_id, employee_id, service_id), staff
 * notes, notification timestamps and the customer's own contact details are
 * deliberately left out -- the previous behaviour returned the whole
 * database row.
 */
export interface PublicAppointmentConfirmation {
  id?: string;
  status?: string;
  appointment_date?: string;
  appointment_time?: string;
  service_name?: string;
  service_duration_min?: number;
  service_price?: number;
  /** Migration 041: the code applied and the money it took off (0 / absent when none). */
  discount_code?: string;
  discount_amount?: number;
}

const PUBLIC_APPOINTMENT_FIELDS = [
  "id",
  "status",
  "appointment_date",
  "appointment_time",
  "service_name",
  "service_duration_min",
  "service_price",
  "discount_code",
  "discount_amount",
] as const;

export function toPublicAppointment(appointment: unknown): PublicAppointmentConfirmation {
  const source = (appointment ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of PUBLIC_APPOINTMENT_FIELDS) {
    if (source[field] !== undefined && source[field] !== null) out[field] = source[field];
  }
  return out as PublicAppointmentConfirmation;
}
