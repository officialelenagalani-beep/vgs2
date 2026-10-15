import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import SectionHeading from "@/components/SectionHeading";
import QuickBook from "@/components/booking/QuickBook";
import { business } from "@/lib/data";
import { getBusinessBySlug } from "@/services/businesses";
import { getBusinessWorkingHours } from "@/services/business-hours";
import { businessHasFeature } from "@/lib/plans";
import { TEAM_PHOTOS } from "@/lib/gallery";

export const metadata: Metadata = {
  title: "Κλείσε Ραντεβού",
  description: `Κλείσε ραντεβού online στο ${business.name}: υπηρεσία, κουρέας, ώρα.`,
};

export const dynamic = "force-dynamic";

// The booking app in this site's colours (ink, bone, hairline; white to press).
const theme = {
  "--qb-card": "#15151A",
  "--qb-field": "#0F0F12",
  "--qb-ink": "#F1F1EF",
  "--qb-muted": "#9B9B98",
  "--qb-line": "#2B2B2E",
  "--qb-accent": "#F1F1EF",
  "--qb-on-accent": "#0A0A0B",
  "--qb-ring": "rgba(241, 241, 239, 0.08)",
  "--qb-shadow": "rgba(0, 0, 0, 0.9)",
} as CSSProperties;

export default async function BookingPage() {
  const shop = await getBusinessBySlug(business.slug).catch(() => null);
  if (!shop) notFound();
  const hours = await getBusinessWorkingHours(shop.id);
  return (
    <div className="min-h-screen pb-28 pt-36">
      <div className="container-xl">
        <SectionHeading align="center" eyebrow="Κράτηση" title="Κλείσε το ραντεβού σου." description="Υπηρεσία, κουρέας, ώρα. Σε ένα λεπτό." />
        <div className="mx-auto mt-14 max-w-3xl" style={theme}>
          <Suspense fallback={null}>
            <QuickBook
              slug={business.slug}
              shopName={business.name}
              closedWeekdays={hours.filter((d) => d.is_closed).map((d) => d.day_of_week as number)}
              discounts={businessHasFeature(shop, "discounts")}
              marketing={businessHasFeature(shop, "campaigns")}
              barberPhotos={TEAM_PHOTOS[business.slug]}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
