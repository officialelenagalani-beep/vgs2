import type { Metadata } from "next";
import Reveal from "@/components/Reveal";
import SectionHeading from "@/components/SectionHeading";
import WorkGallery from "@/components/WorkGallery";
import ButtonLink from "@/components/ButtonLink";
import { business, sitePath } from "@/lib/data";

export const metadata: Metadata = {
  title: "Gallery",
  description: `Δουλειές από την καρέκλα του ${business.name}.`,
};

export default function GalleryPage() {
  return (
    <div className="pt-36 pb-28">
      <div className="container-xl">
        <Reveal>
          <SectionHeading
            eyebrow="Οι Δουλειές Μας"
            title="Από την καρέκλα μας."
            description="Κουρέματα από την καρέκλα μας, οργανωμένα ανά κατηγορία."
          />
        </Reveal>

        <Reveal delay={0.15} className="mt-14">
          <WorkGallery />
        </Reveal>
      </div>

      <div className="container-xl mt-4 text-center">
        <Reveal>
          <ButtonLink href={sitePath("/booking")}>Κλείσε Ραντεβού</ButtonLink>
        </Reveal>
      </div>
    </div>
  );
}
