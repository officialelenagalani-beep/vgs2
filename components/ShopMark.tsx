import { business } from "@/lib/data";

/** A simple monogram for the demo shop's website (no real brand is used). */
export default function ShopMark({ size = 36, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" className={className}>
      <circle cx="20" cy="20" r="18.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x="20" y="25.5" textAnchor="middle" fontFamily="var(--font-fraunces), serif" fontSize="14" fill="currentColor">
        {business.monogram}
      </text>
    </svg>
  );
}
