"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import ShopMark from "./ShopMark";
import { business, sitePath } from "@/lib/data";

const links = [
  { href: sitePath("/"), label: "Αρχική" },
  { href: sitePath("/services"), label: "Υπηρεσίες" },
  { href: `${sitePath("/")}#omada`, label: "Η ομάδα" },
  { href: `${sitePath("/")}#kritikes`, label: "Κριτικές" },
  { href: sitePath("/gallery"), label: "Gallery" },
  { href: sitePath("/location"), label: "Τοποθεσία" },
];

export default function Header() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 inset-x-0 z-50 transition-all duration-500 ${
        scrolled
          ? "bg-ink/90 backdrop-blur-md border-b border-hairline"
          : "bg-transparent border-b border-transparent"
      }`}
    >
      <div className="container-xl flex items-center justify-between h-20">
        <Link
          href={sitePath("/")}
          className="flex items-center gap-3 text-bone"
          aria-label={`${business.name} -- Αρχική`}
        >
          <ShopMark size={36} />
          <span className="font-display text-lg tracking-wide leading-none">
            {business.name}
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-10">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm text-stone hover:text-bone transition-colors duration-300 tracking-wide"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="hidden md:block">
          <Link
            href={sitePath("/booking")}
            className="px-6 py-2.5 text-sm font-medium bg-white text-ink hover:bg-accent-dim transition-colors duration-300"
          >
            Κλείσε Ραντεβού
          </Link>
        </div>

        <button
          onClick={() => setOpen((v) => !v)}
          className="md:hidden text-bone p-2 -mr-2"
          aria-label={open ? "Κλείσιμο μενού" : "Άνοιγμα μενού"}
          aria-expanded={open}
        >
          <div className="w-6 flex flex-col gap-1.5">
            <motion.span
              animate={{ rotate: open ? 45 : 0, y: open ? 6 : 0 }}
              className="h-px bg-bone block origin-center"
            />
            <motion.span
              animate={{ opacity: open ? 0 : 1 }}
              className="h-px bg-bone block"
            />
            <motion.span
              animate={{ rotate: open ? -45 : 0, y: open ? -6 : 0 }}
              className="h-px bg-bone block origin-center"
            />
          </div>
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="md:hidden bg-ink border-b border-hairline overflow-hidden"
          >
            <div className="container-xl py-6 flex flex-col gap-5">
              <div className="flex items-center gap-3 pb-3 mb-1 border-b border-hairline">
                <ShopMark size={32} />
                <span className="font-display text-base text-bone">{business.name}</span>
              </div>
              {links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="text-bone text-lg font-display"
                >
                  {l.label}
                </Link>
              ))}
              <Link
                href={sitePath("/booking")}
                onClick={() => setOpen(false)}
                className="mt-2 px-6 py-3 text-center text-sm font-medium bg-white text-ink"
              >
                Κλείσε Ραντεβού
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
