import "server-only";
import { createHash } from "node:crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { headers } from "next/headers";

/**
 * Step 23C -- shared rate-limiting abstraction.
 *
 * Architecture (see the Step 23C inspection for the full rationale):
 *  - Production is treated as serverless/multi-instance, so an in-memory
 *    counter would only limit per-instance, not globally -- Upstash Redis
 *    (HTTP-based, no persistent connection) is used as the shared store,
 *    reachable from both the Node.js runtime every route handler/Server
 *    Action here already uses and the Edge runtime if ever needed later.
 *  - The FAIL-OPEN contract lives entirely in checkRateLimit() below.
 *    Every call site gets a plain, already-safe RateLimitResult back --
 *    they never see a provider exception and never need their own
 *    try/catch for Upstash specifically. A provider outage must never
 *    become a login/booking outage.
 *  - Two identity mechanisms are needed because the endpoints being
 *    protected are two different shapes: real route handlers (a
 *    NextRequest, headers read directly) and Server Actions (no request
 *    object at all -- headers() from next/headers is the only way to see
 *    the incoming request, same pattern already used elsewhere in this
 *    codebase: lib/supabase/auth-server.ts, lib/business-context.ts,
 *    app/admin/switch-business/actions.ts).
 */

// ---------------------------------------------------------------------------
// Upstash client -- constructed lazily so a missing/misconfigured env in
// dev doesn't crash module load; checkRateLimit() below fails open if
// this is ever null when a check is attempted.
// ---------------------------------------------------------------------------

function buildRedisClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const redis = buildRedisClient();

// One Ratelimit instance per distinct (limit, window) pair, created lazily
// and cached -- @upstash/ratelimit's own recommended pattern, since each
// instance is cheap but the underlying sliding-window algorithm benefits
// from a stable instance per configuration rather than being rebuilt on
// every call.
const limiterCache = new Map<string, Ratelimit>();

function getLimiter(limit: number, windowSeconds: number): Ratelimit | null {
  if (!redis) return null;
  const cacheKey = `${limit}:${windowSeconds}`;
  const existing = limiterCache.get(cacheKey);
  if (existing) return existing;
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
    analytics: false,
    prefix: "medusa-barber-ratelimit",
  });
  limiterCache.set(cacheKey, limiter);
  return limiter;
}

// ---------------------------------------------------------------------------
// Core result shape + checkRateLimit()
// ---------------------------------------------------------------------------

export type RateLimitResult = {
  /** True if the request should proceed (includes the fail-open case). */
  allowed: boolean;
  /** Requests remaining in the current window. -1 when unknown (fail-open). */
  remaining: number;
  /** Unix ms timestamp when the window resets. null when unknown (fail-open). */
  resetAt: number | null;
  /** Seconds the caller should wait before retrying. Only meaningful when !allowed. */
  retryAfterSeconds: number | null;
  /** True only when this result came from the fail-open path (a provider error), never from a real allow/deny decision. */
  failedOpen: boolean;
};

const ALLOW_FAIL_OPEN: Omit<RateLimitResult, "failedOpen"> = {
  allowed: true,
  remaining: -1,
  resetAt: null,
  retryAfterSeconds: null,
};

// ---------------------------------------------------------------------------
// In-process fallback limiter -- used ONLY when Upstash is not configured.
//
// A sliding window of request timestamps per key, held in this server
// process's memory. It is exact for a single long-running Node process
// (`next start` behind a reverse proxy, which is how this application is
// hosted). On a multi-instance or serverless deployment each instance
// counts separately, so the effective limit is "limit x instances" -- still
// a real brake on brute force and booking spam, but configure
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN there for a shared,
// exact limit. Counters reset when the process restarts.
//
// When Upstash IS configured this code is never reached: a provider error
// still fails open (see below), exactly as before.
// ---------------------------------------------------------------------------

/** Upper bound on tracked keys, so a flood of distinct keys cannot grow memory without limit. */
const MEMORY_LIMITER_MAX_KEYS = 20_000;
const memoryHits = new Map<string, number[]>();
let memoryLimiterAnnounced = false;

