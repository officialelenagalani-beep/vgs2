/**
 * The demo barbershop used for sales presentations ("Κουρείο Αλέξη").
 * It is an ordinary business marked with settings.is_demo = true; see
 * supabase/migrations/045_demo_business.sql.
 */
export function isDemoBusiness(business: { settings?: unknown } | null | undefined): boolean {
  const settings = business?.settings;
  return typeof settings === "object" && settings !== null && (settings as Record<string, unknown>).is_demo === true;
}
