"use client";

import { useState } from "react";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { workCategories } from "@/lib/gallery";

/**
 * Real haircut/work photos, organized by category. Categories start empty
 * and fill in as real photos are provided -- see lib/gallery.ts.
 */
export default function WorkGallery() {
  const [activeCat, setActiveCat] = useState(workCategories[0].id);
  const [lightbox, setLightbox] = useState<number | null>(null);

  const current = workCategories.find((c) => c.id === activeCat)!;

  return (
    <div>
      <div className="flex flex-wrap gap-2 sm:gap-3">
        {workCategories.map((cat) => (
          <button
            key={cat.id}
            onClick={() => {
              setActiveCat(cat.id);
              setLightbox(null);
            }}
            className={`px-5 py-2.5 text-sm border transition-colors duration-300 ${
              activeCat === cat.id
                ? "border-bone bg-bone text-ink"
                : "border-hairline text-stone hover:border-bone hover:text-bone"
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeCat}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="mt-8"
        >
          {current.photos.length === 0 ? (
            <div className="border border-dashed border-hairline py-16 px-6 text-center">
              <p className="text-stone text-sm">
                Οι φωτογραφίες της κατηγορίας &ldquo;{current.label}&rdquo; προστίθενται σύντομα.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 sm:gap-2">
              {current.photos.map((photo, i) => (
                <button
                  key={photo.src}
                  onClick={() => setLightbox(i)}
                  className="relative aspect-square overflow-hidden group"
                  aria-label={`Μεγέθυνση: ${photo.alt}`}
                >
                  <Image
                    src={photo.src}
                    alt={photo.alt}
                    fill
                    sizes="(max-width: 640px) 50vw, 33vw"
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                  <div className="absolute inset-0 bg-ink/0 group-hover:bg-ink/20 transition-colors duration-300" />
                </button>
              ))}
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      <AnimatePresence>
        {lightbox !== null && current.photos[lightbox] && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-ink/95 backdrop-blur-sm flex items-center justify-center p-6"
            onClick={() => setLightbox(null)}
            role="dialog"
            aria-modal="true"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-2xl aspect-square"
            >
              <Image
                src={current.photos[lightbox].src}
                alt={current.photos[lightbox].alt}
                fill
                sizes="90vw"
                className="object-contain"
              />
            </motion.div>
            <button
              onClick={() => setLightbox(null)}
              className="absolute top-6 right-6 text-bone text-sm border border-hairline px-4 py-2 hover:border-bone transition-colors"
            >
              Κλείσιμο
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
