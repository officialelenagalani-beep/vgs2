import "server-only";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabase/auth-server";
import type { User } from "@supabase/supabase-js";

/**
 * Returns the currently authenticated user, or null if signed out.
 * Safe to call from any Server Component or Server Action.
 */
export async function getUser(): Promise<User | null> {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * Defense-in-depth guard for Server Components under /admin.
 *
 * middleware.ts already redirects unauthenticated requests before they
 * reach the page, so under normal operation this never redirects. It
 * exists as a second, independent check in case middleware is ever
 * bypassed, misconfigured, or its matcher is changed.
 */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) {
    redirect("/admin/login");
  }
  return user;
}

/**
 * Resolves the current admin's identity for audit-log attribution
 * (Phase 4 / Step 14) -- id + email only, nothing else is needed. Returns
 * null instead of redirecting: this is called from inside server actions
 * (app/admin/actions.ts) after a mutation has already succeeded, where a
 * redirect() would be the wrong response to an unrelated auth hiccup.
 * Under normal operation middleware.ts already guarantees a session for
 * every /admin route this is called from, so null here should not occur
 * in practice; callers must treat it as "could not attribute this action"
 * and log accordingly, never as a reason to fabricate an actor.
 */
export async function getActor(): Promise<{ id: string; email: string | null } | null> {
  const user = await getUser();
  if (!user) return null;
  return { id: user.id, email: user.email ?? null };
}
