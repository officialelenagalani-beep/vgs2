import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getBusinessBySlug } from "@/services/businesses";
import { isDomain } from "@/lib/domains";
import { shopPrivacySections } from "@/lib/vgs-legal";
import LegalText from "@/components/vgs/LegalText";
import type { Business } from "@/types/businesses";

/**
 * /b/<slug>/privacy -- what the shop's booking page tells its customers
 * about their data (the shop is the controller; VGS APP processes for it).
 * Exists for every active barber shop, also those that book through their
 * own website (Medusa), since the booking form links here.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

async function loadShop(slug: string): Promise<Business | null> {
  if (!SLUG_RE.test(slug)) return null;
  try {
    const business = await getBusinessBySlug(slug);
    return business && isDomain(business, "barber") ? business : null;
  } catch {
    return null;
  }
}

export async function generateMetadata(props: Params): Promise<Metadata> {
  const business = await loadShop((await props.params).slug);
  if (!business) return { title: { absolute: "Δεν βρέθηκε" }, robots: { index: false, follow: false } };
  const title = `Απόρρητο | ${business.name}`;
  return {
    title: { absolute: title },
    description: `Πώς το ${business.name} χειρίζεται τα στοιχεία των πελατών του.`,
    keywords: null,
    authors: null,
    openGraph: null,
    twitter: null,
    icons: null,
    robots: { index: false, follow: true },
  };
}

export default async function ShopPrivacyPage(props: Params) {
  const params = await props.params;
  const business = await loadShop(params.slug);
  if (!business) notFound();
  const address = [business.address, business.city].filter(Boolean).join(", ") || null;
  const sections = shopPrivacySections({ name: business.name, address, phone: business.phone ?? null });
  const link = "underline underline-offset-2 text-bone hover:text-white";

  return (
    <main className="min-h-screen bg-ink text-bone px-5 py-16">
      <div className="max-w-2xl mx-auto">
        <p className="text-stone text-xs uppercase tracking-[0.2em]">Ενημέρωση για τα προσωπικά δεδομένα</p>
        <h1 className="font-display text-3xl sm:text-4xl text-bone mt-3">{business.name}</h1>
        <p className="mt-4 text-sm leading-relaxed text-stone">
          Τι γίνεται με τα στοιχεία σου όταν κλείνεις ραντεβού στο κατάστημα.
        </p>
        <div className="mt-10 space-y-9">
          {sections.map((s) => (
            <section key={s.id} aria-labelledby={`${s.id}-h`}>
              <h2 id={`${s.id}-h`} className="font-display text-xl text-bone">{s.title}</h2>
              {s.paragraphs?.map((p) => (
                <p key={p} className="mt-3 text-sm leading-relaxed text-stone"><LegalText text={p} linkClass={link} /></p>
              ))}
              {s.points && (
                <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-stone marker:text-stone/60">
                  {s.points.map((p) => (
                    <li key={p}><LegalText text={p} linkClass={link} /></li>
                  ))}
                </ul>
              )}
              {s.after?.map((p) => (
                <p key={p} className="mt-3 text-sm leading-relaxed text-stone"><LegalText text={p} linkClass={link} /></p>
              ))}
            </section>
          ))}
        </div>
        {(business.settings as Record<string, unknown> | null)?.public_page_enabled === true && (
          <p className="mt-14 text-xs text-stone/60">
            <a href={`/b/${business.slug}`} className="hover:text-bone">← Πίσω στην κράτηση</a>
          </p>
        )}
      </div>
    </main>
  );
}
