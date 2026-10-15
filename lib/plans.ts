/**
 * The VGS APP plans a shop pays for (see lib/vgs-content.ts PLANS for the
 * public wording). Stored on the shop as settings.plan; only the platform
 * owner changes it.
 *
 *   independence  booking page, team calendar, staff, services, customer card
 *                 with history and notes.
 *   autopilot     everything, including the features below.
 *
 * A shop with no plan written (Medusa and every shop created before plans
 * existed) counts as Autopilot, so nothing is taken away from anyone by this
 * change. Pure: no database, so it is unit-tested and usable everywhere.
 */

export type PlanId = "independence" | "autopilot";

export const PLAN_IDS: readonly PlanId[] = ["independence", "autopilot"];

/** The features the Independence plan does not include. */
export type PlanFeature =
  | "analytics"
  | "loyalty"
  | "reviews"
  | "discounts"
  | "gift_cards"
  | "memberships"
  | "campaigns"
  | "sms"
  | "rebooking";

export const PLAN_NAMES: Record<PlanId, string> = {
  independence: "Independence",
  autopilot: "Autopilot",
};

const AUTOPILOT_ONLY: ReadonlySet<PlanFeature> = new Set<PlanFeature>([
  "analytics",
  "loyalty",
  "reviews",
  "discounts",
  "gift_cards",
  "memberships",
  "campaigns",
  "sms",
  "rebooking",
]);

/** What each locked feature is, in words a shop owner understands. */
export const FEATURE_INFO: Record<PlanFeature, { title: string; text: string }> = {
  analytics: {
    title: "Οικονομικά στατιστικά",
    text: "Τζίρος ανά κουρέα και ανά υπηρεσία, ώρες αιχμής, ακυρώσεις και no-shows, όλα σε ένα σημείο.",
  },
  loyalty: {
    title: "Πόντοι επιβράβευσης",
    text: "Ο πελάτης μαζεύει πόντους σε κάθε επίσκεψη και τους εξαργυρώνει, οπότε έχει λόγο να γυρίσει σε σένα.",
  },
  reviews: {
    title: "Κριτικές πελατών",
    text: "Μετά την επίσκεψη ο πελάτης αφήνει κριτική. Εσύ εγκρίνεις ποιες εμφανίζονται στη σελίδα σου.",
  },
  discounts: {
    title: "Κωδικοί έκπτωσης",
    text: "Κωδικοί όπως WELCOME10 για νέους πελάτες ή φοιτητές, με όρια και ημερομηνίες λήξης.",
  },
  gift_cards: {
    title: "Δωροκάρτες",
    text: "Δωροκάρτες με μοναδικό κωδικό, που τις πουλάς στο ταμείο και τις εκτυπώνεις.",
  },
  memberships: {
    title: "Μηνιαίες συνδρομές",
    text: "Πακέτα όπως «2 κουρέματα τον μήνα» με σταθερή τιμή: εγγυημένο εισόδημα κάθε μήνα.",
  },
  campaigns: {
    title: "Καμπάνιες email",
    text: "Μηνύματα όπως «σας λείψαμε» σε όσους έχουν καιρό να έρθουν, ή προσφορές σε όλους τους πελάτες σου.",
  },
  sms: {
    title: "SMS στους πελάτες",
    text: "Αυτόματα SMS επιβεβαίωσης και υπενθύμισης (έως 500 τον μήνα), για να μη μένουν άδειες καρέκλες.",
  },
  rebooking: {
    title: "«Ήρθε η ώρα για κούρεμα»",
    text: "Το πρόγραμμα ξέρει κάθε πόσο έρχεται ο κάθε πελάτης και του θυμίζει να κλείσει το επόμενο ραντεβού.",
  },
};

/** The plan written on the shop; none (or unknown) -> Autopilot. */
export function readPlan(settings: unknown): PlanId {
  const value =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).plan
      : undefined;
  return value === "independence" ? "independence" : "autopilot";
}

export function planIncludes(plan: PlanId, feature: PlanFeature): boolean {
  return plan === "autopilot" || !AUTOPILOT_ONLY.has(feature);
}

/** Whether this shop's plan includes `feature`. */
export function businessHasFeature(business: { settings?: unknown } | null | undefined, feature: PlanFeature): boolean {
  return planIncludes(readPlan(business?.settings), feature);
}

export const PLAN_LOCKED_MESSAGE = "Αυτή η λειτουργία είναι στο πακέτο Autopilot.";

/** For server actions: stops with a message for the person when the plan does not include it. */
export function assertFeature(business: { settings?: unknown } | null | undefined, feature: PlanFeature): void {
  if (!businessHasFeature(business, feature)) throw new Error(PLAN_LOCKED_MESSAGE);
}

/** From the platform owner's form. Throws a message for the person. */
export function parsePlanId(value: unknown): PlanId {
  if (typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value)) return value as PlanId;
  throw new Error("Μη έγκυρο πακέτο.");
}

/** Menu path -> the feature behind it (for the padlocks in the menu). */
export const NAV_FEATURES: Record<string, PlanFeature> = {
  "/admin/analytics": "analytics",
  "/admin/loyalty": "loyalty",
  "/admin/reviews": "reviews",
  "/admin/discounts": "discounts",
  "/admin/gift-cards": "gift_cards",
  "/admin/memberships": "memberships",
  "/admin/campaigns": "campaigns",
};
