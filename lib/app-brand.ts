import type { Metadata } from "next";

/**
 * Name of the application itself, shown on the pages every business shares
 * before one is selected: the sign-in screen and invitation acceptance.
 * Those pages belong to no single business, so they carry the app's own
 * name instead of a business's.
 */
export const APP_BRAND_NAME = "VGS APP";

/**
 * The application's own emblem (public/brand/vgs/): light on transparent,
 * made for the dark entrance pages. `width`/`height` are the picture's real
 * size, so the page keeps its place before the picture has loaded.
 */
export const APP_BRAND_MARK = { src: "/brand/vgs/mark.png", width: 450, height: 380 } as const;

/** Browser-tab and home-screen icons of the shared entrance pages. */
export const APP_BRAND_ICONS = { icon: "/brand/vgs/icon-64.png", apple: "/brand/vgs/icon-180.png" } as const;

/**
 * Metadata for a shared entrance page.
 *
 * The root layout (app/layout.tsx) describes the Medusa Barber public site:
 * a "%s | Medusa Barber Peristeri" title template, a description, keywords,
 * author, canonical "/", social-preview tags and tab icon. A page that only
 * sets a plain `title` inherits all of that. Here every one of those is
 * replaced or cleared, so neither the browser tab nor a link preview of
 * these pages names (or shows the logo of) a business.
 */
export function appEntranceMetadata(pageTitle: string, description: string): Metadata {
  const title = `${pageTitle} | ${APP_BRAND_NAME}`;
  return {
    title: { absolute: title },
    description,
    keywords: null,
    authors: null,
    alternates: null,
    openGraph: { type: "website", locale: "el_GR", siteName: APP_BRAND_NAME, title, description },
    twitter: { card: "summary", title, description },
    icons: { icon: APP_BRAND_ICONS.icon, apple: APP_BRAND_ICONS.apple },
    robots: { index: false, follow: false },
  };
}
