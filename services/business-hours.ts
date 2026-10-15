import "server-only";
import { createServerClient } from "@/lib/supabase/server";
import {
  DAY_ORDER,
  closedDay,
  validateWeeklySchedule,
  type DayOfWeek,
  type WeeklySchedule,
  type WorkingHoursDay,
} from "@/types/employees";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

/**
 * Phase 4 / Step 19 -- Business Management: the business's own default
 * weekly schedule (business_working_hours, 001_initial_schema.sql).
 *
 * This table already existed before this step -- it's read by
 * services/employee-schedule.ts as the fallback source when an employee
 * has no individual override, and by get_available_slots() the same way
 * -- but nothing let an admin actually VIEW or EDIT it directly until now.
 * No new table, column, or migration was needed; this file only adds the
 * read/write service functions the Business Management UI calls.
 *
 * Deliberately reuses the exact same domain types (WeeklySchedule,
 * DayOfWeek, WorkingHoursDay, DAY_ORDER, closedDay, validateWeeklySchedule)
 * that services/employee-schedule.ts already uses for the per-employee
 * editor -- they were written generically (0=Sunday..6=Saturday, one row
 * per day, open/closed + HH:MM open/close) and apply identically here;
 * introducing a parallel/duplicate set of "business hours" types would
 * just be the same shape twice.
 */

type RawHoursRow = {
  day_of_week: number;
  is_closed: boolean;
  open_time: string | null;
  close_time: string | null;
};

function normalizeTime(t: string | null): string | null {
  // DB TIME columns come back as "HH:MM:SS" -- trim to "HH:MM" for the UI.
  return t ? t.slice(0, 5) : null;
}

function rowToDay(row: RawHoursRow): WorkingHoursDay {
  return {
    day_of_week: row.day_of_week as DayOfWeek,
    is_closed: row.is_closed,
    open_time: row.is_closed ? null : normalizeTime(row.open_time),
    close_time: row.is_closed ? null : normalizeTime(row.close_time),
  };
}

/**
 * The business's default weekly schedule for the Business Management
 * editor: always exactly 7 entries (Sunday..Saturday), one per day. Any
 * day with no saved row defaults to closed -- the same safe default
 * services/employee-schedule.ts uses for an employee with no hours
 * configured at all.
 */
export async function getBusinessWorkingHours(businessId: string): Promise<WeeklySchedule> {
  const { data, error } = await db()
    .from("business_working_hours")
    .select("day_of_week, is_closed, open_time, close_time")
    .eq("business_id", businessId);

  if (error) {
    console.error("[business-hours] getBusinessWorkingHours:", JSON.stringify(error));
  }

  const map = new Map<DayOfWeek, WorkingHoursDay>();
  for (const row of (data ?? []) as RawHoursRow[]) {
    map.set(row.day_of_week as DayOfWeek, rowToDay(row));
  }

  return DAY_ORDER.map((day) => map.get(day) ?? closedDay(day));
}

/**
 * Saves the business's full weekly schedule (always writes all 7 days as
 * an explicit upsert, same "edit the whole week, save the whole week"
 * model as the employee schedule editor).
 *
 * SECURITY / tenant isolation: `businessId` must always be resolved
 * server-side from the acting user's session (see
 * app/admin/(dashboard)/business/actions.ts's requireBusinessOwner()) --
 * never accepted from the client. Every written row is explicitly scoped
 * to that businessId; there is no code path here that can write a row for
 * any other business_id.
 */
export async function upsertBusinessWorkingHours(
  businessId: string,
  schedule: WeeklySchedule
): Promise<WeeklySchedule> {
  if (schedule.length !== 7) {
    throw new Error("Το ωράριο πρέπει να περιλαμβάνει και τις 7 ημέρες.");
  }
  const validationError = validateWeeklySchedule(schedule);
  if (validationError) throw new Error(validationError);

  const rows = schedule.map((day) => ({
    business_id: businessId,
    day_of_week: day.day_of_week,
    is_closed: day.is_closed,
    open_time: day.is_closed ? null : day.open_time,
    close_time: day.is_closed ? null : day.close_time,
  }));

  const { error } = await db()
    .from("business_working_hours")
    .upsert(rows, { onConflict: "business_id,day_of_week" });

  if (error) {
    console.error("[business-hours] upsertBusinessWorkingHours:", JSON.stringify(error));
    throw new Error("Σφάλμα κατά την αποθήκευση ωραρίου.");
  }

  return getBusinessWorkingHours(businessId);
}
