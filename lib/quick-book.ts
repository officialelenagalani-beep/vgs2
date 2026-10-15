/**
 * Pure helpers for the booking app (components/booking/QuickBook.tsx):
 * service -> barber -> day & time -> details. No React, no network.
 */

export type TeamMember = { id: string; name: string };

/** The barbers who perform `serviceSlug`, in the shop's order. */
export function barbersFor(
  serviceSlug: string | null | undefined,
  team: TeamMember[],
  byService: Record<string, string[]>
): TeamMember[] {
  if (!serviceSlug) return [];
  const ids = byService[serviceSlug] ?? [];
  const byId = new Map(team.map((m) => [m.id, m]));
  return ids.map((id) => byId.get(id)).filter((m): m is TeamMember => Boolean(m));
}

export type DayPart = { key: "morning" | "afternoon" | "evening"; label: string; slots: string[] };

/** "09:30" -> morning (before 12), afternoon (12-17), evening (17+). Empty parts are left out. */
export function groupSlots(slots: string[]): DayPart[] {
  const parts: DayPart[] = [
    { key: "morning", label: "Πρωί", slots: [] },
    { key: "afternoon", label: "Μεσημέρι", slots: [] },
    { key: "evening", label: "Απόγευμα", slots: [] },
  ];
  for (const s of [...slots].sort()) {
    const h = Number(s.slice(0, 2));
    if (!Number.isFinite(h)) continue;
    parts[h < 12 ? 0 : h < 17 ? 1 : 2].slots.push(s);
  }
  return parts.filter((p) => p.slots.length > 0);
}

/** Today and the next `count - 1` days, at local midnight. */
export function nextDays(count: number, from: Date = new Date()): Date[] {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  return Array.from({ length: count }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/** 14 -> "14€", 12.5 -> "12,50€" */
export function euro(n: number): string {
  const v = Math.round(Number(n) * 100) / 100;
  return `${Number.isInteger(v) ? v : v.toFixed(2).replace(".", ",")}€`;
}

/** First letter for an avatar ("Νίκος" -> "Ν"). */
export function initial(name: string): string {
  return (name.trim()[0] ?? "?").toLocaleUpperCase("el-GR");
}

/** "Τρίτη 14 Οκτωβρίου" */
export function longDay(d: Date): string {
  return d.toLocaleDateString("el-GR", { weekday: "long", day: "numeric", month: "long" });
}

/** "Σήμερα" / "Αύριο" / "Πεμ" */
export function dayLabel(d: Date, today: Date = new Date()): string {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - t) / 86_400_000);
  if (diff === 0) return "Σήμερα";
  if (diff === 1) return "Αύριο";
  return d.toLocaleDateString("el-GR", { weekday: "short" }).replace(".", "");
}

export const PHONE_RE = /^[0-9+ ]{8,15}$/;
