import type { Metadata } from "next";
import Reveal from "@/components/Reveal";
import SectionHeading from "@/components/SectionHeading";
import ServicesGrid from "@/components/ServicesGrid";
import ButtonLink from "@/components/ButtonLink";
import { business, sitePath } from "@/lib/data";
import { getBusinessBySlug } from "@/services/businesses";
import { getPublicServiceCatalog } from "@/services/catalog";

export const metadata: Metadata = {
  title: "Υπηρεσίες & Τιμές",
  description: `Τιμοκατάλογος ${business.name}: κούρεμα, fade, γένια. Δες τιμές και κλείσε ραντεβού online.`,
};

export const dynamic = "force-dynamic";

export default async function ServicesPage() {
  const shop = await getBusinessBySlug(business.slug).catch(() => null);
  const catalog = shop ? await getPublicServiceCatalog(shop.id) : { categories: [] };

  return (
    <div className="pt-36 pb-28">
      <div className="container-xl">
        <Reveal>
          <SectionHeading
            eyebrow="Υπηρεσίες & Τιμές"
            title="Κάθε υπηρεσία, με την ίδια ακρίβεια."
            description="Διαφανείς τιμές, ξεκάθαρος χρόνος. Επίλεξε υπηρεσία και κλείσε την ώρα σου σε λιγότερο από ένα λεπτό."
          />
        </Reveal>

        <Reveal delay={0.15} className="mt-16">
          <ServicesGrid categories={catalog.categories.map((cat) => ({
            id: cat.id,
            label: cat.label,
            services: cat.services.map((s) => ({ id: s.slug, name: s.name, duration: s.duration, price: s.price })),
          }))} />
        </Reveal>

        <Reveal delay={0.1} className="mt-16 text-center">
          <ButtonLink href={sitePath("/booking")}>Κλείσε Ραντεβού</ButtonLink>
        </Reveal>
      </div>
    </div>
  );
}
