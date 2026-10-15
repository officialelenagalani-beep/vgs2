import { NextRequest } from "next/server";
import { resolveBusiness, ok, err, tooManyRequests } from "../../../_middleware";
import { getAvailability } from "@/services/appointments";
import { checkRateLimit, extractIpFromRequest, retryAfterHeader } from "@/lib/rate-limit";
import { isRealISODate, todayInTimeZone, dropPastSlots } from "@/lib/booking-rules";

type Params = { params: Promise<{ slug: string }> };

/**
 * GET /api/v1/businesses/:slug/availability?date=YYYY-MM-DD
 *                                           &service=<slug>     (recommended -- see below)
 *                                           (excludeId is ignored here; admin-only route)
 *                                           &employeeId=<uuid>  (optional, for per-barber availability)
 *
 * Public endpoint -- no authentication required.
 * Returns all, booked, and available time slots for the given date.
 *
 * `service` (Phase 3 / Step 1): when provided, availability is computed
 * from real employee scheduling data -- only active employees assigned to
 * perform that service are considered, and a slot is "available" if at
 * least one of them is free (working hours, recurring breaks, blocked
 * dates/vacations, and existing appointments are all respected; see
 * services/employee-availability.ts). The specific employee is not
 * exposed here and is decided automatically at booking time.
 *
 * When `service` is omitted, the response falls back to the legacy
 * business-wide slot list (pre-Phase-3 behavior), preserved for
 * compatibility with callers that don't yet pass it.
 *
 * Used by:
 *  - Public booking form (BookingWizard component) -- always passes `service`
 *  - Admin reschedule modal (with excludeId to keep current slot open)
 *  - AI Call Agent (primary availability check before offering times to caller)
 *  - Future mobile app
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     date: "2026-07-15",
 *     business_id: "...",
 *     employee_id: null | "...",
 *     service_id: null | "...",
 *     all_slots:       ["09:00", "09:30", ...],
 *     booked_slots:    ["10:00", "11:30"],
 *     available_slots: ["09:00", "09:30", "10:30", ...]
 *   }
 * }
 */
export async function GET(request: NextRequest, ctx: Params) {
  const params = await ctx.params;
  const result = await resolveBusiness(params.slug);
  if (!result.ok) return result.response;

  // Step 23C: read-only, high-frequency endpoint (BookingWizard polls it
  // on every date/service change) -- generous limit, checked immediately
  // after business resolution and before any date validation or the
  // getAvailability() DB work below. Same IP+business key composition as
  // the booking endpoint, for the same business-isolation reason.
  const ip = extractIpFromRequest(request);
  const rateLimit = await checkRateLimit(`availability:ip:${result.business.id}:${ip}`, 60, 60);
  if (!rateLimit.allowed) {
    return tooManyRequests(
      "Πάρα πολλά αιτήματα. Δοκιμάστε ξανά σε λίγο.",
      retryAfterHeader(rateLimit)
    );
  }

  const { searchParams } = request.nextUrl;
  const date       = searchParams.get("date");
  // excludeId is NOT taken from anonymous callers: freeing a booked slot by
  // naming an appointment id would reveal that appointment. Rescheduling
  // from the admin uses the signed-in /api/availability route instead.
  const excludeId: string | undefined = undefined;
  const employeeId = searchParams.get("employeeId") ?? undefined;
  const service    = searchParams.get("service")    ?? undefined;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealISODate(date)) {
    return err("Παρακαλώ δώστε ημερομηνία σε μορφή YYYY-MM-DD (παράμετρος: date).", 400);
  }

  // "Today" is the business's own date (businesses.timezone), not UTC.
  const today = todayInTimeZone(result.business.timezone);
  if (date < today) {
    return err("Δεν μπορείτε να ελέγξετε διαθεσιμότητα για παρελθοντική ημερομηνία.", 400);
  }

  try {
    const availability = await getAvailability(
      result.business.id,
      date,
      { excludeId, employeeId, service }
    );
    // On the business's own today, slots that have already started can no
    // longer be booked (the booking endpoint refuses them too) -- show them
    // as taken rather than as free.
    const stillBookable = dropPastSlots(availability.available_slots ?? [], date, result.business.timezone);
    if (stillBookable.length !== (availability.available_slots ?? []).length) {
      const free = new Set(stillBookable);
      return ok({
        ...availability,
        available_slots: stillBookable,
        booked_slots: (availability.all_slots ?? []).filter((slot) => !free.has(slot)),
      });
    }
    return ok(availability);
  } catch (e) {
    console.error("[v1/availability] error:", e);
    return err("Σφάλμα κατά τον έλεγχο διαθεσιμότητας.", 500);
  }
}
