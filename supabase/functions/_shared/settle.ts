// Maps an LND invoice lookup to a payment state transition. Shared by lnd-watcher (cron)
// and payment-status (on demand). The database guards make every transition idempotent.
import type { LookupResult } from "./lnd.ts";

export type Transition = "settled" | "expired" | "failed" | "none";

// LND cancels expired invoices itself; the grace period covers clock skew before we
// conclude an invoice that still reads OPEN has expired.
export const EXPIRY_GRACE_MS = 120_000;

export function decideTransition(
  payment: { expires_at: string },
  invoice: LookupResult | null,
  now: Date,
): Transition {
  const pastExpiry = now.getTime() > new Date(payment.expires_at).getTime() + EXPIRY_GRACE_MS;
  if (invoice === null) {
    // LND does not know it. Only give up once it could not be paid anyway.
    return pastExpiry ? "failed" : "none";
  }
  switch (invoice.state) {
    case "SETTLED":
      return "settled";
    case "CANCELED":
      return "expired";
    default:
      return pastExpiry ? "expired" : "none";
  }
}

export interface TransitionStore {
  settle(hash: string, settledAt: Date | null, amtPaidSat: number, source: "watcher" | "status"): Promise<boolean>;
  expire(hash: string): Promise<boolean>;
  fail(hash: string): Promise<boolean>;
}

// Returns the transition and whether this call was the one that applied it.
export async function applyLookup(
  payment: { payment_hash: string; expires_at: string },
  invoice: LookupResult | null,
  store: TransitionStore,
  source: "watcher" | "status",
  now: Date,
): Promise<{ transition: Transition; changed: boolean }> {
  const transition = decideTransition(payment, invoice, now);
  let changed = false;
  if (transition === "settled") {
    changed = await store.settle(payment.payment_hash, invoice?.settleDate ?? null, invoice?.amtPaidSat ?? 0, source);
  } else if (transition === "expired") {
    changed = await store.expire(payment.payment_hash);
  } else if (transition === "failed") {
    changed = await store.fail(payment.payment_hash);
  }
  return { transition, changed };
}
