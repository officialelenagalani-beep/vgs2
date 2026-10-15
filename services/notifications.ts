import { createServerClient } from "@/lib/supabase/server";
import { getNotificationProvider } from "@/lib/notifications/provider";
import type {
  NotificationChannel,
  NotificationType,
  NotificationStatus,
  NotificationLog,
} from "@/types/notifications";
import type { Appointment } from "@/types/appointments";
import { getBusinessById } from "@/services/businesses";
import { planSms } from "@/services/sms";
import type { SmsKind } from "@/lib/sms";
import {
  buildAppointmentEmail,
  formatFromHeader,
  isPlainEmailAddress,
  type AppointmentEmailKind,
} from "@/lib/notifications/email-templates";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

// ---------------------------------------------------------------------------
// Core: the one authoritative writer for notification_log
// ---------------------------------------------------------------------------

/**
 * How recently an identical (business_id, channel, type, recipient)
 * notification must have been logged for a new request to be treated as an
 * accidental duplicate (e.g. a double-click on a quick action, or React
 * Strict Mode's intentional double-invoke in dev) rather than a genuinely
 * new event. Deliberately short -- long enough to absorb a double-submit,
 * short enough that a real later event of the same type for the same
 * appointment (e.g. cancel, reactivate, then cancel again) is never
 * silently swallowed.
 */
const DUPLICATE_WINDOW_MS = 30_000;

/** Width of the time bucket in an e-mail's provider idempotency key. */
const IDEMPOTENCY_BUCKET_MS = 10 * 60_000;

interface LogNotificationParams {
  businessId: string;
  /** null when a notification isn't tied to one specific appointment. */
  appointmentId: string | null;
  channel: NotificationChannel;
  type: NotificationType;
  recipient: string;
  /**
   * Human-readable content for a future provider's `send()` call. There is
   * no `message`/`body` column on notification_log (001_initial_schema.sql
   * only persists channel/type/recipient/status/provider metadata) --
   * this is never itself written to the database, only handed to
   * `provider.send()` when a provider is actually configured.
   */
  message: string;
  /** E-mail channel only: what the provider needs beyond recipient + text. */
  email?: {
    subject: string;
    html: string;
    from: string;
    replyTo: string | null;
    idempotencyKey: string;
  };
  /**
   * Skip the 30-second "same recipient, same type" duplicate check. Only for
   * senders that already guarantee one e-mail per person themselves (e-mail
   * campaigns: one recipient row per customer, claimed before sending) --
   * otherwise two different campaigns, or a campaign and a rebooking nudge,
   * to the same address within 30 seconds would wrongly count as one.
   */
  skipDuplicateCheck?: boolean;
  /**
   * False = record the notification but do NOT hand it to the provider (it
   * stays `pending`). SMS use this: a message is sent only when the shop's
   * plan, allowance and the customer's choice allow it (services/sms.ts).
   */
  deliver?: boolean;
  /** SMS only: the shop's own sender name. */
  smsFrom?: string | null;
}

export interface NotifyResult {
  ok: boolean;
  /**
   * duplicate      -- an identical notification was logged moments ago.
   * no_recipient   -- (e-mail) the appointment has no usable e-mail address.
   * not_configured -- (e-mail) sending is switched off: no RESEND_API_KEY, or
   *                   the business has no sender address in its settings.
   */
  skipped?: "duplicate" | "no_recipient" | "not_configured";
  row?: NotificationLog;
  error?: string;
}

