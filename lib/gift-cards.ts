/**
 * Gift cards -- pure helpers (codes, amounts, error mapping).
 * Codes are 12 characters from an alphabet without look-alikes (no I, O, 0, 1),
 * shown as XXXX-XXXX-XXXX: 32^12 ≈ 10^18 possibilities, so they cannot be guessed.
 */
import { GIFT_CARD_REFUSAL_MESSAGES_EL, type GiftCardRefusal } from "@/types/gift-cards";

export const GIFT_CARD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const GIFT_CARD_CODE_LENGTH = 12;
export const GIFT_CARD_MAX_AMOUNT = 10_000;
const CODE_RE = /^[A-HJ-NP-Z2-9]{12}$/;

/** Cryptographically random code (rejection sampling keeps every character equally likely). */
export function generateGiftCardCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let out = "";
  while (out.length < GIFT_CARD_CODE_LENGTH) {
    for (const b of random(GIFT_CARD_CODE_LENGTH * 2)) {
      if (b < 256 - (256 % GIFT_CARD_ALPHABET.length)) out += GIFT_CARD_ALPHABET[b % GIFT_CARD_ALPHABET.length];
      if (out.length === GIFT_CARD_CODE_LENGTH) break;
    }
  }
  return out;
}

/** What staff typed ("abcd-efgh jk23") -> stored form ("ABCDEFGHJK23"). */
export function normalizeGiftCardCode(raw: unknown): string {
  return typeof raw === "string" ? raw.toUpperCase().replace(/[\s-]/g, "") : "";
}

export function isGiftCardCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** "ABCDEFGHJK23" -> "ABCD-EFGH-JK23" */
export function formatGiftCardCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

/** A money amount from a form: number, > 0, at most 2 decimals, at most the max. Null when not valid. */
export function parseMoney(value: unknown, max = GIFT_CARD_MAX_AMOUNT): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.replace(",", ".")) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return null;
  return Math.round(n * 100) / 100;
}

const REFUSALS = Object.keys(GIFT_CARD_REFUSAL_MESSAGES_EL) as GiftCardRefusal[];

export function giftCardRefusalFromError(message: unknown): GiftCardRefusal | null {
  if (typeof message !== "string") return null;
  const m = /gift_card:([a-z_]+)/.exec(message);
  return m && (REFUSALS as string[]).includes(m[1]) ? (m[1] as GiftCardRefusal) : null;
}

export function formatMoneyEl(n: number): string {
  return `${(Math.round(Number(n) * 100) / 100).toFixed(2).replace(".", ",")} €`;
}
