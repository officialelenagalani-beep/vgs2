/** Discount codes (migration 041_discount_codes.sql). */

export type DiscountKind = "percent" | "fixed";

export interface DiscountCode {
  id: string;
  business_id: string;
  code: string;
  description: string | null;
  kind: DiscountKind;
  value: number;
  valid_from: string | null;
  valid_until: string | null;
  max_uses: number | null;
  max_uses_per_customer: number | null;
  first_visit_only: boolean;
  service_ids: string[];
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A code plus how many bookings currently use it (not cancelled, not deleted). */
export interface DiscountCodeWithUses extends DiscountCode {
  uses: number;
}

/** What the admin form sends. */
export interface DiscountCodeInput {
  code: string;
  description: string | null;
  kind: DiscountKind;
  value: number;
  valid_from: string | null;
  valid_until: string | null;
  max_uses: number | null;
  /** true = each customer once; false = no per-customer limit. */
  once_per_customer: boolean;
  first_visit_only: boolean;
  service_ids: string[];
  is_active: boolean;
}

/** Reasons the database (and the preview) can refuse a code. */
export type DiscountRefusal =
  | "not_found"
  | "not_started"
  | "expired"
  | "wrong_service"
  | "used_up"
  | "customer_limit"
  | "first_visit";

export const DISCOUNT_REFUSAL_MESSAGES_EL: Record<DiscountRefusal, string> = {
  not_found: "Ο κωδικός δεν ισχύει.",
  not_started: "Ο κωδικός δεν ισχύει ακόμα.",
  expired: "Ο κωδικός έχει λήξει.",
  wrong_service: "Ο κωδικός δεν ισχύει για αυτή την υπηρεσία.",
  used_up: "Ο κωδικός έχει εξαντληθεί.",
  customer_limit: "Έχεις ήδη χρησιμοποιήσει αυτόν τον κωδικό.",
  first_visit: "Ο κωδικός ισχύει μόνο για την πρώτη επίσκεψη.",
};
