"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import type { ReactNode } from "react";

type ButtonLinkProps = {
  href: string;
  children: ReactNode;
  variant?: "primary" | "ghost";
  className?: string;
};

export default function ButtonLink({
  href,
  children,
  variant = "primary",
  className = "",
}: ButtonLinkProps) {
  const base =
    "inline-flex items-center justify-center gap-2 px-7 py-3.5 text-sm tracking-wide font-medium transition-colors duration-300";

  const styles =
    variant === "primary"
      ? "bg-white text-ink hover:bg-accent-dim"
      : "border border-hairline text-bone hover:border-bone";

  return (
    <motion.div
      whileHover={{ scale: 1.025 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 22 }}
      className="inline-block"
    >
      <Link href={href} className={`${base} ${styles} ${className}`}>
        {children}
      </Link>
    </motion.div>
  );
}
