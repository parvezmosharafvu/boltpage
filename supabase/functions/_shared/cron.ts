import { timingSafeEqual } from "./http.ts";

// pg_cron -> pg_net calls carry x-cron-secret. Fails closed when CRON_SECRET is unset.
export function hasCronSecret(req: Request, expected = Deno.env.get("CRON_SECRET")): boolean {
  if (!expected) return false;
  return timingSafeEqual(req.headers.get("x-cron-secret") ?? "", expected);
}
