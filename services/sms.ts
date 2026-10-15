import "server-only";
import { businessHasFeature } from "@/lib/plans";
import { createServerClient } from "@/lib/supabase/server";
import { getNotificationProvider } from "@/lib/notifications/provider";
import { zonedDateTimeToInstant, zonedNow } from "@/lib/booking-rules";
import { isDemoBusiness } from "@/lib/demo";
import { isUuid } from "@/lib/ids";
import {
  buildSmsText,
  decideSms,
  parsePlatformSms,
  parseShopSmsChoices,
  readSmsSettings,
  type SmsKind,
  type SmsSettings,
  type SmsSkipReason,
} from "@/lib/sms";
import type { Business } from "@/types/businesses";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

/**
 * SMS to customers: the facts the rules in lib/sms.ts need (what this shop
 * sent this month, what the customer chose), and the shop's SMS settings.
 * Nothing here sends; services/notifications.ts and services/sms-reminders.ts
 * do, after asking planSms().
 */

/** Start of the current calendar month in the shop's own time zone, as an instant. */
export function monthStart(timeZone: string | null | undefined, now: Date = new Date()): Date {
  const today = zonedNow(timeZone, now).date;
  return zonedDateTimeToInstant(`${today.slice(0, 8)}01`, "00:00", timeZone);
}

/** SMS that went out for this shop since the start of its month. On a read error: the limit, to stay on the safe side. */
export async function countSmsSentThisMonth(business: Pick<Business, "id" | "timezone">, now: Date = new Date()): Promise<number> {
  const { count, error } = await db()
    .from("notification_log")
    .select("id", { count: "exact", head: true })
    .eq("business_id", business.id)
    .eq("channel", "sms")
    .in("status", ["sent", "delivered"])
    .gte("sent_at", monthStart(business.timezone, now).toISOString());
  if (error) {
    console.error("[sms] usage read failed:", JSON.stringify(error));
    return Number.POSITIVE_INFINITY;
  }
  return typeof count === "number" ? count : 0;
}

/** The customer's own choice (customers.sms_notifications). No customer linked -> allowed; read error -> not allowed. */
export async function customerAllowsSms(businessId: string, customerId: string | null | undefined): Promise<boolean> {
  if (!customerId) return true;
  const { data, error } = await db()
    .from("customers")
    .select("sms_notifications")
    .eq("business_id", businessId)
    .eq("id", customerId)
    .maybeSingle();
  if (error) {
    console.error("[sms] customer choice read failed:", JSON.stringify(error));
    return false;
  }
  return data?.sms_notifications !== false;
}

export type SmsPlan =
  | { send: true; to: string; text: string; from: string | null }
  | { send: false; reason: SmsSkipReason; text: string };

/**
 * Decides one SMS and prepares its text. Cheap checks first: the database is
 * asked about usage and the customer only when everything else says yes.
 */
export async function planSms(
  kind: SmsKind,
  business: Business,
  appointment: { customer_id?: string | null; customer_phone: string; appointment_date: string; appointment_time: string },
  options: { previousDate?: string | null; now?: Date } = {}
): Promise<SmsPlan> {
  const now = options.now ?? new Date();
  // A plan without SMS counts as "not switched on", whatever the settings say.
  const stored = readSmsSettings(business.settings);
  const settings = { ...stored, enabled: stored.enabled && businessHasFeature(business, "sms") };
  const text = buildSmsText(kind, {
    shopName: business.name,
    date: appointment.appointment_date,
    time: appointment.appointment_time,
    previousDate: options.previousDate ?? null,
    today: zonedNow(business.timezone, now).date,
  });
  const providerConfigured = getNotificationProvider("sms") !== null;
  const isDemo = isDemoBusiness(business);
  const kindOn = kind === "reminder" ? settings.reminders : settings.confirmations;

  let sentThisMonth = 0;
  let customerAllows = true;
  if (providerConfigured && !isDemo && settings.enabled && kindOn) {
    [sentThisMonth, customerAllows] = await Promise.all([
      countSmsSentThisMonth(business, now),
      customerAllowsSms(business.id, appointment.customer_id),
    ]);
  }

  const decision = decideSms({
    providerConfigured,
    isDemo,
    settings,
    kind,
    sentThisMonth,
    customerAllowsSms: customerAllows,
    phone: appointment.customer_phone,
  });
  return decision.send ? { send: true, to: decision.to, text, from: settings.senderName } : { send: false, reason: decision.reason, text };
}

