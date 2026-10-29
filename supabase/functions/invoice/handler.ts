import { preflight } from "../_shared/cors.ts";
import { clientIp, errorResponse, HttpError, json, sha256Hex, UUID_RE } from "../_shared/http.ts";

export interface InvoiceRow {
  status: "pending" | "settled" | "expired" | "failed";
  amount_usd: number | string;
  amount_sats: number | string;
  bolt11: string;
  expires_at: string;
  settled_at: string | null;
  memo: string | null;
  display_name: string;
  slug: string;
}

export interface InvoiceViewDeps {
  getInvoice(id: string): Promise<InvoiceRow | null>;
  rateLimit(bucket: string, maxPerMinute: number): Promise<boolean>;
  limitPerMinute(): Promise<number>;
  ipSalt: string;
}

// GET ?id=<payment uuid> -> the public view of one invoice, used when an admin shares an
// invoice link (/<slug>?i=<id>). The random id is the capability; the BOLT11 is returned only
// while the invoice can still be paid. Never returns owner, commission or other payments.
export function createHandler(deps: InvoiceViewDeps) {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;
    try {
      if (req.method !== "GET") throw new HttpError(405, "method_not_allowed");
      const id = new URL(req.url).searchParams.get("id") ?? "";
      if (!UUID_RE.test(id)) throw new HttpError(400, "invalid_id");

      const ipKey = await sha256Hex(`${deps.ipSalt}:${clientIp(req)}`);
      if (!(await deps.rateLimit(`invoice-view:ip:${ipKey}`, await deps.limitPerMinute()))) {
        throw new HttpError(429, "rate_limited");
      }

      const inv = await deps.getInvoice(id);
      if (!inv) throw new HttpError(404, "not_found");
      return json({
        payment_id: id,
        status: inv.status,
        amount_usd: Number(inv.amount_usd).toFixed(2),
        amount_sats: Number(inv.amount_sats),
        bolt11: inv.status === "pending" ? inv.bolt11 : null,
        expires_at: inv.expires_at,
        settled_at: inv.settled_at,
        memo: inv.memo,
        display_name: inv.display_name,
        slug: inv.slug,
      });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
