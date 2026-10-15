"use client";

import { sitePath } from "@/lib/data";
import { motion } from "framer-motion";
import Link from "next/link";

// Phase 4 / Step 17 (services-catalog cutover): this component no longer
// imports lib/services.ts's static catalog directly. Its parent server
// components (app/(site)/page.tsx, app/(site)/services/page.tsx) now fetch
// the real, per-business DB catalog (services/catalog.ts, via the public
// /api/v1/businesses/[slug]/services endpoint's own data source) and pass
// it down as `categories` -- keeping this component itself a plain,
// presentational client component (it still needs "use client" for
// framer-motion's viewport-aware animations).
export interface ServicesGridCategory {
  id: string;
  label: string;
  services: { id: string; name: string; duration: number; price: number }[];
}

export default function ServicesGrid({
  categories,
  preview = false,
}: {
  categories: ServicesGridCategory[];
  preview?: boolean;
}) {
  return (
    <div className="space-y-16">
      {categories.map((cat, ci) => {
        const items = cat.services;
        const list = preview ? items.slice(0, 3) : items;
        return (
          <motion.div
            key={cat.id}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.7, delay: ci * 0.1, ease: [0.16, 1, 0.3, 1] }}
          >
            <h3 className="font-display text-2xl sm:text-3xl text-bone mb-6">{cat.label}</h3>
            <div className="border-y border-hairline divide-y divide-hairline">
              {list.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-4 py-5 px-1 transition-colors duration-300 hover:bg-charcoal/50"
                >
                  <div className="min-w-0">
                    <p className="text-bone font-medium leading-snug">{s.name}</p>
                    <p className="text-xs text-stone mt-1">{s.duration} λεπτά</p>
                  </div>
                  <div className="flex items-center gap-5 flex-shrink-0">
                    <span className="font-display text-lg text-bone">{s.price}€</span>
                    <Link
                      href={`${sitePath("/booking")}?service=${s.id}`}
                      className="hidden sm:inline text-sm text-stone hover:text-bone transition-colors duration-300"
                    >
                      Κράτηση →
                    </Link>
                  </div>
                </div>
              ))}
            </div>
            {preview && items.length > list.length && (
              <Link
                href={sitePath("/services")}
                className="mt-4 inline-block text-sm text-stone hover:text-bone transition-colors"
              >
                + {items.length - list.length} ακόμα στην κατηγορία {cat.label}
              </Link>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}
