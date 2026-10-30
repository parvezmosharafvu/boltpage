import { timingSafeEqual } from "./http.ts";

// pg_cron -> pg_net calls carry x-cron-secret. A CRON_SECRET function secret wins when set;
// otherwise the header is checked in the database against the Vault secret that migration 0011
// generates, so nobody copies it by hand. Fails closed when neither is available.
export async function hasCronSecret(
  req: Request,
  expected = Deno.env.get("CRON_SECRET"),
  matchesVault?: (secret: string) => Promise<boolean>,
): Promise<boolean> {
  const given = req.headers.get("x-cron-secret") ?? "";
  if (!given) return false;
  if (expected) return timingSafeEqual(given, expected);
  if (!matchesVault) return false;
  return await matchesVault(given).catch(() => false);
}
