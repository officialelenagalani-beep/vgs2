/** Memberships (migration 043_memberships.sql). */

export interface MembershipPlan {
  id: string;
  business_id: string;
  name: string;
  price: number;
  visits_per_month: number;
  service_ids: string[];
  description: string | null;
  is_active: boolean;
  created_at: string;
}

export interface PlanWithMembers extends MembershipPlan {
  activeMembers: number;
}

export interface MembershipVisit {
  id: string;
  kind: "use" | "undo";
  visit_date: string;
  period_month: string;
  appointment_id: string | null;
  undoes_visit_id: string | null;
  note: string | null;
  actor_email: string | null;
  created_at: string;
}

export interface CustomerMembership {
  id: string;
  customer_id: string;
  plan_id: string;
  plan_name: string;
  visits_per_month: number;
  price: number;
  service_ids: string[];
  starts_on: string;
  ends_on: string | null;
  status: "active" | "ended";
  ended_at: string | null;
  created_at: string;
}

export interface MembershipView extends CustomerMembership {
  /** First day of the current month (business calendar). */
  periodMonth: string;
  usedThisMonth: number;
  remainingThisMonth: number;
  visits: MembershipVisit[];
  undone: string[];
}

export interface AppointmentOption {
  id: string;
  appointment_date: string;
  appointment_time: string;
  service_name: string;
}

export interface CustomerMembershipState {
  active: MembershipView | null;
  past: CustomerMembership[];
  /** This customer's recent appointments a visit can be tied to. */
  appointmentOptions: AppointmentOption[];
}

export interface ActiveMemberRow {
  membershipId: string;
  customerId: string;
  customerName: string;
  planName: string;
  visitsPerMonth: number;
  usedThisMonth: number;
  startsOn: string;
  /** The monthly fee this member signed up for. */
  price: number;
}

export type MembershipRefusal =
  | "not_found"
  | "inactive"
  | "not_started"
  | "ended"
  | "limit"
  | "wrong_service"
  | "bad_appointment"
  | "already_undone"
  | "not_use";

export const MEMBERSHIP_REFUSAL_MESSAGES_EL: Record<MembershipRefusal, string> = {
  not_found: "Η συνδρομή δεν βρέθηκε.",
  inactive: "Η συνδρομή δεν είναι ενεργή.",
  not_started: "Η συνδρομή δεν έχει ξεκινήσει ακόμα σε αυτή την ημερομηνία.",
  ended: "Η συνδρομή έχει λήξει σε αυτή την ημερομηνία.",
  limit: "Οι επισκέψεις του μήνα έχουν εξαντληθεί.",
  wrong_service: "Η υπηρεσία του ραντεβού δεν περιλαμβάνεται στη συνδρομή.",
  bad_appointment: "Αυτό το ραντεβού δεν μπορεί να καταγραφεί (άλλος πελάτης, ακυρωμένο ή ήδη καταγεγραμμένο).",
  already_undone: "Η επίσκεψη έχει ήδη αναιρεθεί.",
  not_use: "Αναιρείται μόνο καταγεγραμμένη επίσκεψη.",
};
