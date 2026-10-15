/**
 * Discount codes -- pure helpers shared by the server, the booking form and
 * the admin. The database trigger (migration 041) is the authority on
 * whether a code applies and how much it takes off; these functions mirror
 * its arithmetic for previews and display.
 */
import { DISCOUNT_REFUSAL_MESSAGES_EL, type DiscountKind, type DiscountRefusal } from "@/types/discount-codes";

export const DISCOUNT_CODE_PATTERN = /^[A-Z0-9_-]{4,32}$/;

/** What the customer typed -> the stored form (trimmed, upper-case). */
export function normalizeDiscountCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

export function isDiscountCodeFormat(code: string): boolean {
  return DISCOUNT_CODE_PATTERN.test(code);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Money taken off `price` -- same rule as the trigger: percent rounded to cents, never above the price. */
export function computeDiscountAmount(kind: DiscountKind, value: number, price: number): number {
  const p = Number(price);
  const v = Number(value);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(v) || v <= 0) return 0;
  const raw = kind === "percent" ? round2((p * v) / 100) : round2(v);
  return Math.min(Math.max(raw, 0), round2(p));
}

/** What the customer pays for an appointment row (service_price minus any discount). */
export function paidPrice(row: { service_price?: number | string | null; discount_amount?: number | string | null }): number {
  const price = Number(row.service_price) || 0;
  const discount = Number(row.discount_amount) || 0;
  return round2(Math.max(0, price - discount));
}

const REFUSALS: DiscountRefusal[] = ["not_found", "not_started", "expired", "wrong_service", "used_up", "customer_limit", "first_visit"];

/** Reads the trigger's "discount_code:<reason>" error. Null when the error is something else. */
export function discountRefusalFromError(message: unknown): DiscountRefusal | null {
  if (typeof message !== "string") return null;
  const m = /discount_code:([a-z_]+)/.exec(message);
  if (!m) return null;
  return (REFUSALS as string[]).includes(m[1]) ? (m[1] as DiscountRefusal) : null;
}

export function discountRefusalMessage(reason: DiscountRefusal): string {
  return DISCOUNT_REFUSAL_MESSAGES_EL[reason];
}

/** Code-level checks the preview can do without knowing the customer (dates, service, total uses). */
export function previewRefusal(
  code: { is_active: boolean; valid_from: string | null; valid_until: string | null; service_ids: string[]; max_uses: number | null },
  ctx: { today: string; serviceId: string | null; uses: number }
): DiscountRefusal | null {
  if (!code.is_active) return "not_found";
  if (code.valid_from && ctx.today < code.valid_from) return "not_started";
  if (code.valid_until && ctx.today > code.valid_until) return "expired";
  if (code.service_ids.length > 0 && (!ctx.serviceId || !code.service_ids.includes(ctx.serviceId))) return "wrong_service";
  if (code.max_uses !== null && ctx.uses >= code.max_uses) return "used_up";
  return null;
}

/** "−10%" / "−5,00 €" for lists. */
export function describeDiscount(kind: DiscountKind, value: number): string {
  return kind === "percent" ? `−${Number(value)}%` : `−${Number(value).toFixed(2).replace(".", ",")} €`;
}

/** A discount code the database refused for a booking; `message` is the Greek text for the customer. */
export class DiscountCodeError extends Error {
  readonly reason: DiscountRefusal;
  constructor(reason: DiscountRefusal) {
    super(discountRefusalMessage(reason));
    this.name = "DiscountCodeError";
    this.reason = reason;
  }
}
