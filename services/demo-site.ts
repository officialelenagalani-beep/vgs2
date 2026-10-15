import "server-only";
import { createServerClient } from "@/lib/supabase/server";
import { getBusinessBySlug } from "@/services/businesses";
import { getPublicServiceCatalog, type PublicCatalogCategory } from "@/services/catalog";
import { getBusinessWorkingHours } from "@/services/business-hours";
import { getPublicReviews, getPublicReviewSummary } from "@/services/reviews";
import { listPlans } from "@/services/memberships";
import { getBusinessLoyaltySettings } from "@/services/loyalty";
import { businessHasFeature } from "@/lib/plans";
import type { Business } from "@/types/businesses";
import type { WeeklySchedule } from "@/types/employees";
import type { PublicReview, PublicReviewSummary } from "@/types/reviews";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

/**
 * Everything the website of an Autopilot shop shows, read from the shop's
 * own records (services, team, hours, reviews, points, memberships), so the
 * site is always in step with what the owner changes in the admin.
 * Only public information: no customer data beyond approved reviews, which
 * already show only first name and initial.
 */

export type SiteBarber = { id: string; name: string; isOwner: boolean; daysOff: number[] };

export type ShopSite = {
  business: Business;
  categories: PublicCatalogCategory[];
  team: SiteBarber[];
  hours: WeeklySchedule;
  reviews: PublicReview[];
  summary: PublicReviewSummary;
  loyalty: { pointsPerEuro: number; euroPerPoint: number } | null;
  memberships: Array<{ name: string; price: number; visits: number; description: string | null }>;
  features: { reviews: boolean; loyalty: boolean; memberships: boolean; giftCards: boolean; discounts: boolean; campaigns: boolean };
};

export async function loadShopSite(slug: string): Promise<ShopSite | null> {
  const business = await getBusinessBySlug(slug).catch(() => null);
  if (!business) return null;
  const id = business.id;
  const has = {
    reviews: businessHasFeature(business, "reviews"),
    loyalty: businessHasFeature(business, "loyalty"),
    memberships: businessHasFeature(business, "memberships"),
    giftCards: businessHasFeature(business, "gift_cards"),
    discounts: businessHasFeature(business, "discounts"),
    campaigns: businessHasFeature(business, "campaigns"),
  };

  const [catalog, employees, employeeHours, hours, reviews, summary, plans, loyalty] = await Promise.all([
    getPublicServiceCatalog(id),
    db().from("employees").select("id, name, role, created_at").eq("business_id", id).eq("is_active", true).order("created_at"),
    db().from("employee_working_hours").select("employee_id, day_of_week, is_closed").eq("business_id", id),
    getBusinessWorkingHours(id),
    has.reviews ? getPublicReviews(id, 6).catch(() => []) : Promise.resolve([] as PublicReview[]),
    has.reviews ? getPublicReviewSummary(id).catch(() => ({ count: 0, average: null })) : Promise.resolve({ count: 0, average: null }),
    has.memberships ? listPlans(id).catch(() => []) : Promise.resolve([]),
    has.loyalty ? getBusinessLoyaltySettings(id).catch(() => null) : Promise.resolve(null),
  ]);

  const shopClosed = new Set(hours.filter((d) => d.is_closed).map((d) => d.day_of_week as number));
  const offByEmployee = new Map<string, number[]>();
  for (const row of (employeeHours.data ?? []) as Array<{ employee_id: string; day_of_week: number; is_closed: boolean }>) {
    if (row.is_closed && !shopClosed.has(row.day_of_week)) {
      offByEmployee.set(row.employee_id, [...(offByEmployee.get(row.employee_id) ?? []), row.day_of_week]);
    }
  }

  return {
    business,
    categories: catalog.categories,
    team: ((employees.data ?? []) as Array<{ id: string; name: string; role: string }>).map((e) => ({
      id: e.id,
      name: e.name,
      isOwner: e.role === "owner",
      daysOff: (offByEmployee.get(e.id) ?? []).sort(),
    })),
    hours,
    reviews,
    summary,
    loyalty:
      loyalty && loyalty.is_enabled
        ? { pointsPerEuro: Number(loyalty.earn_rate_points_per_currency_unit), euroPerPoint: Number(loyalty.redemption_value_per_point) }
        : null,
    memberships: plans
      .filter((p) => p.is_active)
      .map((p) => ({ name: p.name, price: Number(p.price), visits: p.visits_per_month, description: p.description })),
    features: has,
  };
}
