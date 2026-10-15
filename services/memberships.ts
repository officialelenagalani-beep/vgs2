import "server-only";
import { createServerClient } from "@/lib/supabase/server";
import { addDaysISO, isRealISODate, zonedNow } from "@/lib/booking-rules";
import { parseMoney } from "@/lib/gift-cards";
import { isUuid } from "@/lib/ids";
import {
  MEMBERSHIP_REFUSAL_MESSAGES_EL,
  type ActiveMemberRow,
  type AppointmentOption,
  type CustomerMembership,
  type CustomerMembershipState,
  type MembershipPlan,
  type MembershipRefusal,
  type MembershipView,
  type MembershipVisit,
  type PlanWithMembers,
} from "@/types/memberships";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

/**
 * Memberships (migration 043).
 *
 * TRUST MODEL: `businessId` and the actor come from the caller's session
 * (app/admin/(dashboard)/memberships/actions.ts and the customer actions),
 * never from input. Every read and write filters by business. Visits are
 * recorded only through record_membership_visit / undo_membership_visit,
 * which lock the membership and enforce the monthly limit.
 */

export interface MembershipActor {
  id: string;
  email: string | null;
}

const PLAN_COLUMNS = "id, business_id, name, price, visits_per_month, service_ids, description, is_active, created_at";
const MEMBERSHIP_COLUMNS = "id, customer_id, plan_id, plan_name, visits_per_month, price, service_ids, starts_on, ends_on, status, ended_at, created_at";
const VISIT_COLUMNS = "id, kind, visit_date, period_month, appointment_id, undoes_visit_id, note, actor_email, created_at";
const REFUSALS = Object.keys(MEMBERSHIP_REFUSAL_MESSAGES_EL) as MembershipRefusal[];

function toPlan(r: Record<string, unknown>): MembershipPlan {
  return { ...(r as unknown as MembershipPlan), price: Number(r.price), service_ids: Array.isArray(r.service_ids) ? (r.service_ids as string[]) : [] };
}
function toMembership(r: Record<string, unknown>): CustomerMembership {
  return { ...(r as unknown as CustomerMembership), price: Number(r.price), service_ids: Array.isArray(r.service_ids) ? (r.service_ids as string[]) : [] };
}
function refusal(error: unknown, fallback: string): Error {
  const m = /membership:([a-z_]+)/.exec(String((error as { message?: unknown } | null)?.message ?? ""));
  if (m && (REFUSALS as string[]).includes(m[1])) return new Error(MEMBERSHIP_REFUSAL_MESSAGES_EL[m[1] as MembershipRefusal]);
  console.error("[memberships]", fallback, JSON.stringify(error));
  return new Error(fallback);
}
async function businessToday(businessId: string): Promise<string> {
  const { data } = await db().from("businesses").select("timezone").eq("id", businessId).maybeSingle();
  return zonedNow(data?.timezone ?? null).date;
}
export function monthStart(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface PlanInput {
  name: string;
  price: number;
  visits_per_month: number;
  service_ids: string[];
  description: string | null;
  is_active: boolean;
}

export function parsePlanInput(value: unknown): PlanInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Μη έγκυρα στοιχεία.");
  const v = value as Record<string, unknown>;
  const name = typeof v.name === "string" ? v.name.replace(/\s+/g, " ").trim() : "";
  if (name.length < 2 || name.length > 80) throw new Error("Το όνομα του πακέτου θέλει 2–80 χαρακτήρες.");
  const price = v.price === 0 || v.price === "0" ? 0 : parseMoney(v.price);
  if (price === null) throw new Error("Η τιμή πρέπει να είναι από 0 έως 10.000 € (έως 2 δεκαδικά).");
  const visits = typeof v.visits_per_month === "string" ? Number(v.visits_per_month) : v.visits_per_month;
  if (typeof visits !== "number" || !Number.isInteger(visits) || visits < 1 || visits > 100) {
    throw new Error("Οι επισκέψεις τον μήνα πρέπει να είναι από 1 έως 100.");
  }
  const description = typeof v.description === "string" ? v.description.trim() : "";
  if (description.length > 300) throw new Error("Η περιγραφή είναι πολύ μεγάλη (έως 300 χαρακτήρες).");
  const ids = Array.isArray(v.service_ids) ? v.service_ids : null;
  if (!ids || ids.length > 200 || !ids.every((s) => typeof s === "string" && isUuid(s))) throw new Error("Μη έγκυρη επιλογή υπηρεσιών.");
  if (typeof v.is_active !== "boolean") throw new Error("Μη έγκυρα στοιχεία.");
  return { name, price, visits_per_month: visits, service_ids: Array.from(new Set(ids as string[])), description: description || null, is_active: v.is_active };
}

