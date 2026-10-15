import type { BusinessDomain } from "@/lib/domains";

export type EmployeeRole = "owner" | "employee";

export interface Business {
  id: string; slug: string; name: string; phone: string | null;
  email: string | null; address: string | null; city: string | null;
  country: string; timezone: string; currency: string;
  /**
   * Phase 4 / Step 22 -- Business branding. Storage OBJECT PATH inside
   * the private "business-logos" bucket (e.g. "<business_id>/<file>"),
   * NOT a public URL -- same convention as employees.avatar_url. NULL =
   * no logo uploaded. The app generates a short-lived signed URL for
   * display server-side.
   */
  logo_url: string | null;
  /** Hex color (e.g. '#4A90E2') used for the business's admin/public branding accent. NULL = no custom color set. */
  brand_color: string | null;
  /**
   * Step 26 -- business domain module (migration 025: NOT NULL DEFAULT
   * 'barber'). Optional in the type only so that older fixtures/objects
   * without it keep compiling; read it through lib/domains.ts's
   * getBusinessDomain(), which treats a missing value as "barber".
   */
  domain?: BusinessDomain;
  /** businesses.settings jsonb (e.g. travel: { website_url }). Optional in the type for older fixtures. */
  settings?: Record<string, unknown> | null;
  is_active: boolean; created_at: string; updated_at: string;
}

export interface PublicBusiness {
  slug: string; name: string; phone: string | null; email: string | null;
  address: string | null; city: string | null; country: string;
  timezone: string; currency: string; brand_color: string | null;
}

export interface Employee {
  id: string; business_id: string; slug: string; name: string;
  phone: string | null; email: string | null; color: string | null;
  role: EmployeeRole; is_active: boolean; created_at: string; updated_at: string;
}

export interface PublicEmployee {
  id: string; slug: string; name: string; color: string | null; role: EmployeeRole;
}

export interface CreateEmployeeInput {
  name: string; slug: string; phone?: string; email?: string;
  color?: string; role?: EmployeeRole;
}

export interface UpdateEmployeeInput {
  name?: string; slug?: string; phone?: string; email?: string;
  color?: string; role?: EmployeeRole; is_active?: boolean;
}

export type Slug = string;
