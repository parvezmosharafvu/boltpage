import { corsHeaders } from "./cors.ts";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

// Business errors raised by SQL as `raise exception '<code>'`, and the status each maps to.
// Anything else becomes a generic 500 so internals never leak to callers.
const DB_ERRORS: Record<string, number> = {
  account_not_active: 403,
  not_authorized: 403,
  checkout_disabled: 503,
  link_not_found: 404,
  not_found: 404,
  amount_invalid: 400,
  amount_below_min: 400,
  amount_above_max: 400,
  insufficient_balance: 400,
  withdrawal_below_min: 400,
  withdrawal_in_progress: 409,
  destination_not_found: 404,
  payout_method_unavailable: 400,
  telegram_not_configured: 503,
  reason_required: 400,
  statement_not_closed: 409,
};

export function dbError(err: { message?: string } | null | undefined): HttpError {
  const code = err?.message ?? "";
  return code in DB_ERRORS ? new HttpError(DB_ERRORS[code], code) : new HttpError(500, "internal_error");
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.code }, err.status);
  }
  // Log the message only; never request bodies, headers or secrets.
  console.error("unhandled error:", err instanceof Error ? err.message : String(err));
  return json({ error: "internal_error" }, 500);
}

export async function readJson<T>(req: Request, maxBytes = 8192): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) {
    throw new HttpError(413, "body_too_large");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time for equal lengths; length mismatch returns early (length is not secret).
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
