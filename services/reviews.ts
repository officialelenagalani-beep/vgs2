import { createServerClient } from "@/lib/supabase/server";
import { canIssueReviewLinks, canModerateReviews, canViewReviews } from "@/lib/auth/roles";
import {
  cleanReviewComment,
  generateReviewToken,
  hashReviewToken,
  isReviewTokenFormat,
  parseRating,
  reviewMonth,
  reviewerDisplayName,
} from "@/lib/reviews";
import {
  PUBLIC_REVIEWS_LIMIT,
  REVIEW_LINK_TTL_DAYS,
  REVIEWS_ADMIN_PAGE_SIZE,
  SUBMITTED_REVIEW_STATUSES,
  type AdminReviewItem,
  type AdminReviewPage,
  type PublicReview,
  type PublicReviewSummary,
  type ReviewActor,
  type ReviewInvitationView,
  type ReviewStatus,
  type SubmittedReviewStatus,
} from "@/types/reviews";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createServerClient() as any;

/**
 * Roadmap Step 26 -- customer reviews.
 *
 *   staff (owner/manager)        customer (no account)          anyone
 *   ---------------------        ---------------------          ------
 *   issueReviewLink()      ->    getReviewInvitationByToken()
 *                                submitReview()            ->   (pending)
 *   listReviewsForAdmin()
 *   moderateReview()       ------------------------------->     getPublicReviews()
 *                                                               getPublicReviewSummary()
 *
 * SECURITY NOTES
 *   - The link's token exists in plain form in exactly two places: the
 *     return value of issueReviewLink() (shown once to the staff member who
 *     asked for it) and the customer's own link. The database holds only
 *     its SHA-256 hash, and every lookup is by hash.
 *   - The customer-facing functions take NOTHING but the token (and the
 *     rating/comment): no business id, no appointment id. Which review is
 *     written to is decided entirely by the token.
 *   - Unknown, expired and malformed tokens are all answered the same way
 *     ("invalid"), so the endpoint cannot be used to probe for valid links.
 *   - The staff-facing functions take `businessId` and `actor` from the
 *     caller's server-side session resolution and check the role
 *     themselves; every query is filtered by business_id.
 *   - Nothing here returns a customer's phone number or e-mail address, and
 *     the public functions return no ids of any kind.
 *   - The database enforces the core rules independently of this file
 *     (035_appointment_reviews.sql): one review per appointment, completed
 *     appointments only, single use, expiry, and that a submitted review's
 *     content can never be changed.
 */

const PG_UNIQUE_VIOLATION = "23505";
const PG_CHECK_VIOLATION = "23514";

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? ((error as { code: string }).code)
    : null;
}

function requireActor(actor: ReviewActor | null | undefined): ReviewActor {
  if (!actor || typeof actor.id !== "string" || actor.id.length === 0) {
    throw new Error("Δεν ήταν δυνατή η ταυτοποίηση του χρήστη.");
  }
  return actor;
}

// ---------------------------------------------------------------------------
// Staff: issue a review link
// ---------------------------------------------------------------------------

export interface IssuedReviewLink {
  /** The raw token -- returned ONCE, never stored. The link is `/review/<token>`. */
  token: string;
  expiresAt: string;
  /** True when a previous, unused link for the same appointment was replaced (it no longer works). */
  replacedPrevious: boolean;
}

const NOT_COMPLETED_MESSAGE = "Κριτική μπορεί να ζητηθεί μόνο για ολοκληρωμένο ραντεβού.";
const ALREADY_REVIEWED_MESSAGE = "Υπάρχει ήδη κριτική για αυτό το ραντεβού.";
const ISSUE_FAILED_MESSAGE = "Ο σύνδεσμος δεν δημιουργήθηκε. Δοκίμασε ξανά.";

/**
 * Creates the review link for one COMPLETED appointment of this business.
 * If an unused link already exists it is replaced (the old one stops
 * working); if the customer has already submitted, it refuses.
 */
