import { NextRequest } from "next/server";
import { resolveBusiness, ok, tooManyRequests } from "../../../_middleware";
import { getPublicServiceCatalog, getPublicTeam } from "@/services/catalog";
import { checkRateLimit, extractIpFromRequest, retryAfterHeader } from "@/lib/rate-limit";
import { isCustomerEmailEnabled } from "@/services/notifications";

type Params = { params: Promise<{ slug: string }> };

/**
 * GET /api/v1/businesses/:slug/services
 *
 * Phase 4 / Step 17: previously read from lib/services.ts (a single,
 * hardcoded, single-tenant static catalog -- see the Step 16 audit's gap
 * #6). Now reads the real, per-business `services` DB table via
 * services/catalog.ts. Response shape is unchanged from before this
 * change (still `{ id, name, duration, price, currency }` per service,
 * `id` being the service's slug -- see PublicCatalogService's own doc
 * comment for why) -- existing consumers of this endpoint do not need to
 * change.
 *
 * The response also carries `booking.email_confirmation` (boolean) and
 * `team` / `team_by_service` (who can be chosen for which service) --
 * additive fields; existing consumers can ignore them.
 *
 * Step 23C: same read-only, generous, IP+business-keyed rate limit as
 * the availability endpoint (60/min), checked before the
 * getPublicServiceCatalog() DB work.
 */
export async function GET(request: NextRequest, ctx: Params) {
  const params = await ctx.params;
  const result = await resolveBusiness(params.slug);
  if (!result.ok) return result.response;

  const ip = extractIpFromRequest(request);
  const rateLimit = await checkRateLimit(`services:ip:${result.business.id}:${ip}`, 60, 60);
  if (!rateLimit.allowed) {
    return tooManyRequests(
      "Πάρα πολλά αιτήματα. Δοκιμάστε ξανά σε λίγο.",
      retryAfterHeader(rateLimit)
    );
  }

  const [catalog, team] = await Promise.all([
    getPublicServiceCatalog(result.business.id),
    getPublicTeam(result.business.id),
  ]);

  return ok({
    // Additive: tells the booking form whether to offer the optional e-mail
    // field. True only when confirmation e-mails are really switched on for
    // this business (see isCustomerEmailEnabled()).
    booking: { email_confirmation: isCustomerEmailEnabled(result.business) },
    categories: catalog.categories.map((cat) => ({
      id: cat.id,
      label: cat.label,
      services: cat.services.map((s) => ({
        id: s.slug, name: s.name, duration: s.duration, price: s.price, currency: result.business.currency,
      })),
    })),
    // Additive: the barbers a customer can choose, and which of them does
    // each service (by service id = slug). Empty when the team can't be
    // read; the booking page then books "whoever is free".
    team: team.members,
    team_by_service: team.byService,
    all: catalog.all.map((s) => ({
      id: s.slug, category: s.category_id, name: s.name, duration: s.duration, price: s.price, currency: result.business.currency,
    })),
  });
}