// ── Settings ───────────────────────────────────────────────────────────────

export interface SmsOverview extends SmsSettings {
  providerConfigured: boolean;
  sentThisMonth: number;
}

export async function getSmsOverview(business: Business): Promise<SmsOverview> {
  const stored = readSmsSettings(business.settings);
  const settings = { ...stored, enabled: stored.enabled && businessHasFeature(business, "sms") };
  const sentThisMonth = await countSmsSentThisMonth(business);
  return {
    ...settings,
    providerConfigured: getNotificationProvider("sms") !== null,
    sentThisMonth: Number.isFinite(sentThisMonth) ? sentThisMonth : 0,
  };
}

/** Writes `patch` into businesses.settings (keeping every other key) and returns the result. */
export async function mergeBusinessSettings(
  businessId: string,
  patch: Record<string, unknown>,
  drop: string[] = []
): Promise<Record<string, unknown>> {
  if (!isUuid(businessId)) throw new Error("Η επιχείρηση δεν βρέθηκε.");
  const { data: current, error: readError } = await db().from("businesses").select("settings").eq("id", businessId).maybeSingle();
  if (readError || !current) {
    if (readError) console.error("[sms] settings read:", JSON.stringify(readError));
    throw new Error("Η επιχείρηση δεν βρέθηκε.");
  }
  const base = current.settings && typeof current.settings === "object" && !Array.isArray(current.settings) ? current.settings : {};
  const merged: Record<string, unknown> = { ...base, ...patch };
  for (const key of drop) delete merged[key];
  const { error } = await db().from("businesses").update({ settings: merged }).eq("id", businessId);
  if (error) {
    console.error("[sms] settings update:", JSON.stringify(error));
    throw new Error("Οι ρυθμίσεις δεν αποθηκεύτηκαν. Δοκίμασε ξανά.");
  }
  return merged;
}

async function mergeSettings(businessId: string, patch: Record<string, unknown>, drop: string[] = []): Promise<SmsSettings> {
  return readSmsSettings(await mergeBusinessSettings(businessId, patch, drop));
}

/** The shop's own choices (owner): which SMS, and the sender name. Never touches the plan switch. */
export async function updateShopSmsChoices(businessId: string, value: unknown): Promise<SmsSettings> {
  const next = parseShopSmsChoices(value);
  return mergeSettings(
    businessId,
    {
      sms_confirmations: next.confirmations,
      sms_reminders: next.reminders,
      ...(next.senderName ? { sms_sender_name: next.senderName } : {}),
    },
    next.senderName ? [] : ["sms_sender_name"]
  );
}

/** The platform owner's switch (Autopilot plan) and monthly allowance. Caller checks isPlatformAdmin. */
export async function updatePlatformSms(businessId: string, value: unknown, business?: Business): Promise<SmsSettings> {
  const next = parsePlatformSms(value);
  if (next.enabled && business && !businessHasFeature(business, "sms")) {
    throw new Error("Το κατάστημα είναι στο πακέτο Independence: τα SMS ανοίγουν με το Autopilot.");
  }
  return mergeSettings(businessId, { sms_enabled: next.enabled, sms_monthly_limit: next.monthlyLimit });
}

/** Staff side: the customer asked for SMS on or off. */
export async function setCustomerSms(businessId: string, customerId: string, allow: boolean): Promise<boolean> {
  if (!isUuid(businessId) || !isUuid(customerId) || typeof allow !== "boolean") throw new Error("Μη έγκυρη επιλογή.");
  const { data, error } = await db()
    .from("customers")
    .update({ sms_notifications: allow })
    .eq("business_id", businessId)
    .eq("id", customerId)
    .is("deleted_at", null)
    .select("sms_notifications")
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("[sms] customer choice update:", JSON.stringify(error));
    throw new Error("Η αλλαγή δεν αποθηκεύτηκε. Δοκίμασε ξανά.");
  }
  return data.sms_notifications !== false;
}