export async function issueReviewLink(input: {
  businessId: string;
  appointmentId: string;
  actor: ReviewActor;
  /** Injectable clock for tests. */
  now?: Date;
}): Promise<IssuedReviewLink> {
  const actor = requireActor(input.actor);
  if (!canIssueReviewLinks(actor.role)) throw new Error("Δεν έχεις δικαίωμα να ζητήσεις κριτική.");

  const { data: appointment, error: appointmentError } = await db()
    .from("appointments")
    .select("id, status, customer_id, employee_id, service_name")
    .eq("business_id", input.businessId)
    .eq("id", input.appointmentId)
    .is("deleted_at", null)
    .maybeSingle();

  if (appointmentError) {
    console.error("[reviews] issueReviewLink appointment read:", JSON.stringify(appointmentError));
    throw new Error(ISSUE_FAILED_MESSAGE);
  }
  if (!appointment) throw new Error("Το ραντεβού δεν βρέθηκε.");
  if (appointment.status !== "completed") throw new Error(NOT_COMPLETED_MESSAGE);

  const now = input.now ?? new Date();
  const token = generateReviewToken();
  const tokenHash = hashReviewToken(token);
  const expiresAt = new Date(now.getTime() + REVIEW_LINK_TTL_DAYS * 86_400_000).toISOString();

  /** Replaces the token of an existing, still-unused invitation. Returns false when there is none. */
  const replaceExisting = async (): Promise<boolean> => {
    const { data, error } = await db()
      .from("appointment_reviews")
      .update({ token_hash: tokenHash, token_expires_at: expiresAt, invited_by: actor.id })
      .eq("business_id", input.businessId)
      .eq("appointment_id", appointment.id)
      .eq("status", "invited")
      .select("id")
      .maybeSingle();
    if (error) {
      if (errorCode(error) === PG_CHECK_VIOLATION) throw new Error(NOT_COMPLETED_MESSAGE);
      console.error("[reviews] issueReviewLink re-issue:", JSON.stringify(error));
      throw new Error(ISSUE_FAILED_MESSAGE);
    }
    return Boolean(data);
  };

  const { data: existing, error: existingError } = await db()
    .from("appointment_reviews")
    .select("id, status")
    .eq("business_id", input.businessId)
    .eq("appointment_id", appointment.id)
    .maybeSingle();
  if (existingError) {
    console.error("[reviews] issueReviewLink existing read:", JSON.stringify(existingError));
    throw new Error(ISSUE_FAILED_MESSAGE);
  }

  if (existing) {
    if (existing.status !== "invited") throw new Error(ALREADY_REVIEWED_MESSAGE);
    // The customer may submit between the read above and this write; then nothing is replaced.
    if (!(await replaceExisting())) throw new Error(ALREADY_REVIEWED_MESSAGE);
    return { token, expiresAt, replacedPrevious: true };
  }

  const { error: insertError } = await db()
    .from("appointment_reviews")
    .insert({
      business_id: input.businessId,
      appointment_id: appointment.id,
      customer_id: appointment.customer_id ?? null,
      employee_id: appointment.employee_id ?? null,
      service_name: typeof appointment.service_name === "string" ? appointment.service_name.slice(0, 200) : null,
      token_hash: tokenHash,
      token_expires_at: expiresAt,
      invited_by: actor.id,
    })
    .select("id")
    .single();

  if (insertError) {
    const code = errorCode(insertError);
    if (code === PG_UNIQUE_VIOLATION) {
      // A colleague issued a link for the same appointment a moment ago: replace theirs.
      if (await replaceExisting()) return { token, expiresAt, replacedPrevious: true };
      throw new Error(ALREADY_REVIEWED_MESSAGE);
    }
    if (code === PG_CHECK_VIOLATION) throw new Error(NOT_COMPLETED_MESSAGE);
    console.error("[reviews] issueReviewLink insert:", JSON.stringify(insertError));
    throw new Error(ISSUE_FAILED_MESSAGE);
  }

  return { token, expiresAt, replacedPrevious: false };
}

/**
 * The automatic counterpart of issueReviewLink(), for the scheduled job
 * (services/review-requests.ts): creates the invitation for a completed
 * appointment ONLY if the appointment has none yet -- an existing one (a
 * link staff already gave, or an earlier automatic one) is never replaced.
 * Returns the raw token, or null when there is nothing to do.
 */
export async function createAutomaticReviewInvitation(input: {
  businessId: string;
  appointment: { id: string; customer_id: string | null; employee_id: string | null; service_name: string | null };
  now?: Date;
}): Promise<{ token: string; expiresAt: string } | null> {
  const now = input.now ?? new Date();
  const token = generateReviewToken();
  const expiresAt = new Date(now.getTime() + REVIEW_LINK_TTL_DAYS * 86_400_000).toISOString();
  const { error } = await db()
    .from("appointment_reviews")
    .insert({
      business_id: input.businessId,
      appointment_id: input.appointment.id,
      customer_id: input.appointment.customer_id ?? null,
      employee_id: input.appointment.employee_id ?? null,
      service_name: typeof input.appointment.service_name === "string" ? input.appointment.service_name.slice(0, 200) : null,
      token_hash: hashReviewToken(token),
      token_expires_at: expiresAt,
      invited_by: null,
    })
    .select("id")
    .single();
  if (error) {
    // 23505: already has one; 23514: no longer completed. Neither is a failure of the job.
    const code = errorCode(error);
    if (code !== PG_UNIQUE_VIOLATION && code !== PG_CHECK_VIOLATION) {
      console.error("[reviews] createAutomaticReviewInvitation:", JSON.stringify(error));
    }
    return null;
  }
  return { token, expiresAt };
}

