import { createServerClient } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

export type BusinessMemberRole = "owner" | "manager" | "employee";

export interface BusinessMembership {
  business_id: string;
  role: BusinessMemberRole;
}

/**
 * Resolves which business(es) an authenticated Supabase Auth user belongs
 * to. Phase 4 / Step 16: a user may in principle belong to more than one
 * business (the schema does not prevent it), but nothing in this step's UI
 * lets an admin choose between businesses -- that's out of scope until a
 * business switcher is genuinely needed. For now, callers use
 * getPrimaryBusinessMembership() below, which picks the single membership
 * a Step-16-era admin is expected to have.
 */
export async function getBusinessMemberships(userId: string): Promise<BusinessMembership[]> {
  const { data, error } = await db()
    .from("business_members")
    .select("business_id, role")
    .eq("user_id", userId);

  if (error) {
    console.error("[business-members] getBusinessMemberships:", JSON.stringify(error));
    return [];
  }
  return (data ?? []) as BusinessMembership[];
}

/**
 * Resolves the single business an authenticated admin acts on.
 *
 * Phase 4 / Step 16 deliberately does not build a business switcher --
 * every admin today has exactly one membership row, seeded by this step's
 * migration/backfill for the existing Medusa Barber owner. If a user has
 * zero memberships, this returns null and callers must treat that as
 * "not authorized for any business" (never fall back to any default
 * business id). If a user somehow has more than one (not reachable via any
 * UI yet, but not schema-forbidden), the first is used and this is logged,
 * since choosing between multiple businesses is explicitly a future
 * (post-Step-16) concern.
 */
export async function getPrimaryBusinessMembership(userId: string): Promise<BusinessMembership | null> {
  const memberships = await getBusinessMemberships(userId);
  if (memberships.length === 0) return null;
  if (memberships.length > 1) {
    console.warn(
      `[business-members] user ${userId} has ${memberships.length} memberships; using the first. ` +
        "Multi-business membership selection is not yet implemented (post-Step-16)."
    );
  }
  return memberships[0];
}

export interface UserBusinessMembership {
  business_id: string;
  business_name: string;
  business_slug: string;
  role: BusinessMemberRole;
}

/**
 * Phase 4 / Step 20 -- Business Switcher.
 *
 * Resolves the FULL list of businesses an authenticated user belongs to,
 * with just enough business-facing information to render a switcher (id,
 * name, slug, this user's role in it) -- never more. Scoped by `user_id`
 * exactly like getBusinessMemberships(); the query itself is what makes
 * it impossible for this to ever return another user's businesses -- there
 * is no code path here that accepts or trusts anything from the client.
 *
 * Uses the existing embedded-select join pattern already established
 * elsewhere in this codebase (see e.g. services/analytics.ts's
 * `employee:employees(name)`, services/catalog.ts's
 * `service_categories(...)`) rather than N+1 round-trips per membership.
 */
export async function getUserBusinessMemberships(userId: string): Promise<UserBusinessMembership[]> {
  const { data, error } = await db()
    .from("business_members")
    .select("business_id, role, business:businesses(name, slug)")
    .eq("user_id", userId);

  if (error) {
    console.error("[business-members] getUserBusinessMemberships:", JSON.stringify(error));
    return [];
  }

  return ((data ?? []) as Array<{
    business_id: string;
    role: BusinessMemberRole;
    business: { name: string; slug: string } | { name: string; slug: string }[] | null;
  }>)
    // A business row could in principle be missing (e.g. a dangling
    // membership after a hard-delete outside the normal soft-delete
    // path) -- skip rather than render a broken switcher entry.
    .filter((row) => row.business != null)
    .map((row) => {
      const business = Array.isArray(row.business) ? row.business[0] : row.business;
      return {
        business_id: row.business_id,
        business_name: business!.name,
        business_slug: business!.slug,
        role: row.role,
      };
    })
    .filter((row): row is UserBusinessMembership => row.business_name != null && row.business_slug != null);
}

/**
 * Phase 4 / Step 20 -- Business Switcher.
 *
 * Independently verifies that `userId` has a membership for `businessId`,
 * via `business_members` -- never trusts that a `businessId` is valid
 * just because it exists in the `businesses` table (a business existing
 * says nothing about whether THIS user may act on it). This is the single
 * choke point the switch server action calls before ever writing the
 * active-business cookie; a null return means "reject the switch,
 * change nothing", never "fall back to some other business" -- that
 * decision belongs to the caller, not this function.
 */
