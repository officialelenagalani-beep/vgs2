/**
 * Roadmap Step 26 -- customer reviews.
 * Mirrors the appointment_reviews table (supabase/migrations/035_appointment_reviews.sql).
 *
 * This file is safe to import from client components: types and plain
 * constants only. Token generation and hashing live in lib/reviews.ts.
 */

/** invited: link issued. pending: submitted, awaiting moderation. approved: public. rejected: hidden. */
export type ReviewStatus = "invited" | "pending" | "approved" | "rejected";

/** The states a submitted review can be in (what the moderation screen lists). */
export const SUBMITTED_REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type SubmittedReviewStatus = (typeof SUBMITTED_REVIEW_STATUSES)[number];

export const REVIEW_STATUS_LABELS_EL: Record<ReviewStatus, string> = {
  invited: "Στάλθηκε σύνδεσμος",
  pending: "Σε αναμονή έγκρισης",
  approved: "Δημοσιευμένη",
  rejected: "Απορρίφθηκε",
};

export const REVIEW_COMMENT_MAX_LENGTH = 1000;
/** A review link works for this many days after it is issued. */
export const REVIEW_LINK_TTL_DAYS = 30;
export const REVIEWS_ADMIN_PAGE_SIZE = 50;
/** Most approved reviews one public request returns. */
export const PUBLIC_REVIEWS_LIMIT = 30;

/** A row as stored. token_hash is deliberately absent: nothing outside services/reviews.ts needs it. */
export interface AppointmentReview {
  id: string;
  business_id: string;
  appointment_id: string;
  customer_id: string | null;
  employee_id: string | null;
  status: ReviewStatus;
  token_expires_at: string;
  rating: number | null;
  comment: string | null;
  reviewer_display_name: string | null;
  service_name: string | null;
  submitted_at: string | null;
  invited_by: string | null;
  moderated_by: string | null;
  moderated_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One line of the moderation screen (owner / manager only). */
export interface AdminReviewItem {
  id: string;
  status: SubmittedReviewStatus;
  rating: number;
  comment: string | null;
  reviewer_display_name: string | null;
  service_name: string | null;
  employee_name: string | null;
  customer_id: string | null;
  submitted_at: string;
  moderated_at: string | null;
}

export interface AdminReviewPage {
  items: AdminReviewItem[];
  hasMore: boolean;
}

/**
 * An approved review as ANY visitor may see it. No ids, no customer link,
 * no exact date -- a shortened name, the rating, the text, the service and
 * the month.
 */
export interface PublicReview {
  rating: number;
  comment: string | null;
  name: string;
  service_name: string | null;
  /** YYYY-MM */
  month: string;
}

export interface PublicReviewSummary {
  count: number;
  /** 1.00 - 5.00, or null when there are no approved reviews. */
  average: number | null;
}

/** What the page behind a review link is allowed to know. */
export type ReviewInvitationView =
  | { state: "open"; businessName: string; serviceName: string | null; appointmentDate: string | null }
  | { state: "submitted"; businessName: string }
  | { state: "invalid" };

/** The authenticated staff member performing a review action. Always resolved server-side. */
export interface ReviewActor {
  id: string;
  role: "owner" | "manager" | "employee";
}
