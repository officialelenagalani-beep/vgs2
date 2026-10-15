/**
 * Phase 4 / Step 25 -- Loyalty.
 *
 * Mirrors business_loyalty_settings / service_loyalty_settings /
 * loyalty_ledger (021/022/023_loyalty_*.sql). Kept as its own file,
 * matching this project's existing convention of one types file per
 * feature (types/audit-log.ts, types/customers.ts, etc).
 */

/**
 * Deliberately a closed, exhaustive list matching loyalty_ledger's own
 * chk_loyalty_ledger_transaction_type CHECK constraint -- same pattern
 * as types/audit-log.ts's AuditAction.
 */
export type LoyaltyTransactionType = "earn" | "redeem" | "reversal" | "manual_adjustment";

/** Greek display labels -- same pattern as STATUS_LABELS_EL (types/appointments.ts). */
export const LOYALTY_TRANSACTION_LABELS_EL: Record<LoyaltyTransactionType, string> = {
  earn: "Συγκέντρωση",
  redeem: "Εξαργύρωση",
  reversal: "Αναστροφή",
  manual_adjustment: "Χειροκίνητη προσαρμογή",
};

/** One row as read back from business_loyalty_settings. */
export interface BusinessLoyaltySettings {
  business_id: string;
  is_enabled: boolean;
  earn_rate_points_per_currency_unit: number;
  redemption_value_per_point: number;
  min_redemption_points: number;
  max_redemption_percent: number;
  daily_redemption_limit_points: number | null;
  monthly_redemption_limit_points: number | null;
  /** Migration 041: largest manual adjustment an employee may make at once (either sign). NULL = no limit. */
  employee_adjustment_limit_points: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * A business that has never configured loyalty has no
 * business_loyalty_settings row at all (021_business_loyalty_settings.sql's
 * own header) -- getBusinessLoyaltySettings() (services/loyalty.ts)
 * returns this shape in that case, matching a disabled, all-zero
 * configuration. is_enabled = false either way is what every earning/
 * redemption check gates on, so the "row absent" and "row present but
 * disabled" cases behave identically to every caller.
 */
export const DEFAULT_BUSINESS_LOYALTY_SETTINGS: Omit<BusinessLoyaltySettings, "business_id" | "created_at" | "updated_at"> = {
  is_enabled: false,
  earn_rate_points_per_currency_unit: 0,
  redemption_value_per_point: 0,
  min_redemption_points: 0,
  max_redemption_percent: 100,
  daily_redemption_limit_points: null,
  monthly_redemption_limit_points: null,
  employee_adjustment_limit_points: 50,
};

export interface UpdateBusinessLoyaltySettingsInput {
  is_enabled?: boolean;
  earn_rate_points_per_currency_unit?: number;
  redemption_value_per_point?: number;
  min_redemption_points?: number;
  max_redemption_percent?: number;
  daily_redemption_limit_points?: number | null;
  monthly_redemption_limit_points?: number | null;
  employee_adjustment_limit_points?: number | null;
}

/** One row as read back from service_loyalty_settings. */
export interface ServiceLoyaltySettings {
  id: string;
  business_id: string;
  service_id: string;
  earn_allowed: boolean;
  redemption_allowed: boolean;
  restrict_same_service_redemption: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * getServiceLoyaltySettings()'s return shape -- always fully resolved
 * (defaults applied when no row exists, per rule 15), so every caller can
 * read earn_allowed/redemption_allowed/restrict_same_service_redemption
 * unconditionally. `id`/`created_at`/`updated_at` are null when no
 * service_loyalty_settings row actually exists yet -- present only to let
 * the settings-editing UI distinguish "showing you the defaults" from
 * "this is a saved override", never required for the earning/redemption
 * logic itself.
 */
export interface ResolvedServiceLoyaltySettings {
  id: string | null;
  business_id: string;
  service_id: string;
  earn_allowed: boolean;
  redemption_allowed: boolean;
  restrict_same_service_redemption: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * Rule 15: a service with no row uses these permissive defaults. Every
 * read path (getServiceLoyaltySettings() and the earning/redemption logic
 * itself) falls back to this shape rather than treating "no row" as an
 * error or as "loyalty disabled for this service".
 */
export const DEFAULT_SERVICE_LOYALTY_SETTINGS: Omit<ServiceLoyaltySettings, "id" | "business_id" | "service_id" | "created_at" | "updated_at"> = {
  earn_allowed: true,
  redemption_allowed: true,
  restrict_same_service_redemption: false,
};

export interface UpdateServiceLoyaltySettingsInput {
  earn_allowed?: boolean;
  redemption_allowed?: boolean;
  restrict_same_service_redemption?: boolean;
}

/** One row as read back from loyalty_ledger. */
export interface LoyaltyLedgerEntry {
  id: string;
  business_id: string;
  customer_id: string;
  appointment_id: string | null;
  service_id: string | null;
  transaction_type: LoyaltyTransactionType;
  amount: number;
  reason: string | null;
  reverses_transaction_id: string | null;
  actor_id: string | null;
  actor_email: string | null;
  idempotency_key: string;
  created_at: string;
}

export const LOYALTY_LEDGER_PAGE_SIZE = 50;

export interface LoyaltyLedgerPage {
  entries: LoyaltyLedgerEntry[];
  hasMore: boolean;
}

/** Input for createManualLoyaltyAdjustment() (services/loyalty.ts). */
export interface CreateManualLoyaltyAdjustmentInput {
  businessId: string;
  customerId: string;
  amount: number;
  reason: string;
  actorId: string;
  actorEmail: string | null;
}

/** Input for redeemLoyaltyPoints() (services/loyalty.ts). */
export interface RedeemLoyaltyPointsInput {
  businessId: string;
  customerId: string;
  serviceId: string;
  points: number;
  /**
   * One id per redemption the staff member intends (the dashboard creates
   * it when the redemption window opens). Sending the same request twice --
   * a double click, a retry after a timeout -- then redeems ONCE: it becomes
   * the ledger's idempotency key. Optional for older callers (a random key
   * is used then).
   */
  requestId?: string;
}

/**
 * Result of calculateAvailableRedemption() -- everything the redemption
 * UI/logic needs to know BEFORE attempting an actual redemption: how many
 * points the customer could redeem against this specific service right
 * now, and the monetary value that represents. A pure read -- never
 * writes to the ledger.
 */
export interface AvailableRedemption {
  /** Whether redemption is possible at all for this customer/service combination right now. */
  eligible: boolean;
  /** Human-readable reason redemption is not currently possible, when eligible = false. */
  reason: string | null;
  /** The customer's total loyalty balance (SUM of all ledger entries), independent of eligibility for this specific service. */
  totalBalance: number;
  /** Points eligible to redeem specifically against this service (excludes same-service-restricted-origin points when applicable). */
  eligiblePoints: number;
  /** min(eligiblePoints, the max-% cap for this service's price, remaining daily/monthly allowance). The most a redemption call would actually accept right now. */
  maxRedeemablePoints: number;
  /** maxRedeemablePoints * redemption_value_per_point. */
  maxRedeemableValue: number;
}
