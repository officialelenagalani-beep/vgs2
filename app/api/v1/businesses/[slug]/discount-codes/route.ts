import { NextRequest } from "next/server";
import { businessHasFeature } from "@/lib/plans";
import { resolveBusiness, ok, err, tooManyRequests } from "../../../_middleware";
import { checkRateLimit, extractIpFromRequest, retryAfterHeader } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/json-body";
import { discountRefusalMessage } from "@/lib/discounts";
import { previewDiscount } from "@/services/discount-codes";

type Params = { params: Promise<{ slug: string }> };

/**
 * POST /api/v1/businesses/:slug/discount-codes
 * Body: { "code": "FIRST10", "service": "<service slug>" }
 *
 * Lets the booking form show the discounted price before the customer
 * books. It never reserves anything: the code is checked again (with the
 * customer's phone) by the database when the booking is saved.
 * Rate-limited per IP and business so codes cannot be guessed by trying many.
 */
export async function POST(request: NextRequest, ctx: Params) {
  const params = await ctx.params;
  const result = await resolveBusiness(params.slug);
  if (!result.ok) return result.response;
  if (!businessHasFeature(result.business, "discounts")) return err(discountRefusalMessage("not_found"), 400);

  const limit = await checkRateLimit(`discount:ip:${result.business.id}:${extractIpFromRequest(request)}`, 20, 600);
  if (!limit.allowed) return tooManyRequests("Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγο.", retryAfterHeader(limit));

  const parsed = await readJsonBody(request, 2_000);
  if (!parsed.ok) return err("Μη έγκυρο αίτημα.", 400);

  const preview = await previewDiscount(result.business, parsed.body.code, parsed.body.service);
  if (!preview.ok) {
    return err(preview.reason === "bad_service" ? "Η υπηρεσία δεν βρέθηκε." : discountRefusalMessage(preview.reason), 400);
  }
  return ok({
    code: preview.code,
    description: preview.description,
    price: preview.price,
    discount: preview.discount,
    final_price: preview.finalPrice,
    first_visit_only: preview.firstVisitOnly,
    once_per_customer: preview.oncePerCustomer,
  });
}
