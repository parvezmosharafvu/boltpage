import { preflight } from "../_shared/cors.ts";
import { clientIp, errorResponse, HttpError, json, sha256Hex, UUID_RE } from "../_shared/http.ts";
import type { LookupResult } from "../_shared/lnd.ts";
import { applyLookup, type TransitionStore } from "../_shared/settle.ts";

export interface PaymentRow {
  id: string;
  status: "pending" | "settled" | "expired" | "failed";
  amount_usd: number | string;
  settled_at: string | null;
  payment_hash: string;
  expires_at: string;
  last_checked_at: string | null;
}

export interface PaymentStatusDeps extends TransitionStore {
  getPayment(id: string): Promise<PaymentRow | null>;
  markChecked(id: string): Promise<void>;
  lookupInvoice(paymentHash: string): Promise<LookupResult | null>;
  rateLimit(bucket: string, maxPerMinute: number): Promise<boolean>;
  limitPerMinute(): Promise<number>;
  ipSalt: string;
  now?: () => Date;
}

// The checkout polls every 3 s; ask LND at most this often per payment.
export const RECHECK_MS = 4000;

// GET ?id=<payment uuid> -> { status, amount_usd, settled_at } and nothing else.
export function createHandler(deps: PaymentStatusDeps) {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;
    try {
      if (req.method !== "GET") throw new HttpError(405, "method_not_allowed");
      const id = new URL(req.url).searchParams.get("id") ?? "";
      if (!UUID_RE.test(id)) throw new HttpError(400, "invalid_id");

      const ipKey = await sha256Hex(`${deps.ipSalt}:${clientIp(req)}`);
      if (!(await deps.rateLimit(`status:ip:${ipKey}`, await deps.limitPerMinute()))) {
        throw new HttpError(429, "rate_limited");
      }

      let payment = await deps.getPayment(id);
      if (!payment) throw new HttpError(404, "not_found");

      const now = deps.now?.() ?? new Date();
      const lastCheck = payment.last_checked_at ? new Date(payment.last_checked_at).getTime() : 0;
      if (payment.status === "pending" && now.getTime() - lastCheck >= RECHECK_MS) {
        await deps.markChecked(id);
        try {
          const invoice = await deps.lookupInvoice(payment.payment_hash);
          const { transition } = await applyLookup(payment, invoice, deps, "status", now);
          if (transition !== "none") payment = (await deps.getPayment(id)) ?? payment;
        } catch (err) {
          // The cron watcher will catch up; answer with the stored status.
          console.error("payment-status lookup failed:", err instanceof Error ? err.message : String(err));
        }
      }

      return json({
        status: payment.status,
        amount_usd: Number(payment.amount_usd).toFixed(2),
        settled_at: payment.settled_at,
      });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
