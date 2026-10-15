import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";
import { publicSiteUrl } from "@/lib/site-url";
import { APP_BRAND_ICONS, APP_BRAND_NAME } from "@/lib/app-brand";

const fraunces = Fraunces({
  subsets: ["latin", "latin-ext"],
  variable: "--font-fraunces",
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

const inter = Inter({
  subsets: ["latin", "latin-ext", "greek"],
  variable: "--font-inter",
  display: "swap",
});

export const viewport: Viewport = {
  themeColor: "#0A0A0B",
  width: "device-width",
  initialScale: 1,
};

/**
 * Defaults for every page; each part of the site (VGS APP page, the demo
 * shops' websites, booking pages, admin) sets its own title and icons.
 */
export const metadata: Metadata = {
  metadataBase: new URL(publicSiteUrl() ?? "http://localhost:3100"),
  title: { default: APP_BRAND_NAME, template: `%s | ${APP_BRAND_NAME}` },
  description: "Το πρόγραμμα κρατήσεων και πελατών για κουρεία.",
  icons: { icon: APP_BRAND_ICONS.icon, apple: APP_BRAND_ICONS.apple },
  robots: { index: true, follow: true },
};

/**
 * Root layout: html + body + fonts + SEO only.
 * No Header/Footer here — those live in app/manos/layout.tsx (demo shop site), app/vgs (VGS APP page)
 * and app/admin/(dashboard)/layout.tsx (admin dashboard) respectively.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="el" className={`${fraunces.variable} ${inter.variable}`} data-scroll-behavior="smooth">
      <body className="bg-ink text-bone font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
