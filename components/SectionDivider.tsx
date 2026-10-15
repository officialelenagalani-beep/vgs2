"use client";

import { motion } from "framer-motion";

type SectionDividerProps = {
  className?: string;
  align?: "left" | "center";
};

/**
 * A minimal, neutral hairline accent under section headings -- a simple
 * scale-in on scroll, no color, no flourish.
 */
export default function SectionDivider({ className = "", align = "left" }: SectionDividerProps) {
  return (
    <motion.div
      initial={{ scaleX: 0, opacity: 0 }}
      whileInView={{ scaleX: 1, opacity: 1 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      style={{ transformOrigin: align === "center" ? "center" : "left" }}
      className={`h-px w-16 bg-stone/50 ${align === "center" ? "mx-auto" : ""} ${className}`}
    />
  );
}
