/**
 * Identifier format check for values that arrive from a browser (server
 * action arguments, route parameters). Every primary key in this schema is
 * a UUID; rejecting anything else up front gives a clean "not found"
 * instead of a database type error, and keeps arbitrary strings out of
 * queries altogether.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
