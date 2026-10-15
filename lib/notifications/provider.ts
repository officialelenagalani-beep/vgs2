import type { NotificationChannel, NotificationProvider, NotificationSendInput } from "@/types/notifications";

/**
 * Provider resolution boundary -- Phase 3 / Step 7, extended with a real
 * e-mail provider.
 *
 * `services/notifications.ts` asks this module "is there a real provider
 * configured for this channel?" instead of talking to a vendor itself.
 *
 *   email     -> Resend, but ONLY when the RESEND_API_KEY environment
 *                variable is set. Without it this returns null, exactly as
 *                before, and nothing is ever sent.
 *   sms       -> Twilio, only when the TWILIO_* variables are set (see below).
 *   whatsapp / push -> null. No provider exists for them yet.
 *
 * Returning `null` is a deliberate, valid state: `services/notifications.ts`
 * then logs the notification as `status: 'pending'` and moves on without
 * attempting to send anything.
 *
 * No vendor SDK is used -- the provider is one HTTPS call made with the
 * platform's own fetch(), so package.json is unchanged. This is the same
 * approach (and the same Resend endpoint) the travel module's enquiry
 * function already uses.
 */

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 8000;
/** Printable ASCII, no spaces: safe to place inside an HTTP header. */
const RESEND_KEY_RE = /^[\x21-\x7E]{8,200}$/;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Builds the Resend e-mail provider. `fetchImpl` is injectable so the
 * provider can be unit-tested without any network access.
 *
 * send() THROWS on every failure (missing sender, timeout, non-2xx reply).
 * That is the contract services/notifications.ts expects: it catches the
 * error and records the notification as `failed` with the message. The
 * error text never contains the API key or the recipient's address.
 */
export function createResendEmailProvider(apiKey: string, fetchImpl: FetchLike = fetch): NotificationProvider {
  return {
    name: "resend",
    async send(input: NotificationSendInput) {
      if (!input.from) throw new Error("Δεν έχει οριστεί διεύθυνση αποστολέα.");
      if (!input.subject) throw new Error("Λείπει το θέμα του email.");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
      try {
        const response = await fetchImpl(RESEND_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from: input.from,
            to: [input.recipient],
            ...(input.replyTo ? { reply_to: input.replyTo } : {}),
            subject: input.subject,
            text: input.message,
            ...(input.html ? { html: input.html } : {}),
            // Marks the message as automatic, so other mail systems do not auto-answer it.
            headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Ο πάροχος email απάντησε με κωδικό ${response.status}.`);
        }
        const data = (await response.json().catch(() => null)) as { id?: unknown } | null;
        return { providerMessageId: typeof data?.id === "string" ? data.id : undefined };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error("Ο πάροχος email δεν απάντησε εγκαίρως.");
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function getNotificationProvider(channel: NotificationChannel): NotificationProvider | null {
  if (channel === "email") {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) return null; // not configured: e-mail stays switched off
    if (!RESEND_KEY_RE.test(apiKey)) {
      console.error("[notifications] RESEND_API_KEY does not look like an API key; e-mail stays switched off");
      return null;
    }
    return createResendEmailProvider(apiKey);
  }

  if (channel === "sms") {
    const twilio = readTwilioConfig();
    return twilio ? createTwilioSmsProvider(twilio) : null;
  }

  // No WhatsApp / push provider is configured in this project.
  // Intentionally not stubbed with a fake "always succeeds" implementation
  // -- an honest `null` is what lets the notification service log `pending`
  // instead of falsely claiming something was `sent`.
  return null;
}

// ── SMS: Twilio ────────────────────────────────────────────────────────────
//
// Switched on ONLY when the server has:
//   TWILIO_ACCOUNT_SID   AC + 32 hex characters
//   TWILIO_AUTH_TOKEN    32 hex characters
//   and one of:
//   TWILIO_MESSAGING_SERVICE_SID   MG + 32 hex (recommended: Twilio picks the sender)
//   TWILIO_SMS_FROM                a number (+30...) or a sender name (3-11 letters/digits)
// Anything missing or malformed -> null, and no SMS is ever attempted.
// Even with a provider, services/sms.ts still decides per shop and per
// customer whether a message may go out (lib/sms.ts, decideSms).

const TWILIO_TIMEOUT_MS = 8000;
const TWILIO_SID_RE = /^AC[0-9a-fA-F]{32}$/;
const TWILIO_TOKEN_RE = /^[0-9a-fA-F]{32}$/;
const TWILIO_SERVICE_RE = /^MG[0-9a-fA-F]{32}$/;
const TWILIO_FROM_RE = /^(\+\d{8,15}|[A-Za-z0-9 ]{3,11})$/;

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string | null;
  from: string | null;
}

export function readTwilioConfig(env: Record<string, string | undefined> = process.env): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const service = env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? "";
  const from = env.TWILIO_SMS_FROM?.trim() ?? "";
  if (!TWILIO_SID_RE.test(accountSid) || !TWILIO_TOKEN_RE.test(authToken)) return null;
  const messagingServiceSid = TWILIO_SERVICE_RE.test(service) ? service : null;
  const fromOk = TWILIO_FROM_RE.test(from) ? from : null;
  if (!messagingServiceSid && !fromOk) return null;
  return { accountSid, authToken, messagingServiceSid, from: fromOk };
}

/**
 * Builds the Twilio SMS provider (one HTTPS call, no SDK). `input.from` may
 * carry the shop's own sender name; otherwise the platform's sender is used.
 * Like the e-mail provider, send() THROWS on any failure and the error never
 * contains the token or the phone number.
 */
export function createTwilioSmsProvider(config: TwilioConfig, fetchImpl: FetchLike = fetch): NotificationProvider {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
  return {
    name: "twilio",
    async send(input: NotificationSendInput) {
      if (!/^\+\d{8,15}$/.test(input.recipient)) throw new Error("Μη έγκυρος αριθμός κινητού.");
      if (!input.message) throw new Error("Κενό μήνυμα.");
      const body = new URLSearchParams({ To: input.recipient, Body: input.message });
      if (config.messagingServiceSid) body.set("MessagingServiceSid", config.messagingServiceSid);
      const from = input.from && TWILIO_FROM_RE.test(input.from) ? input.from : config.from;
      if (from) body.set("From", from);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TWILIO_TIMEOUT_MS);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: controller.signal,
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as { code?: unknown } | null;
          const code = typeof data?.code === "number" ? ` (${data.code})` : "";
          throw new Error(`Ο πάροχος SMS απάντησε με κωδικό ${response.status}${code}.`);
        }
        const data = (await response.json().catch(() => null)) as { sid?: unknown } | null;
        return { providerMessageId: typeof data?.sid === "string" ? data.sid : undefined };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw new Error("Ο πάροχος SMS δεν απάντησε εγκαίρως.");
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