export async function validateBusinessSwitch(
  userId: string,
  businessId: string
): Promise<BusinessMembership | null> {
  if (!businessId) return null;

  const { data, error } = await db()
    .from("business_members")
    .select("business_id, role")
    .eq("user_id", userId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (error || !data) return null;
  return data as BusinessMembership;
}

/**
 * Phase 4 / Step 21 -- Member management.
 */

export interface BusinessMemberWithEmail {
  id: string;
  user_id: string;
  email: string | null;
  role: BusinessMemberRole;
  created_at: string;
}

/**
 * Lists every member of `businessId` with their email, for the owner-facing
 * member-management UI. Scoped exclusively by `business_id` -- the caller
 * (app/admin/(dashboard)/invitations/actions.ts) must have already
 * resolved and authorized that id server-side. Email is resolved
 * per-member via the Supabase Auth admin API (business_members itself has
 * no email column -- auth.users is the single source of truth for it,
 * same reasoning as services/business-invitations.ts's
 * hasActiveInvitationOrMembership()).
 */
export async function getBusinessMembersWithEmail(businessId: string): Promise<BusinessMemberWithEmail[]> {
  const { data, error } = await db()
    .from("business_members")
    .select("id, user_id, role, created_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[business-members] getBusinessMembersWithEmail:", JSON.stringify(error));
    return [];
  }

  const rows = (data ?? []) as Array<{ id: string; user_id: string; role: BusinessMemberRole; created_at: string }>;
  const withEmail: BusinessMemberWithEmail[] = [];
  for (const row of rows) {
    const { data: userData, error: userError } = await db().auth.admin.getUserById(row.user_id);
    if (userError) {
      console.error("[business-members] getBusinessMembersWithEmail getUserById:", JSON.stringify(userError));
    }
    withEmail.push({ ...row, email: userData?.user?.email ?? null });
  }
  return withEmail;
}

export type UpdateMemberRoleError = "not_found" | "invalid_role" | "self" | "target_is_owner" | "db_error";

/**
 * Changes an existing member's role between manager and employee.
 *
 * SECURITY / INVARIANTS (all enforced here, independent of any UI):
 *   - `businessId` scopes every lookup/update -- makes it impossible to
 *     touch a member of a different business even with a guessed
 *     memberUserId (see this step's task spec, §21 -- no cross-tenant
 *     access "even if they manually send business_id=BusinessB").
 *   - `newRole` may only ever be 'manager' or 'employee' -- there is no
 *     code path here that can create a second owner.
 *   - `actingUserId === memberUserId` is always rejected -- an owner can
 *     never change their own role through this function (self-demotion
 *     prevention, task spec §18).
 *   - The target's CURRENT role is independently re-checked here too --
 *     if it is 'owner', the change is rejected outright, regardless of
 *     what newRole was requested. There is no operation in this codebase
 *     that changes an owner's role.
 *
 * Authorization (is the acting user even allowed to change roles at all,
 * i.e. canManageRoles(role)) is the caller's responsibility, same as
 * every other privileged action in this codebase -- this function only
 * enforces the invariants above, which must hold no matter who calls it.
 */
export async function updateMemberRole(
  businessId: string,
  memberUserId: string,
  actingUserId: string,
  newRole: string
): Promise<{ success: true } | { success: false; error: UpdateMemberRoleError }> {
  if (newRole !== "manager" && newRole !== "employee") {
    return { success: false, error: "invalid_role" };
  }
  if (memberUserId === actingUserId) {
    return { success: false, error: "self" };
  }

  const { data: target, error: fetchError } = await db()
    .from("business_members")
    .select("id, role")
    .eq("business_id", businessId)
    .eq("user_id", memberUserId)
    .maybeSingle();

  if (fetchError) {
    console.error("[business-members] updateMemberRole fetch:", JSON.stringify(fetchError));
    return { success: false, error: "db_error" };
  }
  if (!target) {
    return { success: false, error: "not_found" };
  }
  if (target.role === "owner") {
    return { success: false, error: "target_is_owner" };
  }

  const { error } = await db()
    .from("business_members")
    .update({ role: newRole })
    .eq("business_id", businessId)
    .eq("user_id", memberUserId);

  if (error) {
    console.error("[business-members] updateMemberRole update:", JSON.stringify(error));
    return { success: false, error: "db_error" };
  }

  return { success: true };
}

export type RemoveMemberError = "not_found" | "self" | "target_is_owner" | "db_error";

/**
 * Removes a member from a business.
 *
 * Same invariants as updateMemberRole() above: business-scoped, rejects
 * self-removal (task spec §18 -- "Owner cannot remove themselves"), and
 * independently re-checks the target isn't an owner before deleting
 * (owners are never removable through this function -- there is no
 * ownership-transfer feature in this step, per the task's explicit scope
 * boundary).
 */
export async function removeMember(
  businessId: string,
  memberUserId: string,
  actingUserId: string
): Promise<{ success: true } | { success: false; error: RemoveMemberError }> {
  if (memberUserId === actingUserId) {
    return { success: false, error: "self" };
  }

  const { data: target, error: fetchError } = await db()
    .from("business_members")
    .select("id, role")
    .eq("business_id", businessId)
    .eq("user_id", memberUserId)
    .maybeSingle();

  if (fetchError) {
    console.error("[business-members] removeMember fetch:", JSON.stringify(fetchError));
    return { success: false, error: "db_error" };
  }
  if (!target) {
    return { success: false, error: "not_found" };
  }
  if (target.role === "owner") {
    return { success: false, error: "target_is_owner" };
  }

  const { error } = await db()
    .from("business_members")
    .delete()
    .eq("business_id", businessId)
    .eq("user_id", memberUserId);

  if (error) {
    console.error("[business-members] removeMember delete:", JSON.stringify(error));
    return { success: false, error: "db_error" };
  }

  return { success: true };
}
