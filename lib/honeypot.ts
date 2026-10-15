/**
 * Simple protection of the public forms against automated submissions.
 *
 * The booking and review forms contain one extra text field, hidden from
 * people (off-screen, not focusable, ignored by screen readers and by
 * browser autofill). A person never fills it; many bots fill every field
 * they find. A request that arrives with it filled in is refused before
 * any other work.
 *
 * It costs real customers nothing and needs no third-party service. It is
 * not a complete defence -- the rate limits on the same endpoints remain
 * the main protection.
 */

/** Name of the hidden field, in the form and in the request body. */
export const HONEYPOT_FIELD = "company_website";

/** True when the hidden field was filled in, i.e. the request came from a bot. */
export function isHoneypotTripped(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const value = (body as Record<string, unknown>)[HONEYPOT_FIELD];
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

/** Inline styles that keep the field out of sight without display:none (which some bots skip). */
export const HONEYPOT_STYLE = {
  position: "absolute",
  left: "-10000px",
  top: "auto",
  width: "1px",
  height: "1px",
  overflow: "hidden",
} as const;
