import type { SupabaseClient } from "./auth.ts";

export interface RuntimeSettings {
  rateLimitIpPerMin: number;
  rateLimitLinkPerMin: number;
  rateLimitStatusPerMin: number;
}

const DEFAULTS: RuntimeSettings = {
  rateLimitIpPerMin: 10,
  rateLimitLinkPerMin: 30,
  rateLimitStatusPerMin: 120,
};

const KEYS: Record<keyof RuntimeSettings, string> = {
  rateLimitIpPerMin: "rate_limit_ip_per_min",
  rateLimitLinkPerMin: "rate_limit_link_per_min",
  rateLimitStatusPerMin: "rate_limit_status_per_min",
};

let cache: { at: number; value: RuntimeSettings } | null = null;

// Reads a few operational settings with the service client, cached for 30 s per isolate.
// Business rules (min/max, expiry, commission) are enforced in SQL, not here.
export async function loadSettings(db: SupabaseClient, ttlMs = 30_000): Promise<RuntimeSettings> {
  if (cache && Date.now() - cache.at < ttlMs) return cache.value;
  const { data, error } = await db.from("app_settings").select("key, value").in("key", Object.values(KEYS));
  if (error) throw new Error(`settings: ${error.message}`);
  const byKey = new Map((data ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
  const value = { ...DEFAULTS };
  for (const [field, key] of Object.entries(KEYS) as [keyof RuntimeSettings, string][]) {
    const n = Number(byKey.get(key));
    if (Number.isFinite(n) && n > 0) value[field] = n;
  }
  cache = { at: Date.now(), value };
  return value;
}
