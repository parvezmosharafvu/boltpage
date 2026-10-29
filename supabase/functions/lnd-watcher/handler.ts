import { errorResponse, HttpError, json } from "../_shared/http.ts";
import type { LookupResult } from "../_shared/lnd.ts";
import { applyLookup, type TransitionStore } from "../_shared/settle.ts";

export interface PendingPayment {
  payment_hash: string;
  expires_at: string;
}

export interface WatcherDeps extends TransitionStore {
  isAuthorized(req: Request): boolean;
  listPending(limit: number): Promise<PendingPayment[]>;
  lookupInvoice(paymentHash: string): Promise<LookupResult | null>;
  now?: () => Date;
}

const BATCH = 200;
const CONCURRENCY = 5;

// Cron (every minute): reconcile every pending payment with LND.
export function createHandler(deps: WatcherDeps) {
  return async (req: Request): Promise<Response> => {
    try {
      if (!deps.isAuthorized(req)) throw new HttpError(401, "unauthorized");
      const pending = await deps.listPending(BATCH);
      const summary = { checked: 0, settled: 0, expired: 0, failed: 0, errors: 0 };

      let next = 0;
      const worker = async () => {
        while (next < pending.length) {
          const payment = pending[next++];
          try {
            const invoice = await deps.lookupInvoice(payment.payment_hash);
            const { transition, changed } = await applyLookup(
              payment,
              invoice,
              deps,
              "watcher",
              deps.now?.() ?? new Date(),
            );
            summary.checked++;
            if (changed && transition !== "none") summary[transition]++;
          } catch (err) {
            summary.errors++;
            console.error("watcher lookup failed:", err instanceof Error ? err.message : String(err));
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return json(summary);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