async function assertOwnServices(businessId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { data, error } = await db().from("services").select("id").eq("business_id", businessId).in("id", ids);
  if (error) throw new Error("Σφάλμα κατά τον έλεγχο των υπηρεσιών.");
  if ((data ?? []).length !== ids.length) throw new Error("Κάποια υπηρεσία δεν βρέθηκε.");
}

export async function listPlans(businessId: string): Promise<PlanWithMembers[]> {
  const [plansRes, activeRes] = await Promise.all([
    db().from("membership_plans").select(PLAN_COLUMNS).eq("business_id", businessId).order("created_at", { ascending: true }).limit(200),
    db().from("customer_memberships").select("plan_id").eq("business_id", businessId).eq("status", "active").limit(100_000),
  ]);
  if (plansRes.error || activeRes.error) throw refusal(plansRes.error ?? activeRes.error, "Σφάλμα κατά τη φόρτωση των συνδρομών.");
  const counts = new Map<string, number>();
  for (const r of (activeRes.data ?? []) as Array<{ plan_id: string }>) counts.set(r.plan_id, (counts.get(r.plan_id) ?? 0) + 1);
  return ((plansRes.data ?? []) as Record<string, unknown>[]).map(toPlan).map((p) => ({ ...p, activeMembers: counts.get(p.id) ?? 0 }));
}

export async function createPlan(businessId: string, actorId: string | null, value: unknown): Promise<MembershipPlan> {
  const input = parsePlanInput(value);
  await assertOwnServices(businessId, input.service_ids);
  const { data, error } = await db()
    .from("membership_plans")
    .insert({ ...input, business_id: businessId, created_by: actorId })
    .select(PLAN_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new Error("Υπάρχει ήδη πακέτο με αυτό το όνομα.");
    throw refusal(error, "Το πακέτο δεν αποθηκεύτηκε. Δοκίμασε ξανά.");
  }
  return toPlan(data);
}

/** Changes apply to NEW sign-ups only; existing members keep the terms they joined with. */
export async function updatePlan(businessId: string, planId: string, value: unknown): Promise<MembershipPlan> {
  if (!isUuid(planId)) throw new Error("Το πακέτο δεν βρέθηκε.");
  const input = parsePlanInput(value);
  await assertOwnServices(businessId, input.service_ids);
  const { data, error } = await db()
    .from("membership_plans")
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", planId)
    .select(PLAN_COLUMNS)
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new Error("Υπάρχει ήδη πακέτο με αυτό το όνομα.");
    throw refusal(error, "Το πακέτο δεν αποθηκεύτηκε. Δοκίμασε ξανά.");
  }
  if (!data) throw new Error("Το πακέτο δεν βρέθηκε.");
  return toPlan(data);
}

// ---------------------------------------------------------------------------
// A customer's membership
// ---------------------------------------------------------------------------

/** Pure: visits used in a month from a list of visit rows (uses minus undos). */
export function usedInMonth(visits: Pick<MembershipVisit, "kind" | "period_month">[], period: string): number {
  let n = 0;
  for (const v of visits) if (v.period_month === period) n += v.kind === "use" ? 1 : -1;
  return Math.max(0, n);
}

async function viewOf(businessId: string, m: CustomerMembership, today: string): Promise<MembershipView> {
  const { data, error } = await db()
    .from("membership_visits")
    .select(VISIT_COLUMNS)
    .eq("business_id", businessId)
    .eq("membership_id", m.id)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw refusal(error, "Σφάλμα κατά τη φόρτωση της συνδρομής.");
  const visits = (data ?? []) as MembershipVisit[];
  const periodMonth = monthStart(today);
  const usedThisMonth = usedInMonth(visits, periodMonth);
  return {
    ...m,
    periodMonth,
    usedThisMonth,
    remainingThisMonth: Math.max(0, m.visits_per_month - usedThisMonth),
    visits: visits.slice(0, 100),
    undone: visits.filter((v) => v.undoes_visit_id).map((v) => v.undoes_visit_id as string),
  };
}

