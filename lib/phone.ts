import { normalizePhoneForRateLimit } from "@/lib/rate-limit";

/**
 * Phase 4 / Step 24 -- customer-identity phone normalization.
 *
 * Deliberately built ON TOP OF the existing Step 23C
 * `normalizePhoneForRateLimit()` (lib/rate-limit.ts) rather than
 * re-deriving the same cleaning/prefix-stripping logic a second time --
 * per the Step 24 design review, that function already correctly
 * collapses every representation this step cares about ("6900000000",
 * "690 000 0000", "+30 690 000 0000", "0030 690 000 0000") down to the
 * same digit string. `lib/rate-limit.ts` itself is intentionally NOT
 * modified, extracted, or refactored as part of this step.
 *
 * Why a separate, stricter function is still needed on top of it:
 * `normalizePhoneForRateLimit()` is explicitly scoped (see its own doc
 * comment) to "for use as a rate-limit key ONLY" -- it never validates
 * length/plausibility, and it collapses every malformed input down to one
 * shared "invalid" bucket string (exactly right for rate-limiting, where
 * the bucket just needs to exist and be shared; exactly wrong for
 * customer identity, where treating "invalid" as if it were one real
 * phone number would make every malformed submission look like the same
 * customer).
 *
 * `normalizeGreekPhoneForIdentity()` adds the one rule identity matching
 * actually needs: the cleaned result must be exactly 10 digits (true for
 * both Greek mobile numbers, e.g. 69xxxxxxxx, and Greek landline numbers,
 * e.g. 21xxxxxxxx -- Greek national numbers do not use a variable-length
 * trunk prefix, so a single length check covers both without needing to
 * special-case mobile vs. landline). Anything else -- too short, too
 * long, or the shared "invalid" sentinel -- returns `null`, meaning "no
 * usable identity signal", which is exactly the contract
 * findOrCreateCustomer() (services/customers.ts) needs: no exception, no
 * generic-junk customer, just "don't link this one automatically."
 *
 * This function is used for IDENTITY MATCHING ONLY. It never changes
 * what gets stored/displayed: appointments.customer_phone keeps whatever
 * the caller submitted (services/appointments.ts's existing `.trim()`
 * handling is untouched), and customers.phone (the profile's
 * human-readable field) is likewise stored separately from
 * customers.normalized_phone (the column this function's output feeds).
 */
const GREEK_NATIONAL_NUMBER_LENGTH = 10;

export function normalizeGreekPhoneForIdentity(rawPhone: string): string | null {
  const cleaned = normalizePhoneForRateLimit(rawPhone);
  if (cleaned.length !== GREEK_NATIONAL_NUMBER_LENGTH) return null;
  // normalizePhoneForRateLimit() only ever returns digits (or the literal
  // "invalid" sentinel) at this point, but a defensive digit-only check
  // costs nothing and guards against that contract ever silently
  // changing upstream.
  if (!/^\d{10}$/.test(cleaned)) return null;
  return cleaned;
}
