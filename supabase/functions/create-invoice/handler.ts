import { preflight } from "../_shared/cors.ts";
import { clientIp, errorResponse, HttpError, json, readJson, sha256Hex } from "../_shared/http.ts";
import { type AddInvoiceResult, MAX_EXPIRY_SECONDS } from "../_shared/lnd.ts";
import { formatCents, parseUsdCents, usdCentsToSats } from "../_shared/money.ts";

export interface PreparedCheckout {
  linkId: string;
  displayName: string;
  expirySeconds: number;
}

export interface InvoiceRecord {
  linkId: string;
  amountUsd: string;
  amountSats: bigint;
  btcUsdRate: number;
  paymentHash: string;
  bolt11: string;
  expirySeconds: number;
  domain: string | null;
}

export interface CreateInvoiceDeps {
  // Validates link + amount against settings and link limits (SQL prepare_checkout). Throws HttpError.
  prepareCheckout(slug: string, amountUsd: string, hostname: string | null): Promise<PreparedCheckout>;
  recordInvoice(record: InvoiceRecord): Promise<string>;
  rateLimit(bucket: string, maxPerMinute: number): Promise<boolean>;
  limits(): Promise<{ perIp: number; perLink: number }>;
  btcUsd(): Promise<number>;
  addInvoice(input: { valueSat: bigint; memo: string; expirySeconds: number }): Promise<AddInvoiceResult>;
  ipSalt: string;
  brandName: string;
  now?: () => Date;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const HOST_RE = /^[a-z0-9.-]{1,253}$/;

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

      const amountUsd = formatCents(cents);
      const prepared = await deps.prepareCheckout(slug, amountUsd, hostname);
      if (!(await deps.rateLimit(`invoice:link:${prepared.linkId}`, limits.perLink))) {
        throw new HttpError(429, "rate_limited");
      }

      let rate: number;
      try {
        rate = await deps.btcUsd();
      } catch {
        throw new HttpError(503, "rate_unavailable");
      }
      const sats = usdCentsToSats(cents, rate);
      const expirySeconds = Math.min(MAX_EXPIRY_SECONDS, prepared.expirySeconds);

      let invoice: AddInvoiceResult;
      try {
        invoice = await deps.addInvoice({
          valueSat: sats,
          memo: `${deps.brandName}: ${prepared.displayName}`,
          expirySeconds,
        });
      } catch (err) {
        console.error("addInvoice failed:", err instanceof Error ? err.message : String(err));
        throw new HttpError(502, "lightning_unavailable");
      }

      const paymentId = await deps.recordInvoice({
        linkId: prepared.linkId,
        amountUsd,
        amountSats: sats,
        btcUsdRate: rate,
        paymentHash: invoice.paymentHash,
        bolt11: invoice.paymentRequest,
        expirySeconds,
        domain: hostname,
      });

      const now = deps.now?.() ?? new Date();
      return json({
        payment_id: paymentId,
        bolt11: invoice.paymentRequest,
        amount_usd: amountUsd,
        amount_sats: Number(sats),
        expires_at: new Date(now.getTime() + expirySeconds * 1000).toISOString(),
      });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
