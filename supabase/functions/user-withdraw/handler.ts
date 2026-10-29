import { preflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson, UUID_RE } from "../_shared/http.ts";
import { formatCents, parseUsdCents } from "../_shared/money.ts";

export interface Withdrawal {
  id: string;
  amount_usd: number | string;
  status: string;
  created_at: string;
}

export interface WithdrawDeps {
  // Resolves the caller from the bearer token (401 otherwise) and binds the RPC to them.
  authenticate(req: Request): Promise<{
    userId: string;
    requestWithdrawal(amountUsd: string, destinationId: string): Promise<Withdrawal>;
  }>;
  rateLimit(bucket: string, maxPerMinute: number): Promise<boolean>;
}

// POST { amount_usd, destination_id }. Balance, minimum, one-at-a-time and the row lock are
// all enforced by request_withdrawal in SQL; this adds auth and a per-user rate limit.
export function createHandler(deps: WithdrawDeps) {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;
    try {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      const user = await deps.authenticate(req);
      const body = await readJson<{ amount_usd?: unknown; destination_id?: unknown }>(req);
      const cents = parseUsdCents(body.amount_usd);
      if (cents === null) throw new HttpError(400, "amount_invalid");
      const destinationId = typeof body.destination_id === "string" ? body.destination_id : "";
      if (!UUID_RE.test(destinationId)) throw new HttpError(404, "destination_not_found");
      if (!(await deps.rateLimit(`withdraw:user:${user.userId}`, 5))) throw new HttpError(429, "rate_limited");

      const w = await user.requestWithdrawal(formatCents(cents), destinationId);
      return json({ id: w.id, amount_usd: Number(w.amount_usd).toFixed(2), status: w.status, created_at: w.created_at });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
