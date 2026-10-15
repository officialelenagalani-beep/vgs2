/**
 * Photos of the two demo shops' websites (public/demo), provided by the
 * owner for presentations. No real shop's name appears on these pages.
 */

export type GalleryPhoto = {
  src: string;
  alt: string;
};

export type WorkCategoryId = "haircuts" | "beard" | "space";

export const workCategories: { id: WorkCategoryId; label: string; photos: GalleryPhoto[] }[] = [
  {
    id: "haircuts",
    label: "Κουρέματα",
    photos: [
      { src: "/demo/work-comb.webp", alt: "Κούρεμα με χτένα και ψαλίδι" },
      { src: "/demo/work-scissors.webp", alt: "Φινίρισμα με ψαλίδι" },
      { src: "/demo/work-blowdry.webp", alt: "Styling με πιστολάκι μετά το κούρεμα" },
    ],
  },
  {
    id: "beard",
    label: "Ξύρισμα & γένια",
    photos: [{ src: "/demo/work-shave.webp", alt: "Περιποίηση γενειάδας με ξυράφι" }],
  },
  {
    id: "space",
    label: "Ο χώρος",
    photos: [
      { src: "/demo/interior-brick.webp", alt: "Οι θέσεις του κουρείου" },
      { src: "/demo/interior-long.webp", alt: "Ο χώρος του κουρείου" },
      { src: "/demo/tools.webp", alt: "Τα εργαλεία του κουρέα" },
    ],
  },
];

/** Every photo, for a simple grid. */
export const allWorkPhotos: GalleryPhoto[] = workCategories.flatMap((c) => c.photos);

/** The big photo at the top of the Autopilot site. */
export const HERO_PHOTO = "/demo/interior-brick.webp";

/** Behind the shop's card on the Independence booking page. */
export const PANEL_PHOTO = "/demo/interior-long.webp";

/** A barber's photo: where the face sits in the frame, for round crops. */
export type BarberPhoto = { src: string; position: string };

/** Each demo shop's barbers, by the name the shop gave them in the admin. */
export const TEAM_PHOTOS: Record<string, Record<string, BarberPhoto>> = {
  "kourio-alexi": {
    Αλέξης: { src: "/demo/barber-1.webp", position: "55% 22%" },
    Νίκος: { src: "/demo/barber-2.webp", position: "58% 26%" },
    Γιώργος: { src: "/demo/barber-4.webp", position: "50% 18%" },
  },
  "barber-studio-manos": {
    Μάνος: { src: "/demo/barber-3.webp", position: "50% 24%" },
    Στέλιος: { src: "/demo/barber-4.webp", position: "50% 18%" },
  },
};
