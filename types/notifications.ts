/**
 * Notification system types -- Phase 3 / Step 7.
 *
 * These mirror the existing `notification_log` table
 * (supabase/migrations/001_initial_schema.sql) exactly. Every union member
 * below is one of that table's actual CHECK-constraint values
 * (chk_notification_channel / chk_notification_type / chk_notification_status)
 * -- nothing here is invented; the schema was read first and these types
 * are derived from it, not the other way around.
 */

/** notification_log.channel -- chk_notification_channel */
export type NotificationChannel = "sms" | "email" | "whatsapp" | "push";

/** notification_log.type -- chk_notification_type */
export type NotificationType =
  | "confirmation"
  | "reminder"
  | "cancellation"
  | "rescheduled"
  | "custom";

/** notification_log.status -- chk_notification_status */
export type NotificationStatus = "pending" | "sent" | "delivered" | "failed";

/** A row as stored in / returned from notification_log. */
export interface NotificationLog {
  id: string;
  business_id: string;
  appointment_id: string | null;
  channel: NotificationChannel;
  type: NotificationType;
  recipient: string;
  status: NotificationStatus;
  provider: string | null;
  provider_message_id: string | null;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
}

/**
 * Provider-agnostic boundary. `services/notifications.ts` never talks to a
 * concrete SMS/email/WhatsApp/push vendor (Twilio, Resend, SendGrid, ...)
 * directly -- it only ever calls whatever implements this interface,
 * resolved through `lib/notifications/provider.ts`. An e-mail
 * implementation (Resend) exists there and is active only when configured;
 * SMS / WhatsApp / push have none yet.
 */
/**
 * What a provider is asked to deliver. `recipient` and `message` are all an
 * SMS-style channel needs; the optional fields carry what an e-mail needs
 * in addition. `message` is always the plain-text body.
 */
export interface NotificationSendInput {
  recipient: string;
  message: string;
  /** E-mail only. */
  subject?: string;
  /** E-mail only: HTML body. `message` is sent alongside as the text alternative. */
  html?: string;
  /** E-mail: full From header value, e.g. `Medusa Barber <bookings@example.gr>`. SMS: the shop's sender name, e.g. `KourioAlexi`. */
  from?: string;
  /** E-mail only: where a customer's reply should go (the business's own address). */
  replyTo?: string | null;
  /** Lets the provider discard an accidental second send of the same notification. */
  idempotencyKey?: string;
}

export interface NotificationProvider {
  /** Machine name persisted verbatim to notification_log.provider, e.g. 'twilio'. */
  name: string;
  send(input: NotificationSendInput): Promise<{
    /** Persisted to notification_log.provider_message_id when present. */
    providerMessageId?: string;
  }>;
}