/** Keys up to this length are kept as-is (readable in debugging); longer ones are hashed. */
const MAX_PLAIN_KEY_LENGTH = 200;
export function boundedKey(key: string): string {
  return key.length <= MAX_PLAIN_KEY_LENGTH ? key : `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

function memoryRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  consume: boolean
): RateLimitResult {
  if (!memoryLimiterAnnounced) {
    memoryLimiterAnnounced = true;
    console.warn(
      "[rate-limit] Upstash is not configured -- using the in-process rate limiter (per server process)."
    );
  }

  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  // limit/window are part of the bucket identity, mirroring how one Upstash
  // Ratelimit instance exists per (limit, window) pair.
  // Keys contain caller-supplied text (e-mail, phone). Long ones are hashed so every
  // tracked key has a bounded size no matter what is sent.
  const bucket = `${limit}:${windowSeconds}:${boundedKey(key)}`;
  const hits = (memoryHits.get(bucket) ?? []).filter((t) => now - t < windowMs);

  const allowed = hits.length < limit;
  if (consume && allowed) hits.push(now);

  // Re-insert so the Map's iteration order is "least recently touched first".
  memoryHits.delete(bucket);
  if (hits.length > 0) memoryHits.set(bucket, hits);
  if (memoryHits.size > MEMORY_LIMITER_MAX_KEYS) {
    let excess = memoryHits.size - MEMORY_LIMITER_MAX_KEYS;
    for (const oldest of memoryHits.keys()) {
      if (excess-- <= 0) break;
      memoryHits.delete(oldest);
    }
  }

  const resetAt = hits.length > 0 ? hits[0] + windowMs : null;
  return {
    allowed,
    remaining: Math.max(0, limit - hits.length),
    resetAt,
    retryAfterSeconds: allowed || resetAt === null ? null : Math.max(1, Math.ceil((resetAt - now) / 1000)),
    failedOpen: false,
  };
}

/**
 * Checks and consumes one request against the named rate-limit bucket.
 *
 * FAIL-OPEN CONTRACT (Correction 1): every PROVIDER failure below -- the
 * network call throwing, timing out, or returning a malformed response --
 * results in `{ allowed: true, failedOpen: true, ... }`. (Upstash simply
 * not being configured is no longer a "failure": the in-process limiter
 * above makes a real decision instead.) Call sites never need their own try/catch for
 * provider errors; they only ever branch on `result.allowed`. A rate-limit
 * *decision* is a best-effort security enhancement, not a dependency the
 * underlying login/booking flow can be allowed to go down with.
 *
 * Logging: on a provider failure, only a fixed, generic classification of
 * the failure (its JS error constructor name, e.g. "TypeError") and the
 * configured limit/window are logged server-side (console.error) --
 * never the raw error object or message (which could echo back
 * configured secrets such as the Upstash token in a network-library
 * error string) and never the rate-limit key or any client-supplied
 * input.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  try {
    const limiter = getLimiter(limit, windowSeconds);
    if (!limiter) {
      // Upstash is not configured. Previously this returned "allowed" for
      // every request, which meant that a deployment without the two
      // UPSTASH_* variables had NO rate limiting at all -- login, signup,
      // password reset and public booking were all unthrottled. Now the
      // in-process limiter below takes over: a real allow/deny decision,
      // enforced per server process.
      return memoryRateLimit(key, limit, windowSeconds, true);
    }

    const result = await limiter.limit(key);

    return {
      allowed: result.success,
      remaining: result.remaining,
      resetAt: result.reset,
      retryAfterSeconds: result.success
        ? null
        : Math.max(0, Math.ceil((result.reset - Date.now()) / 1000)),
      failedOpen: false,
    };
  } catch (error) {
    // Provider genuinely failed (network error, timeout, Upstash outage,
    // malformed response, etc.) -- fail open. Log only a fixed, generic
    // classification of the failure -- deliberately never the raw error
    // object/message (which could echo back configured secrets, e.g. the
    // Upstash token, in a network-library error string) and never the
    // rate-limit key or any user-supplied input.
    const errorType = error instanceof Error ? error.constructor.name : typeof error;
    console.error(
      `[rate-limit] provider request failed (${errorType}) -- failing open. limit=${limit}/${windowSeconds}s`
    );
    return { ...ALLOW_FAIL_OPEN, failedOpen: true };
  }
}

/**
 * Checks the named rate-limit bucket WITHOUT consuming a request against
 * it -- a pure "how much is left" read, using @upstash/ratelimit's own
 * getRemaining() (confirmed present in the installed package's type
 * declarations). Used where a caller needs to decide whether to even
 * attempt an expensive operation (e.g. a Supabase auth call) without
 * penalizing that decision itself -- see loginAction()'s email-keyed
 * limiter, which peeks here before calling Supabase and only actually
 * consumes (via checkRateLimit()) after a confirmed failed attempt, so a
 * successful login never consumes any of the failed-attempt budget.
 *
 * Same contract as checkRateLimit(): a provider failure returns an allow;
 * "not configured" is answered by the in-process limiter.
 *
 * NOTE: peek-then-separately-consume is not perfectly atomic -- two
 * concurrent requests could both pass the peek before either consumes,
 * allowing the bucket to be exceeded by a small margin under high
 * concurrency. Acceptable here: this is a brute-force *slowdown*, not a
 * hard resource cap, and the imprecision is bounded and self-correcting
 * within one window.
 */
export async function peekRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  try {
    const limiter = getLimiter(limit, windowSeconds);
    if (!limiter) {
      // Not configured -> in-process limiter, read-only (see checkRateLimit).
      return memoryRateLimit(key, limit, windowSeconds, false);
    }

    const result = await limiter.getRemaining(key);

    return {
      allowed: result.remaining > 0,
      remaining: result.remaining,
      resetAt: result.reset,
      retryAfterSeconds:
        result.remaining > 0 ? null : Math.max(0, Math.ceil((result.reset - Date.now()) / 1000)),
      failedOpen: false,
    };
  } catch (error) {
    const errorType = error instanceof Error ? error.constructor.name : typeof error;
    console.error(
      `[rate-limit] provider request failed (${errorType}) -- failing open (peek). limit=${limit}/${windowSeconds}s`
    );
    return { ...ALLOW_FAIL_OPEN, failedOpen: true };
  }
}

/** Standard Retry-After header value (seconds, as a string) for a denied RateLimitResult. */
export function retryAfterHeader(result: RateLimitResult): string {
  return String(result.retryAfterSeconds ?? 60);
}

// ---------------------------------------------------------------------------
// IP extraction
// ---------------------------------------------------------------------------

const UNKNOWN_IP = "unknown";

/**
 * Extracts a best-effort client IP from a Headers-like object.
 *
 * Prefers the FIRST address in `x-forwarded-for` (the original client, as
 * set by the nearest trusted proxy -- the standard convention). Falls back
 * to `x-real-ip` (set by some proxies, e.g. nginx, when x-forwarded-for is
 * absent), then to a fixed "unknown" sentinel rather than throwing or
 * returning an empty string, so a header-less request (e.g. local dev)
 * still gets a stable, single shared bucket instead of crashing.
 *
 * KNOWN LIMITATION (documented per Step 23C inspection, not solved here):
 * `x-forwarded-for` can be forged by a client if there is no trusted
 * reverse proxy/CDN stripping and re-setting it before the request
 * reaches this app. No deployment platform has been confirmed for this
 * project, so this cannot be fully closed here -- it's why every
 * IP-keyed limit in this module is deliberately paired with a second,
 * non-IP identity signal (normalized email or phone) wherever one exists.
 * `request.ip` (a Vercel-specific NextRequest convenience field) is
 * deliberately NOT used as the only mechanism, since it would be
 * `undefined` on any non-Vercel host.
 */
export function extractIp(headerSource: Headers): string {
  const forwardedFor = headerSource.get("x-forwarded-for");
  if (forwardedFor) {
    // Each proxy APPENDS the address it received the request from, so the left
    // part of the header is whatever the client chose to send. The trustworthy
    // entry is the one added by our own outermost proxy: counted from the right,
    // TRUSTED_PROXY_HOPS entries in (default 1 = a single reverse proxy such as
    // nginx; a platform that overwrites the header, like Vercel, also works with 1;
    // Cloudflare in front of nginx would be 2).
    const parts = forwardedFor.split(",").map((p) => p.trim()).filter(Boolean);
    const pick = parts[Math.max(0, parts.length - trustedProxyHops())];
    if (pick) return pick;
  }
  const realIp = headerSource.get("x-real-ip");
  if (realIp) return realIp.trim();
  return UNKNOWN_IP;
}

function trustedProxyHops(): number {
  const n = Number(process.env.TRUSTED_PROXY_HOPS ?? "1");
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
}

/** extractIp() for a real NextRequest (route handlers). */
export function extractIpFromRequest(request: Request): string {
  return extractIp(request.headers);
}

/**
 * extractIp() for a Server Action (no Request object exists at all --
 * next/headers' headers() is the only way to see the incoming request's
 * headers there). Async because headers() itself is async in this
 * Next.js version's Server Action context.
 */
export async function extractIpFromServerAction(): Promise<string> {
  const headerList = await headers();
  return extractIp(headerList as unknown as Headers);
}

// ---------------------------------------------------------------------------
// Email normalization -- reuses the exact convention already established
// in services/business-invitations.ts's normalizeEmail(), rather than
// inventing a second one.
// ---------------------------------------------------------------------------

export function normalizeEmailForRateLimit(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Phone canonicalization (Correction 2)
// ---------------------------------------------------------------------------

/**
 * Canonicalizes a phone number for use as a rate-limit key ONLY -- never
 * used to change the stored/displayed `customer_phone` value anywhere
 * (services/appointments.ts's own `.trim()`-only handling of that field
 * is untouched by this module).
 *
 * Inspection finding this is based on: the booking route's existing
 * validation (`^[0-9+ ]{8,15}$`,
 * app/api/v1/businesses/[slug]/appointments/route.ts) already constrains
 * input to digits, `+`, and spaces only -- so the only real-world
 * variation to collapse is (a) spacing and (b) the Greek international
 * prefix. Greek national numbers do not use a trunk "0" prefix (unlike
 * many other countries), so a Greek mobile/landline's national form is
 * always the bare digits with no leading zero to strip -- this rule is
 * intentionally Greece-specific (per your instruction not to pull in a
 * generic international-phone-number library for what is currently a
 * single-market concern); it can be revisited if/when this platform
 * expands to a country with different national-number conventions.
 *
 * Rule:
 *  1. Strip everything except digits and a leading "+".
 *  2. Recognize the Greek country-code prefix in either written form
 *     ("+30" or the "00" international dialing prefix, "0030") and strip
 *     it, leaving the bare national number.
 *  3. Strip any remaining "+" (a `+` appearing anywhere other than as the
 *     already-handled leading country-code marker is not meaningful).
 *
 * Examples (see lib/rate-limit.test.ts for the full table):
 *   "6900000000"        -> "6900000000"
 *   "690 000 0000"       -> "6900000000"
 *   "+30 690 000 0000"   -> "6900000000"
 *   "6911111111"        -> "6911111111"   (genuinely different number)
 *
 * Malformed/unsupported input (empty, letters-only, etc.) never throws --
 * it resolves to a fixed "invalid" sentinel bucket rather than an empty
 * string, so malformed submissions still get a real (shared, low-risk)
 * bucket instead of crashing or silently bypassing the limiter via an
 * empty key. In practice the booking route's own phone-format validation
 * runs and rejects malformed phones before this would ever be reached for
 * a real request; this is a defensive floor, not the primary safeguard.
 */
const INVALID_PHONE_BUCKET = "invalid";

export function normalizePhoneForRateLimit(rawPhone: string): string {
  // Keep only digits and '+', discarding spaces and anything else the
  // (already-enforced) input format wouldn't contain anyway.
  let cleaned = rawPhone.replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+30")) {
    cleaned = cleaned.slice(3);
  } else if (cleaned.startsWith("0030")) {
    cleaned = cleaned.slice(4);
  }

  // Any remaining '+' (e.g. a malformed "++123" or a non-Greek "+xx...")
  // is not a meaningful marker at this point -- drop it rather than let
  // it leak into the key.
  cleaned = cleaned.replace(/\+/g, "");

  if (cleaned.length === 0) return INVALID_PHONE_BUCKET;
  return cleaned;
}
