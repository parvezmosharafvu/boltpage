// Production wiring shared by several functions: service-role RPC calls and the LND client.
import { serviceClient } from "./auth.ts";
import { dbError } from "./http.ts";
import { type LndClient, lndFromEnv } from "./lnd.ts";
import type { TransitionStore } from "./settle.ts";

let lnd: LndClient | null = null;

// Created lazily so a missing LND secret fails the request, not the function boot.
export function getLnd(): LndClient {
  lnd ??= lndFromEnv();
  return lnd;
}

export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await serviceClient().rpc(fn, args);
  if (error) throw dbError(error);
  return data as T;
}

export function rateLimit(bucket: string, maxPerMinute: number): Promise<boolean> {
  return rpc<boolean>("rate_limit_hit", { p_bucket: bucket, p_window_seconds: 60, p_max: maxPerMinute });
}

export const transitionStore: TransitionStore = {
  settle: (hash, settledAt, amtPaidSat, source) =>
    rpc<boolean>("settle_payment", {
      p_payment_hash: hash,
      p_settled_at: settledAt?.toISOString() ?? null,
      p_amt_paid_sat: amtPaidSat,
      p_source: source,
    }),
  expire: (hash) => rpc<boolean>("expire_payment", { p_payment_hash: hash }),
  fail: (hash) => rpc<boolean>("fail_payment", { p_payment_hash: hash }),
};

export function brandName(): string {
  return Deno.env.get("BRAND_NAME") || "Boltpage";
}