/**
 * The single authoritative entry point for writing to notification_log.
 * Every appointment-event notifier below (notifyAppointmentConfirmed,
 * notifyAppointmentCancelled, notifyAppointmentRescheduled) funnels through
 * this one function -- there is exactly one place in this codebase that
 * ever calls `.from("notification_log").insert(...)`, so channel/type/
 * status handling, duplicate prevention, and provider resolution each
 * exist in exactly one place.
 *
 * Guarantees (this step's core requirement, "IMPORTANT BEHAVIOR"):
 *
 *   - NEVER throws. Every failure path (duplicate-check query error,
 *     provider error, insert error, or anything unexpected) is caught and
 *     returned as `{ ok: false, error }`. Callers -- always an appointment
 *     mutation that has already succeeded and committed -- can invoke this
 *     and ignore the result entirely; a notification failure can never
 *     roll back or fail the appointment change that triggered it.
 *
 *   - Resolves the provider (or lack of one) and decides the row's final
 *     `status`/`provider`/`provider_message_id`/`error_message` BEFORE
 *     inserting, never after, because notification_log is append-only in
 *     this schema (see its own comment in 001_initial_schema.sql: "No
 *     updated_at: notification_log rows are append-only (never updated)").
 *     There is no follow-up UPDATE once a provider is eventually wired
 *     in -- the single INSERT must already be correct.
 */
async function logNotification(params: LogNotificationParams): Promise<NotifyResult> {
  try {
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
    let dupQuery = db()
      .from("notification_log")
      .select("id")
      .eq("business_id", params.businessId)
      .eq("channel", params.channel)
      .eq("type", params.type)
      .eq("recipient", params.recipient)
      // A FAILED attempt is not a duplicate: a retry right after a failure
      // must be allowed to go out.
      .in("status", ["pending", "sent", "delivered"])
      .gte("created_at", since)
      .limit(1);

    // Phase 3 / Step 8 addition: when this notification IS tied to a
    // specific appointment, scope the duplicate check to that appointment
    // too. Without this, a recurring series (Step 8) that creates several
    // appointments for the same customer within the same request -- each a
    // genuinely distinct, notification-worthy event with its own date/time
    // -- would have occurrences 2..N silently swallowed as "duplicates" of
    // occurrence 1, since they share the same business/channel/type/
    // recipient and all fall inside the same 30-second window. Scoping by
    // appointment_id keeps the original double-click/StrictMode-dedupe
    // guarantee for repeated calls about the SAME appointment (unchanged
    // behavior for every existing Step 7 call site), while never
    // conflating two DIFFERENT appointments. When appointmentId is null
    // (not tied to one specific appointment -- e.g. a possible future
    // marketing notification), the check falls back to exactly the
    // original business+channel+type+recipient scoping.
    if (params.appointmentId) {
      dupQuery = dupQuery.eq("appointment_id", params.appointmentId);
    }

    const { data: recent, error: dupError } = await dupQuery;

    if (params.skipDuplicateCheck) {
      // The caller guarantees uniqueness itself (see the parameter's comment).
    } else if (dupError) {
      // Don't let a broken duplicate-check permanently block logging --
      // report it and fall through to attempt the insert anyway.
      console.error("[notifications] duplicate-check error:", JSON.stringify(dupError));
    } else if (recent && recent.length > 0) {
      return { ok: true, skipped: "duplicate" };
    }

    const provider = params.deliver === false ? null : getNotificationProvider(params.channel);

    let status: NotificationStatus = "pending";
    let providerName: string | null = null;
    let providerMessageId: string | null = null;
    let errorMessage: string | null = null;
    let sentAt: string | null = null;

    if (provider) {
      try {
        const result = await provider.send({
          recipient: params.recipient,
          message: params.message,
          ...(params.email ?? {}),
          ...(params.channel === "sms" && params.smsFrom ? { from: params.smsFrom } : {}),
        });
        status = "sent";
        providerName = provider.name;
        providerMessageId = result.providerMessageId ?? null;
        sentAt = new Date().toISOString();
      } catch (sendErr) {
        status = "failed";
        providerName = provider.name;
        errorMessage =
          sendErr instanceof Error ? sendErr.message : "Άγνωστο σφάλμα αποστολής.";
      }
    }
    // else: no provider is configured for this channel (always true today
    // -- see lib/notifications/provider.ts). `status` stays at its initial
    // value, 'pending', which is also notification_log.status's own DB
    // default -- the safe "logged but not yet sent" state this step asks
    // for, ready for a future sender/worker to pick up via the existing
    // idx_notification_log_pending index.

    const { data, error } = await db()
      .from("notification_log")
      .insert({
        business_id: params.businessId,
        appointment_id: params.appointmentId,
        channel: params.channel,
        type: params.type,
        recipient: params.recipient,
        status,
        provider: providerName,
        provider_message_id: providerMessageId,
        error_message: errorMessage,
        sent_at: sentAt,
      })
      .select()
      .single();

    if (error) {
      console.error("[notifications] logNotification insert error:", JSON.stringify(error));
      return { ok: false, error: "Η καταγραφή της ειδοποίησης απέτυχε." };
    }

    return { ok: true, row: data as NotificationLog };
  } catch (err) {
    // Absolute last-resort guard -- see this function's doc comment above.
    console.error("[notifications] logNotification unexpected error:", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Απρόσμενο σφάλμα ειδοποίησης.",
    };
  }
}