/**
 * Removes an automatic invitation that was never delivered (the e-mail
 * failed), so a later run can try again. Only an unanswered invitation
 * with no inviting staff member is ever removed.
 */
export async function withdrawAutomaticReviewInvitation(businessId: string, appointmentId: string): Promise<void> {
  const { error } = await db()
    .from("appointment_reviews")
    .delete()
    .eq("business_id", businessId)
    .eq("appointment_id", appointmentId)
    .eq("status", "invited")
    .is("invited_by", null);
  if (error) console.error("[reviews] withdrawAutomaticReviewInvitation:", JSON.stringify(error));
}

// ---------------------------------------------------------------------------
// Customer: open the link, submit
// ---------------------------------------------------------------------------

type TokenRow = {
  id: string;
  business_id: string;
  appointment_id: string;
  status: ReviewStatus;
  token_expires_at: string;
  service_name: string | null;
};

async function findByToken(token: unknown): Promise<TokenRow | null> {
  if (!isReviewTokenFormat(token)) return null; // never reaches the database
  const { data, error } = await db()
    .from("appointment_reviews")
    .select("id, business_id, appointment_id, status, token_expires_at, service_name")
    .eq("token_hash", hashReviewToken(token))
    .maybeSingle();
  if (error) {
    console.error("[reviews] findByToken:", JSON.stringify(error));
    return null;
  }
  return (data as TokenRow) ?? null;
}

