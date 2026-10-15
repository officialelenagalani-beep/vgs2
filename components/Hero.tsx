"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import ButtonLink from "./ButtonLink";
import { business, sitePath } from "@/lib/data";
import { HERO_PHOTO } from "@/lib/gallery";

const easing = [0.16, 1, 0.3, 1] as const;

export default function Hero() {
  return (
    <section className="relative min-h-[100vh] flex items-center overflow-hidden">
      <Image
        src={HERO_PHOTO}
        alt=""
        fill
        priority
        sizes="100vw"
        className="object-cover"
      />
      {/* discreet dark overlay for text legibility */}
      <div className="absolute inset-0 bg-ink/65" />
      <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/30 to-ink/40" />

      <div className="container-xl relative z-10 pt-24">
        <motion.h1
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: easing }}
          className="font-display text-[3rem] sm:text-[4.4rem] lg:text-[5.6rem] leading-[1.04] text-bone tracking-tight"
        >
          {business.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase()}
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.15, ease: easing }}
          className="mt-5 text-stone text-lg sm:text-xl tracking-wide"
        >
          {business.tagline}
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.3, ease: easing }}
          className="mt-10"
        >
          <ButtonLink href={sitePath("/booking")}>Κλείσε Ραντεβού</ButtonLink>
        </motion.div>
      </div>
    </section>
  );
}
