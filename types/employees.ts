/**
 * Employee Management -- domain types.
 *
 * Phase 2 / Step 1: core profile only (name, contact, color, role,
 * active status, avatar, notes). Working hours, breaks, blocked dates,
 * and service assignments are separate concerns added in later steps.
 */

export type EmployeeRole = "owner" | "manager" | "employee";

/** Full employee record as stored in the database. */
export interface Employee {
  id: string;
  business_id: string;
  slug: string;
  name: string;
  phone: string | null;
  email: string | null;
  color: string | null;
  role: EmployeeRole;
  is_active: boolean;
  /** Storage object path in the private "employee-avatars" bucket, or null. */
  avatar_url: string | null;
  /** Staff-only note. Never shown to customers. */
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Employee record shaped for the admin UI: adds a short-lived signed URL
 * resolved server-side from `avatar_url`, ready to pass directly to <img>.
 */
export interface AdminEmployee extends Employee {
  avatar_signed_url: string | null;
}

/** Publicly-safe projection (for the booking flow / public API). */
export interface PublicEmployee {
  id: string;
  slug: string;
  name: string;
  color: string | null;
  role: EmployeeRole;
}

export interface CreateEmployeeInput {
  name: string;
  phone?: string;
  email?: string;
  color?: string;
  role?: EmployeeRole;
  notes?: string;
}

export interface UpdateEmployeeInput {
  name?: string;
  phone?: string | null;
  email?: string | null;
  color?: string | null;
  role?: EmployeeRole;
  notes?: string | null;
  is_active?: boolean;
}

/** Calendar color palette offered in the admin UI (auto-assigned, editable). */
export const EMPLOYEE_COLOR_PALETTE: string[] = [
  "#4A90E2", // blue
  "#E24A6E", // rose
  "#4AE28C", // mint
  "#E2A34A", // amber
  "#9B4AE2", // violet
  "#4AD1E2", // cyan
  "#E24A4A", // red
  "#8CE24A", // lime
];

// ─── Working hours (Phase 2 / Step 2) ─────────────────────────────────────

/** 0 = Sunday .. 6 = Saturday, matching JS Date#getDay() and the DB column. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const DAY_LABELS_EL: Record<DayOfWeek, string> = {
  1: "Δευτέρα",
  2: "Τρίτη",
  3: "Τετάρτη",
  4: "Πέμπτη",
  5: "Παρασκευή",
  6: "Σάββατο",
  0: "Κυριακή",
};

/** Display order: Monday first, Sunday last. */
export const DAY_ORDER: DayOfWeek[] = [1, 2, 3, 4, 5, 6, 0];

/** One row of an employee's weekly schedule. */
export interface WorkingHoursDay {
  day_of_week: DayOfWeek;
  is_closed: boolean;
  /** "HH:MM", 24h. Null when is_closed = true. */
  open_time: string | null;
  /** "HH:MM", 24h. Null when is_closed = true. */
  close_time: string | null;
}

/** Always exactly 7 entries, one per day of week, in no particular order. */
export type WeeklySchedule = WorkingHoursDay[];

/** A closed day with times cleared -- the safe default for a brand-new day. */
export function closedDay(day: DayOfWeek): WorkingHoursDay {
  return { day_of_week: day, is_closed: true, open_time: null, close_time: null };
}

/**
 * Validates a single day entry against the same rules enforced by the
 * DB check constraint (chk_employee_hours_consistency), plus basic
 * HH:MM format sanity. Returns an error message, or null if valid.
 */
export function validateWorkingHoursDay(day: WorkingHoursDay): string | null {
  const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;

  if (day.is_closed) {
    return null; // open_time/close_time are ignored (and cleared) when closed
  }
  if (!day.open_time || !day.close_time) {
    return `${DAY_LABELS_EL[day.day_of_week]}: συμπλήρωσε ώρα έναρξης και λήξης.`;
  }
  if (!timeRe.test(day.open_time) || !timeRe.test(day.close_time)) {
    return `${DAY_LABELS_EL[day.day_of_week]}: μη έγκυρη μορφή ώρας.`;
  }
  if (day.close_time <= day.open_time) {
    return `${DAY_LABELS_EL[day.day_of_week]}: η ώρα λήξης πρέπει να είναι μετά την ώρα έναρξης.`;
  }
  return null;
}

export function validateWeeklySchedule(schedule: WeeklySchedule): string | null {
  for (const day of schedule) {
    const err = validateWorkingHoursDay(day);
    if (err) return err;
  }
  return null;
}

// ─── Breaks (Phase 2 / Step 3) ─────────────────────────────────────────────

/** A single recurring break window within one day of an employee's schedule. */
export interface EmployeeBreak {
  /** Real DB id once saved; a client-generated temp id while unsaved. */
  id: string;
  day_of_week: DayOfWeek;
  /** "HH:MM", 24h. */
  start_time: string;
  /** "HH:MM", 24h. */
  end_time: string;
  label: string | null;
}

/** All of an employee's breaks, grouped by day of week. Always has all 7 keys. */
export type BreaksByDay = Record<DayOfWeek, EmployeeBreak[]>;

export function emptyBreaksByDay(): BreaksByDay {
  return { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Validates one day's breaks against that day's working hours: each break
 * must be a valid range, fall entirely inside the working window, and
 * breaks must not overlap each other. Returns an error message, or null.
 */
export function validateDayBreaks(day: WorkingHoursDay, breaks: EmployeeBreak[]): string | null {
  const dayLabel = DAY_LABELS_EL[day.day_of_week];

  if (breaks.length === 0) return null;

  if (day.is_closed) {
    return `${dayLabel}: δεν μπορεί να έχει διαλείμματα αφού η ημέρα είναι κλειστή.`;
  }

  for (const brk of breaks) {
    if (!TIME_RE.test(brk.start_time) || !TIME_RE.test(brk.end_time)) {
      return `${dayLabel}: μη έγκυρη μορφή ώρας σε διάλειμμα.`;
    }
    if (brk.end_time <= brk.start_time) {
      return `${dayLabel}: η ώρα λήξης του διαλείμματος πρέπει να είναι μετά την έναρξη.`;
    }
    if (brk.start_time < (day.open_time ?? "")) {
      return `${dayLabel}: το διάλειμμα ξεκινά πριν την έναρξη του ωραρίου.`;
    }
    if (brk.end_time > (day.close_time ?? "")) {
      return `${dayLabel}: το διάλειμμα τελειώνει μετά τη λήξη του ωραρίου.`;
    }
  }

  const sorted = [...breaks].sort((a, b) => a.start_time.localeCompare(b.start_time));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start_time < sorted[i - 1].end_time) {
      return `${dayLabel}: τα διαλείμματα δεν μπορούν να επικαλύπτονται.`;
    }
  }

  return null;
}

export function validateAllBreaks(schedule: WeeklySchedule, breaksByDay: BreaksByDay): string | null {
  for (const day of schedule) {
    const err = validateDayBreaks(day, breaksByDay[day.day_of_week] ?? []);
    if (err) return err;
  }
  return null;
}

// ─── Service assignment (Phase 2 / Step 5) ─────────────────────────────────

/** A service as offered for the admin's assignment picker. */
export interface ServiceOption {
  id: string;
  name: string;
  category_name: string | null;
  duration_min: number;
  price: number;
}

// ─── Blocked dates: vacations, days off, partial blocks (Phase 2 / Step 4) ─

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** How many days a single "full-day range" create can span, as a sanity cap. */
export const MAX_BLOCKED_RANGE_DAYS = 366;

/** One saved row: a specific date, either blocked all day or for a time window. */
export interface BlockedPeriod {
  id: string;
  /** "YYYY-MM-DD" */
  blocked_date: string;
  /** "HH:MM", null when the whole day is blocked. */
  blocked_from: string | null;
  /** "HH:MM", null when the whole day is blocked. */
  blocked_until: string | null;
  reason: string | null;
}

/** Form input for creating one or more blocked days at once. */
export interface CreateBlockedPeriodInput {
  /** "YYYY-MM-DD" */
  start_date: string;
  /** "YYYY-MM-DD", inclusive. Equal to start_date for a single day. */
  end_date: string;
  is_full_day: boolean;
  /** Required, single-day only, when is_full_day = false. */
  blocked_from?: string | null;
  blocked_until?: string | null;
  reason?: string | null;
}

export interface UpdateBlockedPeriodInput {
  blocked_date?: string;
  is_full_day?: boolean;
  blocked_from?: string | null;
  blocked_until?: string | null;
  reason?: string | null;
}

function daysBetweenInclusive(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Enumerates every date "YYYY-MM-DD" from start to end, inclusive. */
export function enumerateDateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function validateCreateBlockedPeriod(input: CreateBlockedPeriodInput): string | null {
  if (!DATE_RE.test(input.start_date) || !DATE_RE.test(input.end_date)) {
    return "Μη έγκυρη ημερομηνία.";
  }
  if (input.end_date < input.start_date) {
    return "Η ημερομηνία λήξης πρέπει να είναι μετά ή ίδια με την ημερομηνία έναρξης.";
  }

  if (!input.is_full_day) {
    if (input.start_date !== input.end_date) {
      return "Το μπλοκάρισμα συγκεκριμένων ωρών αφορά μόνο μία ημερομηνία.";
    }
    if (!input.blocked_from || !input.blocked_until) {
      return "Συμπλήρωσε ώρα έναρξης και λήξης.";
    }
    if (!TIME_RE.test(input.blocked_from) || !TIME_RE.test(input.blocked_until)) {
      return "Μη έγκυρη μορφή ώρας.";
    }
    if (input.blocked_until <= input.blocked_from) {
      return "Η ώρα λήξης πρέπει να είναι μετά την ώρα έναρξης.";
    }
    return null;
  }

  if (daysBetweenInclusive(input.start_date, input.end_date) > MAX_BLOCKED_RANGE_DAYS) {
    return `Το εύρος ημερομηνιών δεν μπορεί να ξεπερνά τις ${MAX_BLOCKED_RANGE_DAYS} ημέρες.`;
  }
  return null;
}