async function businessNameOf(businessId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("businesses")
    .select("name")
    .eq("id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (error || !data || typeof data.name !== "string") return null;
  return data.name;
}

/**
 * What the page behind a review link may show. Unknown, malformed and
 * expired links are all "invalid". The customer's own name is NOT returned:
 * the page never needs it, and a link that leaks (forwarded, screenshot)
 * should not identify anyone.
 */
export async function getReviewInvitationByToken(token: unknown, now: Date = new Date()): Promise<ReviewInvitationView> {
  const row = await findByToken(token);
  if (!row) return { state: "invalid" };

  const businessName = await businessNameOf(row.business_id);
  if (!businessName) return { state: "invalid" }; // business closed or removed

  if (row.status !== "invited") return { state: "submitted", businessName };
  if (new Date(row.token_expires_at).getTime() <= now.getTime()) return { state: "invalid" };

  const { data: appointment } = await db()
    .from("appointments")
    .select("appointment_date, status")
    .eq("business_id", row.business_id)
    .eq("id", row.appointment_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!appointment || appointment.status !== "completed") return { state: "invalid" };

  return {
    state: "open",
    businessName,
    serviceName: row.service_name,
    appointmentDate: typeof appointment.appointment_date === "string" ? appointment.appointment_date : null,
  };
}

export type SubmitReviewResult =
  | { ok: true }
  /** invalid: the link is unknown, expired, already used, or its appointment no longer qualifies. */
  | { ok: false; reason: "invalid" }
  /** validation: the rating or comment was not acceptable; `message` says why. */
  | { ok: false; reason: "validation"; message: string };

/**
 * Records the customer's review. Works exactly once per link: the UPDATE is
 * conditional on the row still being an unexpired invitation, so two
 * simultaneous submissions cannot both succeed, and the database trigger
 * refuses any later change to what was written.
 */
export async function submitReview(input: {
  token: unknown;
  rating: unknown;
  comment?: unknown;
  now?: Date;
}): Promise<SubmitReviewResult> {
  const rating = parseRating(input.rating);
  if (rating === null) return { ok: false, reason: "validation", message: "Διάλεξε βαθμολογία από 1 έως 5." };

  let comment: string | null;
  try {
    comment = cleanReviewComment(input.comment);
  } catch (err) {
    return { ok: false, reason: "validation", message: err instanceof Error ? err.message : "Το σχόλιο δεν είναι έγκυρο." };
  }

  const now = input.now ?? new Date();
  const row = await findByToken(input.token);
  if (!row || row.status !== "invited" || new Date(row.token_expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: "invalid" };
  }

  // The displayed name comes from the appointment the link belongs to --
  // never from anything the submitter sends.
  const { data: appointment, error: appointmentError } = await db()
    .from("appointments")
    .select("customer_name, status")
    .eq("business_id", row.business_id)
    .eq("id", row.appointment_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (appointmentError || !appointment || appointment.status !== "completed") {
    return { ok: false, reason: "invalid" };
  }

  const nowISO = now.toISOString();
  const { data: updated, error: updateError } = await db()
    .from("appointment_reviews")
    .update({
      status: "pending",
      rating,
      comment,
      reviewer_display_name: reviewerDisplayName(appointment.customer_name),
      submitted_at: nowISO,
    })
    .eq("id", row.id)
    .eq("token_hash", hashReviewToken(input.token as string))
    .eq("status", "invited")
    .gt("token_expires_at", nowISO)
    .select("id")
    .maybeSingle();

  if (updateError) {
    // 23514: the database guard refused (expired, or the appointment is no longer completed).
    if (errorCode(updateError) !== PG_CHECK_VIOLATION) {
      console.error("[reviews] submitReview update:", JSON.stringify(updateError));
    }
    return { ok: false, reason: "invalid" };
  }
  if (!updated) return { ok: false, reason: "invalid" }; // used a moment ago by another request

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Staff: list and moderate
// ---------------------------------------------------------------------------

function isSubmittedStatus(value: unknown): value is SubmittedReviewStatus {
  return typeof value === "string" && (SUBMITTED_REVIEW_STATUSES as readonly string[]).includes(value);
}

/** Submitted reviews of this business, newest first. Invitations nobody answered are not reviews and are not listed. */
export async function listReviewsForAdmin(
  businessId: string,
  actor: ReviewActor,
  options: { status?: SubmittedReviewStatus; page?: number } = {}
): Promise<AdminReviewPage> {
  requireActor(actor);
  if (!canViewReviews(actor.role)) throw new Error("Δεν έχεις δικαίωμα προβολής κριτικών.");

  const page = Number.isInteger(options.page) && (options.page as number) > 0 ? (options.page as number) : 0;
  const statuses = isSubmittedStatus(options.status) ? [options.status] : [...SUBMITTED_REVIEW_STATUSES];
  const from = page * REVIEWS_ADMIN_PAGE_SIZE;

  const { data, error } = await db()
    .from("appointment_reviews")
    .select("id, status, rating, comment, reviewer_display_name, service_name, employee_id, customer_id, submitted_at, moderated_at")
    .eq("business_id", businessId)
    .in("status", statuses)
    .order("submitted_at", { ascending: false })
    // one extra row tells us whether there is a next page
    .range(from, from + REVIEWS_ADMIN_PAGE_SIZE);

  if (error) {
    console.error("[reviews] listReviewsForAdmin:", JSON.stringify(error));
    return { items: [], hasMore: false };
  }

  type Row = Omit<AdminReviewItem, "employee_name"> & { employee_id: string | null };
  const rows = (data ?? []) as Row[];
  const pageRows = rows.slice(0, REVIEWS_ADMIN_PAGE_SIZE);

  const employeeIds = Array.from(new Set(pageRows.map((r) => r.employee_id).filter((id): id is string => Boolean(id))));
  const names = new Map<string, string>();
  if (employeeIds.length > 0) {
    const { data: employees, error: employeesError } = await db()
      .from("employees")
      .select("id, name")
      .eq("business_id", businessId)
      .in("id", employeeIds);
    if (employeesError) {
      console.error("[reviews] listReviewsForAdmin employees:", JSON.stringify(employeesError));
    } else {
      for (const e of (employees ?? []) as { id: string; name: string }[]) names.set(e.id, e.name);
    }
  }

  return {
    items: pageRows.map((r) => ({
      id: r.id,
      status: r.status,
      rating: r.rating,
      comment: r.comment,
      reviewer_display_name: r.reviewer_display_name,
      service_name: r.service_name,
      employee_name: r.employee_id ? names.get(r.employee_id) ?? null : null,
      customer_id: r.customer_id,
      submitted_at: r.submitted_at,
      moderated_at: r.moderated_at,
    })),
    hasMore: rows.length > REVIEWS_ADMIN_PAGE_SIZE,
  };
}

/**
 * Approves or rejects a submitted review. May be changed later (approved
 * <-> rejected). The review's content is never part of the update.
 */
export async function moderateReview(input: {
  businessId: string;
  reviewId: string;
  decision: unknown;
  actor: ReviewActor;
  now?: Date;
}): Promise<{ id: string; status: SubmittedReviewStatus }> {
  const actor = requireActor(input.actor);
  if (!canModerateReviews(actor.role)) throw new Error("Δεν έχεις δικαίωμα έγκρισης κριτικών.");
  if (input.decision !== "approved" && input.decision !== "rejected") {
    throw new Error("Μη έγκυρη ενέργεια.");
  }

  const { data, error } = await db()
    .from("appointment_reviews")
    .update({
      status: input.decision,
      moderated_by: actor.id,
      moderated_at: (input.now ?? new Date()).toISOString(),
    })
    .eq("business_id", input.businessId)
    .eq("id", input.reviewId)
    .in("status", [...SUBMITTED_REVIEW_STATUSES])
    .select("id, status")
    .maybeSingle();

  if (error) {
    console.error("[reviews] moderateReview:", JSON.stringify(error));
    throw new Error("Η αλλαγή δεν αποθηκεύτηκε. Δοκίμασε ξανά.");
  }
  if (!data) throw new Error("Η κριτική δεν βρέθηκε.");
  return { id: data.id as string, status: data.status as SubmittedReviewStatus };
}

/**
 * Review state per appointment, for the customer-history view:
 * appointment id -> status. Appointments without a row are simply absent.
 */
export async function getReviewStatusByAppointment(
  businessId: string,
  appointmentIds: string[],
  actor: ReviewActor
): Promise<Record<string, ReviewStatus>> {
  requireActor(actor);
  if (!canViewReviews(actor.role)) return {};
  const ids = Array.from(new Set(appointmentIds.filter((id) => typeof id === "string" && id.length > 0)));
  if (ids.length === 0) return {};

  const { data, error } = await db()
    .from("appointment_reviews")
    .select("appointment_id, status")
    .eq("business_id", businessId)
    .in("appointment_id", ids);
  if (error) {
    console.error("[reviews] getReviewStatusByAppointment:", JSON.stringify(error));
    return {};
  }
  const result: Record<string, ReviewStatus> = {};
  for (const r of (data ?? []) as { appointment_id: string; status: ReviewStatus }[]) {
    result[r.appointment_id] = r.status;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Anyone: approved reviews
// ---------------------------------------------------------------------------

/** Approved reviews only, newest first, stripped to what a public page may show. */
export async function getPublicReviews(businessId: string, limit: number = PUBLIC_REVIEWS_LIMIT): Promise<PublicReview[]> {
  const capped = Number.isInteger(limit) ? Math.min(PUBLIC_REVIEWS_LIMIT, Math.max(1, limit)) : PUBLIC_REVIEWS_LIMIT;
  const { data, error } = await db()
    .from("appointment_reviews")
    .select("rating, comment, reviewer_display_name, service_name, submitted_at")
    .eq("business_id", businessId)
    .eq("status", "approved")
    .order("submitted_at", { ascending: false })
    .limit(capped);

  if (error) {
    console.error("[reviews] getPublicReviews:", JSON.stringify(error));
    return [];
  }
  type Row = { rating: number; comment: string | null; reviewer_display_name: string | null; service_name: string | null; submitted_at: string | null };
  return ((data ?? []) as Row[]).map((r) => ({
    rating: r.rating,
    comment: r.comment,
    // run through the same filter again on the way out: defence in depth
    name: reviewerDisplayName(r.reviewer_display_name),
    service_name: r.service_name,
    month: reviewMonth(r.submitted_at),
  }));
}

/** Count and average of approved reviews (get_review_summary()). Zero / null on any failure. */
export async function getPublicReviewSummary(businessId: string): Promise<PublicReviewSummary> {
  const { data, error } = await db().rpc("get_review_summary", { p_business_id: businessId });
  if (error) {
    console.error("[reviews] getPublicReviewSummary:", JSON.stringify(error));
    return { count: 0, average: null };
  }
  const row = (Array.isArray(data) ? data[0] : data) as { review_count?: unknown; average_rating?: unknown } | null | undefined;
  const count = Number(row?.review_count ?? 0);
  const average = row?.average_rating === null || row?.average_rating === undefined ? null : Number(row.average_rating);
  if (!Number.isFinite(count) || count <= 0 || average === null || !Number.isFinite(average)) {
    return { count: 0, average: null };
  }
  return { count, average };
}