// ---------------------------------------------------------------------------
// Appointment event notifiers
// ---------------------------------------------------------------------------
//
// Every function below is a thin, event-specific wrapper around
// logNotification() -- they only ever decide *what* to log (channel, type,
// recipient, message), never *how* (that's entirely logNotification's
// job). This is the "provider-agnostic boundary" this step asks for:
//
//   appointment mutation (services/appointments.ts)
//     -> notifyAppointment*() (below)
//       -> logNotification() (above)
//         -> lib/notifications/provider.ts (currently always: not configured)
//
// Channel choice: every notifier below uses 'sms' and
// `appointment.customer_phone` as the recipient. `customer_phone` is a
// required field on every appointment (CreateAppointmentInput,
// 001_initial_schema.sql), so it's always available and gives a single,
// deterministic recipient per event -- unlike `customer_email`, which is
// optional. Since no provider is actually configured yet (nothing is
// being sent today regardless of channel), this keeps the first version
// of the notification system to one row per event rather than guessing at
// a future multi-channel fan-out policy that hasn't been decided.

// ---------------------------------------------------------------------------
// E-mail to the customer
// ---------------------------------------------------------------------------

export interface NotifyOptions {
  /**
   * Suppress the customer e-mail for this event (the SMS-log row is still
   * written). Used by recurring series, which confirm many appointments at
   * once: the customer gets one e-mail, not one per occurrence.
   */
  skipEmail?: boolean;
}

/**
 * The sender address a business has chosen for its customer e-mails:
 * businesses.settings.notification_from_email, falling back to
 * settings.auto_reply_from_email (the key the travel module already uses
 * for the same idea). Returns null unless it is one plain address.
 */
export function readNotificationSender(settings: unknown): string | null {
  if (!settings || typeof settings !== "object") return null;
  const s = settings as Record<string, unknown>;
  for (const key of ["notification_from_email", "auto_reply_from_email"] as const) {
    const value = typeof s[key] === "string" ? (s[key] as string).trim() : "";
    if (isPlainEmailAddress(value)) return value;
  }
  return null;
}

/**
 * True when customer e-mails are switched on for this business: the
 * platform has an e-mail provider configured AND the business has chosen a
 * sender address. The public booking form asks for an e-mail address only
 * when this is true -- an address is not collected while nothing would be
 * done with it.
 */
export function isCustomerEmailEnabled(business: { settings?: unknown } | null | undefined): boolean {
  if (!business) return false;
  return getNotificationProvider("email") !== null && readNotificationSender(business.settings) !== null;
}

/**
 * Sends (and logs) the customer e-mail for an appointment event.
 *
 * SWITCHED OFF BY DEFAULT. An e-mail is attempted only when ALL of these
 * hold; otherwise nothing is sent and nothing is logged:
 *   1. the appointment has a usable customer_email,
 *   2. RESEND_API_KEY is set (lib/notifications/provider.ts),
 *   3. the business has a sender address in its settings
 *      (readNotificationSender()).
 *
 * Like everything in this file it NEVER throws: the appointment change
 * that triggered it has already been committed and must not be affected by
 * a notification problem.
 */
