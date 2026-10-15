import { NextRequest, NextResponse } from "next/server";
import { businessHasFeature } from "@/lib/plans";
import { resolveBusiness, ok, err, tooManyRequests } from "../../../_middleware";
import { createAppointment } from "@/services/appointments";
import { DiscountCodeError, discountRefusalMessage, isDiscountCodeFormat, normalizeDiscountCode } from "@/lib/discounts";
import type { CreateAppointmentInput, AppointmentSource } from "@/types/appointments";
import {
  checkRateLimit,
  extractIpFromRequest,
  normalizePhoneForRateLimit,
  retryAfterHeader,
} from "@/lib/rate-limit";
import {
  checkBookingDateTime,
  bookingDateTimeMessage,
  readAdvanceBookingDays,
  toPublicAppointment,
} from "@/lib/booking-rules";
import { isPlainEmailAddress } from "@/lib/notifications/email-templates";
import { isHoneypotTripped } from "@/lib/honeypot";
import { readJsonBody } from "@/lib/json-body";

type Params = { params: Promise<{ slug: string }> };

/**
 * POST /api/v1/businesses/:slug/appointments
 *
 * Public endpoint -- no authentication required.
 * Creates a new appointment for the given business.
 *
 * Used by:
 *  - Public booking form (BookingWizard.tsx -- migrated onto this v1 path
 *    since Step 17; the legacy /api/appointments it used to describe here
 *    was confirmed dead and removed in Step 23)
 *  - AI Call Agent (source: "ai_agent")
 *  - Future mobile app (source: "website" or a new source value)
 *
 * Body:
 * {
 *   customer_name:     string  (required)
 *   customer_phone:    string  (required)
 *   customer_email?:   string
 *   marketing_opt_in?: boolean   (048: "offers & news" ticked; needs customer_email)
 *   service:           string  service slug from /services endpoint (required)
 *   service_name?:     string  ignored -- resolved server-side from the DB (Step 17)
 *   service_price?:    number  ignored -- resolved server-side from the DB (Step 17)
 *   service_duration_min?: number  ignored -- resolved server-side from the DB (Step 17)
 *   appointment_date:  string  YYYY-MM-DD
 *   appointment_time:  string  HH:MM
 *   employee_id?:      string  UUID of specific employee/barber
 *   notes?:            string
 *   source?:           "website" | "ai_agent"
 * }
 *
 * Responses:
 *   201 Created     -- appointment saved, returns full Appointment object
 *   400 Bad Request -- validation error
 *   409 Conflict    -- slot already taken (caller should re-check availability)
 *   429 Too Many Requests -- rate limited (see Step 23C: IP+business and
 *       phone-keyed limits, both checked before the expensive
 *       availability/insert work in createAppointment())
 *   500 Server Error
 */
