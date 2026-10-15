import type { Metadata } from "next";
import type { ReactNode } from "react";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import StickyBookButton from "@/components/StickyBookButton";
import MotionProvider from "@/components/MotionProvider";
import { business } from "@/lib/data";

/**
 * The website of the demo shop «Κουρείο Αλέξη» -- the example of the full
 * website that comes with the Autopilot plan (everything of the
 * Independence booking, plus the site, team, reviews, points, memberships
 * and gift cards). Not for search engines: it is a demo with invented
 * details.
 */
export const metadata: Metadata = {
  title: { absolute: business.name, template: `%s | ${business.name}` },
  description: business.description,
  keywords: null,
  authors: null,
  openGraph: null,
  twitter: null,
  alternates: null,
  icons: null,
  robots: { index: false, follow: false },
};

export default function AlexiLayout({ children }: { children: ReactNode }) {
  return (
    <MotionProvider>
      <Header />
      <main>{children}</main>
      <Footer />
      <StickyBookButton />
    </MotionProvider>
  );
}
