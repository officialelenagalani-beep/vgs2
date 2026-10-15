import type { Metadata } from "next";
import Link from "next/link";
import Hero from "@/components/Hero";
import Reveal from "@/components/Reveal";
import SectionHeading from "@/components/SectionHeading";
import ServicesGrid from "@/components/ServicesGrid";
import WorkGallery from "@/components/WorkGallery";
import MapSection from "@/components/MapSection";
import ButtonLink from "@/components/ButtonLink";
import { business, sitePath } from "@/lib/data";
import { notFound } from "next/navigation";
import Image from "next/image";
import { loadShopSite } from "@/services/demo-site";
import { TEAM_PHOTOS } from "@/lib/gallery";

export const metadata: Metadata = {
  title: { absolute: `${business.name} | Ανδρικό κουρείο, Πάτρα` },
};

// Services, prices, team, reviews, points and memberships are read from the
// shop's records on every visit: what the owner changes in the admin shows here.
export const dynamic = "force-dynamic";

const DAYS_ACC = ["Κυριακή", "Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο"];
const num = (n: number) => new Intl.NumberFormat("el-GR", { maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);

function Stars({ value }: { value: number }) {
  const full = Math.round(value);
  return (
    <span aria-hidden="true" className="tracking-[0.15em] text-bone">
      {"★".repeat(full)}
      <span className="text-stone/40">{"★".repeat(5 - full)}</span>
    </span>
  );
}

const values = [
  {
    title: "Ακρίβεια στη λεπτομέρεια",
    text: "Κάθε κούρεμα γίνεται με τη φιλοσοφία ενός χειροτέχνη, όχι ενός γρήγορου κουρέματος.",
  },
  {
    title: "Premium υλικά & εργαλεία",
    text: "Προϊόντα περιποίησης υψηλής ποιότητας σε κάθε ραντεβού.",
  },
  {
    title: "Ραντεβού, όχι αναμονή",
    text: "Κλείνεις online σε λίγα βήματα και έρχεσαι ακριβώς στην ώρα σου.",
  },
];

export default async function HomePage() {
  const site = await loadShopSite(business.slug);
  if (!site) notFound();
  const { team, reviews, summary, loyalty, memberships, features } = site;
  const catalog = { categories: site.categories };
  const average = summary.average !== null ? summary.average.toFixed(1).replace(".", ",") : null;
  return (
    <>
      <Hero />

      {/* Value proposition strip */}
      <section className="py-24 border-t border-hairline">
        <div className="container-xl grid grid-cols-1 sm:grid-cols-3 gap-12">
          {values.map((v, i) => (
            <Reveal key={v.title} delay={i * 0.1}>
              <span className="font-display text-stone text-3xl">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-4 font-display text-xl text-bone">{v.title}</h3>
              <p className="mt-3 text-stone leading-relaxed">{v.text}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Services preview */}
      <section className="py-24 sm:py-32 border-t border-hairline">
        <div className="container-xl">
          <Reveal>
            <SectionHeading
              eyebrow="Υπηρεσίες"
              title="Κούρεμα & Grooming."
              description="Από το ανδρικό κούρεμα μέχρι την πλήρη περιποίηση -- διαφανείς τιμές, ξεκάθαρος χρόνος."
            />
          </Reveal>
          <Reveal delay={0.15} className="mt-14">
            <ServicesGrid preview categories={catalog.categories.map((cat) => ({
              id: cat.id,
              label: cat.label,
              services: cat.services.map((s) => ({ id: s.slug, name: s.name, duration: s.duration, price: s.price })),
            }))} />
          </Reveal>
          <Reveal delay={0.2} className="mt-12">
            <Link
              href={sitePath("/services")}
              className="inline-flex items-center gap-2 text-bone hover:gap-3.5 transition-all duration-300 text-sm tracking-wide"
            >
              Όλες οι υπηρεσίες &amp; τιμές <span aria-hidden="true">→</span>
            </Link>
          </Reveal>
        </div>
      </section>

      {/* The team (Autopilot) */}
      {team.length > 0 && (
        <section id="omada" aria-labelledby="omada-title" className="scroll-mt-24 py-24 sm:py-32 border-t border-hairline">
          <div className="container-xl">
            <Reveal>
              <SectionHeading eyebrow="Η ομάδα" title="Ποιος θα σε κουρέψει." description="Διαλέγεις τον κουρέα σου όταν κλείνεις ραντεβού." />
            </Reveal>
            <div role="list" className="mt-14 grid gap-px bg-hairline border border-hairline sm:grid-cols-2 lg:grid-cols-3">
              {team.map((b, i) => (
                <Reveal key={b.id} delay={i * 0.08} className="bg-ink">
                  <div role="listitem" className="group h-full p-8 transition-colors duration-500 hover:bg-charcoal">
                    {TEAM_PHOTOS[business.slug]?.[b.name] ? (
                      <div className="relative aspect-[4/5] overflow-hidden">
                        <Image
                          src={TEAM_PHOTOS[business.slug][b.name].src}
                          alt={`${b.name}, ${b.isOwner ? "ιδιοκτήτης" : "κουρέας"}`}
                          fill
                          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                          className="object-cover grayscale-[35%] transition duration-700 group-hover:scale-105 group-hover:grayscale-0"
                          style={{ objectPosition: TEAM_PHOTOS[business.slug][b.name].position }}
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-ink/60 to-transparent" />
                      </div>
                    ) : (
                      <span aria-hidden="true" className="flex h-20 w-20 items-center justify-center rounded-full border border-hairline font-display text-4xl text-bone transition-transform duration-500 group-hover:scale-105 group-hover:border-bone/60">
                        {b.name.charAt(0)}
                      </span>
                    )}
                    <h3 className="mt-6 font-display text-2xl text-bone">{b.name}</h3>
                    <p className="mt-1.5 text-sm text-stone">
                      {b.isOwner ? "Ιδιοκτήτης και κουρέας" : "Κουρέας"}
                      {b.daysOff.length > 0 ? ` · Ρεπό ${b.daysOff.map((d) => DAYS_ACC[d]).join(", ")}` : ""}
                    </p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* The work */}
      <section className="py-24 sm:py-32 border-t border-hairline bg-charcoal/40">
        <div className="container-xl">
          <Reveal>
            <SectionHeading eyebrow="Gallery" title="Από την καρέκλα μας." description="Λίγες από τις δουλειές μας." />
          </Reveal>
          <Reveal delay={0.15} className="mt-14">
            <WorkGallery />
          </Reveal>
          <Reveal delay={0.2} className="mt-10">
            <Link
              href={sitePath("/gallery")}
              className="inline-flex items-center gap-2 text-bone hover:gap-3.5 transition-all duration-300 text-sm tracking-wide"
            >
              Δες όλη τη συλλογή <span aria-hidden="true">→</span>
            </Link>
          </Reveal>
        </div>
      </section>

      {/* Reviews (Autopilot) */}
      {features.reviews && reviews.length > 0 && (
        <section id="kritikes" aria-labelledby="kritikes-title" className="scroll-mt-24 py-24 sm:py-32 border-t border-hairline">
          <div className="container-xl grid gap-14 lg:grid-cols-12">
            <Reveal className="lg:col-span-4">
              <span className="eyebrow">Κριτικές</span>
              <h2 id="kritikes-title" className="mt-4 font-display text-4xl sm:text-5xl text-bone leading-tight">Τι λένε οι πελάτες μας.</h2>
              {average && (
                <p className="mt-8">
                  <span className="block font-display text-7xl text-bone leading-none">{average}</span>
                  <span className="mt-3 flex items-center gap-3 text-sm text-stone">
                    <Stars value={summary.average!} /> από {summary.count} κριτικές
                  </span>
                </p>
              )}
            </Reveal>
            <div role="list" className="grid gap-px bg-hairline border border-hairline sm:grid-cols-2 lg:col-span-8">
              {reviews.slice(0, 4).map((r, i) => (
                <Reveal key={i} delay={i * 0.08} className="bg-ink">
                  <div role="listitem" className="h-full p-8">
                    <Stars value={r.rating} />
                    {r.comment && <p className="mt-4 font-display text-xl leading-snug text-bone">«{r.comment}»</p>}
                    <p className="mt-4 text-sm text-stone">
                      {r.name}
                      {r.service_name ? ` · ${r.service_name}` : ""}
                    </p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* For regulars (Autopilot): points, memberships, gift cards */}
      {(loyalty || memberships.length > 0 || features.giftCards) && (
        <section aria-labelledby="taktikoi-title" className="py-24 sm:py-32 border-t border-hairline bg-charcoal/40">
          <div className="container-xl">
            <Reveal>
              <SectionHeading eyebrow="Για τους τακτικούς" title="Όσο πιο συχνά έρχεσαι, τόσο κερδίζεις." />
            </Reveal>
            <div className="mt-14 grid gap-px bg-hairline border border-hairline lg:grid-cols-3">
              {loyalty && (
                <Reveal className="bg-ink">
                  <div className="h-full p-8">
                    <span className="font-display text-stone text-3xl">01</span>
                    <h3 className="mt-4 font-display text-xl text-bone">Πόντοι σε κάθε επίσκεψη</h3>
                    <p className="mt-3 text-stone leading-relaxed">
                      Κερδίζεις {loyalty.pointsPerEuro === 1 ? "1 πόντο" : `${num(loyalty.pointsPerEuro)} πόντους`} για κάθε ευρώ. Κάθε πόντος αξίζει{" "}
                      {num(loyalty.euroPerPoint)}€ στην επόμενη επίσκεψη.
                    </p>
                  </div>
                </Reveal>
              )}
              {memberships.slice(0, 1).map((m) => (
                <Reveal key={m.name} delay={0.08} className="bg-ink">
                  <div className="h-full p-8">
                    <span className="font-display text-stone text-3xl">02</span>
                    <h3 className="mt-4 font-display text-xl text-bone">{m.name}</h3>
                    <p className="mt-3 text-stone leading-relaxed">
                      {m.visits} επισκέψεις τον μήνα με {num(m.price)}€. {m.description ?? ""}
                    </p>
                  </div>
                </Reveal>
              ))}
              {features.giftCards && (
                <Reveal delay={0.16} className="bg-ink">
                  <div className="h-full p-8">
                    <span className="font-display text-stone text-3xl">03</span>
                    <h3 className="mt-4 font-display text-xl text-bone">Δωροκάρτες</h3>
                    <p className="mt-3 text-stone leading-relaxed">
                      Το πιο εύκολο δώρο για γενέθλια και γιορτές. Τις βρίσκεις στο ταμείο, με όποιο ποσό θέλεις.
                    </p>
                  </div>
                </Reveal>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Location preview */}
      <section className="py-24 sm:py-32 border-t border-hairline">
        <div className="container-xl">
          <Reveal>
            <SectionHeading eyebrow="Τοποθεσία" title="Σε βρίσκουμε εύκολα." />
          </Reveal>
          <Reveal delay={0.15} className="mt-14">
            <MapSection compact />
          </Reveal>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-28 sm:py-36 border-t border-hairline text-center">
        <div className="container-xl">
          <Reveal>
            <span className="eyebrow">{business.shortName}</span>
            <h2 className="mt-5 font-display text-4xl sm:text-5xl text-bone max-w-2xl mx-auto leading-tight">
              Η λεπτομέρεια κάνει τη διαφορά.
            </h2>
            <div className="mt-10">
              <ButtonLink href={sitePath("/booking")}>Κλείσε Ραντεβού</ButtonLink>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