export async function POST(request: NextRequest, ctx: Params) {
  const params = await ctx.params;
  const result = await resolveBusiness(params.slug);
  if (!result.ok) return result.response;

  // Step 23C: IP+business rate limit, checked immediately once the
  // business is resolved -- before parsing/validating the body and long
  // before the expensive availability/employee-lookup/insert work inside
  // createAppointment(). Keyed by business as well as IP (not IP alone)
  // so a flood against one business's booking form can never exhaust a
  // different business's quota, even if both happen to share an IP
  // (shared wifi, corporate/mobile NAT, etc. -- see the Step 23C
  // inspection).
  const ip = extractIpFromRequest(request);
  const ipLimit = await checkRateLimit(`booking:ip:${result.business.id}:${ip}`, 8, 600);
  if (!ipLimit.allowed) {
    return tooManyRequests(
      "Πολλές προσπάθειες κράτησης. Δοκιμάστε ξανά σε λίγο.",
      retryAfterHeader(ipLimit)
    );
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return parsed.reason === "too_large" ? err("Το αίτημα είναι πολύ μεγάλο.", 413) : err("Μη έγκυρο JSON body.", 400);
  }
  const body = parsed.body as Partial<CreateAppointmentInput & { source?: AppointmentSource }>;

  // Hidden form field filled in: an automated submission (lib/honeypot.ts).
  // Refused with a neutral message before any further work.
  if (isHoneypotTripped(body)) {
    return err("Η κράτηση δεν ολοκληρώθηκε. Δοκιμάστε ξανά.", 400);
  }

  // Required field validation.
  // Phase 4 / Step 17: "service_name" removed -- createAppointment() now
  // resolves name/price/duration server-side from the DB `services` table
  // (see resolveBookableService()) and no longer reads it. Kept optional
  // on the type for backward compatibility, but no longer required here.
  const requiredFields = [
    "customer_name",
    "customer_phone",
    "service",
    "appointment_date",
    "appointment_time",
  ] as const;

  for (const field of requiredFields) {
    if (!body[field]) {
      return err(`Το πεδίο "${field}" είναι υποχρεωτικό.`, 400);
    }
  }
  // The body is untyped JSON from an anonymous caller: a number or an
  // object in a text field would otherwise crash the .trim() calls below
  // and surface as a 500.
  for (const field of requiredFields) {
    if (typeof body[field] !== "string") {
      return err(`Το πεδίο "${field}" δεν είναι έγκυρο.`, 400);
    }
  }
  for (const field of ["customer_email", "notes", "employee_id"] as const) {
    const value = body[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      return err(`Το πεδίο "${field}" δεν είναι έγκυρο.`, 400);
    }
  }

  // Step 23C: phone-keyed rate limit -- checked as soon as customer_phone
  // is confirmed present (above), still well before the expensive
  // availability/insert work below. Global (not per-business): the same
  // abuser spamming bookings across several different businesses on this
  // platform with one phone number is still the same abuser, and should
  // still be capped -- see the Step 23C inspection's key-composition
  // rationale.
  // Format first, so only a real-looking phone number ever becomes a rate-limit key.
  if (!/^[0-9+ ]{8,15}$/.test(body.customer_phone!.trim())) {
    return err("Παρακαλώ δώστε ένα έγκυρο τηλέφωνο.", 400);
  }
  const phoneKey = normalizePhoneForRateLimit(body.customer_phone!);
  const phoneLimit = await checkRateLimit(`booking:phone:${phoneKey}`, 5, 3600);
  if (!phoneLimit.allowed) {
    return tooManyRequests(
      "Πολλές προσπάθειες κράτησης για αυτό το τηλέφωνο. Δοκιμάστε ξανά αργότερα.",
      retryAfterHeader(phoneLimit)
    );
  }

  if (body.customer_name!.trim().length < 2) {
    return err("Το ονοματεπώνυμο πρέπει να έχει τουλάχιστον 2 χαρακτήρες.", 400);
  }

  // Step 23: server-side max-length caps on public, unauthenticated input.
  // Limits are deliberately generous relative to any realistic real value
  // (see the Step 23 audit) -- this is defense-in-depth against storage
  // abuse via an oversized payload, not a constraint any genuine customer
  // should ever be able to hit.
  if (body.customer_name!.trim().length > 100) {
    return err("Το ονοματεπώνυμο είναι πολύ μεγάλο (μέγιστο 100 χαρακτήρες).", 400);
  }

  if (body.customer_email && body.customer_email.trim().length > 254) {
    // 254 chars is the actual RFC 5321 maximum for a valid email address.
    return err("Το email είναι πολύ μεγάλο.", 400);
  }

  // Optional, but when given it must be ONE plain address: a confirmation
  // e-mail may be sent to it (services/notifications.ts), so a list of
  // addresses or anything containing a line break is refused here.
  const customerEmail = typeof body.customer_email === "string" ? body.customer_email.trim() : "";
  if (customerEmail && !isPlainEmailAddress(customerEmail)) {
    return err("Το email δεν είναι έγκυρο.", 400);
  }
  if (customerEmail) {
    // One address can be named in at most a few bookings per hour, whoever
    // makes them and whichever phone number they give -- so the booking
    // form cannot be used to flood somebody's inbox with confirmations.
    const emailLimit = await checkRateLimit(`booking:email:${customerEmail.toLowerCase()}`, 3, 3600);
    if (!emailLimit.allowed) {
      return tooManyRequests(
        "Πολλές προσπάθειες κράτησης για αυτό το email. Δοκιμάστε ξανά αργότερα.",
        retryAfterHeader(emailLimit)
      );
    }
  }

  if (body.notes && body.notes.trim().length > 1000) {
    return err("Οι σημειώσεις είναι πολύ μεγάλες (μέγιστο 1000 χαρακτήρες).", 400);
  }

  if (!/^[0-9+ ]{8,15}$/.test(body.customer_phone!.trim())) {
    return err("Παρακαλώ δώστε ένα έγκυρο τηλέφωνο.", 400);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.appointment_date!)) {
    return err("Η ημερομηνία πρέπει να είναι σε μορφή YYYY-MM-DD.", 400);
  }

  if (!/^\d{2}:\d{2}$/.test(body.appointment_time!)) {
    return err("Η ώρα πρέπει να είναι σε μορφή HH:MM.", 400);
  }

  // Real calendar date and clock time, judged against the BUSINESS's own
  // clock (businesses.timezone), not the server's UTC date: not in the past,
  // not a time that has already started today, and -- when the business has
  // configured settings.advance_booking_days -- not further ahead than that.
  // See lib/booking-rules.ts.
  const maxAdvanceDays = readAdvanceBookingDays(result.business.settings);
  const dateTimeProblem = checkBookingDateTime({
    date: body.appointment_date,
    time: body.appointment_time,
    timeZone: result.business.timezone,
    maxAdvanceDays,
  });
  if (dateTimeProblem) {
    return err(bookingDateTimeMessage(dateTimeProblem, maxAdvanceDays), 400);
  }

  // Optional discount code (migration 041). Only its shape is checked here;
  // whether it applies, and by how much, is decided by the database.
  let discountCode: string | undefined;
  if (body.discount_code !== undefined && body.discount_code !== null && body.discount_code !== "") {
    // A plan without discount codes has none to apply.
    if (!businessHasFeature(result.business, "discounts")) return err(discountRefusalMessage("not_found"), 400);
    if (typeof body.discount_code !== "string") return err(`Το πεδίο "discount_code" δεν είναι έγκυρο.`, 400);
    discountCode = normalizeDiscountCode(body.discount_code);
    if (!isDiscountCodeFormat(discountCode)) return err(discountRefusalMessage("not_found"), 400);
  }

  // Validate source if provided
  // "admin" is NOT accepted here: this endpoint is anonymous, and "admin"
  // marks a booking as entered by staff (it is what the dashboard's own
  // server action sets). Letting any caller claim it would make public
  // bookings indistinguishable from staff-entered ones in the calendar,
  // exports and analytics. An unknown or disallowed value falls back to
  // "website", as before.
  const validSources: AppointmentSource[] = ["website", "ai_agent"];
  const source: AppointmentSource = validSources.includes(body.source as AppointmentSource)
    ? (body.source as AppointmentSource)
    : "website";

  try {
    const appointment = await createAppointment(result.business.id, {
      ...(body as CreateAppointmentInput),
      customer_email: customerEmail || undefined,
      source,
      discount_code: discountCode,
      // Migration 048: consent to offers & news counts only as a real `true`
      // and only together with an e-mail address.
      marketing_opt_in:
        (body as { marketing_opt_in?: unknown }).marketing_opt_in === true &&
        Boolean(customerEmail) &&
        businessHasFeature(result.business, "campaigns"),
    });
    // Anonymous caller: return a confirmation summary, never the full row.
    return ok(toPublicAppointment(appointment), 201);
  } catch (e) {
    if (e instanceof DiscountCodeError) {
      return NextResponse.json({ success: false, error: e.message, field: "discount_code" }, { status: 400 });
    }
    const message = e instanceof Error ? e.message : "Σφάλμα κατά την αποθήκευση.";
    // 409 = slot conflict, 500 = other error
    // "δεν είναι διαθέσιμος": the barber the customer chose was booked in
    // the meantime -- a conflict too, so the page offers other times.
    const status = message.includes("πλέον διαθέσιμη") || message.includes("δεν είναι διαθέσιμος") ? 409 : 500;
    return err(message, status);
  }
}
