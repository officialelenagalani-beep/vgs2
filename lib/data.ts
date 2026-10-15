/**
 * The website of the demo shop «Κουρείο Αλέξη» (Autopilot plan), served at
 * /alexi: the full site (home, services, gallery, location, booking) plus
 * what Autopilot adds -- the team, reviews, points, memberships and gift
 * cards, read from the shop's records. Invented details, for
 * presentations: the address is street-level and the phone is not real.
 *
 * The site is not indexed by search engines (app/alexi/layout.tsx).
 */

export const business = {
  /** The shop in the database (create_demo_business, migration 045). */
  slug: "kourio-alexi",
  /** Where this website lives; every internal link starts with it. */
  base: "/alexi",
  name: "Κουρείο Αλέξη",
  shortName: "Κουρείο Αλέξη",
  /** Two letters for the round monogram in the header and footer. */
  monogram: "ΚΑ",
  tagline: "Κούρεμα, fade και ξύρισμα με ζεστή πετσέτα. Στην ώρα σου, κάθε φορά.",
  description: "Ανδρικό κουρείο στην Πάτρα. Κλείσε ραντεβού online στο Κουρείο Αλέξη.",
  street: "Κορίνθου 214",
  city: "Πάτρα",
  postalCode: "262 23",
  region: "Αχαΐα",
  country: "GR",
  phone: "2610 000000",
  phoneHref: "+302610000000",
  email: null as string | null,
  instagram: null as string | null,
  mapsQuery: "Κορίνθου 214, Πάτρα",
  mapsDirectionsUrl: "https://www.google.com/maps/dir/?api=1&destination=%CE%9A%CE%BF%CF%81%CE%AF%CE%BD%CE%B8%CE%BF%CF%85+214,+%CE%A0%CE%AC%CF%84%CF%81%CE%B1",
  mapsPlaceUrl: "https://www.google.com/maps/search/?api=1&query=%CE%9A%CE%BF%CF%81%CE%AF%CE%BD%CE%B8%CE%BF%CF%85+214,+%CE%A0%CE%AC%CF%84%CF%81%CE%B1",
  mapsEmbedUrl: "https://maps.google.com/maps?q=%CE%9A%CE%BF%CF%81%CE%AF%CE%BD%CE%B8%CE%BF%CF%85+214,+%CE%A0%CE%AC%CF%84%CF%81%CE%B1&z=15&output=embed&hl=el",
  /** The shop's hours, as set in the demo (Sunday closed). */
  hours: [
    { day: "Δευτέρα", hours: "11:00 - 20:00" },
    { day: "Τρίτη", hours: "09:00 - 21:00" },
    { day: "Τετάρτη", hours: "09:00 - 21:00" },
    { day: "Πέμπτη", hours: "09:00 - 21:00" },
    { day: "Παρασκευή", hours: "09:00 - 21:00" },
    { day: "Σάββατο", hours: "09:00 - 17:00" },
    { day: "Κυριακή", hours: "Κλειστά" },
  ],
};

/** "/services" -> "/alexi/services" */
export function sitePath(path: string): string {
  if (path === "/") return business.base;
  return `${business.base}${path}`;
}
