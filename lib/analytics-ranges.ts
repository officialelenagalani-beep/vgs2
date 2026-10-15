/**
 * Booking Analytics -- period preset resolution (Phase 4 / Step 10).
 *
 * Pure date math, no server/client-only dependency, so both the analytics
 * Server Component (initial page load, section-3.J default) and the
 * client `AnalyticsDashboard` (preset switcher) resolve presets the exact
 * same way. Dates are computed from whatever `Date` the caller passes in
 * (normally `new Date()`), the same "local time, no timezone conversion"
 * approach `AdminDashboard.tsx`'s own `isoDate()`/today/upcoming filters
 * already use -- consistent with the rest of this single-timezone,
 * single-business deployment rather than introducing server-side
 * timezone math this project has never needed elsewhere.
 */

import type { AnalyticsDateRange, AnalyticsRangePreset, AnalyticsRangePresetOption } from "@/types/analytics";

export const ANALYTICS_RANGE_PRESETS: AnalyticsRangePresetOption[] = [
  { id: "today", labelEl: "Σήμερα" },
  { id: "last7", labelEl: "Τελευταίες 7 ημέρες" },
  { id: "last30", labelEl: "Τελευταίες 30 ημέρες" },
  { id: "thisMonth", labelEl: "Αυτός ο μήνας" },
  { id: "previousMonth", labelEl: "Προηγούμενος μήνας" },
  { id: "custom", labelEl: "Προσαρμοσμένο" },
];

export function isoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function lastOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

/**
 * Resolves a preset into a concrete `{ from, to }` range. `custom` requires
 * both `customFrom`/`customTo` to already be present and valid --
 * `AnalyticsDashboard` never calls this with `preset: "custom"` until the
 * admin has picked both dates.
 */
export function resolveAnalyticsRange(
  preset: AnalyticsRangePreset,
  now: Date,
  customFrom?: string,
  customTo?: string
): AnalyticsDateRange {
  switch (preset) {
    case "today": {
      const today = isoDate(now);
      return { from: today, to: today };
    }
    case "last7":
      return { from: isoDate(addDays(now, -6)), to: isoDate(now) };
    case "last30":
      return { from: isoDate(addDays(now, -29)), to: isoDate(now) };
    case "thisMonth":
      return { from: isoDate(firstOfMonth(now)), to: isoDate(lastOfMonth(now)) };
    case "previousMonth": {
      const prevMonthAnchor = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { from: isoDate(firstOfMonth(prevMonthAnchor)), to: isoDate(lastOfMonth(prevMonthAnchor)) };
    }
    case "custom":
      if (!customFrom || !customTo) {
        // Defensive fallback -- should be unreachable from the UI (see
        // doc comment above), but never silently returns an invalid range.
        const today = isoDate(now);
        return { from: today, to: today };
      }
      return customFrom <= customTo
        ? { from: customFrom, to: customTo }
        : { from: customTo, to: customFrom };
  }
}
