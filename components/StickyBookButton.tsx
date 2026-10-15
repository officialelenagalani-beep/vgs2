"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { sitePath } from "@/lib/data";

export default function StickyBookButton() {
  const pathname = usePathname();
  const hide = pathname === sitePath("/booking");

  return (
    <AnimatePresence>
      {!hide && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="md:hidden fixed bottom-0 inset-x-0 z-40 p-4 bg-gradient-to-t from-ink via-ink/95 to-transparent"
        >
          <Link
            href={sitePath("/booking")}
            className="block w-full text-center py-3.5 bg-white text-ink font-medium text-sm tracking-wide active:scale-[0.98] transition-transform"
          >
            Κλείσε Ραντεβού
          </Link>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
