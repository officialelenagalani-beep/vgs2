import { business } from "@/lib/data";
import ButtonLink from "./ButtonLink";
import MapEmbed from "./MapEmbed";

/**
 * Two-column map + info section.
 *
 * Architecture: the outer wrapper has an explicit fixed height on desktop
 * (`lg:h-[560px]`). Both columns are absolutely filled inside this wrapper
 * via a CSS grid that's already been given a definite size -- so the map
 * iframe always initialises into a container whose dimensions are already
 * settled, not one that's still being computed by its sibling's content.
 * This is the permanent fix for the "bottom half is black" rendering bug.
 */
export default function MapSection({ compact = false }: { compact?: boolean }) {
  const outerH = compact
    ? "flex flex-col lg:flex-row min-h-[560px] lg:h-[500px]"
    : "flex flex-col lg:flex-row lg:h-[560px]";

  return (
    <div className={`${outerH} border border-hairline overflow-hidden`}>
      {/* Map pane -- always a definite height on every breakpoint */}
      <div className="relative w-full lg:w-1/2 h-[300px] sm:h-[380px] lg:h-full flex-shrink-0">
        <MapEmbed
          src={business.mapsEmbedUrl}
          title={`Χάρτης τοποθεσίας ${business.name}`}
        />
      </div>

      {/* Info pane */}
      <div className="w-full lg:w-1/2 flex-shrink-0 p-8 sm:p-10 lg:p-12 flex flex-col justify-center bg-charcoal overflow-y-auto">
        <span className="eyebrow">Βρες μας</span>

        <a
          href={business.mapsPlaceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group mt-4 font-display text-2xl sm:text-3xl text-bone leading-snug hover:text-stone transition-colors duration-300"
        >
          {business.street}
          <br />
          {business.city} {business.postalCode}
          <span className="block mt-1 text-sm font-sans text-stone group-hover:text-bone transition-colors duration-300 tracking-wide">
            Άνοιγμα στο Google Maps →
          </span>
        </a>

        <div className="mt-7 space-y-1.5 text-sm text-stone">
          {business.hours.map((h) => (
            <div key={h.day} className="flex justify-between max-w-xs">
              <span>{h.day}</span>
              <span className={h.hours === "Κλειστά" ? "text-stone/50" : "text-bone/80"}>
                {h.hours}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap gap-4">
          <ButtonLink href={business.mapsDirectionsUrl}>
            Οδηγίες μέσω Google Maps
          </ButtonLink>
          <a
            href={`tel:${business.phoneHref}`}
            className="inline-flex items-center px-7 py-3.5 text-sm border border-hairline text-bone hover:border-bone transition-colors duration-300"
          >
            {business.phone}
          </a>
        </div>
      </div>
    </div>
  );
}
