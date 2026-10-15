/** Gift cards (migration 042_gift_cards.sql). */

export type GiftCardStatus = "active" | "void";
export type GiftCardTxKind = "issue" | "redeem" | "refund";

export interface GiftCard {
  id: string;
  business_id: string;
  code: string;
  initial_amount: number;
  purchaser_name: string | null;
  recipient_name: string | null;
  note: string | null;
  expires_on: string | null;
  status: GiftCardStatus;
  voided_at: string | null;
  created_at: string;
}

export interface GiftCardTransaction {
  id: string;
  gift_card_id: string;
  kind: GiftCardTxKind;
  amount: number;
  appointment_id: string | null;
  reverses_transaction_id: string | null;
  note: string | null;
  actor_email: string | null;
  created_at: string;
}

/** A card with its current balance (sum of its transactions). */
export interface GiftCardWithBalance extends GiftCard {
  balance: number;
}

export interface GiftCardDetail extends GiftCardWithBalance {
  transactions: GiftCardTransaction[];
  /** ids of redeem transactions that were already undone */
  reversed: string[];
}

export interface GiftCardSummary {
  /** Active, not expired, balance > 0. */
  activeCount: number;
  /** Money still to be spent on active, not expired cards. */
  outstanding: number;
  /** Sold since the 1st of this month (business calendar). */
  soldThisMonthCount: number;
  soldThisMonthAmount: number;
}

export type GiftCardRefusal =
  | "not_found"
  | "void"
  | "expired"
  | "insufficient"
  | "bad_amount"
  | "already_reversed"
  | "not_redeem"
  | "bad_appointment";

export const GIFT_CARD_REFUSAL_MESSAGES_EL: Record<GiftCardRefusal, string> = {
  not_found: "Η δωροκάρτα δεν βρέθηκε.",
  void: "Η δωροκάρτα έχει ακυρωθεί.",
  expired: "Η δωροκάρτα έχει λήξει.",
  insufficient: "Το υπόλοιπο της δωροκάρτας δεν φτάνει.",
  bad_amount: "Μη έγκυρο ποσό.",
  already_reversed: "Η χρέωση έχει ήδη αναιρεθεί.",
  not_redeem: "Αναιρείται μόνο χρέωση.",
  bad_appointment: "Το ραντεβού δεν βρέθηκε.",
};
