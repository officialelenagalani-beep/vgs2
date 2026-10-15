import Link from "next/link";
import ShopMark from "./ShopMark";
import { business, sitePath } from "@/lib/data";

export default function Footer() {
  return (
    <footer className="border-t border-hairline bg-ink">
      <div className="container-xl py-16 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-12">

        {/* Brand */}
        <div>
          <div className="flex items-center gap-3 text-bone">
            <ShopMark size={30} />
            <span className="font-display text-base tracking-wide">
              {business.name}
            </span>
          </div>
          <p className="mt-4 text-sm text-stone leading-relaxed">
            {business.tagline}
          </p>
        </div>

        {/* Navigation */}
        <div>
          <h3 className="eyebrow">Πλοήγηση</h3>
          <ul className="mt-4 space-y-2.5 text-sm text-stone">
            <li><Link href={sitePath("/services")} className="hover:text-bone transition-colors">Υπηρεσίες</Link></li>
            <li><Link href={sitePath("/booking")} className="hover:text-bone transition-colors">Κλείσε Ραντεβού</Link></li>
            <li><Link href={sitePath("/gallery")} className="hover:text-bone transition-colors">Gallery</Link></li>
            <li><Link href={sitePath("/location")} className="hover:text-bone transition-colors">Τοποθεσία</Link></li>
          </ul>
        </div>

        {/* Contact */}
        <div>
          <h3 className="eyebrow">Επικοινωνία</h3>
          <ul className="mt-4 space-y-2.5 text-sm text-stone">
            <li>
              <a
                href={business.mapsDirectionsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-bone transition-colors leading-snug block"
              >
                {business.street}<br />{business.city} {business.postalCode}
              </a>
            </li>
            <li>
              <a href={`tel:${business.phoneHref}`} className="hover:text-bone transition-colors">
                {business.phone}
              </a>
            </li>
            {business.email && (
              <li>
                <a href={`mailto:${business.email}`} className="hover:text-bone transition-colors">
                  {business.email}
                </a>
              </li>
            )}
          </ul>
        </div>

        {/* Hours -- all 7 days */}
        <div>
          <h3 className="eyebrow">Ώρες Λειτουργίας</h3>
          <ul className="mt-4 space-y-1.5 text-xs text-stone">
            {business.hours.map((h) => (
              <li key={h.day} className="flex justify-between gap-3">
                <span className="shrink-0">{h.day}</span>
                <span className={`text-right ${h.hours === "Κλειστά" ? "text-stone/50" : "text-bone/80"}`}>
                  {h.hours}
                </span>
              </li>
            ))}
          </ul>
        </div>

      </div>

      <div className="hairline" />

      <div className="container-xl py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-stone">
        <p>© {new Date().getFullYear()} {business.name} · Παράδειγμα ιστοσελίδας με φανταστικά στοιχεία</p>
        <a href="/vgs" target="_blank" rel="noopener" className="uppercase tracking-[0.18em] text-[11px] hover:text-bone transition-colors">
          Booking system powered by <span className="font-semibold">VGS</span>
        </a>
      </div>
    </footer>
  );
}