export async function sendAppointmentEmail(
  kind: AppointmentEmailKind,
  businessId: string,
  appointment: Appointment,
  previousDateISO?: string,
  extra: { preferencesUrl?: string | null } = {}
): Promise<NotifyResult> {
  try {
    const recipient = appointment.customer_email?.trim() ?? "";
    if (!isPlainEmailAddress(recipient)) return { ok: true, skipped: "no_recipient" };

    if (!getNotificationProvider("email")) return { ok: true, skipped: "not_configured" };

    const business = await getBusinessById(businessId);
    const sender = readNotificationSender(business?.settings);
    if (!business || !sender) return { ok: true, skipped: "not_configured" };

    const mail = buildAppointmentEmail({
      kind,
      businessName: business.name,
      serviceName: appointment.service_name,
      date: appointment.appointment_date,
      time: appointment.appointment_time,
      previousDate: previousDateISO ?? null,
      businessPhone: business.phone,
      businessAddress: [business.address, business.city].filter(Boolean).join(", ") || null,
      preferencesUrl: extra.preferencesUrl ?? null,
    });

    return await logNotification({
      businessId,
      appointmentId: appointment.id,
      channel: "email",
      type: kind,
      recipient,
      message: mail.text,
      email: {
        subject: mail.subject,
        html: mail.html,
        from: formatFromHeader(business.name, sender),
        replyTo: isPlainEmailAddress(business.email) ? business.email : null,
        // Same event for the same appointment at the same date/time within
        // the same ten minutes -> the provider discards a second send (a
        // double submit that slipped past the duplicate window above). A
        // later move, or a genuine re-confirmation after a cancellation,
        // has a different key and is sent.
        idempotencyKey:
          `appointment-${kind}/${appointment.id}/${appointment.appointment_date}T${timeOnly(appointment.appointment_time)}` +
          `/${Math.floor(Date.now() / IDEMPOTENCY_BUCKET_MS)}`,
      },
    });
  } catch (err) {
    console.error("[notifications] sendAppointmentEmail unexpected error:", err instanceof Error ? err.message : err);
    return { ok: false, error: "Η αποστολή email απέτυχε." };
  }
}

/**
 * Sends (and logs) an OPTIONAL e-mail that is not tied to a booking change --
 * a review request or a rebooking nudge. The caller has already built the
 * message and decided the customer wants it; this resolves the business's
 * sender and the provider exactly like sendAppointmentEmail(). Same
 * guarantees: never throws, sends nothing unless everything is configured.
 */
export async function sendBusinessEmail(input: {
  businessId: string;
  appointmentId: string | null;
  recipient: string;
  mail: { subject: string; text: string; html: string };
  idempotencyKey: string;
  /** See LogNotificationParams.skipDuplicateCheck. */
  skipDuplicateCheck?: boolean;
}): Promise<NotifyResult> {
  try {
    const recipient = input.recipient?.trim() ?? "";
    if (!isPlainEmailAddress(recipient)) return { ok: true, skipped: "no_recipient" };
    if (!getNotificationProvider("email")) return { ok: true, skipped: "not_configured" };

    const business = await getBusinessById(input.businessId);
    const sender = readNotificationSender(business?.settings);
    if (!business || !sender) return { ok: true, skipped: "not_configured" };

    return await logNotification({
      businessId: input.businessId,
      appointmentId: input.appointmentId,
      channel: "email",
      type: "custom",
      recipient,
      message: input.mail.text,
      email: {
        subject: input.mail.subject,
        html: input.mail.html,
        from: formatFromHeader(business.name, sender),
        replyTo: isPlainEmailAddress(business.email) ? business.email : null,
        idempotencyKey: input.idempotencyKey,
      },
      skipDuplicateCheck: input.skipDuplicateCheck === true,
    });
  } catch (err) {
    console.error("[notifications] sendBusinessEmail unexpected error:", err instanceof Error ? err.message : err);
    return { ok: false, error: "Η αποστολή email απέτυχε." };
  }
}

/** True when a send result means the e-mail went out (or an identical one just did). */
export function wasDelivered(result: NotifyResult): boolean {
  return result.ok && (result.skipped === "duplicate" || result.row?.status === "sent");
}

