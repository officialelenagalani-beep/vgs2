/**
 * Reads a JSON request body with a size cap, so an anonymous caller cannot
 * make the server buffer and parse an arbitrarily large payload.
 * Returns the parsed object, or a reason ("too_large" / "invalid").
 */
export const DEFAULT_MAX_JSON_BYTES = 16 * 1024;

export type JsonBodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; reason: "too_large" | "invalid" };

export async function readJsonBody(request: Request, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<JsonBodyResult> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large" };
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (Buffer.byteLength(raw, "utf8") > maxBytes) return { ok: false, reason: "too_large" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "invalid" };
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