export async function getCustomerMembershipState(businessId: string, customerId: string): Promise<CustomerMembershipState> {
  if (!isUuid(customerId)) return { active: null, past: [], appointmentOptions: [] };
  const today = await businessToday(businessId);
  const [mRes, apptRes] = await Promise.all([
    db().from("customer_memberships").select(MEMBERSHIP_COLUMNS).eq("business_id", businessId).eq("customer_id", customerId).order("created_at", { ascending: false }).limit(50),
    db()
      .from("appointments")
      .select("id, appointment_date, appointment_time, service_name, status")
      .eq("business_id", businessId)
      .eq("customer_id", customerId)
      .is("deleted_at", null)
      .gte("appointment_date", addDaysISO(today, -14))
      .lte("appointment_date", today)
      .order("appointment_date", { ascending: false })
      .limit(30),
  ]);
  if (mRes.error) throw refusal(mRes.error, "Σφάλμα κατά τη φόρτωση της συνδρομής.");
  const all = ((mRes.data ?? []) as Record<string, unknown>[]).map(toMembership);
  const activeRow = all.find((m) => m.status === "active") ?? null;
  const active = activeRow ? await viewOf(businessId, activeRow, today) : null;
  const usedAppointments = new Set(
    (active?.visits ?? []).filter((v) => v.kind === "use" && v.appointment_id && !active!.undone.includes(v.id)).map((v) => v.appointment_id as string)
  );
  const appointmentOptions: AppointmentOption[] = ((apptRes.data ?? []) as Array<AppointmentOption & { status: string }>)
    .filter((a) => a.status !== "cancelled" && !usedAppointments.has(a.id))
    .map(({ id, appointment_date, appointment_time, service_name }) => ({ id, appointment_date, appointment_time: appointment_time.slice(0, 5), service_name }));
  return { active, past: all.filter((m) => m.status !== "active"), appointmentOptions };
}

export async function enrollCustomer(
  businessId: string,
  actorId: string | null,
  input: { customerId: unknown; planId: unknown; startsOn: unknown; endsOn?: unknown }
): Promise<void> {
  if (typeof input.customerId !== "string" || !isUuid(input.customerId)) throw new Error("Ο πελάτης δεν βρέθηκε.");
  if (typeof input.planId !== "string" || !isUuid(input.planId)) throw new Error("Διάλεξε πακέτο.");
  if (!isRealISODate(input.startsOn)) throw new Error("Μη έγκυρη ημερομηνία έναρξης.");
  let endsOn: string | null = null;
  if (input.endsOn !== undefined && input.endsOn !== null && input.endsOn !== "") {
    if (!isRealISODate(input.endsOn)) throw new Error("Μη έγκυρη ημερομηνία λήξης.");
    if (input.endsOn < input.startsOn) throw new Error("Η λήξη είναι πριν από την έναρξη.");
    endsOn = input.endsOn;
  }
  const [{ data: customer }, { data: plan }] = await Promise.all([
    db().from("customers").select("id").eq("business_id", businessId).eq("id", input.customerId).is("deleted_at", null).maybeSingle(),
    db().from("membership_plans").select(PLAN_COLUMNS).eq("business_id", businessId).eq("id", input.planId).maybeSingle(),
  ]);
  if (!customer) throw new Error("Ο πελάτης δεν βρέθηκε.");
  if (!plan || !plan.is_active) throw new Error("Το πακέτο δεν βρέθηκε ή δεν είναι ενεργό.");
  const p = toPlan(plan);
  const { error } = await db().from("customer_memberships").insert({
    business_id: businessId,
    customer_id: input.customerId,
    plan_id: p.id,
    plan_name: p.name,
    visits_per_month: p.visits_per_month,
    price: p.price,
    service_ids: p.service_ids,
    starts_on: input.startsOn,
    ends_on: endsOn,
    created_by: actorId,
  });
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new Error("Ο πελάτης έχει ήδη ενεργή συνδρομή.");
    throw refusal(error, "Η συνδρομή δεν ενεργοποιήθηκε. Δοκίμασε ξανά.");
  }
}

export async function endMembership(businessId: string, actorId: string | null, membershipId: unknown): Promise<void> {
  if (typeof membershipId !== "string" || !isUuid(membershipId)) throw new Error(MEMBERSHIP_REFUSAL_MESSAGES_EL.not_found);
  const { data, error } = await db()
    .from("customer_memberships")
    .update({ status: "ended", ended_at: new Date().toISOString(), ended_by: actorId })
    .eq("business_id", businessId)
    .eq("id", membershipId)
    .eq("status", "active")
    .select("id")
    .maybeSingle();
  if (error) throw refusal(error, "Η λήξη δεν έγινε. Δοκίμασε ξανά.");
  if (!data) throw new Error("Η συνδρομή δεν βρέθηκε ή έχει ήδη λήξει.");
}

