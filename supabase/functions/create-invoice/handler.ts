import { preflight } from "../_shared/cors.ts";
import { clientIp, errorResponse, HttpError, json, readJson, sha256Hex } from "../_shared/http.ts";
import { type IssueDeps, issueInvoice } from "../_shared/invoice.ts";
import { parseUsdCents } from "../_shared/money.ts";

export type { InvoiceRecord, PreparedCheckout } from "../_shared/invoice.ts";

export interface CreateInvoiceDeps extends IssueDeps {
  rateLimit(bucket: string, maxPerMinute: number): Promise<boolean>;
  limits(): Promise<{ perIp: number; perLink: number }>;
  ipSalt: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const HOST_RE = /^[a-z0-9.-]{1,253}$/;

// POST { slug, amount_usd, hostname } -> { payment_id, bolt11, amount_usd, amount_sats, expires_at }
export function createHandler(deps: CreateInvoiceDeps) {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;
    try {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      const body = await readJson<{ slug?: unknown; amount_usd?: unknown; hostname?: unknown }>(req);

      const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
      if (!SLUG_RE.test(slug)) throw new HttpError(404, "link_not_found");
      const cents = parseUsdCents(body.amount_usd);
      if (cents === null) throw new HttpError(400, "amount_invalid");
      const host = typeof body.hostname === "string" ? body.hostname.trim().toLowerCase() : "";
      const hostname = HOST_RE.test(host) ? host : null;

      const limits = await deps.limits();
      const ipKey = await sha256Hex(`${deps.ipSalt}:${clientIp(req)}`);
      if (!(await deps.rateLimit(`invoice:ip:${ipKey}`, limits.perIp))) {
        throw new HttpError(429, "rate_limited");
      }

      const invoice = await issueInvoice(deps, {
        slug,
        cents,
        hostname,
        afterPrepare: async (prepared) => {
          if (!(await deps.rateLimit(`invoice:link:${prepared.linkId}`, limits.perLink))) {
            throw new HttpError(429, "rate_limited");
          }
        },
      });
      return json(invoice);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
