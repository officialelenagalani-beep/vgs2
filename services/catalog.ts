import "server-only";
import { createServerClient } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

/**
 * Phase 4 / Step 17 (services-catalog cutover, following the Step 16 audit's
 * gap #6): the public, per-business service catalog -- what a customer sees
 * on the marketing site and in the booking wizard -- sourced from the real,
 * already-existing, already-business-scoped `services`/`service_categories`
 * DB tables (seeded per-business since 002_seed_medusa.sql), never from
 * lib/services.ts's static, single-tenant, hardcoded catalog.
 *
 * This is a read-only, publicly-exposable catalog (no auth required to
 * view it -- prices/durations are public information, same as before this
 * cutover). It is deliberately a SEPARATE function from
 * services/employee-services.ts's getBusinessServices(), which returns a
 * differently-shaped ServiceOption[] for the admin employee-assignment
 * picker -- keeping them separate avoids reshaping that picker's existing,
 * already-tested contract for an unrelated consumer.
 */

export interface PublicCatalogService {
  /** services.slug -- the bookable identifier passed to createAppointment
   *  / getAvailability / resolveBookableService as `service`. Exposed to
   *  API consumers as `id` for backward compatibility with the response
   *  shape this replaces (see app/api/v1/businesses/[slug]/services/route.ts). */
  slug: string;
  name: string;
  duration: number;
  price: number;
}

export interface PublicCatalogCategory {
  id: string;
  label: string;
  services: PublicCatalogService[];
}

export interface PublicServiceCatalog {
  categories: PublicCatalogCategory[];
  all: (PublicCatalogService & { category_id: string | null })[];
}

const EMPTY_CATALOG: PublicServiceCatalog = { categories: [], all: [] };

export async function getPublicServiceCatalog(businessId: string): Promise<PublicServiceCatalog> {
  const { data, error } = await db()
    .from("services")
    .select("slug, name, price, duration_min, sort_order, category_id, service_categories(id, name, sort_order, is_active)")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    console.error("[catalog] getPublicServiceCatalog:", JSON.stringify(error));
    return EMPTY_CATALOG;
  }

  type Row = {
    slug: string;
    name: string;
    price: number;
    duration_min: number;
    sort_order: number;
    category_id: string | null;
    service_categories: { id: string; name: string; sort_order: number; is_active: boolean } | null;
  };

  const rows = (data ?? []) as Row[];

  const categoryOrder = new Map<string, number>();
  const byCategory = new Map<string, PublicCatalogCategory>();
  const all: PublicServiceCatalog["all"] = [];

  for (const row of rows) {
    const service: PublicCatalogService = {
      slug: row.slug,
      name: row.name,
      duration: row.duration_min,
      price: Number(row.price),
    };
    all.push({ ...service, category_id: row.category_id });

    const category = row.service_categories;
    if (category && category.is_active) {
      if (!byCategory.has(category.id)) {
        byCategory.set(category.id, { id: category.id, label: category.name, services: [] });
        categoryOrder.set(category.id, category.sort_order);
      }
      byCategory.get(category.id)!.services.push(service);
    }
  }

  const categories = Array.from(byCategory.values()).sort(
    (a, b) => (categoryOrder.get(a.id) ?? 0) - (categoryOrder.get(b.id) ?? 0)
  );

  return { categories, all };
}

// ---------------------------------------------------------------------------
// Public team per service (for "choose your barber" on the booking page)
// ---------------------------------------------------------------------------

export interface PublicTeamMember {
  /** employees.id -- passed back as `employeeId` (availability) / `employee_id` (booking). */
  id: string;
  /** First name as the shop wrote it; nothing else about the person is exposed. */
  name: string;
}

export interface PublicTeam {
  members: PublicTeamMember[];
  /** service slug -> ids of the active barbers who perform it. */
  byService: Record<string, string[]>;
}

const EMPTY_TEAM: PublicTeam = { members: [], byService: {} };

/**
 * Who can be chosen for which service. Only active employees, only their
 * name. Fails closed to an empty team, in which case the booking page simply
 * books "whoever is free" exactly as before.
 */
export async function getPublicTeam(businessId: string): Promise<PublicTeam> {
  try {
    const [employees, links, services] = await Promise.all([
      db().from("employees").select("id, name, created_at").eq("business_id", businessId).eq("is_active", true).order("created_at"),
      db().from("employee_services").select("employee_id, service_id").eq("business_id", businessId),
      db().from("services").select("id, slug").eq("business_id", businessId).eq("is_active", true),
    ]);
    if (employees.error || links.error || services.error) {
      console.error("[catalog] getPublicTeam:", JSON.stringify(employees.error ?? links.error ?? services.error));
      return EMPTY_TEAM;
    }
    const members = ((employees.data ?? []) as Array<{ id: string; name: string }>).map((e) => ({ id: e.id, name: e.name }));
    const active = new Set(members.map((m) => m.id));
    const slugById = new Map(((services.data ?? []) as Array<{ id: string; slug: string }>).map((s) => [s.id, s.slug]));
    const byService: Record<string, string[]> = {};
    for (const link of (links.data ?? []) as Array<{ employee_id: string; service_id: string }>) {
      const slug = slugById.get(link.service_id);
      if (!slug || !active.has(link.employee_id)) continue;
      (byService[slug] ??= []).push(link.employee_id);
    }
    // Keep the shop's own order (as the team is listed) inside every service.
    const order = new Map(members.map((m, i) => [m.id, i]));
    for (const slug of Object.keys(byService)) byService[slug].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    return { members, byService };
  } catch (e) {
    console.error("[catalog] getPublicTeam failed:", e);
    return EMPTY_TEAM;
  }
}
