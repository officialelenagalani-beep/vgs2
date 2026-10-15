import type { Metadata } from "next";
import Reveal from "@/components/Reveal";
import SectionHeading from "@/components/SectionHeading";
import MapSection from "@/components/MapSection";
import { business } from "@/lib/data";

export const metadata: Metadata = {
  title: "Τοποθεσία & Ώρες",
  description: `Βρες το ${business.name} στη διεύθυνση ${business.street}, ${business.city}. Ώρες λειτουργίας και οδηγίες.`,
};

export default function LocationPage() {
  return (
    <div className="pt-36 pb-28">
      <div className="container-xl">
        <Reveal>
          <SectionHeading
            eyebrow="Τοποθεσία"
            title="Στο κέντρο της Πάτρας."
            description="Στην Κορίνθου, λίγα στενά από την πλατεία Γεωργίου."
          />
        </Reveal>

        <Reveal delay={0.15} className="mt-16">
          <MapSection />
        </Reveal>
      </div>
    </div>
  );
}