export async function recordVisit(
  businessId: string,
  actor: MembershipActor,
  input: { membershipId: unknown; appointmentId?: unknown; visitDate?: unknown; note?: unknown; requestId: unknown }
): Promise<void> {
  if (typeof input.membershipId !== "string" || !isUuid(input.membershipId)) throw new Error(MEMBERSHIP_REFUSAL_MESSAGES_EL.not_found);
  const appointmentId = input.appointmentId === undefined || input.appointmentId === null || input.appointmentId === "" ? null : input.appointmentId;
  if (appointmentId !== null && (typeof appointmentId !== "string" || !isUuid(appointmentId))) throw new Error(MEMBERSHIP_REFUSAL_MESSAGES_EL.bad_appointment);
  const visitDate = input.visitDate === undefined || input.visitDate === null || input.visitDate === "" ? null : input.visitDate;
  if (visitDate !== null && !isRealISODate(visitDate)) throw new Error("Μη έγκυρη ημερομηνία.");
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(input.requestId)) throw new Error("Μη έγκυρο αίτημα.");
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) : null;
  const { error } = await db().rpc("record_membership_visit", {
    p_business_id: businessId,
    p_membership_id: input.membershipId,
    p_visit_date: visitDate,
    p_appointment_id: appointmentId,
    p_note: note || null,
    p_actor_id: actor.id,
    p_actor_email: actor.email,
    p_idempotency_key: `visit:${input.requestId}`,
  });
  if (error) throw refusal(error, "Η επίσκεψη δεν καταγράφηκε. Δοκίμασε ξανά.");
}

export async function undoVisit(businessId: string, actor: MembershipActor, visitId: unknown): Promise<void> {
  if (typeof visitId !== "string" || !isUuid(visitId)) throw new Error(MEMBERSHIP_REFUSAL_MESSAGES_EL.not_found);
  const { error } = await db().rpc("undo_membership_visit", {
    p_business_id: businessId,
    p_visit_id: visitId,
    p_actor_id: actor.id,
    p_actor_email: actor.email,
  });
  if (error) throw refusal(error, "Η αναίρεση δεν έγινε. Δοκίμασε ξανά.");
}

/** For the memberships page: every active member and how many visits they used this month. */
export async function listActiveMembers(businessId: string): Promise<{ members: ActiveMemberRow[]; today: string }> {
  const today = await businessToday(businessId);
  const { data, error } = await db()
    .from("customer_memberships")
    .select("id, customer_id, plan_name, visits_per_month, price, starts_on, customer:customers(name)")
    .eq("business_id", businessId)
    .eq("status", "active")
    .order("starts_on", { ascending: false })
    .limit(2000);
  if (error) throw refusal(error, "Σφάλμα κατά τη φόρτωση των μελών.");
  const rows = (data ?? []) as Array<{ id: string; customer_id: string; plan_name: string; visits_per_month: number; price: number | string; starts_on: string; customer: { name: string } | null }>;
  const used = new Map<string, number>();
  if (rows.length > 0) {
    const { data: visits, error: vErr } = await db()
      .from("membership_visits")
      .select("membership_id, kind")
      .eq("business_id", businessId)
      .eq("period_month", monthStart(today))
      .in("membership_id", rows.map((r) => r.id))
      .limit(100_000);
    if (vErr) throw refusal(vErr, "Σφάλμα κατά τη φόρτωση των μελών.");
    for (const v of (visits ?? []) as Array<{ membership_id: string; kind: string }>) {
      used.set(v.membership_id, (used.get(v.membership_id) ?? 0) + (v.kind === "use" ? 1 : -1));
    }
  }
  return {
    today,
    members: rows.map((r) => ({
      membershipId: r.id,
      customerId: r.customer_id,
      customerName: r.customer?.name ?? "—",
      planName: r.plan_name,
      visitsPerMonth: r.visits_per_month,
      usedThisMonth: Math.max(0, used.get(r.id) ?? 0),
      startsOn: r.starts_on,
      price: Number(r.price),
    })),
  };
}