function timeOnly(hms: string): string {
  return hms.slice(0, 5);
}

/** The text recorded with an SMS row when no SMS is sent (unchanged from before SMS existed). */
function legacySmsText(kind: Exclude<SmsKind, "reminder">, appointment: Appointment, previousDateISO?: string): string {
  const at = `${appointment.appointment_date} ${timeOnly(appointment.appointment_time)}`;
  if (kind === "confirmation") return `Το ραντεβού σας για ${appointment.service_name} στις ${at} επιβεβαιώθηκε.`;
  if (kind === "cancellation") return `Το ραντεβού σας για ${appointment.service_name} στις ${at} ακυρώθηκε.`;
  return `Το ραντεβού σας για ${appointment.service_name} μετακινήθηκε από τις ${previousDateISO ?? ""} στις ${at}.`;
}

/**
 * The SMS row of an appointment event. It is ALWAYS recorded (as before);
 * it is SENT only when services/sms.ts says so -- the shop's plan has SMS,
 * the monthly allowance is not used up, the customer did not opt out, the
 * number is a mobile, and it is not the demo shop. Otherwise it stays
 * `pending`, exactly like before SMS existed. Never throws.
 */
async function sendAppointmentSms(
  kind: Exclude<SmsKind, "reminder">,
  businessId: string,
  appointment: Appointment,
  options: { previousDate?: string; suppress?: boolean } = {}
): Promise<NotifyResult> {
  let recipient = appointment.customer_phone;
  let message = legacySmsText(kind, appointment, options.previousDate);
  let deliver = false;
  let smsFrom: string | null = null;
  try {
    // No SMS provider on this server (the usual case until SMS are bought):
    // record the row exactly as before, without even reading the shop.
    const business = getNotificationProvider("sms") ? await getBusinessById(businessId) : null;
    if (business) {
      const plan = await planSms(kind, business, appointment, { previousDate: options.previousDate ?? null });
      message = plan.text;
      if (plan.send && !options.suppress) {
        recipient = plan.to;
        deliver = true;
        smsFrom = plan.from;
      }
    }
  } catch (err) {
    console.error("[notifications] sms planning failed:", err instanceof Error ? err.message : err);
  }
  return logNotification({
    businessId,
    appointmentId: appointment.id,
    channel: "sms",
    type: kind,
    recipient,
    message,
    deliver,
    smsFrom,
  });
}

/** The SMS reminder, already decided by services/sms-reminders.ts. True when it went out. */
export async function logSmsReminder(
  businessId: string,
  appointmentId: string,
  to: string,
  text: string,
  from: string | null
): Promise<boolean> {
  const result = await logNotification({
    businessId,
    appointmentId,
    channel: "sms",
    type: "reminder",
    recipient: to,
    message: text,
    deliver: true,
    smsFrom: from,
  });
  return wasDelivered(result);
}

export async function notifyAppointmentConfirmed(
  businessId: string,
  appointment: Appointment,
  options: NotifyOptions = {}
): Promise<NotifyResult> {
  if (!options.skipEmail) await sendAppointmentEmail("confirmation", businessId, appointment);
  // A recurring series confirms several appointments at once: one SMS, not one per occurrence.
  return sendAppointmentSms("confirmation", businessId, appointment, { suppress: options.skipEmail });
}

export async function notifyAppointmentCancelled(
  businessId: string,
  appointment: Appointment,
  options: NotifyOptions = {}
): Promise<NotifyResult> {
  if (!options.skipEmail) await sendAppointmentEmail("cancellation", businessId, appointment);
  return sendAppointmentSms("cancellation", businessId, appointment, { suppress: options.skipEmail });
}

export async function notifyAppointmentRescheduled(
  businessId: string,
  appointment: Appointment,
  previousDateISO: string,
  options: NotifyOptions = {}
): Promise<NotifyResult> {
  if (!options.skipEmail) await sendAppointmentEmail("rescheduled", businessId, appointment, previousDateISO);
  return sendAppointmentSms("rescheduled", businessId, appointment, { previousDate: previousDateISO, suppress: options.skipEmail });
}
